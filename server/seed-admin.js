'use strict';

// ============================================================
//  Seed admin mặc định từ biến môi trường.
//  Gọi lúc server khởi động. Không hard-code mật khẩu vào code.
//    ADMIN_EMAIL     — email admin mặc định
//    ADMIN_PASSWORD  — mật khẩu (chỉ dùng khi TẠO MỚI tài khoản)
//  Hành vi:
//    - Chưa có user  -> tạo mới + phong admin (cần ADMIN_PASSWORD ≥ 6 ký tự)
//    - Đã có user    -> chỉ đảm bảo is_admin = true (không đổi mật khẩu)
// ============================================================
const bcrypt = require('bcryptjs');
const db = require('./db');

async function seedAdmin() {
  const email = String(process.env.ADMIN_EMAIL || '').trim().toLowerCase();
  const password = String(process.env.ADMIN_PASSWORD || '');
  if (!email) return; // không cấu hình -> bỏ qua

  const existing = await db.query('SELECT id, is_admin FROM users WHERE email=$1', [email]);

  if (existing.rowCount > 0) {
    if (!existing.rows[0].is_admin) {
      await db.query('UPDATE users SET is_admin=true WHERE id=$1', [existing.rows[0].id]);
      console.log(`🛡️  Đã cấp quyền admin cho tài khoản sẵn có: ${email}`);
    } else {
      console.log(`🛡️  Admin mặc định đã sẵn sàng: ${email}`);
    }
    return;
  }

  if (password.length < 6) {
    console.warn(`⚠️  ADMIN_EMAIL=${email} chưa tồn tại nhưng ADMIN_PASSWORD trống/ngắn — bỏ qua seed admin.`);
    return;
  }

  const hash = await bcrypt.hash(password, 10);
  const { rows } = await db.query(
    'INSERT INTO users (email, password_hash, is_admin) VALUES ($1,$2,true) RETURNING id',
    [email, hash]
  );
  await db.query('INSERT INTO settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [rows[0].id]);
  console.log(`🛡️  Đã tạo admin mặc định: ${email}`);
}

module.exports = { seedAdmin };
