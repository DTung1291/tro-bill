'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const {
  adminTransitionInput,
  cancelRefundRequest,
  createRefundRequest,
  listAdminRefundRequests,
  requestInput,
  transitionAdminRefundRequest
} = require('../subscription-refunds');

function responseRecorder() {
  const record = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { record.statusCode = code; return res; },
    set(name, value) { record.headers[String(name).toLowerCase()] = value; return res; },
    json(body) { record.body = body; return res; }
  };
  return { record, res };
}

function userRequest(overrides = {}) {
  return {
    userId: 7,
    userEmail: 'owner@example.com',
    params: { paymentId: '51', id: '12' },
    body: {
      requestType: 'refund',
      requestedAmountVnd: 299000,
      reason: 'Tôi mua nhầm gói và chưa sử dụng dịch vụ',
      ...overrides
    }
  };
}

function paymentRow(overrides = {}) {
  return {
    id: 51,
    user_id: 7,
    amount_vnd: '299000',
    status: 'paid',
    provider_reference: 'TB112233AABBCC',
    plan_code: 'pro',
    plan_name: 'Pro',
    user_email: 'owner@example.com',
    ...overrides
  };
}

function refundRow(overrides = {}) {
  return {
    id: 12,
    user_id: 7,
    payment_id: 51,
    request_type: 'refund',
    requested_amount_vnd: '299000',
    reason: 'Tôi mua nhầm gói và chưa sử dụng dịch vụ',
    status: 'pending',
    admin_note: null,
    refund_reference: null,
    created_at: '2026-08-25T00:00:00.000Z',
    updated_at: '2026-08-25T00:00:00.000Z',
    user_email: 'owner@example.com',
    plan_code: 'pro',
    ...overrides
  };
}

function mockClient(options = {}) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM subscription_payments sp') && sql.includes('FOR UPDATE OF sp')) {
        return { rows: options.payment === null ? [] : [paymentRow(options.payment)] };
      }
      if (sql.includes('FROM subscription_refund_requests') && sql.includes('status IN')) {
        return { rows: options.existing ? [options.existing] : [] };
      }
      if (sql.includes('INSERT INTO subscription_refund_requests')) {
        return { rows: [refundRow(options.inserted)] };
      }
      if (sql.includes('FROM subscription_refund_requests rr') && sql.includes('FOR UPDATE OF rr')) {
        return { rows: options.request === null ? [] : [refundRow(options.request)] };
      }
      if (sql.includes('UPDATE subscription_refund_requests')) {
        const status = params[1] || 'canceled';
        return { rows: [refundRow({ status, ...(options.updated || {}) })] };
      }
      return { rows: [] };
    },
    release() {}
  };
  return { calls, client };
}

test('input chỉ nhận hai loại yêu cầu và số tiền VND nguyên dương', () => {
  assert.equal(requestInput(userRequest()).requestType, 'refund');
  assert.equal(
    requestInput(userRequest({ requestType: 'mistaken_transfer', requestedAmountVnd: 500000 }))
      .requestedAmountVnd,
    500000
  );
  assert.throws(
    () => requestInput(userRequest({ requestType: 'chargeback' })),
    (error) => error.code === 'INVALID_REFUND_REQUEST_TYPE'
  );
  assert.throws(
    () => requestInput(userRequest({ requestedAmountVnd: 10.5 })),
    (error) => error.code === 'INVALID_REFUND_AMOUNT'
  );
});

test('tạo yêu cầu hoàn tiền khóa payment theo đúng user và ghi audit cùng transaction', async (t) => {
  const originalGetClient = db.getClient;
  const { calls, client } = mockClient();
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });
  const response = responseRecorder();

  await createRefundRequest(userRequest(), response.res);

  assert.equal(response.record.statusCode, 201);
  assert.equal(response.record.body.refundRequest.id, 12);
  const paymentQuery = calls.find(call => call.sql.includes('FROM subscription_payments sp'));
  assert.match(paymentQuery.sql, /WHERE sp\.id=\$1 AND sp\.user_id=\$2/);
  assert.deepEqual(paymentQuery.params, [51, 7]);
  assert.equal(calls.some(call => call.sql.includes('subscription_refund_requested')), true);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('không cho hoàn nhiều hơn payment đã xác nhận', async (t) => {
  const originalGetClient = db.getClient;
  const { calls, client } = mockClient();
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });
  const response = responseRecorder();

  await createRefundRequest(userRequest({ requestedAmountVnd: 300000 }), response.res);

  assert.equal(response.record.statusCode, 400);
  assert.equal(response.record.body.code, 'REFUND_AMOUNT_EXCEEDS_PAYMENT');
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
});

