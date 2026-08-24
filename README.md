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
    ├── email.js       # gửi email xác minh/đặt lại mật khẩu qua Resend
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

Khi chạy local mà chưa có `RESEND_API_KEY`, màn hình đăng ký và quên mật khẩu
hiện liên kết để test trực tiếp, không gửi email thật. Trên production phải cấu
hình đủ `RESEND_API_KEY`, `EMAIL_FROM` và `APP_URL`; địa chỉ gửi cần thuộc domain
đã xác minh trong Resend.

## Cách hoạt động

- Frontend giữ nguyên logic tính tiền cũ. `saveState()` vẫn gọi đồng bộ khắp
  nơi nhưng bên trong **debounce ~600ms** rồi `PUT /api/state` gửi toàn bộ state.
- Server nhận state và **tách vào các bảng trong 1 transaction** (settings, rooms,
  room_rate_history, tenants, billing_entries, expense_entries,
  history_snapshots, history_bills + users).
- `GET /api/state` lắp ráp ngược từ các bảng thành đúng shape frontend cần. Giá
  trị "chưa nhập" (`''` phía client) lưu `NULL` trong DB và đổi lại `''` khi đọc.
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
| POST   | `/api/auth/verify-email` | Xác minh email bằng token  |
| POST   | `/api/auth/resend-verification` | Gửi lại email xác minh |
| POST   | `/api/auth/forgot-password` | Gửi liên kết đặt lại mật khẩu |
| POST   | `/api/auth/reset-password` | Đặt mật khẩu mới bằng token |
| GET    | `/api/me`            | Thông tin user (cần đăng nhập) |
| GET    | `/api/state`         | Lấy toàn bộ state              |
| PUT    | `/api/state`         | Lưu toàn bộ state              |

Trình duyệt tự gửi cookie phiên cùng các request cùng origin. JWT không được trả
về JavaScript và không còn lưu trong `localStorage`. Request thay đổi dữ liệu từ
website khác bị server từ chối để giảm rủi ro CSRF.

Tài khoản đăng ký mới chỉ được đăng nhập sau khi xác minh email. Token xác minh
có hiệu lực 24 giờ và database chỉ lưu SHA-256 của token, không lưu token gốc.

Liên kết đặt lại mật khẩu có hiệu lực 30 phút, chỉ dùng được một lần và API quên
mật khẩu luôn trả thông báo chung để không tiết lộ email đã đăng ký. Sau khi đặt
lại thành công, mọi phiên đăng nhập cũ của tài khoản đều mất hiệu lực.

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

Admin API (đều qua `requireAuth` + `requireAdmin`):

| Method | Đường dẫn                        | Mô tả                    |
|--------|----------------------------------|--------------------------|
| GET    | `/api/admin/users`               | Danh sách user           |
| GET    | `/api/admin/users/:id/state`     | Xem dữ liệu 1 user       |
| DELETE | `/api/admin/users/:id`           | Xoá user                 |
| POST   | `/api/admin/users/:id/password`  | Đặt lại mật khẩu         |
| POST   | `/api/admin/users/:id/admin`     | Bật/tắt quyền admin      |

Ràng buộc an toàn: admin không thể tự xoá hay tự gỡ quyền của chính mình;
`requireAdmin` kiểm tra lại DB mỗi request nên việc gỡ quyền có hiệu lực ngay.

## Bảo mật

- Mật khẩu băm bằng bcrypt. JWT ký bằng `JWT_SECRET`, hết hạn sau 30 ngày và chỉ
  được lưu trong cookie `HttpOnly`, `SameSite=Lax`.
- `.env` chứa DATABASE_URL + secret, đã có trong `.gitignore`.
- Cookie tự bật cờ `Secure` trên production/Vercel. Có thể đặt
  `COOKIE_SECURE=false` khi cần chạy local bằng HTTP.
- Môi trường production phải dùng HTTPS.
- `RESEND_API_KEY` chỉ được đặt trong biến môi trường phía server, không đưa vào
  frontend hoặc commit lên Git.
