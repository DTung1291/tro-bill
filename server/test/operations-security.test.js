'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-operations-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.COOKIE_SECURE = 'false';
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const app = require('../index');
const { inspectRuntimeEnvironment, resolveAppEnvironment } = require('../environment');
const { enforceHttps, securityHeaders } = require('../security');

function listen(serverApp) {
  return new Promise((resolve, reject) => {
    const server = serverApp.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close(error => (error ? reject(error) : resolve()));
  });
}

test('Vercel Preview được tách thành staging và Production thành production', () => {
  assert.equal(resolveAppEnvironment({ VERCEL_ENV: 'preview' }), 'staging');
  assert.equal(resolveAppEnvironment({ VERCEL_ENV: 'production' }), 'production');
  assert.equal(resolveAppEnvironment({ NODE_ENV: 'test' }), 'test');
});

test('cấu hình production từ chối URL HTTP và database gắn nhãn sai môi trường', () => {
  const report = inspectRuntimeEnvironment({
    APP_ENV: 'production',
    DATABASE_ENVIRONMENT: 'staging',
    DATABASE_URL: 'postgresql://placeholder',
    JWT_SECRET: 'a'.repeat(40),
    APP_URL: 'http://app.example.com',
    EMAIL_PROVIDER: 'brevo',
    BREVO_API_KEY: 'placeholder',
    EMAIL_FROM: 'TrọBill <no-reply@example.com>',
    CRON_SECRET: 'c'.repeat(40),
    PAYMENT_WEBHOOK_SECRET: 'p'.repeat(40)
  });

  assert.equal(report.valid, false);
  assert.deepEqual(report.issues.map(issue => issue.code), [
    'APP_URL_NOT_HTTPS',
    'DATABASE_ENVIRONMENT_MISMATCH'
  ]);
  assert.equal(report.warnings.some(warning => warning.code === 'OPS_ALERT_WEBHOOK_MISSING'), true);
});

test('production bắt buộc secret đủ dài cho cron', () => {
  const report = inspectRuntimeEnvironment({
    APP_ENV: 'production',
    DATABASE_ENVIRONMENT: 'production',
    DATABASE_URL: 'postgresql://placeholder',
    JWT_SECRET: 'a'.repeat(40),
    APP_URL: 'https://app.example.com',
    EMAIL_PROVIDER: 'brevo',
    BREVO_API_KEY: 'placeholder',
    EMAIL_FROM: 'TrọBill <no-reply@example.com>',
    CRON_SECRET: 'ngắn',
    PAYMENT_WEBHOOK_SECRET: 'p'.repeat(40)
  });
  assert.equal(report.issues.some(issue => issue.code === 'CRON_SECRET_MISSING'), true);
});

test('production bắt buộc secret đủ dài để xác minh webhook thanh toán', () => {
  const report = inspectRuntimeEnvironment({
    APP_ENV: 'production',
    DATABASE_ENVIRONMENT: 'production',
    DATABASE_URL: 'postgresql://placeholder',
    JWT_SECRET: 'a'.repeat(40),
    APP_URL: 'https://app.example.com',
    EMAIL_PROVIDER: 'brevo',
    BREVO_API_KEY: 'placeholder',
    EMAIL_FROM: 'TrọBill <no-reply@example.com>',
    CRON_SECRET: 'c'.repeat(40),
    PAYMENT_WEBHOOK_SECRET: 'ngắn'
  });
  assert.equal(
    report.issues.some(issue => issue.code === 'PAYMENT_WEBHOOK_SECRET_MISSING'),
    true
  );
});

test('middleware production chuyển HTTP sang HTTPS bằng APP_URL tin cậy', () => {
  const originalEnvironment = process.env.APP_ENV;
  const originalAppUrl = process.env.APP_URL;
  process.env.APP_ENV = 'production';
  process.env.APP_URL = 'https://app.example.com';

  let redirect = null;
  const req = {
    secure: false,
    originalUrl: '/api/state?period=2026-08',
    get: () => 'http'
  };
  const res = {
    redirect(status, location) { redirect = { status, location }; },
    status() { return res; },
    json() { return res; }
  };
  enforceHttps(req, res, () => assert.fail('HTTP production không được đi tiếp'));

  process.env.APP_ENV = originalEnvironment;
  if (originalAppUrl === undefined) delete process.env.APP_URL;
  else process.env.APP_URL = originalAppUrl;

  assert.deepEqual(redirect, {
    status: 308,
    location: 'https://app.example.com/api/state?period=2026-08'
  });
});

test('HTTPS production có HSTS và các security header', () => {
  const originalEnvironment = process.env.APP_ENV;
  process.env.APP_ENV = 'production';
  const headers = {};
  const req = { secure: true, get: () => 'https' };
  const res = {
    set(name, value) {
      if (typeof name === 'object') Object.assign(headers, name);
      else headers[name] = value;
      return res;
    }
  };
  securityHeaders(req, res, () => {});
  process.env.APP_ENV = originalEnvironment;

  assert.equal(headers['Strict-Transport-Security'], 'max-age=31536000; includeSubDomains');
  assert.equal(headers['X-Content-Type-Options'], 'nosniff');
  assert.equal(headers['X-Frame-Options'], 'DENY');
  assert.equal(headers['Referrer-Policy'], 'no-referrer');
});

test('health check công khai xác minh kết nối database và không cache', async (t) => {
  const originalQuery = db.query;
  db.query = async sql => {
    assert.equal(sql, 'SELECT 1 AS ready');
    return { rows: [{ ready: 1 }] };
  };
  const server = await listen(app);
  t.after(async () => {
    db.query = originalQuery;
    await close(server);
  });
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  const liveResponse = await fetch(`${baseUrl}/api/health/live`);
  assert.equal(liveResponse.status, 200);
  assert.equal(liveResponse.headers.get('cache-control'), 'no-store');
  assert.equal((await liveResponse.json()).status, 'ok');

  const readyResponse = await fetch(`${baseUrl}/api/health/ready`, {
    headers: { 'X-Request-Id': 'operations-test-request' }
  });
  assert.equal(readyResponse.status, 200);
  assert.equal(readyResponse.headers.get('x-request-id'), 'operations-test-request');
  assert.deepEqual((await readyResponse.json()).checks, {
    configuration: 'ok',
    configurationWarnings: [],
    database: 'ok'
  });
});

test('database lỗi trả incidentId nhưng log không làm lộ thông báo lỗi gốc', async (t) => {
  const originalQuery = db.query;
  const originalConsoleError = console.error;
  const logs = [];
  db.query = async () => {
    const error = new Error('password=super-secret-value');
    error.code = 'ECONNREFUSED';
    throw error;
  };
  console.error = value => logs.push(String(value));
  const server = await listen(app);
  t.after(async () => {
    console.error = originalConsoleError;
    db.query = originalQuery;
    await close(server);
  });

  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/health/ready`);
  const body = await response.json();
  assert.equal(response.status, 503);
  assert.match(body.incidentId, /^inc_[0-9a-f-]+$/);
  assert.equal(logs.some(line => line.includes('super-secret-value')), false);
  assert.equal(logs.some(line => line.includes('database_health_check_failed')), true);
});
