'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const {
  confirmSubscriptionPaymentManually,
  listAdminSubscriptionPayments,
  manualConfirmationInput,
  maskedAccount
} = require('../subscription-payment-admin');

function responseRecorder() {
  const record = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { record.statusCode = code; return res; },
    set(name, value) { record.headers[String(name).toLowerCase()] = value; return res; },
    json(body) { record.body = body; return res; }
  };
  return { record, res };
}

function adminRequest(overrides = {}) {
  return {
    userId: 1,
    userEmail: 'admin@example.com',
    params: { id: '51' },
    body: {
      transactionReference: 'BANK-TXN-001',
      paidAt: '2026-09-09T01:10:00.000Z',
      reason: 'Đã đối chiếu giao dịch trong ứng dụng ngân hàng',
      ...overrides
    }
  };
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
    payment_created_at: '2026-09-09T01:00:00.000Z',
    expires_at: '2026-09-10T01:00:00.000Z',
    settlement_provider: null,
    settlement_reference: null,
    plan_code: 'pro',
    plan_name: 'Pro',
    plan_room_limit: 50,
    subscription_status: 'active',
    current_plan_id: 2,
    current_plan_code: 'standard',
    current_room_limit: 25,
    current_billing_cycle: 'monthly',
    current_starts_at: '2026-08-01T00:00:00.000Z',
    current_ends_at: '2026-09-30T00:00:00.000Z',
    user_email: 'owner@example.com',
    ...overrides
  };
}

function mockClient(options = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM subscription_payments sp') && sql.includes('FOR UPDATE OF sp, s')) {
        return { rows: options.payment === null ? [] : [paymentRow(options.payment)] };
      }
      if (sql.includes('FROM subscription_payments')
          && sql.includes('settlement_provider=$1')) {
        return { rows: options.usedTransaction ? [{ id: 99 }] : [] };
      }
      if (sql.includes('UPDATE subscription_payments')) {
        return { rows: options.paymentUpdateLost ? [] : [{ id: 51 }] };
      }
      if (sql.includes('UPDATE subscriptions')) {
        return { rows: [{
          id: 10,
          status: 'active',
          billing_cycle: 'monthly',
          starts_at: '2026-09-09T01:10:00.000Z',
          ends_at: '2026-10-09T01:10:00.000Z'
        }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  return { calls, client };
}

test('input xác nhận thủ công bắt buộc mã giao dịch, thời điểm và lý do hợp lệ', () => {
  const now = new Date('2026-09-09T02:00:00.000Z');
  const input = manualConfirmationInput(adminRequest(), now);
  assert.equal(input.paymentId, 51);
  assert.equal(input.transactionReference, 'BANK-TXN-001');
  assert.equal(input.paidAt, '2026-09-09T01:10:00.000Z');
  assert.throws(
    () => manualConfirmationInput(adminRequest({ transactionReference: 'mã có khoảng trắng' }), now),
    (error) => error.code === 'INVALID_TRANSACTION_REFERENCE'
  );
  assert.throws(
    () => manualConfirmationInput(adminRequest({ paidAt: '2026-09-09T02:06:00.000Z' }), now),
    (error) => error.code === 'INVALID_PAID_AT'
  );
  assert.throws(
    () => manualConfirmationInput(adminRequest({ reason: 'quá ngắn' }), now),
    (error) => error.code === 'INVALID_REASON'
  );
});

test('danh sách admin che tài khoản nhận và không cache', async (t) => {
  const originalQuery = db.query;
  let captured = null;
  db.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [{
      id: '51',
      user_id: '7',
      user_email: 'owner@example.com',
      plan_code: 'pro',
      plan_name: 'Pro',
      provider_reference: 'TB112233AABBCC',
      transfer_content: 'TB112233AABBCC',
      subscription_action: 'upgrade',
      billing_cycle: 'monthly',
      amount_vnd: '299000',
      currency: 'VND',
      status: 'pending',
      bank_id_snapshot: 'TCB',
      bank_account_snapshot: '123456789',
      settlement_provider: null,
      settlement_reference: null,
      created_at: '2026-09-09T01:00:00.000Z',
      expires_at: '2026-09-10T01:00:00.000Z',
      paid_at: null,
      confirmation_actor_user_id: null,
      confirmation_created_at: null
    }] };
  };
  t.after(() => { db.query = originalQuery; });
  const response = responseRecorder();

  await listAdminSubscriptionPayments({ query: { status: 'pending', limit: '999' } }, response.res);

  assert.deepEqual(captured.params, ['pending', 200]);
  assert.match(captured.sql, /log\.metadata->>'paymentId'=sp\.id::text/);
  assert.equal(response.record.headers['cache-control'], 'no-store');
  assert.equal(response.record.body.payments[0].receiver.accountMasked, '•••••6789');
  assert.equal(JSON.stringify(response.record.body).includes('123456789'), false);
});

