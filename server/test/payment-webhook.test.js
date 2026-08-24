'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const crypto = require('crypto');
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const {
  paymentWebhook,
  verifyPaymentWebhook,
  webhookInput
} = require('../payment-webhook');

const SECRET = 'payment-webhook-test-secret-that-is-long-enough';

function signedRequest(body, overrides = {}) {
  const rawBody = Buffer.from(JSON.stringify(body));
  const timestamp = String(overrides.timestamp || Math.floor(Date.now() / 1000));
  const signature = crypto
    .createHmac('sha256', overrides.secret || SECRET)
    .update(Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]))
    .digest('hex');
  const headers = {
    'x-payment-event-id': overrides.eventId || 'evt_20260825_001',
    'x-payment-timestamp': timestamp,
    'x-payment-signature': overrides.signature || `v1=${signature}`
  };
  return {
    rawBody,
    body,
    get(name) { return headers[String(name).toLowerCase()] || ''; }
  };
}

function validBody(overrides = {}) {
  return {
    type: 'payment.completed',
    transactionId: 'BANK-TXN-001',
    transferContent: 'THANH TOAN TB112233AABBCC',
    bankAccount: '123456789',
    amountVnd: 299000,
    paidAt: new Date(Date.now() - 60_000).toISOString(),
    ...overrides
  };
}

function responseRecorder() {
  const record = { statusCode: 200, body: null };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; }
  };
  return { record, res };
}

function paymentRow(overrides = {}) {
  return {
    payment_id: 51,
    user_id: 7,
    subscription_id: 10,
    plan_id: 3,
    amount_vnd: '299000',
    billing_cycle: 'monthly',
    payment_status: 'pending',
    subscription_action: 'upgrade',
    bank_account_snapshot: '123456789',
    payment_created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    expires_at: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    settlement_provider: null,
    settlement_reference: null,
    plan_code: 'pro',
    plan_name: 'Pro',
    plan_room_limit: 50,
    subscription_status: 'active',
    current_plan_id: 2,
    current_plan_code: 'standard',
    current_room_limit: 25,
    user_email: 'owner@example.com',
    ...overrides
  };
}

