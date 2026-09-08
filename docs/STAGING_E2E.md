# Kiểm thử E2E staging có guard

Runner `scripts/staging-e2e.js` kiểm tra một lát cắt thật qua HTTP và database:

1. `/api/health/ready` phải báo `environment=staging`, database và schema `ok`.
   Nếu schema thiếu, staging trả tên migration cần áp dụng và runner dừng trước
   khi đăng nhập hoặc ghi dữ liệu.
2. Đăng nhập hai tài khoản bằng cookie HttpOnly và xác minh `accountContext`.
3. Tạo một khu UUID bằng tài khoản A và xác minh tài khoản B không nhìn thấy.
4. Mô phỏng tab cũ gửi cookie B cùng context A và yêu cầu server trả
   `409 SESSION_ACCOUNT_CHANGED`.
5. Đọc lại bằng cookie A, xóa khu giả rồi xác minh cleanup không để lại dữ liệu.

Runner từ chối hostname production `tro-bill.vercel.app`, từ chối health không
phải staging và chỉ xóa khu có tên marker ngẫu nhiên do chính lượt chạy tạo ra.
Không tạo hóa đơn, không gọi webhook và không thực hiện giao dịch tiền thật.

## Cấu hình GitHub một lần

Trong GitHub Environment `Preview`, thêm Environment secrets:

- `STAGING_E2E_EMAIL`, `STAGING_E2E_PASSWORD`: tài khoản A chỉ dành cho staging.
- `STAGING_E2E_EMAIL_B`, `STAGING_E2E_PASSWORD_B`: tài khoản B độc lập, không là
  nhân viên/thành viên của workspace A.
- `VERCEL_AUTOMATION_BYPASS_SECRET`: tùy chọn, chỉ cần khi Preview Deployment
  Protection đang bật. Runner API chỉ gửi header `x-vercel-protection-bypass`;
  không yêu cầu Vercel đặt bypass cookie hoặc thực hiện redirect.

Tài khoản phải là workspace thử nghiệm chuyên dụng, không chứa dữ liệu khách thật.
Không dùng tài khoản admin hoặc tài khoản production. Workflow không tự chạy khi
push; người vận hành mở **Actions → Staging E2E → Run workflow** và nhập HTTPS
origin của đúng Vercel Preview cần kiểm thử.

## Chạy từ máy phát triển

Đặt biến môi trường trong terminal hoặc secret manager, không ghi vào repository:

```bash
STAGING_BASE_URL=https://preview-example.vercel.app \
STAGING_E2E_EMAIL=e2e@example.invalid \
STAGING_E2E_PASSWORD='...' \
STAGING_E2E_EMAIL_B=e2e-b@example.invalid \
STAGING_E2E_PASSWORD_B='...' \
STAGING_E2E_CONFIRMATION=I_ACKNOWLEDGE_THIS_IS_A_DEDICATED_STAGING_ACCOUNT \
npm run test:e2e:staging
```

Nếu runner báo lỗi cleanup, không chạy lại mù. Đăng nhập đúng tài khoản staging,
tìm khu có tiền tố `E2E-`, đối chiếu thời điểm chạy rồi xóa khu rỗng đó.
