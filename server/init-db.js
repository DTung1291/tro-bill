'use strict';

// Chạy schema.sql lên Neon: npm run init-db
const fs = require('fs');
const path = require('path');
const db = require('./db');

async function main() {
  const sql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
  console.log('⏳ Đang tạo bảng trên Neon...');
  await db.query(sql);
  const { rows } = await db.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema='public' ORDER BY table_name`
  );
  console.log('✅ Xong. Các bảng hiện có:');
  rows.forEach((r) => console.log('   -', r.table_name));
  await db.pool.end();
}

main().catch((err) => {
  console.error('❌ Lỗi khi tạo bảng:', err.message);
  process.exit(1);
});
