'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-trial-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const { startTrial, trialRequest } = require('../subscription');

function responseRecorder() {
  const record = { statusCode: 200, body: null };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; }
  };
  return { record, res };
}

test('schema cấu hình trial 14–30 ngày, đánh dấu dùng một lần và lưu audit', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  assert.match(schema, /trial_days\s+INTEGER NOT NULL DEFAULT 0/);
  assert.match(schema, /trial_days = 0 OR trial_days BETWEEN 14 AND 30/);
  assert.match(schema, /trial_used_at\s+TIMESTAMPTZ/);
  assert.match(schema, /status <> 'trialing' OR \(ends_at IS NOT NULL AND trial_used_at IS NOT NULL\)/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS subscription_change_logs/);
  assert.match(schema, /subscription_change_reason_length/);
});

test('request trial bắt buộc gói, lý do và thời hạn hợp lệ', () => {
  assert.throws(
    () => trialRequest({ params: { id: '7' }, body: { planCode: 'pro', reason: 'ngắn' } }),
    (error) => error.code === 'INVALID_REASON'
  );
  assert.throws(
    () => trialRequest({
      params: { id: '7' },
      body: { planCode: 'pro', reason: 'Hỗ trợ khách hàng mới', days: 31 }
    }),
    (error) => error.code === 'INVALID_TRIAL_DAYS'
  );
});

test('admin cấp trial và audit trong cùng một transaction', async (t) => {
  const originalGetClient = db.getClient;
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT id, email FROM users')) {
        return { rows: [{ id: 7, email: 'owner@example.com' }] };
      }
      if (sql.includes('FROM plans') && sql.includes('trial_days')) {
        return { rows: [{ id: 3, code: 'pro', name: 'Pro', trial_days: 14 }] };
      }
      if (sql.includes('FROM subscriptions s')) {
        return { rows: [{ status: 'active', trial_used_at: null, plan_code: 'free' }] };
      }
      if (sql.includes('INSERT INTO subscriptions')) {
        return {
          rows: [{
            id: 11,
            status: 'trialing',
            starts_at: '2026-08-24T00:00:00.000Z',
            ends_at: '2026-09-07T00:00:00.000Z'
          }]
        };
      }
      return { rows: [] };
    },
    release() { calls.push({ sql: 'RELEASE', params: [] }); }
  };
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await startTrial({
    params: { id: '7' },
    body: { planCode: 'pro', reason: 'Hỗ trợ khách hàng mới', days: 21 },
    userId: 1,
    userEmail: 'admin@example.com'
  }, response.res);

  assert.equal(response.record.statusCode, 200);
  assert.equal(response.record.body.subscription.trialDays, 21);
  assert.equal(response.record.body.subscription.status, 'trialing');
  assert.equal(response.record.body.audited, true);
  assert.equal(calls[0].sql, 'BEGIN');
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO subscription_change_logs')), true);
  assert.equal(calls.some((call) => call.sql === 'COMMIT'), true);
  assert.equal(calls.some((call) => call.sql === 'ROLLBACK'), false);

  const audit = calls.find((call) => call.sql.includes('INSERT INTO subscription_change_logs'));
  assert.equal(audit.params[7], 'Hỗ trợ khách hàng mới');
  assert.deepEqual(JSON.parse(audit.params[8]), { trialDays: 21 });
});

test('tài khoản đã dùng trial bị từ chối và transaction được rollback', async (t) => {
  const originalGetClient = db.getClient;
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT id, email FROM users')) {
        return { rows: [{ id: 7, email: 'owner@example.com' }] };
      }
      if (sql.includes('FROM plans') && sql.includes('trial_days')) {
        return { rows: [{ id: 3, code: 'pro', name: 'Pro', trial_days: 14 }] };
      }
      if (sql.includes('FROM subscriptions s')) {
        return {
          rows: [{
            status: 'active',
            trial_used_at: '2026-01-01T00:00:00.000Z',
            plan_code: 'free'
          }]
        };
      }
      return { rows: [] };
    },
    release() {}
  };
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await startTrial({
    params: { id: '7' },
    body: { planCode: 'pro', reason: 'Khách đã được trial trước đó' },
    userId: 1,
    userEmail: 'admin@example.com'
  }, response.res);

  assert.equal(response.record.statusCode, 409);
  assert.equal(response.record.body.code, 'TRIAL_ALREADY_USED');
  assert.equal(calls.some((call) => call.sql === 'ROLLBACK'), true);
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO subscriptions')), false);
  assert.equal(calls.some((call) => call.sql.includes('subscription_change_logs')), false);
});