test('xác nhận thủ công đánh dấu paid, gia hạn và audit trong cùng transaction', async (t) => {
  const originalGetClient = db.getClient;
  const { calls, client } = mockClient();
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });
  const response = responseRecorder();

  await confirmSubscriptionPaymentManually(adminRequest(), response.res);

  assert.equal(response.record.statusCode, 200);
  assert.equal(response.record.body.payment.status, 'paid');
  assert.equal(response.record.body.duplicate, false);
  const paymentUpdate = calls.find((call) => call.sql.includes('UPDATE subscription_payments'));
  assert.match(paymentUpdate.sql, /WHERE id=\$1 AND status='pending'/);
  assert.deepEqual(paymentUpdate.params, [51, '2026-09-09T01:10:00.000Z', 'bank_transfer', 'BANK-TXN-001']);
  const subscriptionUpdate = calls.find((call) => call.sql.includes('UPDATE subscriptions'));
  assert.deepEqual(subscriptionUpdate.params.slice(0, 4), [10, 3, 'monthly', 'upgrade']);
  const audit = calls.find((call) => call.sql.includes('INSERT INTO subscription_change_logs'));
  assert.deepEqual(audit.params.slice(0, 5), [
    1,
    'admin@example.com',
    7,
    'owner@example.com',
    'subscription_upgraded_by_payment'
  ]);
  assert.equal(JSON.parse(audit.params[9]).confirmationMethod, 'manual_admin');
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('retry cùng mã giao dịch không gia hạn hoặc audit lần hai', async (t) => {
  const originalGetClient = db.getClient;
  const { calls, client } = mockClient({
    payment: {
      payment_status: 'paid',
      settlement_provider: 'bank_transfer',
      settlement_reference: 'BANK-TXN-001'
    }
  });
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });
  const response = responseRecorder();

  await confirmSubscriptionPaymentManually(adminRequest(), response.res);

  assert.equal(response.record.body.duplicate, true);
  assert.equal(calls.some((call) => call.sql.includes('UPDATE subscription_payments')), false);
  assert.equal(calls.some((call) => call.sql.includes('UPDATE subscriptions')), false);
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO subscription_change_logs')), false);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('không dùng lại mã giao dịch và không nhận giao dịch ngoài thời hạn đơn', async (t) => {
  const originalGetClient = db.getClient;
  t.after(() => { db.getClient = originalGetClient; });

  const used = mockClient({ usedTransaction: true });
  db.getClient = async () => used.client;
  const usedResponse = responseRecorder();
  await confirmSubscriptionPaymentManually(adminRequest(), usedResponse.res);
  assert.equal(usedResponse.record.statusCode, 409);
  assert.equal(usedResponse.record.body.code, 'TRANSACTION_ALREADY_USED');
  assert.equal(used.calls.at(-1).sql, 'ROLLBACK');

  const expired = mockClient({
    payment: { expires_at: '2026-09-09T01:15:00.000Z' }
  });
  db.getClient = async () => expired.client;
  const expiredResponse = responseRecorder();
  await confirmSubscriptionPaymentManually(
    adminRequest({ paidAt: '2026-09-09T01:15:00.000Z' }),
    expiredResponse.res
  );
  assert.equal(expiredResponse.record.statusCode, 409);
  assert.equal(expiredResponse.record.body.code, 'PAYMENT_ORDER_EXPIRED');
  assert.equal(expired.calls.some((call) => call.sql.includes('UPDATE subscriptions')), false);
});

test('route và UI chỉ cho admin xác nhận, có đủ trường đối soát và asset pin mới', () => {
  const root = path.resolve(__dirname, '../..');
  const serverSource = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  const adminSource = fs.readFileSync(path.join(root, 'admin.js'), 'utf8');
  const apiSource = fs.readFileSync(path.join(root, 'api.js'), 'utf8');

  assert.match(
    serverSource,
    /app\.post\([\s\S]*\/api\/admin\/subscription\/payments\/:id\/confirm[\s\S]*adminGuard/
  );
  assert.match(html, /id="subscription-payment-admin-section"/);
  assert.match(html, /class="admin-table-wrap">[\s\S]*class="admin-subtable admin-refund-table" id="subscription-payment-admin-table"/);
  assert.match(html, /style\.css\?v=79/);
  assert.match(html, /api\.js\?v=80[\s\S]*admin\.js\?v=80/);
  assert.match(adminSource, /id="admin-payment-transaction-reference"/);
  assert.match(adminSource, /id="admin-payment-paid-at"/);
  assert.match(adminSource, /id="admin-payment-confirm-reason"/);
  assert.match(apiSource, /\/api\/admin\/subscription\/payments\/\$\{encodeURIComponent\(paymentId\)\}\/confirm/);
});

test('mask số tài khoản chỉ giữ tối đa bốn số cuối', () => {
  assert.equal(maskedAccount('123456789'), '•••••6789');
  assert.equal(maskedAccount('1234'), '1234');
  assert.equal(maskedAccount(''), '');
});
