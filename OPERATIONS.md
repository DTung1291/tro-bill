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

Staging hiện dùng alias `tro-bill-staging-dtung.vercel.app`, được bảo vệ bởi
Vercel Authentication và kết nối Neon branch schema-only `staging-privacy`.
Branch cũ tên `staging` không có đủ schema hợp đồng và không phải database của
Preview; luôn xác minh `rental_contracts` cùng `DATABASE_ENVIRONMENT=staging`
trước khi chạy migration. Có thể kiểm tra deployment được bảo vệ bằng phiên
Vercel CLI đang đăng nhập:

```bash
vercel curl /api/health/ready --deployment https://tro-bill-staging-dtung.vercel.app
```

Không tắt Deployment Protection và không dùng staging để chứa dữ liệu người thuê
thật. Preview không dùng tài khoản Super Admin seed của production.

### Quyền quản trị nền tảng

Super Admin là quyền vận hành toàn nền tảng, khác với Owner là chủ trọ sở hữu
workspace. Không cấp Super Admin qua giao diện hoặc API. Dùng biến
`SUPER_ADMIN_EMAIL`/`SUPER_ADMIN_PASSWORD` trong secret manager để seed tài
khoản đầu tiên, hoặc chạy `npm run make-super-admin -- email@example.com` trong
môi trường được phép truy cập database. Owner quản lý nhân viên bằng vai trò và
phạm vi khu hiện có; không cần và không được cấp Super Admin cho nghiệp vụ này.

Cột database `users.is_admin` được giữ như tên legacy để tránh migration rủi ro,
nhưng chỉ mang nghĩa Super Admin. Trước khi thu hồi quyền cũ, phải kiểm kê tài
khoản đang có `is_admin=true`, xác nhận tài khoản break-glass còn hoạt động và
không đưa kết quả chứa email vào issue công khai.

### Role database của ứng dụng

`DATABASE_URL` của Preview và Production phải dùng `tro_bill_runtime_sql`. Role
này được tạo bằng SQL, không kế thừa `neon_superuser`, không có quyền DDL và chỉ
nhận các quyền bảng/cột/sequence cần cho ứng dụng. `tro_bill_runtime` được giữ ở
trạng thái `NOLOGIN` để làm mẫu quyền cho schema/migration; không dùng credential
của role này cho deployment.

Chỉ chạy `20260907_disable_legacy_runtime_logins.sql` sau khi readiness của môi
trường trả `runtimeRole.status=restricted` và truy vấn `pg_stat_activity` xác nhận
role cũ không còn session. Migration tự rollback nếu phát hiện kết nối cũ, không
ngắt session và không xóa role. Thứ tự áp dụng là staging, smoke test, rồi mới
production. Sau production, chạy lại readiness và health monitor.

Role `tro_bill_app` do Neon Console/API tạo có thể kế thừa `neon_superuser` và
không cho `neondb_owner` đổi sang `NOLOGIN` bằng SQL. Sau khi xác minh role này
không còn session, không sở hữu relation/function/database và không có role con,
xóa nó ở trang **Roles** của đúng branch. Không xóa `tro_bill_runtime` vì đây là
nguồn quyền để đồng bộ sang `tro_bill_runtime_sql`.

Nếu cần rollback do deployment còn phụ thuộc credential cũ, dùng tài khoản quản
trị để chạy `ALTER ROLE tro_bill_runtime LOGIN`, khôi phục credential qua secret
manager rồi điều tra; không ghi mật khẩu vào SQL, terminal history hoặc Git.

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

Khi health production thất bại, GitHub Actions trong repo ứng dụng tự mở một
Issue duy nhất. Khi backup thất bại, workflow trong repo private operations mở
Issue ở chính repo private đó. Cả hai đều gán cho `DTung1291` và tự đóng sau lần
chạy phục hồi thành công. Đây là kênh cảnh báo mặc định không cần thêm secret.