test('yêu cầu chuyển nhầm được gửi cho payment pending để admin đối soát', async (t) => {
  const originalGetClient = db.getClient;
  const { calls, client } = mockClient({
    payment: { status: 'pending', amount_vnd: '299000' },
    inserted: { request_type: 'mistaken_transfer', requested_amount_vnd: '500000' }
  });
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });
  const response = responseRecorder();

  await createRefundRequest(userRequest({
    requestType: 'mistaken_transfer',
    requestedAmountVnd: 500000
  }), response.res);

  assert.equal(response.record.statusCode, 201);
  assert.equal(response.record.body.refundRequest.requestType, 'mistaken_transfer');
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('chủ tài khoản chỉ hủy được yêu cầu pending của chính mình', async (t) => {
  const originalGetClient = db.getClient;
  const { calls, client } = mockClient();
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });
  const response = responseRecorder();

  await cancelRefundRequest(userRequest(), response.res);

  const lookup = calls.find(call => call.sql.includes('FROM subscription_refund_requests rr'));
  assert.match(lookup.sql, /WHERE rr\.id=\$1 AND rr\.user_id=\$2/);
  assert.deepEqual(lookup.params, [12, 7]);
  assert.equal(response.record.body.refundRequest.status, 'canceled');
  assert.equal(calls.some(call => call.sql.includes('subscription_refund_canceled')), true);
});

test('admin phải duyệt trước khi xác nhận đã hoàn và cần mã giao dịch', () => {
  assert.throws(
    () => adminTransitionInput({ body: { status: 'refunded', note: 'Đã hoàn tiền thủ công', refundReference: '' } }),
    (error) => error.code === 'INVALID_REFUND_REFERENCE'
  );
  assert.equal(
    adminTransitionInput({ body: { status: 'refunded', note: 'Đã hoàn tiền thủ công', refundReference: 'RF-001' } })
      .refundReference,
    'RF-001'
  );
});

test('admin xác nhận hoàn tiền sau approved và ghi audit trong transaction', async (t) => {
  const originalGetClient = db.getClient;
  const { calls, client } = mockClient({ request: { status: 'approved' } });
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });
  const response = responseRecorder();
  const req = {
    params: { id: '12' },
    body: { status: 'refunded', note: 'Đã chuyển khoản hoàn tiền đầy đủ', refundReference: 'RF-001' },
    userId: 1,
    userEmail: 'admin@example.com'
  };

  await transitionAdminRefundRequest(req, response.res);

  assert.equal(response.record.statusCode, 200);
  assert.equal(response.record.body.refundRequest.status, 'refunded');
  const update = calls.find(call => call.sql.includes('UPDATE subscription_refund_requests'));
  assert.match(update.sql, /refunded_at=CASE WHEN \$2='refunded' THEN now\(\)/);
  const audit = calls.find(call => call.sql.includes('INSERT INTO subscription_change_logs'));
  assert.equal(audit.params[4], 'subscription_refund_refunded');
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('admin không thể đi thẳng từ pending sang refunded', async (t) => {
  const originalGetClient = db.getClient;
  const { calls, client } = mockClient({ request: { status: 'pending' } });
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });
  const response = responseRecorder();
  const req = {
    params: { id: '12' },
    body: { status: 'refunded', note: 'Đã chuyển khoản hoàn tiền đầy đủ', refundReference: 'RF-001' },
    userId: 1,
    userEmail: 'admin@example.com'
  };

  await transitionAdminRefundRequest(req, response.res);

  assert.equal(response.record.statusCode, 409);
  assert.equal(response.record.body.code, 'INVALID_REFUND_TRANSITION');
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
});

test('admin list mặc định chỉ lấy yêu cầu cần xử lý và không cache', async (t) => {
  const originalQuery = db.query;
  let captured;
  db.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [] };
  };
  t.after(() => { db.query = originalQuery; });
  const response = responseRecorder();

  await listAdminRefundRequests({ query: {} }, response.res);

  assert.match(captured.sql, /rr\.status IN \('pending','reviewing','approved'\)/);
  assert.deepEqual(captured.params, [null, true]);
  assert.deepEqual(response.record.body.refundRequests, []);
  assert.equal(response.record.headers['cache-control'], 'no-store');
});
