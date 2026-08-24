'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-rate-limit-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.COOKIE_SECURE = 'false';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const app = require('../index');

function listen(serverApp) {
  return new Promise((resolve, reject) => {
    const server = serverApp.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('giới hạn đăng nhập theo IP/tài khoản và đăng ký theo tài khoản', async (t) => {
  const originalQuery = db.query;
  let counters = new Map();

  db.query = async (sql, params = []) => {
    if (sql.includes('FROM auth_rate_limits')) {
      const attempts = counters.get(params[0]) || 0;
      return attempts >= Number(params[2])
        ? { rows: [{ attempts, retry_after: 600 }] }
        : { rows: [] };
    }
    if (sql.includes('INSERT INTO auth_rate_limits')) {
      const attempts = (counters.get(params[0]) || 0) + 1;
      counters.set(params[0], attempts);
      return { rows: [{ attempts, retry_after: Number(params[3]) }] };
    }
    if (sql.includes('SELECT id, email, password_hash, is_admin, email_verified_at, token_version')) {
      return { rows: [] };
    }
    if (sql.includes('SELECT 1 FROM users')) return { rowCount: 1, rows: [{ exists: 1 }] };
    throw new Error(`Truy vấn rate-limit không mong đợi: ${sql}`);
  };

  const server = await listen(app);
  t.after(async () => {
    db.query = originalQuery;
    await close(server);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function post(path, body) {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: baseUrl },
      body: JSON.stringify(body)
    });
  }

  for (let index = 0; index < 20; index += 1) {
    const response = await post('/api/auth/login', {
      email: `unknown-${index}@example.com`,
      password: 'sai-mat-khau'
    });
    assert.equal(response.status, 401);
  }
  const ipBlocked = await post('/api/auth/login', {
    email: 'another@example.com',
    password: 'sai-mat-khau'
  });
  assert.equal(ipBlocked.status, 429);
  assert.equal(ipBlocked.headers.get('retry-after'), '600');
  assert.equal((await ipBlocked.json()).code, 'RATE_LIMITED');

  counters = new Map();
  for (let index = 0; index < 8; index += 1) {
    const response = await post('/api/auth/login', {
      email: 'target@example.com',
      password: 'sai-mat-khau'
    });
    assert.equal(response.status, 401);
  }
  const accountBlocked = await post('/api/auth/login', {
    email: 'target@example.com',
    password: 'sai-mat-khau'
  });
  assert.equal(accountBlocked.status, 429);

  counters = new Map();
  for (let index = 0; index < 5; index += 1) {
    const response = await post('/api/auth/register', {
      email: 'existing@example.com',
      password: 'matkhau123'
    });
    assert.equal(response.status, 409);
  }
  const registrationBlocked = await post('/api/auth/register', {
    email: 'existing@example.com',
    password: 'matkhau123'
  });
  assert.equal(registrationBlocked.status, 429);
});
