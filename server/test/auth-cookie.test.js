'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-auth-cookie-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.COOKIE_SECURE = 'false';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
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

test('đăng nhập lưu JWT trong cookie HttpOnly và không trả token cho JavaScript', async (t) => {
  const originalQuery = db.query;
  const passwordHash = await bcrypt.hash('matkhau123', 4);
  let tokenVersion = 0;

  db.query = async (sql) => {
    if (sql.includes('SELECT id, email, password_hash, is_admin, email_verified_at, token_version')) {
      return {
        rows: [{
          id: 7,
          email: 'owner@example.com',
          password_hash: passwordHash,
          is_admin: true,
          email_verified_at: new Date('2026-01-01T00:00:00Z'),
          token_version: tokenVersion
        }]
      };
    }
    if (sql.includes('SELECT email, is_admin, token_version FROM users')) {
      return { rows: [{ email: 'owner@example.com', is_admin: true, token_version: tokenVersion }] };
    }
    if (sql.includes('SELECT is_admin FROM users')) {
      return { rows: [{ is_admin: true }] };
    }
    throw new Error(`Truy vấn không mong đợi trong test auth: ${sql}`);
  };

  const server = await listen(app);
  t.after(async () => {
    db.query = originalQuery;
    await close(server);
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const loginResponse = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ email: 'OWNER@example.com', password: 'matkhau123' })
  });

  assert.equal(loginResponse.status, 200);
  const loginBody = await loginResponse.json();
  assert.deepEqual(loginBody, { email: 'owner@example.com', isAdmin: true });
  assert.equal(Object.hasOwn(loginBody, 'token'), false);

  const setCookie = loginResponse.headers.get('set-cookie');
  assert.match(setCookie, /^trobill_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);
  assert.match(setCookie, /Path=\//i);
  assert.match(setCookie, /Max-Age=2592000/i);

  const cookie = setCookie.split(';')[0];
  const meResponse = await fetch(`${baseUrl}/api/me`, {
    headers: { Cookie: cookie }
  });
  assert.equal(meResponse.status, 200);
  assert.deepEqual(await meResponse.json(), { email: 'owner@example.com', isAdmin: true });

  tokenVersion = 1;
  const revokedResponse = await fetch(`${baseUrl}/api/me`, {
    headers: { Cookie: cookie }
  });
  assert.equal(revokedResponse.status, 401, 'phiên cũ mất hiệu lực khi token_version thay đổi');
  assert.match(revokedResponse.headers.get('set-cookie'), /^trobill_session=;/);

  const bearerOnlyResponse = await fetch(`${baseUrl}/api/me`, {
    headers: { Authorization: `Bearer ${cookie.split('=')[1]}` }
  });
  assert.equal(bearerOnlyResponse.status, 401, 'Bearer token cũ không còn được chấp nhận');

  const logoutResponse = await fetch(`${baseUrl}/api/auth/logout`, {
    method: 'POST',
    headers: { Cookie: cookie, Origin: baseUrl }
  });
  assert.equal(logoutResponse.status, 200);
  assert.deepEqual(await logoutResponse.json(), { ok: true });
  assert.match(logoutResponse.headers.get('set-cookie'), /^trobill_session=;/);

  const clearedCookieResponse = await fetch(`${baseUrl}/api/me`, {
    headers: { Cookie: 'trobill_session=' }
  });
  assert.equal(clearedCookieResponse.status, 401);
});

test('API từ chối request ghi dữ liệu có nguồn cross-site', async (t) => {
  const server = await listen(app);
  t.after(() => close(server));

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Origin: 'https://evil.example',
      'Sec-Fetch-Site': 'cross-site'
    },
    body: JSON.stringify({ email: 'owner@example.com', password: 'matkhau123' })
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'Nguồn yêu cầu không hợp lệ' });
});

test('tài khoản chưa xác minh không được đăng nhập dù mật khẩu đúng', async (t) => {
  const originalQuery = db.query;
  const passwordHash = await bcrypt.hash('matkhau123', 4);
  db.query = async (sql) => {
    if (sql.includes('SELECT id, email, password_hash, is_admin, email_verified_at, token_version')) {
      return {
        rows: [{
          id: 8,
          email: 'pending@example.com',
          password_hash: passwordHash,
          is_admin: false,
          email_verified_at: null,
          token_version: 0
        }]
      };
    }
    throw new Error(`Truy vấn không mong đợi trong test email chưa xác minh: ${sql}`);
  };

  const server = await listen(app);
  t.after(async () => {
    db.query = originalQuery;
    await close(server);
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${baseUrl}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: baseUrl },
    body: JSON.stringify({ email: 'pending@example.com', password: 'matkhau123' })
  });

  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), {
    error: 'Email chưa được xác minh. Vui lòng kiểm tra hộp thư hoặc gửi lại email.',
    code: 'EMAIL_NOT_VERIFIED'
  });
  assert.equal(response.headers.get('set-cookie'), null);
});
