# TrọBill — bản động (Neon Postgres)

Ứng dụng tính tiền nhà trọ hàng tháng. Bản này đã chuyển từ app tĩnh (lưu
`localStorage`) sang **app động nhiều người dùng**: backend Node/Express +
database Neon Postgres, đăng nhập bằng email/mật khẩu (JWT trong cookie
`HttpOnly`).

## Cấu trúc

```
tro-bill/
├── index.html, style.css, app.js, ocr.js, api.js   # frontend
├── vendor/, icons/, manifest.json                  # asset
└── server/                                         # backend Express
    ├── index.js       # serve frontend tĩnh + API, cùng 1 origin
    ├── db.js          # pg Pool từ DATABASE_URL
    ├── auth.js        # register/login (bcrypt) + middleware JWT
    ├── rate-limit.js  # chống brute-force bằng bộ đếm Postgres
    ├── email.js       # gửi email xác minh/đặt lại mật khẩu qua Brevo hoặc Resend
    ├── state.js       # GET/PUT /api/state — lắp ráp ↔ tách các bảng dữ liệu
    ├── schema.sql     # schema chuẩn hóa + lịch sử biểu phí theo tháng
    ├── init-db.js     # chạy schema.sql lên Neon
    └── .env           # DATABASE_URL + JWT_SECRET (KHÔNG commit)
```

## Chạy lần đầu

```bash
cd server
cp .env.example .env      # điền DATABASE_URL của Neon; JWT_SECRET là chuỗi ngẫu nhiên dài
npm install
npm run init-db           # tạo/cập nhật schema trên Neon
npm start                 # chạy tại http://localhost:3000
```

Yêu cầu Node.js 20 trở lên.

Mở http://localhost:3000 → đăng ký tài khoản → dùng bình thường. Mỗi tài khoản
có dữ liệu riêng, tách biệt hoàn toàn.

Khi chạy local mà chưa có API key email, màn hình đăng ký và quên mật khẩu hiện
liên kết để test trực tiếp, không gửi email thật. Trên production có thể dùng:

- Brevo Free tạm thời: `EMAIL_PROVIDER=brevo`, `BREVO_API_KEY`, `EMAIL_FROM` đã
  xác minh và `APP_URL`;
- Resend khi có custom domain: `EMAIL_PROVIDER=resend`, `RESEND_API_KEY`,
  `EMAIL_FROM` thuộc domain đã xác minh và `APP_URL`.

Luồng xác minh/quên mật khẩu dùng chung một adapter nên đổi provider không cần
thay đổi API hoặc dữ liệu người dùng.

## Cách hoạt động

- Frontend giữ nguyên logic tính tiền cũ. `saveState()` vẫn gọi đồng bộ khắp
  nơi nhưng bên trong **debounce ~600ms** rồi `PUT /api/state` gửi toàn bộ state.
- Server nhận state và **tách vào các bảng trong 1 transaction** (settings, rooms,
  room_rate_history, tenants, billing_entries, expense_entries,
  history_snapshots, history_bills, data_audit_logs + users).
- `GET /api/state` lắp ráp ngược từ các bảng thành đúng shape frontend cần. Giá
  trị "chưa nhập" (`''` phía client) lưu `NULL` trong DB và đổi lại `''` khi đọc.
- CCCD trong state luôn được che. Backend giữ nguyên CCCD gốc nếu client gửi lại
  chuỗi đã che; chỉ API reveal/export có mật khẩu hoặc audit mới trả bản đầy đủ.
- Đã bỏ chế độ offline/PWA: service worker cũ được tự gỡ khi tải trang.

## Biểu phí theo tháng

Mỗi phòng có lịch sử biểu phí với mốc `effectiveFrom` dạng `YYYY-MM`. Khi tính
hóa đơn, ứng dụng lấy mốc gần nhất không lớn hơn tháng hóa đơn. Vì vậy một giá
mới có thể bắt đầu từ tháng 2 hoặc tháng 4 mà không làm thay đổi các tháng trước.

Mỗi mốc lưu đồng thời tiền thuê, giá điện, giá nước, phí rác, Wifi và phí quản
lý. Các bản cài đặt cũ sẽ được tạo tự động một mốc nền `1970-01` khi chạy lại:

```bash
cd server
npm run init-db
```

Các hóa đơn đã lưu trong `history_bills` vẫn là snapshot độc lập, không bị tính
lại khi biểu phí phòng thay đổi.

