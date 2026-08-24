'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const { errorDetails, reportOperationalError, writeLog } = require('./observability');

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
  void reportOperationalError(err, {
    event: 'database_pool_error',
    message: 'PostgreSQL connection pool gặp sự cố'
  });
});

async function query(text, params) {
  try {
    return await pool.query(text, params);
  } catch (error) {
    error.isDatabaseFailure = true;
    writeLog('error', 'database_query_failed', {
      ...errorDetails(error)
    });
    throw error;
  }
}

async function getClient() {
  try {
    return await pool.connect();
  } catch (error) {
    error.isDatabaseFailure = true;
    writeLog('error', 'database_connection_failed', {
      ...errorDetails(error)
    });
    throw error;
  }
}

module.exports = {
  query,
  getClient,
  pool
};
