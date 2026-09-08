'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-staging-e2e-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  CONFIRMATION,
  extractSessionCookie,
  run,
  validateDedicatedAccount,
  validateTarget
} = require('../../scripts/staging-e2e');

const root = path.join(__dirname, '..', '..');

test('runner staging từ chối production và HTTP ngoài localhost', () => {
  assert.throws(() => validateTarget('https://tro-bill.vercel.app'), /production/);
  assert.throws(() => validateTarget('http://preview.example.com'), /HTTPS/);
  assert.throws(() => validateTarget('https://preview.example.com/path'), /không kèm path/);
  assert.equal(validateTarget('https://preview.example.com/'), 'https://preview.example.com');
  assert.equal(
    validateTarget('http://127.0.0.1:3000', { ALLOW_LOCAL_E2E: 'true' }),
    'http://127.0.0.1:3000'
  );
});

test('runner yêu cầu xác nhận tài khoản staging chuyên dụng', () => {
  assert.throws(
    () => validateDedicatedAccount('owner@example.com', {}),
    /tài khoản staging chuyên dụng/
  );
  assert.equal(
    validateDedicatedAccount(' E2E@example.com ', { STAGING_E2E_CONFIRMATION: CONFIRMATION }),
    'e2e@example.com'
  );
});

test('runner chỉ lấy cookie phiên TrọBill từ response đăng nhập', () => {
  const headers = new Headers({
    'set-cookie': 'vercel_bypass=abc; Path=/, trobill_session=jwt-value; HttpOnly; Path=/'
  });
  assert.equal(extractSessionCookie(headers), 'trobill_session=jwt-value');
  assert.throws(() => extractSessionCookie(new Headers()), /không trả cookie/);
});

test('workflow staging chỉ chạy thủ công và truyền credential qua secrets', () => {
  const workflow = fs.readFileSync(path.join(root, '.github/workflows/staging-e2e.yml'), 'utf8');
  const guide = fs.readFileSync(path.join(root, 'docs/STAGING_E2E.md'), 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.doesNotMatch(workflow, /\n\s+push:/);
  assert.match(workflow, /environment: Preview/);
  assert.match(workflow, /secrets\.STAGING_E2E_EMAIL/);
  assert.match(workflow, /secrets\.STAGING_E2E_PASSWORD/);
  assert.match(guide, /không thực hiện giao dịch tiền thật/);
});

test('runner đi đủ health, login, context, ghi/đọc và chỉ cleanup marker vừa tạo', async () => {
  const accountContext = 'a'.repeat(64);
  const calls = [];
  let marker = '';
  let markerExists = false;
  const response = (status, body, cookie = '') => ({
    status,
    headers: new Headers(cookie ? { 'set-cookie': cookie } : {}),
    async json() { return body; }
  });
  const fakeFetch = async (url, options) => {
    const parsed = new URL(url);
    const body = options.body ? JSON.parse(options.body) : null;
    calls.push({ path: parsed.pathname, method: options.method, body, headers: options.headers });
    if (parsed.pathname === '/api/health/ready') {
      return response(200, {
        environment: 'staging',
        revision: 'test-revision',
        checks: { database: 'ok', schema: 'ok' }
      });
    }
    if (parsed.pathname === '/api/auth/login') {
      return response(200, {
        email: 'e2e@example.com',
        accountContext
      }, 'trobill_session=test-jwt; HttpOnly; Path=/');
    }
    if (parsed.pathname === '/api/me') {
      return response(200, { email: 'e2e@example.com', accountContext });
    }
    if (parsed.pathname === '/api/properties' && options.method === 'POST') {
      marker = body.name;
      markerExists = true;
      return response(201, { property: { id: 99, name: marker, isDefault: false } });
    }
    if (parsed.pathname === '/api/properties' && options.method === 'GET') {
      return response(200, {
        properties: [
          { id: 1, name: 'Khu thật không được xóa', isDefault: false },
          ...(markerExists ? [{ id: 99, name: marker, isDefault: false }] : [])
        ]
      });
    }
    if (parsed.pathname === '/api/properties/99' && options.method === 'DELETE') {
      markerExists = false;
      return response(200, { ok: true });
    }
    return response(500, { code: 'UNEXPECTED_TEST_REQUEST' });
  };

  const result = await run({
    STAGING_BASE_URL: 'https://preview.example.com',
    STAGING_E2E_EMAIL: 'e2e@example.com',
    STAGING_E2E_PASSWORD: 'test-only-password',
    STAGING_E2E_CONFIRMATION: CONFIRMATION
  }, fakeFetch);

  assert.equal(result.ok, true);
  assert.equal(result.environment, 'staging');
  assert.equal(markerExists, false);
  assert.match(marker, /^E2E-\d{14}-[0-9a-f-]{36}$/);
  assert.deepEqual(
    calls.filter((call) => call.method === 'DELETE').map((call) => call.path),
    ['/api/properties/99']
  );
  const authenticatedCall = calls.find((call) => call.path === '/api/me');
  assert.equal(authenticatedCall.headers.Cookie, 'trobill_session=test-jwt');
  assert.equal(authenticatedCall.headers['X-Trobill-Account-Context'], accountContext);
});
