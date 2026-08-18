# TrọBill — bản động (Neon Postgres)

Ứng dụng tính tiền nhà trọ hàng tháng. Bản này đã chuyển từ app tĩnh (lưu
`localStorage`) sang **app động nhiều người dùng**: backend Node/Express +
database Neon Postgres, đăng nhập bằng email/mật khẩu (JWT).

## Cấu trúc

```
tro-bill/
├── index.html, style.css, app.js, ocr.js, api.js   # frontend
├── vendor/, icons/, manifest.json                  # asset
└── server/                                         # backend Express
    ├── index.js       # serve frontend tĩnh + API, cùng 1 origin
    ├── db.js          # pg Pool từ DATABASE_URL
    ├── auth.js        # register/login (bcrypt) + middleware JWT
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
npm run init-db           # tạo 7 bảng trên Neon
npm start                 # chạy tại http://localhost:3000
```

Mở http://localhost:3000 → đăng ký tài khoản → dùng bình thường. Mỗi tài khoản
có dữ liệu riêng, tách biệt hoàn toàn.

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

## API

| Method | Đường dẫn            | Mô tả                          |
|--------|----------------------|--------------------------------|
| POST   | `/api/auth/register` | Đăng ký, trả JWT               |
| POST   | `/api/auth/login`    | Đăng nhập, trả JWT             |
| GET    | `/api/me`            | Thông tin user (cần token)     |
| GET    | `/api/state`         | Lấy toàn bộ state (cần token)  |
| PUT    | `/api/state`         | Lưu toàn bộ state (cần token)  |

Mọi route `/api/state` yêu cầu header `Authorization: Bearer <token>`.

## Tài khoản admin

Hệ thống có vai trò **admin** (cột `users.is_admin`). Admin xem được toàn bộ
người dùng và dữ liệu trọ của họ.

**Tạo admin đầu tiên** (không thể tự phong qua web — phải chạy trên máy):

```bash
cd server
npm run make-admin -- you@example.com        # cấp quyền (đăng ký tài khoản này trước)
npm run make-admin -- you@example.com off     # gỡ quyền
```

Sau khi được phong, **đăng nhập lại** để token mang cờ admin. Khi đó app hiện
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

- Mật khẩu băm bằng bcrypt. JWT ký bằng `JWT_SECRET`, hết hạn sau 30 ngày.
- `.env` chứa DATABASE_URL + secret, đã có trong `.gitignore`.
- Đây là JWT lưu ở `localStorage`; nếu deploy công khai nên đặt sau HTTPS.