function mockClient(options = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO payment_events')) {
        return { rows: options.duplicateEvent ? [] : [{ id: 80 }] };
      }
      if (sql.includes('UPDATE payment_events') && sql.includes('attempt_count=attempt_count+1')) {
        return { rows: [{ status: options.duplicateStatus || 'processed', error_code: null }] };
      }
      if (sql.includes('FROM subscription_payments sp')) {
        return { rows: options.withoutPayment ? [] : [paymentRow(options.payment)] };
      }
      if (sql.includes('SELECT id FROM subscription_payments')) {
        return { rows: options.settledPaymentId ? [{ id: options.settledPaymentId }] : [] };
      }
      if (sql.includes('UPDATE subscriptions')) {
        return { rows: [{
          id: 10,
          status: 'active',
          billing_cycle: 'monthly',
          starts_at: new Date().toISOString(),
          ends_at: new Date(Date.now() + 30 * 86400_000).toISOString()
        }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  return { calls, client };
}

test('xác minh HMAC trên đúng raw body và timestamp còn hạn', () => {
  const req = signedRequest(validBody());
  const verified = verifyPaymentWebhook(req, SECRET);
  assert.equal(verified.eventId, 'evt_20260825_001');
  assert.throws(
    () => verifyPaymentWebhook({ ...req, get: name => (
      name.toLowerCase() === 'x-payment-signature' ? `v1=${'0'.repeat(64)}` : req.get(name)
    ) }, SECRET),
    (error) => error.code === 'INVALID_WEBHOOK_SIGNATURE'
  );
});

test('từ chối replay khi timestamp quá 5 phút', () => {
  const now = Date.now();
  const req = signedRequest(validBody(), { timestamp: Math.floor(now / 1000) - 301 });
  assert.throws(
    () => verifyPaymentWebhook(req, SECRET, now),
    (error) => error.code === 'WEBHOOK_TIMESTAMP_EXPIRED'
  );
});

test('chỉ lấy các trường thanh toán cần thiết và hash raw payload', () => {
  const req = signedRequest(validBody({ senderName: 'Không được lưu' }));
  const input = webhookInput(req, verifyPaymentWebhook(req, SECRET));
  assert.equal(input.transferCode, 'TB112233AABBCC');
  assert.equal(input.safePayload.senderName, undefined);
  assert.match(input.payloadHash, /^[a-f0-9]{64}$/);
});

test('webhook hợp lệ thanh toán, nâng gói và audit trong cùng transaction', async (t) => {
  const originalGetClient = db.getClient;
  const originalSecret = process.env.PAYMENT_WEBHOOK_SECRET;
  const { calls, client } = mockClient();
  db.getClient = async () => client;
  process.env.PAYMENT_WEBHOOK_SECRET = SECRET;
  t.after(() => {
    db.getClient = originalGetClient;
    if (originalSecret === undefined) delete process.env.PAYMENT_WEBHOOK_SECRET;
    else process.env.PAYMENT_WEBHOOK_SECRET = originalSecret;
  });
  const response = responseRecorder();

  await paymentWebhook(signedRequest(validBody()), response.res);

  assert.equal(response.record.statusCode, 200);
  assert.equal(response.record.body.processed, true);
  const paid = calls.find((call) => call.sql.includes('UPDATE subscription_payments'));
  assert.deepEqual(paid.params.slice(2), ['bank_transfer', 'BANK-TXN-001']);
  const subscription = calls.find((call) => call.sql.includes('UPDATE subscriptions'));
  assert.deepEqual(subscription.params.slice(0, 4), [10, 3, 'monthly', 'upgrade']);
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO subscription_change_logs')), true);
  assert.equal(calls.some((call) => call.sql === 'COMMIT'), true);
  assert.equal(calls.some((call) => call.sql === 'ROLLBACK'), false);
});

test('event ID nhận lại chỉ tăng attempt, không kích hoạt lần hai', async (t) => {
  const originalGetClient = db.getClient;
  const originalSecret = process.env.PAYMENT_WEBHOOK_SECRET;
  const { calls, client } = mockClient({ duplicateEvent: true });
  db.getClient = async () => client;
  process.env.PAYMENT_WEBHOOK_SECRET = SECRET;
  t.after(() => {
    db.getClient = originalGetClient;
    if (originalSecret === undefined) delete process.env.PAYMENT_WEBHOOK_SECRET;
    else process.env.PAYMENT_WEBHOOK_SECRET = originalSecret;
  });
  const response = responseRecorder();

  await paymentWebhook(signedRequest(validBody()), response.res);

  assert.equal(response.record.body.duplicate, true);
  assert.equal(response.record.body.processed, true);
  assert.equal(calls.some((call) => call.sql.includes('UPDATE subscriptions')), false);
});

test('cùng transaction với event ID mới không kích hoạt lần hai', async (t) => {
  const originalGetClient = db.getClient;
  const originalSecret = process.env.PAYMENT_WEBHOOK_SECRET;
  const { calls, client } = mockClient({
    settledPaymentId: 51,
    payment: {
      payment_status: 'paid',
      settlement_provider: 'bank_transfer',
      settlement_reference: 'BANK-TXN-001'
    }
  });
  db.getClient = async () => client;
  process.env.PAYMENT_WEBHOOK_SECRET = SECRET;
  t.after(() => {
    db.getClient = originalGetClient;
    if (originalSecret === undefined) delete process.env.PAYMENT_WEBHOOK_SECRET;
    else process.env.PAYMENT_WEBHOOK_SECRET = originalSecret;
  });
  const response = responseRecorder();

  await paymentWebhook(
    signedRequest(validBody(), { eventId: 'evt_20260825_002' }),
    response.res
  );

  assert.equal(response.record.body.duplicateTransaction, true);
  assert.equal(response.record.body.processed, true);
  assert.equal(calls.some((call) => call.sql.includes('UPDATE subscriptions')), false);
});

test('sai số tiền được giữ lại để rà soát và không kích hoạt gói', async (t) => {
  const originalGetClient = db.getClient;
  const originalSecret = process.env.PAYMENT_WEBHOOK_SECRET;
  const { calls, client } = mockClient();
  db.getClient = async () => client;
  process.env.PAYMENT_WEBHOOK_SECRET = SECRET;
  t.after(() => {
    db.getClient = originalGetClient;
    if (originalSecret === undefined) delete process.env.PAYMENT_WEBHOOK_SECRET;
    else process.env.PAYMENT_WEBHOOK_SECRET = originalSecret;
  });
  const response = responseRecorder();

  await paymentWebhook(signedRequest(validBody({ amountVnd: 199000 })), response.res);

  assert.equal(response.record.statusCode, 202);
  assert.equal(response.record.body.code, 'PAYMENT_AMOUNT_MISMATCH');
  assert.equal(response.record.body.requiresReview, true);
  assert.equal(calls.some((call) => call.sql.includes('UPDATE subscriptions')), false);
  const failedEvent = calls.find((call) => (
    call.sql.includes('UPDATE payment_events') && call.params[3] === 'failed'
  ));
  assert.equal(failedEvent.params[4], 'PAYMENT_AMOUNT_MISMATCH');
});
