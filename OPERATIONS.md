# Vận hành an toàn TrọBill

Tài liệu này là runbook cho backup, restore, health check, log/cảnh báo, HTTPS và
cấu hình môi trường. Không đưa giá trị secret thật vào tài liệu, issue hoặc log.

## 1. Phân tách môi trường

| Môi trường ứng dụng | Vercel scope | Database | Biến nhận diện |
|---|---|---|---|
| Development | Development/local | Database dev | `APP_ENV=development`, `DATABASE_ENVIRONMENT=development` |
| Staging | Preview | Database staging riêng | `APP_ENV=staging`, `DATABASE_ENVIRONMENT=staging` |
| Production | Production | Database production riêng | `APP_ENV=production`, `DATABASE_ENVIRONMENT=production` |

Khi không đặt `APP_ENV`, server tự ánh xạ `VERCEL_ENV=preview` thành `staging` và
`VERCEL_ENV=production` thành `production`. Nếu `DATABASE_ENVIRONMENT` có giá trị
khác môi trường ứng dụng, readiness check trả `503` để phát hiện gắn nhầm database.

Trên Vercel, tạo các biến trong đúng scope thay vì dùng cùng một `DATABASE_URL`
cho cả Preview và Production. Dùng các file `.env.*.example` làm mẫu; file thật
phải nằm ngoài Git. Kiểm tra một bộ biến bằng:

```bash
npm run check:environment -- production --strict
```

`--strict` coi cả cảnh báo thiếu nhãn database hoặc webhook là lỗi.

## 2. HTTPS

Vercel cấp và gia hạn chứng chỉ TLS sau khi domain/DNS được xác minh. Server còn:

- chuyển request HTTP của staging/production sang `APP_URL` HTTPS bằng mã `308`;
- gửi HSTS một năm, `nosniff`, chống nhúng iframe và không gửi referrer;
- đặt cookie phiên `Secure` ở staging/production.

Sau mỗi thay đổi domain, kiểm tra:

```bash
curl -I http://your-domain.example/api/health/live
curl -I https://your-domain.example/api/health/live
```

Request đầu phải chuyển sang HTTPS; request sau phải có
`Strict-Transport-Security` và trả `200`.

## 3. Health check, log và cảnh báo

- `GET /api/health/live`: process đang phục vụ request, không chạm database.
- `GET /api/health/ready`: kiểm tra cấu hình và chạy `SELECT 1` vào database.
- Lỗi API/database được ghi thành JSON có `incidentId`, `requestId`, route và mã
  lỗi; không ghi body, cookie, query string, câu SQL hoặc thông báo lỗi gốc.
- Response lỗi bất ngờ trả `incidentId` để tra cứu trong Vercel Runtime Logs.

Đặt `OPS_ALERT_WEBHOOK_URL` bằng endpoint HTTPS nhận JSON trong Production,
Preview và GitHub Actions. Alert cùng loại được giới hạn một lần mỗi năm phút
trên mỗi instance để giảm spam. Nếu chưa có hệ thống cảnh báo riêng, Runtime Logs
của Vercel vẫn là nguồn điều tra nhưng chưa được coi là đã hoàn thành alert.

Workflow `.github/workflows/production-health.yml` giám sát readiness mỗi 5 phút
từ bên ngoài Vercel. Tạo GitHub Actions variable `PRODUCTION_HEALTH_URL` bằng
origin HTTPS, không có dấu `/` cuối. Khi chưa có biến này job được bỏ qua thay vì
báo động giả.

## 4. Backup tự động và restore drill

Workflow `.github/workflows/database-backup.yml` chạy hằng ngày lúc **01:15 giờ
Việt Nam** (`18:15 UTC`), hoặc chạy tay bằng `workflow_dispatch`:

1. `pg_dump` từ endpoint Neon **không qua pooler** ở định dạng custom.
2. Kiểm tra manifest có các bảng lõi.
3. Mã hóa AES-256/PBKDF2 trước khi upload.
4. Restore vào PostgreSQL 18 trống, cùng major version với production hiện tại.
5. Kiểm tra đủ bảng và không có tenant/biểu phí/bill trỏ sai chủ phòng.
6. Chỉ lưu file mã hóa, checksum và manifest trong GitHub Artifact 30 ngày.

RPO mục tiêu là 24 giờ. Restore drill chạy cùng mọi backup nên một workflow xanh
là bằng chứng cả tạo backup lẫn phục hồi đã thành công.

Tạo các GitHub Actions secret sau:

- `BACKUP_DATABASE_URL`: endpoint trực tiếp (hostname không có `-pooler`) của
  database production, tài khoản chỉ có quyền cần thiết để đọc backup;
- `BACKUP_ENCRYPTION_PASSPHRASE`: chuỗi ngẫu nhiên dài, lưu thêm một bản trong
  password manager tách khỏi GitHub;
- `OPS_ALERT_WEBHOOK_URL`: webhook cảnh báo, có thể dùng cùng endpoint production.

Ngoài các secret trên, tạo Actions variable `PRODUCTION_HEALTH_URL` để bật giám
sát API/database từ bên ngoài Vercel.

Không đổi passphrase trước khi backup cũ hết hạn hoặc đã được mã hóa lại. GitHub
không cho đọc lại secret sau khi lưu.

### Khôi phục khi có sự cố

Không restore thẳng lên database production đang hoạt động. Tạo database/branch
Neon trống, tải ba file artifact về cùng thư mục rồi chạy:

```bash
export RESTORE_DATABASE_URL='postgresql://...database-trong...?sslmode=require'
export BACKUP_ENCRYPTION_PASSPHRASE='lay-tu-password-manager'
export ALLOW_EMPTY_DATABASE_RESTORE=true
scripts/restore-database.sh backups/trobill-YYYYMMDDTHHMMSSZ.dump.enc
```

Script từ chối database đã có bất kỳ bảng `public` nào. Sau khi restore thành
công, chạy ứng dụng staging với database vừa phục hồi, kiểm tra đăng nhập/phòng/
bill, rồi mới đổi `DATABASE_URL` production theo quy trình change management.

## 5. CI và secret

Workflow CI chạy trên mọi pull request và push vào `main`:

- test đăng nhập, cookie, rate limit, phân quyền, CCCD và công thức bill;
- test HTTPS, health check, môi trường và log không làm lộ thông báo lỗi;
- quét tracked files cùng toàn bộ Git history theo các mẫu secret phổ biến;
- chạy `npm audit` với lỗ hổng production mức high trở lên.

Nếu secret từng bị commit, xóa file khỏi commit mới là chưa đủ: phải thu hồi/đổi
secret ở nhà cung cấp trước, sau đó mới cân nhắc làm sạch lịch sử Git.

## 6. Khi có sự cố

1. Ghi lại thời gian, route, môi trường và `incidentId`; không sao chép dữ liệu
   người thuê vào ticket công khai.
2. Xem Runtime Logs theo `incidentId`/`requestId`, sau đó kiểm tra readiness.
3. Nếu database lỗi, kiểm tra Neon trước khi deploy lại ứng dụng.
4. Nếu nghi mất dữ liệu, khóa thao tác ghi và phục hồi vào database mới; không
   ghi đè production cho đến khi đã đối chiếu.
5. Sau xử lý, ghi nguyên nhân, phạm vi ảnh hưởng, hành động phòng ngừa và thời
   gian khôi phục vào báo cáo sự cố nội bộ.
