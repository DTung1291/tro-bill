# Kiểm thử E2E staging có guard

Runner `scripts/staging-e2e.js` kiểm tra một lát cắt thật qua HTTP và database:

1. `/api/health/ready` phải báo `environment=staging`, database và schema `ok`.
2. Đăng nhập bằng cookie HttpOnly và xác minh `accountContext` qua `/api/me`.
3. Tạo một khu có tên UUID riêng, đọc lại rồi xóa ngay.
4. Đọc lần cuối để chắc chắn cleanup không để lại dữ liệu giả.

Runner từ chối hostname production `tro-bill.vercel.app`, từ chối health không
phải staging và chỉ xóa khu có tên marker ngẫu nhiên do chính lượt chạy tạo ra.
Không tạo hóa đơn, không gọi webhook và không thực hiện giao dịch tiền thật.

## Cấu hình GitHub một lần

Trong GitHub Environment `Preview`, thêm Environment secrets:

- `STAGING_E2E_EMAIL`: tài khoản chỉ dành cho kiểm thử staging.
- `STAGING_E2E_PASSWORD`: mật khẩu của tài khoản trên.
- `VERCEL_AUTOMATION_BYPASS_SECRET`: tùy chọn, chỉ cần khi Preview Deployment
  Protection đang bật.

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
STAGING_E2E_CONFIRMATION=I_ACKNOWLEDGE_THIS_IS_A_DEDICATED_STAGING_ACCOUNT \
npm run test:e2e:staging
```

Nếu runner báo lỗi cleanup, không chạy lại mù. Đăng nhập đúng tài khoản staging,
tìm khu có tiền tố `E2E-`, đối chiếu thời điểm chạy rồi xóa khu rỗng đó.
