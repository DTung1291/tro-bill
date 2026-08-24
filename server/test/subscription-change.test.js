'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-change-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { changeSubscription, subscriptionChangeRequest } = require('../subscription');

function responseRecorder() {
  const record = { statusCode: 200, body: null };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; }
  };
  return { record, res };
}

function request(overrides = {}) {
  return {
    params: { id: '7' },
    body: {
      operation: 'upgrade',
      planCode: 'pro',
      billingCycle: 'monthly',
      reason: 'Khách đã thanh toán nâng gói',
      ...overrides
    },
    userId: 1,
    userEmail: 'admin@example.com'
  };
}

function mockClient(currentOverrides = {}, planOverrides = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT id, email FROM users')) {
        return { rows: [{ id: 7, email: 'owner@example.com' }] };
      }
      if (sql.includes('FROM plans') && sql.includes('room_limit')) {
        return { rows: [{ id: 3, code: 'pro', name: 'Pro', room_limit: 50, ...planOverrides }] };
      }
      if (sql.includes('FROM subscriptions s')) {
        return {
          rows: [{
            id: 10,
            status: 'active',
            starts_at: '2026-08-01T00:00:00.000Z',
            ends_at: '2026-09-01T00:00:00.000Z',
            billing_cycle: 'monthly',
            plan_id: 2,
            plan_code: 'standard',
            plan_name: 'Standard',
            room_limit: 25,
            ...currentOverrides
          }]
        };
      }
      if (sql.includes('UPDATE subscriptions')) {
        return {
          rows: [{
            id: 10,
            status: 'active',
            billing_cycle: params[3],
            starts_at: '2026-08-25T00:00:00.000Z',
            ends_at: '2026-10-01T00:00:00.000Z'
          }]
        };
      }
      return { rows: [] };
    },
    release() {}
  };
  return { calls, client };
}

test('request nâng gói chỉ nhận operation và chu kỳ hợp lệ', () => {
  assert.throws(
    () => subscriptionChangeRequest(request({ operation: 'downgrade' })),
    (error) => error.code === 'INVALID_SUBSCRIPTION_OPERATION'
  );
  assert.throws(
    () => subscriptionChangeRequest(request({ billingCycle: 'weekly' })),
    (error) => error.code === 'INVALID_BILLING_CYCLE'
  );
});

test('nâng gói cập nhật entitlement và audit trong cùng transaction', async (t) => {
  const originalGetClient = db.getClient;
  const { calls, client } = mockClient();
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await changeSubscription(request(), response.res);

  assert.equal(response.record.statusCode, 200);
  assert.equal(response.record.body.operation, 'upgrade');
  assert.equal(response.record.body.subscription.planCode, 'pro');
  assert.equal(response.record.body.subscription.billingCycle, 'monthly');
  const update = calls.find((call) => call.sql.includes('UPDATE subscriptions'));
  assert.match(update.sql, /ends_at IS NOT NULL AND ends_at > now\(\)/);
  assert.match(update.sql, /interval '1 month'/);
  assert.match(update.sql, /interval '1 year'/);
  assert.deepEqual(update.params, [7, 3, 'upgrade', 'monthly']);
  const audit = calls.find((call) => call.sql.includes('INSERT INTO subscription_change_logs'));
  assert.equal(audit.params[4], 'subscription_upgraded');
  assert.equal(calls.some((call) => call.sql === 'COMMIT'), true);
  assert.equal(calls.some((call) => call.sql === 'ROLLBACK'), false);
});

test('gia hạn sai gói bị từ chối và rollback', async (t) => {
  const originalGetClient = db.getClient;
  const { calls, client } = mockClient();
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await changeSubscription(request({ operation: 'renew' }), response.res);

  assert.equal(response.record.statusCode, 409);
  assert.equal(response.record.body.code, 'RENEW_PLAN_MISMATCH');
  assert.equal(calls.some((call) => call.sql === 'ROLLBACK'), true);
  assert.equal(calls.some((call) => call.sql.includes('UPDATE subscriptions')), false);
});

test('không cho dùng luồng nâng gói để hạ giới hạn phòng', async (t) => {
  const originalGetClient = db.getClient;
  const { calls, client } = mockClient({ room_limit: 100 }, { room_limit: 50 });
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await changeSubscription(request(), response.res);

  assert.equal(response.record.statusCode, 409);
  assert.equal(response.record.body.code, 'PLAN_NOT_UPGRADE');
  assert.equal(calls.some((call) => call.sql.includes('UPDATE subscriptions')), false);
});
