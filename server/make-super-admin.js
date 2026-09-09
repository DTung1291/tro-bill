'use strict';

// ============================================================
//  Cấp quyền Super Admin cho một user — chạy trên máy, KHÔNG qua web.
//  Dùng:  npm run make-super-admin -- you@example.com
//         npm run make-super-admin -- you@example.com off   (gỡ quyền)
//  Cột users.is_admin được giữ như tên legacy để tương thích database hiện tại.
// ============================================================
require('dotenv').config();
const { pool } = require('./db');

async function main() {
  const email = (process.argv[2] || '').trim().toLowerCase();
  const flag = (process.argv[3] || 'on').toLowerCase();
  const makeSuperAdmin = flag !== 'off' && flag !== 'false' && flag !== '0';

  if (!email) {
    console.error('Thiếu email. Dùng: npm run make-super-admin -- you@example.com [off]');
    process.exit(1);
  }

  const result = await pool.query(
    'UPDATE users SET is_admin=$1 WHERE email=$2 RETURNING id, email, is_admin',
    [makeSuperAdmin, email]
  );
  if (result.rowCount === 0) {
    console.error(`Không tìm thấy user: ${email} (hãy đăng ký tài khoản này trước)`);
    process.exit(1);
  }
  const user = result.rows[0];
  console.log(`✅ ${user.email} — Super Admin = ${user.is_admin}`);
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
