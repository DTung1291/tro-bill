'use strict';

require('dotenv').config();
const { Pool } = require('pg');

if (!process.env.DATABASE_URL) {
  console.error('❌ Thiếu DATABASE_URL trong .env — xem .env.example');
  process.exit(1);
}

// Neon yêu cầu SSL. connectionString đã kèm ?sslmode=require,
// nhưng bật ssl ở đây cho chắc với mọi biến thể chuỗi kết nối.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: 10,
  idleTimeoutMillis: 30000
});

pool.on('error', (err) => {
  console.error('Lỗi pool Postgres bất ngờ:', err);
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  getClient: () => pool.connect(),
  pool
};