Nếu phòng có `rentStartDate`, riêng tháng bắt đầu thuê sẽ tính tiền theo ngày:

```text
tiền thuê = làm tròn(giá tháng / số ngày trong tháng × (số ngày trong tháng - ngày vào ở + 1))
```

Ngày vào ở được tính tiền. Ví dụ vào ngày 10/08 thì tháng 8 tính 22/31 ngày;
từ tháng 9 trở đi thu đủ giá tháng. Nếu để trống ngày
bắt đầu thuê, hệ thống luôn thu đủ tháng như trước.

## API

| Method | Đường dẫn            | Mô tả                          |
|--------|----------------------|--------------------------------|
| POST   | `/api/auth/register` | Tạo tài khoản, gửi email xác minh |
| POST   | `/api/auth/login`    | Đăng nhập và tạo phiên         |
| POST   | `/api/auth/logout`   | Xóa cookie phiên               |
| POST   | `/api/auth/logout-all` | Thu hồi mọi phiên của tài khoản |
| POST   | `/api/auth/verify-email` | Xác minh email bằng token  |
| POST   | `/api/auth/resend-verification` | Gửi lại email xác minh |
| POST   | `/api/auth/forgot-password` | Gửi liên kết đặt lại mật khẩu |
| POST   | `/api/auth/reset-password` | Đặt mật khẩu mới bằng token |
| GET    | `/api/me`            | Thông tin user (cần đăng nhập) |
| GET    | `/api/state`         | Lấy toàn bộ state              |
| PUT    | `/api/state`         | Lưu toàn bộ state              |
| GET    | `/api/privacy/status` | Phiên bản chính sách và thời hạn lưu |
| POST   | `/api/privacy/accept` | Ghi nhận đồng ý chính sách hiện tại |
| POST   | `/api/privacy/tenants/:tenantId/reveal-cccd` | Xem CCCD của khách thuộc tài khoản + audit |
| GET    | `/api/privacy/audit-logs` | Nhật ký xem/sửa/xuất/xóa dữ liệu |
| POST   | `/api/privacy/export` | Xuất toàn bộ dữ liệu, yêu cầu mật khẩu |
| DELETE | `/api/account`       | Tự xóa tài khoản, yêu cầu mật khẩu + cụm xác nhận |

Trình duyệt tự gửi cookie phiên cùng các request cùng origin. JWT không được trả
về JavaScript và không còn lưu trong `localStorage`. Request thay đổi dữ liệu từ
website khác bị server từ chối để giảm rủi ro CSRF.

Tài khoản đăng ký mới chỉ được đăng nhập sau khi xác minh email. Token xác minh
có hiệu lực 24 giờ và database chỉ lưu SHA-256 của token, không lưu token gốc.

Liên kết đặt lại mật khẩu có hiệu lực 30 phút, chỉ dùng được một lần và API quên
mật khẩu luôn trả thông báo chung để không tiết lộ email đã đăng ký. Sau khi đặt
lại thành công, mọi phiên đăng nhập cũ của tài khoản đều mất hiệu lực.

Đăng nhập sai được giới hạn đồng thời theo IP (20 lần/15 phút) và tài khoản
(8 lần/15 phút). Đăng ký được giới hạn theo IP (10 lần/giờ) và email
(5 lần/giờ). Bộ đếm lưu trong Postgres để dùng được trên nhiều serverless
instance; IP/email chỉ được lưu dưới dạng HMAC. Có thể cấu hình khóa HMAC riêng
bằng `RATE_LIMIT_SECRET`, nếu bỏ trống sẽ dùng `JWT_SECRET`.

Trong Cài đặt, nút **Đăng xuất tất cả thiết bị** tăng `token_version` của tài
khoản nên mọi JWT đã cấp trước đó mất hiệu lực ngay, bao gồm phiên hiện tại.

## Bảo vệ dữ liệu khách thuê

- Đăng ký mới bắt buộc đồng ý [Chính sách bảo mật](privacy.html) và
  [Điều khoản sử dụng](terms.html); tài khoản cũ có thể xác nhận bản hiện tại
  trong Cài đặt.
- Khi tạo hoặc sửa hồ sơ khách thuê, chủ tài khoản phải xác nhận đã thông báo
  mục đích thu thập bằng [thông báo mẫu](tenant-data-notice.html). Phiên bản
  thông báo và thời điểm xác nhận được lưu ở tenant.
