'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { listPublicPlans, updatePlan } = require('../plans');

function responseRecorder() {
  const record = { statusCode: 200, body: null };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; }
  };
  return { record, res };
}

function plan(overrides = {}) {
  return {
    code: 'pro',
    name: 'Pro',
    description: 'Gói Pro',
    monthly_price_vnd: '299000',
    yearly_price_vnd: '2990000',
    room_limit: 50,
    staff_limit: 0,
    trial_days: 14,
    is_active: true,
    is_public: true,
    sort_order: 30,
    ...overrides
  };
}

function request(overrides = {}, code = 'pro') {
  return {
    params: { code },
    body: {
      monthlyPriceVnd: 299000,
      yearlyPriceVnd: 2990000,
      isActive: true,
      isPublic: true,
      reason: 'Cập nhật giá bán thử nghiệm tháng tám',
      ...overrides
    },
    userId: 1,
    userEmail: 'admin@example.com'
  };
}

test('API public chỉ truy vấn các gói đang mở bán', async (t) => {
  const originalQuery = db.query;
  let capturedSql = '';
  db.query = async (sql) => {
    capturedSql = sql;
    return { rows: [plan()] };
  };
  t.after(() => { db.query = originalQuery; });
  const response = responseRecorder();

  await listPublicPlans({}, response.res);

  assert.match(capturedSql, /is_active=true AND is_public=true/);
  assert.equal(response.record.body.plans[0].monthlyPriceVnd, 299000);
});

test('không cho thay đổi gói Free', async () => {
  const response = responseRecorder();
  await updatePlan(request({}, 'free'), response.res);
  assert.equal(response.record.statusCode, 409);
  assert.equal(response.record.body.code, 'FREE_PLAN_LOCKED');
});

test('gói mở bán bắt buộc có đủ giá tháng và năm', async () => {
  const response = responseRecorder();
  await updatePlan(request({ yearlyPriceVnd: null }), response.res);
  assert.equal(response.record.statusCode, 400);
  assert.equal(response.record.body.code, 'PLAN_PRICE_REQUIRED');
});

test('cập nhật giá và audit chạy trong cùng transaction', async (t) => {
  const originalGetClient = db.getClient;
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM plans') && sql.includes('FOR UPDATE')) {
        return { rows: [plan({ monthly_price_vnd: '199000' })] };
      }
      if (sql.includes('UPDATE plans')) return { rows: [plan()] };
      return { rows: [] };
    },
    release() {}
  };
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });
  const response = responseRecorder();

  await updatePlan(request(), response.res);

  assert.equal(response.record.statusCode, 200);
  assert.equal(response.record.body.audited, true);
  const update = calls.find((call) => call.sql.includes('UPDATE plans'));
  assert.deepEqual(update.params, ['pro', 299000, 2990000, true, true]);
  const audit = calls.find((call) => call.sql.includes('INSERT INTO subscription_change_logs'));
  assert.equal(audit.params[3], 'Cập nhật giá bán thử nghiệm tháng tám');
  assert.equal(calls.some((call) => call.sql === 'COMMIT'), true);
});
