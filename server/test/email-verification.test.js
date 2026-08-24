'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-email-verification-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.COOKIE_SECURE = 'false';
process.env.NODE_ENV = 'test';
delete process.env.VERCEL;
delete process.env.RESEND_API_KEY;
delete process.env.BREVO_API_KEY;
delete process.env.EMAIL_PROVIDER;

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const db = require('../db');
const { register, verifyEmail } = require('../auth');

function request(body) {
  return {
    body,
    protocol: 'http',
    headers: {},
    get(name) {
      if (name.toLowerCase() === 'host') return 'localhost:3000';
      return '';
    }
  };
}

function responseRecorder() {
  const record = { statusCode: 200, body: null, cookie: null, headers: {} };
  const res = {
    status(code) {
      record.statusCode = code;
      return res;
    },
    json(body) {
      record.body = body;
      return res;
    },
    cookie(name, value, options) {
      record.cookie = { name, value, options };
      return res;
    },
    set(name, value) {
      record.headers[name] = value;
      return res;
    }
  };
  return { res, record };
}

test('đăng ký bắt buộc đồng ý chính sách bảo mật và điều khoản', async () => {
  const response = responseRecorder();
  await register(request({ email: 'new@example.com', password: 'matkhau123' }), response.res);
  assert.equal(response.record.statusCode, 400);
  assert.equal(response.record.body.code, 'POLICY_ACCEPTANCE_REQUIRED');
});

test('đăng ký lưu hash token, không đăng nhập trước khi xác minh và link local dùng được', async (t) => {
  const originalQuery = db.query;
  const originalGetClient = db.getClient;
  const originalInfo = console.info;
  let storedTokenHash = '';

  db.query = async (sql) => {
    if (sql.includes('FROM auth_rate_limits')) return { rows: [] };
    if (sql.includes('INSERT INTO auth_rate_limits')) {
      return { rows: [{ attempts: 1, retry_after: 3600 }] };
    }
    if (sql.includes('SELECT 1 FROM users')) return { rowCount: 0, rows: [] };
    throw new Error(`Truy vấn db.query không mong đợi: ${sql}`);
  };

  const registrationClient = {
    async query(sql, params = []) {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      if (sql.includes('INSERT INTO users')) {
        return { rows: [{ id: 9, email: 'new@example.com' }] };
      }
      if (sql.includes('INSERT INTO settings')) return { rows: [] };
      if (sql.includes('INSERT INTO email_verification_tokens')) {
        storedTokenHash = params[1];
        return { rows: [] };
      }
      throw new Error(`Truy vấn đăng ký không mong đợi: ${sql}`);
    },
    release() {}
  };
  db.getClient = async () => registrationClient;
  console.info = () => {};

  t.after(() => {
    db.query = originalQuery;
    db.getClient = originalGetClient;
    console.info = originalInfo;
  });

  const registration = responseRecorder();
  await register(request({
    email: 'NEW@example.com',
    password: 'matkhau123',
    acceptPrivacy: true,
    acceptTerms: true
  }), registration.res);

  assert.equal(registration.record.statusCode, 201);
  assert.equal(registration.record.body.email, 'new@example.com');
  assert.equal(registration.record.body.verificationRequired, true);
  assert.equal(registration.record.body.emailSent, false);
  assert.equal(registration.record.cookie, null, 'đăng ký chưa tạo cookie phiên');
  assert.match(registration.record.body.verificationUrl, /^http:\/\/localhost:3000\/\?verify=/);

  const token = new URL(registration.record.body.verificationUrl).searchParams.get('verify');
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.notEqual(storedTokenHash, token, 'database không lưu token gốc');
  assert.equal(
    storedTokenHash,
    crypto.createHash('sha256').update(token).digest('hex'),
    'database lưu đúng SHA-256 của token'
  );

  const verificationClient = {
    async query(sql, params = []) {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      if (sql.includes('UPDATE users u')) {
        assert.equal(params[0], storedTokenHash);
        return { rows: [{ id: 9, email: 'new@example.com', is_admin: false, token_version: 0 }] };
      }
      if (sql.includes('DELETE FROM email_verification_tokens')) return { rows: [] };
      throw new Error(`Truy vấn xác minh không mong đợi: ${sql}`);
    },
    release() {}
  };
  db.getClient = async () => verificationClient;

  const verification = responseRecorder();
  await verifyEmail(request({ token }), verification.res);

  assert.equal(verification.record.statusCode, 200);
  assert.deepEqual(verification.record.body, {
    email: 'new@example.com',
    isAdmin: false,
    verified: true
  });
  assert.equal(verification.record.cookie.name, 'trobill_session');
  assert.equal(verification.record.cookie.options.httpOnly, true);
  assert.equal(verification.record.cookie.options.sameSite, 'lax');
});
