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

function databaseConnectionString(connectionString, options = {}) {
  const normalized = normalizeDatabaseUrl(connectionString);
  const roleOverride = String(options.roleOverride || '').trim();
  if (!roleOverride) return normalized;
  if (!/^[a-z_][a-z0-9_]{0,62}$/.test(roleOverride)) {
    throw new Error('DATABASE_ROLE_OVERRIDE không hợp lệ');
  }
  const parsed = new URL(normalized);
  parsed.username = roleOverride;
  return parsed.toString();
}

const pool = new Pool({
  connectionString: databaseConnectionString(process.env.DATABASE_URL, {
    roleOverride: process.env.DATABASE_ROLE_OVERRIDE
  }),
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
  databaseConnectionString,
  query,
  getClient,
  normalizeDatabaseUrl,
  pool
};
