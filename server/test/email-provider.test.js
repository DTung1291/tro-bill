'use strict';

process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  inspectEmailConfiguration,
  resolveEmailProvider
} = require('../email-config');
const { sendVerificationEmail } = require('../email');

function restoreEnvironment(snapshot) {
  for (const [key, value] of Object.entries(snapshot)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

test('chọn Brevo Free khi có BREVO_API_KEY và vẫn hỗ trợ Resend về sau', () => {
  assert.equal(resolveEmailProvider({ BREVO_API_KEY: 'placeholder' }), 'brevo');
  assert.equal(resolveEmailProvider({ EMAIL_PROVIDER: 'resend', BREVO_API_KEY: 'placeholder' }), 'resend');

  const configuration = inspectEmailConfiguration({
    EMAIL_PROVIDER: 'brevo',
    BREVO_API_KEY: 'placeholder',
    EMAIL_FROM: 'TrọBill <owner@example.com>',
    APP_URL: 'https://tro-bill.vercel.app'
  });
  assert.deepEqual(configuration, {
    provider: 'brevo',
    keyName: 'BREVO_API_KEY',
    missing: [],
    valid: true
  });
});

test('Brevo nhận đúng sender, người nhận và link xác minh mà không lộ API key trong body', async (t) => {
  const keys = ['APP_ENV', 'NODE_ENV', 'VERCEL', 'EMAIL_PROVIDER', 'BREVO_API_KEY', 'EMAIL_FROM', 'APP_URL'];
  const snapshot = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    restoreEnvironment(snapshot);
  });

  process.env.APP_ENV = 'production';
  process.env.NODE_ENV = 'production';
  process.env.VERCEL = '1';
  process.env.EMAIL_PROVIDER = 'brevo';
  process.env.BREVO_API_KEY = 'brevo-test-key';
  process.env.EMAIL_FROM = 'TrọBill <owner@example.com>';
  process.env.APP_URL = 'https://tro-bill.vercel.app';

  let request;
  global.fetch = async (url, options) => {
    request = { url, options };
    return {
      ok: true,
      status: 201,
      async json() { return { messageId: 'brevo-message-1' }; }
    };
  };

  const delivery = await sendVerificationEmail({
    email: 'tenant@example.com',
    token: 'verify-token',
    userId: 42,
    req: {}
  });

  assert.equal(request.url, 'https://api.brevo.com/v3/smtp/email');
  assert.equal(request.options.method, 'POST');
  assert.equal(request.options.headers['api-key'], 'brevo-test-key');

  const body = JSON.parse(request.options.body);
  assert.deepEqual(body.sender, { email: 'owner@example.com', name: 'TrọBill' });
  assert.deepEqual(body.to, [{ email: 'tenant@example.com' }]);
  assert.match(body.htmlContent, /https:\/\/tro-bill\.vercel\.app\/\?verify=verify-token/);
  assert.equal(request.options.body.includes('brevo-test-key'), false);
  assert.deepEqual(delivery, {
    delivered: true,
    emailId: 'brevo-message-1',
    verificationUrl: 'https://tro-bill.vercel.app/?verify=verify-token'
  });
});

test('lỗi Brevo được chuẩn hóa thành EMAIL_SEND_FAILED', async (t) => {
  const keys = ['NODE_ENV', 'VERCEL', 'EMAIL_PROVIDER', 'BREVO_API_KEY', 'EMAIL_FROM', 'APP_URL'];
  const snapshot = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  const originalFetch = global.fetch;
  t.after(() => {
    global.fetch = originalFetch;
    restoreEnvironment(snapshot);
  });

  process.env.NODE_ENV = 'production';
  process.env.VERCEL = '1';
  process.env.EMAIL_PROVIDER = 'brevo';
  process.env.BREVO_API_KEY = 'brevo-test-key';
  process.env.EMAIL_FROM = 'TrọBill <owner@example.com>';
  process.env.APP_URL = 'https://tro-bill.vercel.app';
  global.fetch = async () => ({
    ok: false,
    status: 401,
    async json() { return { message: 'key not found' }; }
  });

  await assert.rejects(
    sendVerificationEmail({ email: 'tenant@example.com', token: 'token', userId: 42, req: {} }),
    error => error.code === 'EMAIL_SEND_FAILED' && !error.message.includes('brevo-test-key')
  );
});
