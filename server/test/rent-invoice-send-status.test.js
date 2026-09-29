'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { confirmManualZalo, recordDirectEmailSuccess } = require('../rent-invoice-send-status');
const { summaryJson } = require('../rent-payments');

const root = path.resolve(__dirname, '../..');

function responseRecorder() {
  const record = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; },
    set(name, value) { record.headers[name] = value; return res; }
  };
  return { record, res };
}

function request(overrides = {}) {
  return {
    userId: 7,
    params: { invoiceId: '41' },
    body: { tenantId: 'tenant-1', templateType: 'invoice', confirmed: true },
    ...overrides
  };
}

test('chỉ ghi nhận gửi Zalo sau xác nhận và kiểm tra đúng invoice/tenant cùng chủ', async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    return sql.includes('SELECT invoice.id')
      ? { rows: [{ id: 41 }] }
      : { rows: [{ id: 12, created_at: '2026-09-29T00:00:00Z' }] };
  };
  const { record, res } = responseRecorder();
  await confirmManualZalo(request(), res, { query });
  assert.equal(record.statusCode, 201);
  assert.equal(record.body.confirmed, true);
  assert.equal(record.headers['Cache-Control'], 'no-store');
  assert.deepEqual(calls[0].params, [7, 41, 'tenant-1']);
  assert.match(calls[0].sql, /tenant\.user_id=invoice\.user_id AND tenant\.room_id=invoice\.room_id/);
  assert.match(calls[1].sql, /ON CONFLICT \(user_id, idempotency_key\) DO NOTHING/);
  assert.equal(calls[1].params[3], 'invoice');
  assert.match(calls[1].params[4], /^rent-invoice-send-[a-f0-9]{64}$/);
});

test('không xác nhận thay khách hoặc khi chưa bấm xác nhận', async () => {
  const blocked = responseRecorder();
  await confirmManualZalo(request({ body: { tenantId: 'tenant-1', templateType: 'invoice' } }), blocked.res, {
    query: async () => { throw new Error('must not query'); }
  });
  assert.equal(blocked.record.statusCode, 400);
  assert.equal(blocked.record.body.code, 'SEND_CONFIRMATION_REQUIRED');

  const wrongOwner = responseRecorder();
  await confirmManualZalo(request(), wrongOwner.res, { query: async () => ({ rows: [] }) });
  assert.equal(wrongOwner.record.statusCode, 404);
  assert.equal(wrongOwner.record.body.code, 'INVOICE_RECIPIENT_NOT_FOUND');
});

test('email gửi ngay chỉ ghi bằng chứng provider với khóa idempotency', async () => {
  let received;
  await recordDirectEmailSuccess({
    userId: 7, invoiceId: 41, tenantId: 'tenant-1', templateType: 'invoice',
    emailId: 'provider-123', idempotencyKey: 'rent-invoice-0123456789abcdef'
  }, async (sql, params) => { received = { sql, params }; return { rows: [] }; });
  assert.match(received.sql, /'email','provider_accepted'/);
  assert.match(received.sql, /ON CONFLICT \(user_id, idempotency_key\) DO NOTHING/);
  assert.deepEqual(received.params, [7, 41, 'tenant-1', 'invoice', 'provider-123', 'rent-invoice-0123456789abcdef']);
});

test('summary phân biệt đã gửi, hóa đơn mới chưa gửi và hóa đơn cũ chưa rõ', () => {
  const base = { id: 41, room_id: 'r1', period: '2026-09', issued_total_vnd: 1000,
    paid_amount_vnd: 0, prior_debt_vnd: 0, issued_at: '2026-09-29T00:00:00Z', due_date: '2026-10-09' };
  assert.equal(summaryJson({ ...base, invoice_delivery_confirmed: true }).deliveryStatus, 'sent');
  assert.equal(summaryJson({ ...base, delivery_tracking_baseline: 'tracked' }).deliveryStatus, 'unsent');
  assert.equal(summaryJson({ ...base, delivery_tracking_baseline: 'legacy_unknown' }).deliveryStatus, 'unknown');
});

test('schema giữ baseline hóa đơn cũ và sự kiện gửi append-only', () => {
  const migration = fs.readFileSync(path.join(root, 'server/migrations/20260929_rent_invoice_send_status.sql'), 'utf8');
  const schema = fs.readFileSync(path.join(root, 'server/schema.sql'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.match(migration, /DEFAULT 'legacy_unknown'[\s\S]*SET DEFAULT 'tracked'/);
  assert.match(migration, /REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rent_invoice_send_events/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS rent_invoice_send_events/);
  assert.match(server, /\/api\/rent-invoices\/:invoiceId\/confirm-zalo-send/);
  assert.match(app, /Cần kiểm tra gửi hóa đơn/);
  assert.match(app, /function confirmBillMessageZaloSend/);
  assert.match(app, /async function confirmBillMessageZaloSend\(event\) \{\s*const button = event\.currentTarget;/);
});
