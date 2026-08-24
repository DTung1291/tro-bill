'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const {
  getSubscriptionReceipt,
  listSubscriptionPayments,
  receiptCode
} = require('../subscription-payment-history');

function responseRecorder() {
  const record = { statusCode: 200, body: null };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; }
  };
  return { record, res };
}

function paidRow(overrides = {}) {
  return {
    id: 51,
    provider_reference: 'TB112233AABBCC',
    transfer_content: 'TB112233AABBCC',
    subscription_action: 'upgrade',
    billing_cycle: 'monthly',
    amount_vnd: '299000',
    currency: 'VND',
    status: 'paid',
    created_at: '2026-08-25T00:00:00.000Z',
    expires_at: '2026-08-26T00:00:00.000Z',
    paid_at: '2026-08-25T01:00:00.000Z',
    settlement_provider: 'bank_transfer',
    settlement_reference: 'BANK-TXN-001',
    bank_id_snapshot: 'VCB',
    bank_account_snapshot: '123456789',
    bank_owner_snapshot: 'NGUYEN VAN A',
    plan_code: 'pro',
    plan_name: 'Pro',
    customer_email: 'owner@example.com',
    ...overrides
  };
}

test('mã biên nhận ổn định theo payment ID', () => {
  assert.equal(receiptCode(51), 'TB-RCPT-00000051');
});

test('lịch sử payment chỉ kèm yêu cầu hoàn tiền mới nhất, không lộ dữ liệu admin', async (t) => {
  const originalQuery = db.query;
  db.query = async () => ({ rows: [paidRow({
    refund_request_id: 12,
    refund_request_type: 'refund',
    refund_requested_amount_vnd: '299000',
    refund_reason: 'Tôi mua nhầm gói và chưa sử dụng dịch vụ',
    refund_status: 'reviewing',
    refund_admin_note: 'Đang kiểm tra giao dịch với ngân hàng',
    refund_reference: null,
    refund_created_at: '2026-08-25T02:00:00.000Z',
    refund_updated_at: '2026-08-25T03:00:00.000Z'
  })] });
  t.after(() => { db.query = originalQuery; });
  const response = responseRecorder();

  await listSubscriptionPayments({ userId: 7, query: {} }, response.res);

  const refund = response.record.body.payments[0].refundRequest;
  assert.equal(refund.id, 12);
  assert.equal(refund.status, 'reviewing');
  assert.equal(refund.adminNote, 'Đang kiểm tra giao dịch với ngân hàng');
  assert.equal('adminEmail' in refund, false);
});

test('lịch sử chỉ truy vấn payment thuộc user đăng nhập và giới hạn tối đa 100', async (t) => {
  const originalQuery = db.query;
  let captured;
  db.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [paidRow()] };
  };
  t.after(() => { db.query = originalQuery; });
  const response = responseRecorder();

  await listSubscriptionPayments({ userId: 7, query: { limit: '999' } }, response.res);

  assert.match(captured.sql, /WHERE sp\.user_id=\$1/);
  assert.deepEqual(captured.params, [7, 100]);
  assert.equal(response.record.body.payments[0].receiptCode, 'TB-RCPT-00000051');
  assert.equal(response.record.body.payments[0].amountVnd, 299000);
  assert.equal('settlement' in response.record.body.payments[0], false);
});

test('biên nhận khóa ownership bằng payment ID và user ID', async (t) => {
  const originalQuery = db.query;
  let captured;
  db.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [paidRow()] };
  };
  t.after(() => { db.query = originalQuery; });
  const response = responseRecorder();

  await getSubscriptionReceipt({ userId: 7, params: { id: '51' } }, response.res);

  assert.match(captured.sql, /WHERE sp\.id=\$1 AND sp\.user_id=\$2/);
  assert.deepEqual(captured.params, [51, 7]);
  assert.equal(response.record.body.receipt.code, 'TB-RCPT-00000051');
  assert.equal(response.record.body.receipt.settlement.reference, 'BANK-TXN-001');
  assert.equal(response.record.body.receipt.customerEmail, 'owner@example.com');
});

test('payment chưa paid không được phát hành biên nhận', async (t) => {
  const originalQuery = db.query;
  db.query = async () => ({ rows: [paidRow({ status: 'pending', paid_at: null })] });
  t.after(() => { db.query = originalQuery; });
  const response = responseRecorder();

  await getSubscriptionReceipt({ userId: 7, params: { id: '51' } }, response.res);

  assert.equal(response.record.statusCode, 409);
  assert.equal(response.record.body.code, 'PAYMENT_RECEIPT_NOT_READY');
});
