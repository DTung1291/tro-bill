'use strict';

require('dotenv').config();
const { Pool } = require('pg');
const { errorDetails, reportOperationalError, writeLog } = require('./observability');

if (!process.env.DATABASE_URL) {
  console.error('❌ Thiếu DATABASE_URL trong .env — xem .env.example');
  process.exit(1);
}

// Giữ nguyên hành vi xác minh chứng thư đầy đủ khi pg đổi semantics của
// sslmode=require ở major version kế tiếp. Không log chuỗi kết nối vì có secret.
function normalizeDatabaseUrl(connectionString) {
  return String(connectionString).replace(
    /([?&])sslmode=(prefer|require|verify-ca)(?=(&|#|$))/gi,
    '$1sslmode=verify-full'
  );
}

const pool = new Pool({
  connectionString: normalizeDatabaseUrl(process.env.DATABASE_URL),
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
  normalizeDatabaseUrl,
  pool
};
