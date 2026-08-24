'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-password-reset-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.COOKIE_SECURE = 'false';
process.env.NODE_ENV = 'test';
delete process.env.VERCEL;
delete process.env.RESEND_API_KEY;

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const db = require('../db');
const { forgotPassword, resetPassword } = require('../auth');

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
  const record = { statusCode: 200, body: null, clearedCookie: null, headers: {} };
  const res = {
    status(code) {
      record.statusCode = code;
      return res;
    },
    json(body) {
      record.body = body;
      return res;
    },
    clearCookie(name, options) {
      record.clearedCookie = { name, options };
      return res;
    },
    set(name, value) {
      record.headers[name] = value;
      return res;
    }
  };
  return { res, record };
}

test('quên mật khẩu lưu hash, reset một lần và thu hồi mọi phiên cũ', async (t) => {
  const originalQuery = db.query;
  const originalGetClient = db.getClient;
  const originalInfo = console.info;
  let storedTokenHash = '';
  let tokenAvailable = true;
  let updatedPasswordHash = '';

  db.query = async (sql, params = []) => {
    if (sql.includes('LEFT JOIN password_reset_tokens')) {
      if (params[0] === 'missing@example.com') return { rows: [] };
      return {
        rows: [{
          id: 12,
          email: 'owner@example.com',
          token_created_at: null
        }]
      };
    }
    if (sql.includes('INSERT INTO password_reset_tokens')) {
      storedTokenHash = params[1];
      assert.equal(params[2], 30);
      return { rows: [] };
    }
    throw new Error(`Truy vấn db.query không mong đợi: ${sql}`);
  };

  const resetClient = {
    async query(sql, params = []) {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      if (sql.includes('UPDATE users u')) {
        assert.match(sql, /token_version=u\.token_version \+ 1/);
        assert.equal(params[0], storedTokenHash);
        updatedPasswordHash = params[1];
        return { rows: tokenAvailable ? [{ id: 12 }] : [] };
      }
      if (sql.includes('DELETE FROM password_reset_tokens')) {
        tokenAvailable = false;
        return { rows: [] };
      }
      throw new Error(`Truy vấn reset không mong đợi: ${sql}`);
    },
    release() {}
  };
  db.getClient = async () => resetClient;
  console.info = () => {};

  t.after(() => {
    db.query = originalQuery;
    db.getClient = originalGetClient;
    console.info = originalInfo;
  });

  const missing = responseRecorder();
  await forgotPassword(request({ email: 'missing@example.com' }), missing.res);
  assert.deepEqual(missing.record.body, {
    ok: true,
    message: 'Nếu email đã đăng ký, liên kết đặt lại mật khẩu sẽ được gửi.'
  });

  const forgot = responseRecorder();
  await forgotPassword(request({ email: 'OWNER@example.com' }), forgot.res);
  assert.equal(forgot.record.statusCode, 200);
  assert.match(forgot.record.body.resetUrl, /^http:\/\/localhost:3000\/\?reset=/);

  const token = new URL(forgot.record.body.resetUrl).searchParams.get('reset');
  assert.match(token, /^[a-f0-9]{64}$/);
  assert.notEqual(storedTokenHash, token, 'database không lưu token gốc');
  assert.equal(storedTokenHash, crypto.createHash('sha256').update(token).digest('hex'));

  const reset = responseRecorder();
  await resetPassword(request({ token, password: 'matkhaumoi123' }), reset.res);
  assert.equal(reset.record.statusCode, 200);
  assert.deepEqual(reset.record.body, { ok: true });
  assert.equal(await bcrypt.compare('matkhaumoi123', updatedPasswordHash), true);
  assert.equal(reset.record.clearedCookie.name, 'trobill_session');
  assert.equal(reset.record.clearedCookie.options.httpOnly, true);

  const reused = responseRecorder();
  await resetPassword(request({ token, password: 'matkhaumoi456' }), reused.res);
  assert.equal(reused.record.statusCode, 400);
  assert.deepEqual(reused.record.body, {
    error: 'Liên kết đặt lại mật khẩu không hợp lệ hoặc đã hết hạn'
  });
});