- CCCD được che mặc định với mọi tài khoản. Mỗi lần chủ tài khoản xem đầy đủ
  đều gọi API theo đúng tenant ownership và ghi audit; admin vẫn phải nhập lý do.
- Thay đổi hoặc xóa hồ sơ khách thuê được phát hiện trong transaction lưu state;
  audit chỉ lưu tên trường thay đổi, không lưu giá trị cũ/mới hoặc CCCD.
- Xuất dữ liệu và tự xóa tài khoản yêu cầu nhập lại mật khẩu, có rate limit và
  audit. File xuất gồm dữ liệu nghiệp vụ, CCCD đầy đủ và nhật ký truy cập của
  chủ tài khoản/admin. Xóa tài khoản cascade dữ liệu khỏi database chính ngay lập tức.
- Backup mã hóa có thời hạn tối đa 30 ngày; audit tối giản giữ 365 ngày và được
  dọn tự động khi có hoạt động audit mới.

## Tài khoản admin

Hệ thống có vai trò **admin** (cột `users.is_admin`). Admin xem được toàn bộ
người dùng và dữ liệu trọ của họ.

**Tạo admin đầu tiên** (không thể tự phong qua web — phải chạy trên máy):

```bash
cd server
npm run make-admin -- you@example.com        # cấp quyền (đăng ký tài khoản này trước)
npm run make-admin -- you@example.com off     # gỡ quyền
```

Sau khi được phong, **đăng nhập lại** để phiên mang cờ admin. Khi đó app hiện
nút 🛡️ trên thanh nav → mở trang `admin.html`:

- Liệt kê user (kèm số phòng, số lịch sử)
- Xem dữ liệu trọ của từng user
- Đổi mật khẩu, cấp/gỡ quyền admin, xoá user (cascade toàn bộ dữ liệu)
- CCCD bị che mặc định; chỉ xem từng CCCD đầy đủ sau khi nhập lý do hỗ trợ
- Rà nhật ký xem CCCD gồm admin, tài khoản đích, khách thuê, lý do, thời gian và
  dấu vân tay IP; log không chứa số CCCD

Admin API (đều qua `requireAuth` + `requireAdmin`):

| Method | Đường dẫn                        | Mô tả                    |
|--------|----------------------------------|--------------------------|
| GET    | `/api/admin/users`               | Danh sách user           |
| GET    | `/api/admin/users/:id/state`     | Xem dữ liệu 1 user       |
| POST   | `/api/admin/users/:id/tenants/:tenantId/reveal-cccd` | Xem CCCD có lý do + audit |
| GET    | `/api/admin/sensitive-access-logs` | Rà nhật ký xem CCCD    |
| DELETE | `/api/admin/users/:id`           | Xoá user                 |
| POST   | `/api/admin/users/:id/password`  | Đặt lại mật khẩu         |
| POST   | `/api/admin/users/:id/admin`     | Bật/tắt quyền admin      |

Ràng buộc an toàn: admin không thể tự xoá hay tự gỡ quyền của chính mình;
`requireAdmin` kiểm tra lại DB mỗi request nên việc gỡ quyền có hiệu lực ngay.
Các API dữ liệu thường chỉ dùng `req.userId` từ phiên đã xác thực. Postgres còn
có khóa ngoại ghép `(user_id, room_id)` để tenant, biểu phí và hóa đơn không thể
tham chiếu phòng của tài khoản khác.

## Bảo mật

- Mật khẩu băm bằng bcrypt. JWT ký bằng `JWT_SECRET`, hết hạn sau 30 ngày và chỉ
  được lưu trong cookie `HttpOnly`, `SameSite=Lax`.
- `.env` chứa DATABASE_URL + secret, đã có trong `.gitignore`.
- Cookie tự bật cờ `Secure` trên production/Vercel. Có thể đặt
  `COOKIE_SECURE=false` khi cần chạy local bằng HTTP.
- Môi trường production phải dùng HTTPS.
- `BREVO_API_KEY`/`RESEND_API_KEY` chỉ được đặt trong biến môi trường phía server,
  không đưa vào frontend hoặc commit lên Git.

Health check, log/cảnh báo, phân tách môi trường, backup mã hóa và quy trình
restore được mô tả trong [OPERATIONS.md](OPERATIONS.md).

Hợp đồng HMAC, payload tối thiểu và quy tắc idempotency của webhook thanh toán
subscription được mô tả trong [PAYMENT_WEBHOOK.md](PAYMENT_WEBHOOK.md).
