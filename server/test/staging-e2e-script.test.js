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

test('runner dừng trước đăng nhập và nêu migration staging còn thiếu', async () => {
  let calls = 0;
  const fakeFetch = async () => {
    calls += 1;
    return {
      status: 503,
      headers: new Headers(),
      async json() {
        return {
          environment: 'staging',
          checks: {
            database: 'ok',
            schema: 'migration-required',
            missingMigrations: ['20260907_electronic_invoice_preflight.sql']
          }
        };
      }
    };
  };
  await assert.rejects(run({
    STAGING_BASE_URL: 'https://preview.example.com',
    STAGING_E2E_EMAIL: 'e2e@example.com',
    STAGING_E2E_PASSWORD: 'test-only-password',
    STAGING_E2E_EMAIL_B: 'e2e-b@example.com',
    STAGING_E2E_PASSWORD_B: 'test-only-password-b',
    STAGING_E2E_CONFIRMATION: CONFIRMATION
  }, fakeFetch), /20260907_electronic_invoice_preflight\.sql/);
  assert.equal(calls, 1);
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
  assert.match(workflow, /secrets\.STAGING_E2E_EMAIL_B/);
  assert.match(workflow, /secrets\.STAGING_E2E_PASSWORD_B/);
  assert.match(guide, /không thực hiện giao dịch tiền thật/);
});

test('runner xác minh hai tài khoản, chặn tab cũ và chỉ cleanup marker vừa tạo', async () => {
  const accountContexts = {
    'e2e@example.com': 'a'.repeat(64),
    'e2e-b@example.com': 'b'.repeat(64)
  };
  const cookies = {
    'e2e@example.com': 'trobill_session=test-jwt-a',
    'e2e-b@example.com': 'trobill_session=test-jwt-b'
  };
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
      const loginEmail = body.email;
      return response(200, {
        email: loginEmail,
        accountContext: accountContexts[loginEmail]
      }, `${cookies[loginEmail]}; HttpOnly; Path=/`);
    }
    if (parsed.pathname === '/api/me') {
      const meEmail = options.headers.Cookie === cookies['e2e@example.com']
        ? 'e2e@example.com'
        : 'e2e-b@example.com';
      return response(200, { email: meEmail, accountContext: accountContexts[meEmail] });
    }
    if (parsed.pathname === '/api/properties' && options.method === 'POST') {
      marker = body.name;
      markerExists = true;
      return response(201, { property: { id: 99, name: marker, isDefault: false } });
    }
    if (parsed.pathname === '/api/properties' && options.method === 'GET') {
      if (options.headers.Cookie === cookies['e2e-b@example.com']
          && options.headers['X-Trobill-Account-Context'] === accountContexts['e2e@example.com']) {
        return response(409, { code: 'SESSION_ACCOUNT_CHANGED' });
      }
      const isPrimary = options.headers.Cookie === cookies['e2e@example.com'];
      return response(200, {
        properties: [
          { id: isPrimary ? 1 : 2, name: 'Khu thật không được xóa', isDefault: false },
          ...(isPrimary && markerExists ? [{ id: 99, name: marker, isDefault: false }] : [])
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
    STAGING_E2E_EMAIL_B: 'e2e-b@example.com',
    STAGING_E2E_PASSWORD_B: 'test-only-password-b',
    STAGING_E2E_CONFIRMATION: CONFIRMATION,
    VERCEL_AUTOMATION_BYPASS_SECRET: 'test-bypass-secret'
  }, fakeFetch);

  assert.equal(result.ok, true);
  assert.equal(result.environment, 'staging');
  assert.ok(result.checks.includes('two-account-isolation'));
  assert.ok(result.checks.includes('stale-tab-block'));
  assert.equal(markerExists, false);
  assert.match(marker, /^E2E-\d{14}-[0-9a-f-]{36}$/);
  assert.deepEqual(
    calls.filter((call) => call.method === 'DELETE').map((call) => call.path),
    ['/api/properties/99']
  );
  const authenticatedCall = calls.find((call) => call.path === '/api/me');
  assert.equal(authenticatedCall.headers.Cookie, cookies['e2e@example.com']);
  assert.equal(authenticatedCall.headers['X-Trobill-Account-Context'], undefined);
  const healthCall = calls.find((call) => call.path === '/api/health/ready');
  assert.equal(healthCall.headers['x-vercel-protection-bypass'], 'test-bypass-secret');
  assert.equal(healthCall.headers['x-vercel-set-bypass-cookie'], undefined);
});