Có thể đặt thêm `OPS_ALERT_WEBHOOK_URL` bằng endpoint HTTPS nhận JSON trong
Production, Preview và GitHub Actions. Alert webhook cùng loại được giới hạn một
lần mỗi năm phút trên mỗi instance để giảm spam. Runtime Logs của Vercel vẫn là
nguồn chính để điều tra theo `incidentId` và `requestId`.

Workflow `.github/workflows/production-health.yml` giám sát readiness mỗi 5 phút
từ bên ngoài Vercel. Tạo GitHub Actions variable `PRODUCTION_HEALTH_URL` bằng
origin HTTPS, không có dấu `/` cuối. Khi chưa có biến này job được bỏ qua thay vì
báo động giả.

## 4. Backup tự động và restore drill

Workflow `database-backup.yml` nằm trong repo private
[`DTung1291/tro-bill-operations`](https://github.com/DTung1291/tro-bill-operations),
chạy hằng ngày lúc **01:15 giờ Việt Nam** (`18:15 UTC`), hoặc chạy tay bằng
`workflow_dispatch`. Repo ứng dụng public không chứa workflow có quyền đọc
database production.

1. `pg_dump` từ endpoint Neon **không qua pooler** ở định dạng custom.
2. Kiểm tra manifest có các bảng lõi.
3. Mã hóa AES-256/PBKDF2 trước khi upload.
4. Restore vào PostgreSQL 18 trống, cùng major version với production hiện tại.
5. Kiểm tra đủ bảng và không có tenant/biểu phí/bill trỏ sai chủ phòng.
6. Chỉ lưu file mã hóa, checksum và manifest trong GitHub Artifact 30 ngày.

RPO mục tiêu là 24 giờ. Restore drill chạy cùng mọi backup nên một workflow xanh
là bằng chứng cả tạo backup lẫn phục hồi đã thành công.

Hai GitHub Actions secrets sau chỉ được đặt trong repo private operations:

- `BACKUP_DATABASE_URL`: endpoint trực tiếp (hostname không có `-pooler`) của
  database production, dùng role `tro_bill_backup` không có membership quản trị,
  đọc được nhưng không thể `INSERT` hoặc `CREATE TABLE`;
- `BACKUP_ENCRYPTION_PASSPHRASE`: chuỗi ngẫu nhiên dài, lưu thêm một bản trong
  macOS Keychain với service `com.trobill.backup`, account
  `production-database-encryption`.

Ngoài các secret trên, tạo Actions variable `PRODUCTION_HEALTH_URL` để bật giám
sát API/database từ bên ngoài Vercel.

Không đổi passphrase trước khi backup cũ hết hạn hoặc đã được mã hóa lại. GitHub
không cho đọc lại secret sau khi lưu.

Lần chạy thủ công `32742953010` ngày 24/08/2026 đã tạo backup mã hóa, restore
thành công vào PostgreSQL 18 trống, qua kiểm tra toàn vẹn và lưu artifact 30 ngày.

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

### Báo cáo bảo mật từ bên ngoài

Kênh nhận lỗ hổng là GitHub Private Vulnerability Reporting theo `SECURITY.md`.
Không yêu cầu người báo gửi bằng public Issue, email chưa xác minh hoặc kênh chat
cá nhân. Chủ repository là người triage hiện tại; chưa công bố SLA trước khi có
lịch trực hỗ trợ chính thức.

Khi nhận báo cáo:

1. tạo advisory riêng tư và chỉ mời người cần xử lý;
2. không chép secret/dữ liệu khách sang issue, log hoặc tài liệu trong Git;
3. nếu có nguy cơ ghi chéo/mất dữ liệu, ưu tiên khóa luồng ghi liên quan và bảo
   toàn bằng chứng trước khi sửa;
4. thêm regression test, kiểm tra Preview rồi production theo quy trình phát hành;
5. rotate credential bị ảnh hưởng, theo dõi runtime log và đóng advisory sau khi
   đã xác minh bản sửa.
