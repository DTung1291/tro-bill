'use strict';

// ============================================================
//  Phong quyền admin cho một user — chạy trên máy, KHÔNG qua web.
//  Dùng:  npm run make-admin -- you@example.com
//         npm run make-admin -- you@example.com off   (gỡ quyền)
// ============================================================
require('dotenv').config();
const { pool } = require('./db');

async function main() {
  const email = (process.argv[2] || '').trim().toLowerCase();
  const flag = (process.argv[3] || 'on').toLowerCase();
  const makeAdmin = flag !== 'off' && flag !== 'false' && flag !== '0';

  if (!email) {
    console.error('Thiếu email. Dùng: npm run make-admin -- you@example.com [off]');
    process.exit(1);
  }

  const r = await pool.query(
    'UPDATE users SET is_admin=$1 WHERE email=$2 RETURNING id, email, is_admin',
    [makeAdmin, email]
  );
  if (r.rowCount === 0) {
    console.error(`Không tìm thấy user: ${email} (hãy đăng ký tài khoản này trước)`);
    process.exit(1);
  }
  const u = r.rows[0];
  console.log(`✅ ${u.email} — is_admin = ${u.is_admin}`);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
