'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const { createSubscriptionOrder, orderRequest, vietQrUrl } = require('../subscription-orders');

function responseRecorder() {
  const record = { statusCode: 200, body: null };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; }
  };
  return { record, res };
}

function request(body = {}) {
  return {
    body: { planCode: 'pro', billingCycle: 'monthly', ...body },
    userId: 7,
    userEmail: 'owner@example.com'
  };
}

function payment(overrides = {}) {
  return {
    id: 51,
    provider_reference: 'TB112233AABBCC',
    subscription_action: 'upgrade',
    billing_cycle: 'monthly',
    amount_vnd: '299000',
    status: 'pending',
    expires_at: '2026-08-26T10:00:00.000Z',
    bank_id_snapshot: 'VCB',
    bank_account_snapshot: '123456789',
    bank_owner_snapshot: 'NGUYEN VAN A',
    transfer_content: 'TB112233AABBCC',
    ...overrides
  };
}

function mockClient(options = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM subscriptions s')) {
        return {
          rows: options.withoutSubscription ? [] : [{
            subscription_id: 10,
            plan_code: options.currentPlanCode || 'standard',
            room_limit: options.currentRoomLimit || 25
          }]
        };
      }
      if (sql.includes('FROM plans') && sql.includes('is_public=true')) {
        return {
          rows: options.withoutPlan ? [] : [{
            id: 3,
            code: 'pro',
            name: 'Pro',
            room_limit: options.targetRoomLimit || 50,
            monthly_price_vnd: options.monthlyPrice ?? '299000',
            yearly_price_vnd: options.yearlyPrice ?? '2990000'
          }]
        };
      }
      if (sql.includes('FROM app_config')) {
        return {
          rows: options.withoutBank ? [{}] : [{
            subscription_bank_id: 'VCB',
            subscription_account: '123456789',
            subscription_owner_name: 'NGUYEN VAN A'
          }]
        };
      }
      if (sql.includes('SELECT * FROM subscription_payments')) {
        return { rows: options.existingPayment ? [payment(options.existingPayment)] : [] };
      }
      if (sql.includes('INSERT INTO subscription_payments')) {
        return { rows: [payment({
          provider_reference: params[5],
          transfer_content: params[5],
          subscription_action: params[6],
          bank_id_snapshot: params[7],
          bank_account_snapshot: params[8],
          bank_owner_snapshot: params[9]
        })] };
      }
      return { rows: [] };
    },
    release() {}
  };
  return { calls, client };
}

test('schema lưu ảnh chụp VietQR, thời hạn và mã chuyển khoản duy nhất', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  assert.match(schema, /subscription_action TEXT/);
  assert.match(schema, /transfer_content\s+TEXT/);
  assert.match(schema, /bank_id_snapshot\s+TEXT/);
  assert.match(schema, /expires_at\s+TIMESTAMPTZ/);
  assert.match(schema, /provider <> 'vietqr'[\s\S]*NULLIF\(bank_account_snapshot, ''\)/);
  assert.match(schema, /CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_payments_transfer_content/);
});

test('request đơn hàng không chấp nhận Free hoặc chu kỳ lạ', () => {
  assert.throws(
    () => orderRequest(request({ planCode: 'free' })),
    (error) => error.code === 'INVALID_PLAN_CODE'
  );
  assert.throws(
    () => orderRequest(request({ billingCycle: 'weekly' })),
    (error) => error.code === 'INVALID_BILLING_CYCLE'
  );
});

test('tạo đơn dùng giá server, snapshot tài khoản và mã chuyển khoản riêng', async (t) => {
  const originalGetClient = db.getClient;
  const { calls, client } = mockClient();
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await createSubscriptionOrder(request({ amountVnd: 1 }), response.res);

  assert.equal(response.record.statusCode, 201);
  assert.equal(response.record.body.reused, false);
  assert.equal(response.record.body.order.amountVnd, 299000);
  assert.equal(response.record.body.order.planCode, 'pro');
  assert.match(response.record.body.vietQr.transferContent, /^TB[A-F0-9]{12}$/);
  assert.match(response.record.body.vietQr.imageUrl, /^https:\/\/img\.vietqr\.io\/image\/VCB-123456789-compact2\.png/);
  const insert = calls.find((call) => call.sql.includes('INSERT INTO subscription_payments'));
  assert.equal(insert.params[3], 299000);
  assert.deepEqual(insert.params.slice(7), ['VCB', '123456789', 'NGUYEN VAN A']);
  assert.match(insert.sql, /now\(\) \+ interval '24 hours'/);
  assert.equal(calls.some((call) => call.sql === 'COMMIT'), true);
  assert.equal(calls.some((call) => call.sql === 'ROLLBACK'), false);
});

test('click lại cùng gói tái sử dụng đơn pending còn hạn', async (t) => {
  const originalGetClient = db.getClient;
  const { calls, client } = mockClient({ existingPayment: {} });
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await createSubscriptionOrder(request(), response.res);

  assert.equal(response.record.statusCode, 200);
  assert.equal(response.record.body.reused, true);
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO subscription_payments')), false);
  assert.equal(calls.some((call) => call.sql === 'COMMIT'), true);
});

test('không cho tạo đơn hạ giới hạn phòng', async (t) => {
  const originalGetClient = db.getClient;
  const { calls, client } = mockClient({ currentRoomLimit: 100, targetRoomLimit: 50 });
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await createSubscriptionOrder(request(), response.res);

  assert.equal(response.record.statusCode, 409);
  assert.equal(response.record.body.code, 'PLAN_NOT_UPGRADE');
  assert.equal(calls.some((call) => call.sql === 'ROLLBACK'), true);
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO subscription_payments')), false);
});

test('chưa cấu hình tài khoản thu phí trả lỗi rõ ràng', async (t) => {
  const originalGetClient = db.getClient;
  const { client } = mockClient({ withoutBank: true });
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await createSubscriptionOrder(request(), response.res);

  assert.equal(response.record.statusCode, 503);
  assert.equal(response.record.body.code, 'SUBSCRIPTION_PAYMENT_NOT_CONFIGURED');
});

test('VietQR URL mã hóa an toàn mọi tham số', () => {
  const url = vietQrUrl(payment({ bank_owner_snapshot: 'NGUYEN VAN A & CO' }));
  assert.match(url, /accountName=NGUYEN%20VAN%20A%20%26%20CO$/);
});
