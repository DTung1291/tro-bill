'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-rent-payment-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const {
  invoiceInput,
  legacyEntries,
  migrateLegacyPaid,
  reverseTransaction,
  settleInvoice
} = require('../rent-payments');

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
    userId: 7,
    params: {},
    body: {
      roomId: 'room-1',
      roomName: 'P101',
      period: '2026-08',
      invoiceTotalVnd: 3000000,
      note: 'Đã nhận đủ qua chuyển khoản',
      idempotencyKey: 'pay-test-00000001',
      occurredAt: '2026-08-25T01:00:00.000Z',
      ...body
    }
  };
}

function summaryRow(overrides = {}) {
  return {
    id: 41,
    room_id: 'room-1',
    room_name_snapshot: 'P101',
    period: '2026-08',
    issued_total_vnd: '3000000',
    paid_amount_vnd: '3000000',
    transaction_count: 1,
    last_payment_at: '2026-08-25T01:00:00.000Z',
    issued_at: '2026-08-25T01:00:00.000Z',
    updated_at: '2026-08-25T01:00:00.000Z',
    ...overrides
  };
}

test('input bắt buộc tổng VND nguyên, tháng và idempotency key hợp lệ', () => {
  assert.throws(
    () => invoiceInput(request({ invoiceTotalVnd: 1.5 }).body),
    (error) => error.code === 'INVALID_AMOUNT'
  );
  assert.throws(
    () => invoiceInput(request({ period: '2026-13' }).body),
    (error) => error.code === 'INVALID_PERIOD'
  );
  assert.throws(
    () => invoiceInput(request({ idempotencyKey: 'short' }).body),
    (error) => error.code === 'INVALID_IDEMPOTENCY_KEY'
  );
  assert.throws(
    () => legacyEntries({ entries: Array.from({ length: 501 }, () => ({})) }),
    (error) => error.code === 'LEGACY_BATCH_TOO_LARGE'
  );
});

test('ghi đủ tiền tạo invoice và transaction phần còn lại trong cùng transaction', async (t) => {
  const originalGetClient = db.getClient;
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('WHERE t.user_id=$1 AND t.idempotency_key=$2')) return { rows: [] };
      if (sql.includes('SELECT source.room_name')) return { rows: [{ room_name: 'P101' }] };
      if (sql.includes('INSERT INTO rent_invoices')) return { rows: [{ id: 41 }] };
      if (sql.includes('SELECT COALESCE(SUM(amount_vnd)')) {
        return { rows: [{ paid_amount_vnd: '500000' }] };
      }
      if (sql.includes('INSERT INTO rent_payment_transactions')) {
        return { rows: [{ id: 91, occurred_at: '2026-08-25T01:00:00.000Z' }] };
      }
      if (sql.includes('SELECT i.id')) return { rows: [summaryRow()] };
      return { rows: [] };
    },
    release() {}
  };
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await settleInvoice(request(), response.res);

  assert.equal(response.record.statusCode, 201);
  assert.equal(response.record.body.transaction.amountVnd, 2500000);
  assert.equal(response.record.body.invoice.status, 'paid');
  const insert = calls.find((call) => call.sql.includes('INSERT INTO rent_payment_transactions'));
  const sourceCheck = calls.find((call) => call.sql.includes('SELECT source.room_name'));
  assert.equal(insert.params[2], 2500000);
  assert.match(sourceCheck.sql, /FROM billing_entries b/);
  assert.match(sourceCheck.sql, /b\.period=\$3/);
  assert.match(insert.sql, /'manual_full'/);
  assert.equal(calls.some((call) => call.sql === 'COMMIT'), true);
  assert.equal(calls.some((call) => /UPDATE rent_payment_transactions|DELETE FROM rent_payment_transactions/.test(call.sql)), false);
});

test('không tạo invoice khi phòng hoặc bill lịch sử không thuộc user', async (t) => {
  const originalGetClient = db.getClient;
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('WHERE t.user_id=$1 AND t.idempotency_key=$2')) return { rows: [] };
      if (sql.includes('SELECT source.room_name')) return { rows: [] };
      return { rows: [] };
    },
    release() {}
  };
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await settleInvoice(request(), response.res);
  assert.equal(response.record.statusCode, 404);
  assert.equal(response.record.body.code, 'INVOICE_SOURCE_NOT_FOUND');
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO rent_invoices')), false);
  assert.equal(calls.some((call) => call.sql === 'ROLLBACK'), true);
});

test('hoàn tác tạo dòng âm tham chiếu giao dịch gốc, không sửa dòng cũ', async (t) => {
  const originalGetClient = db.getClient;
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FOR UPDATE OF t') && sql.includes('t.id=$2')) {
        return {
          rows: [{
            id: 91,
            invoice_id: 41,
            amount_vnd: '3000000',
            payment_method: 'manual',
            entry_type: 'payment'
          }]
        };
      }
      if (sql.includes('reverses_transaction_id=$2')) return { rows: [] };
      if (sql.includes('INSERT INTO rent_payment_transactions')) {
        return {
          rows: [{
            id: 92,
            invoice_id: 41,
            entry_type: 'reversal',
            amount_vnd: '-3000000',
            payment_method: 'manual',
            note: 'Khách chuyển nhầm cần hoàn tác',
            source: 'manual_reversal',
            reverses_transaction_id: 91,
            occurred_at: '2026-08-25T02:00:00.000Z',
            created_at: '2026-08-25T02:00:00.000Z'
          }]
        };
      }
      if (sql.includes('SELECT i.id')) {
        return { rows: [summaryRow({ paid_amount_vnd: '0', transaction_count: 2 })] };
      }
      return { rows: [] };
    },
    release() {}
  };
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await reverseTransaction({
    userId: 7,
    params: { id: '91' },
    body: { reason: 'Khách chuyển nhầm cần hoàn tác' }
  }, response.res);

  assert.equal(response.record.statusCode, 201);
  assert.equal(response.record.body.transaction.amountVnd, -3000000);
  assert.equal(response.record.body.invoice.status, 'unpaid');
  const reversal = calls.find((call) => call.sql.includes('INSERT INTO rent_payment_transactions'));
  assert.deepEqual(reversal.params.slice(1), [41, -3000000, 'manual', 'Khách chuyển nhầm cần hoàn tác', 91]);
  assert.equal(calls.some((call) => /UPDATE rent_payment_transactions|DELETE FROM rent_payment_transactions/.test(call.sql)), false);
});

test('migration legacy chỉ nhận dòng paid thuộc user và chống tạo transaction lần hai', async (t) => {
  const originalGetClient = db.getClient;
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT source.room_name, source.server_total')) {
        return { rows: [{ room_name: 'P101', server_total: '3000000' }] };
      }
      if (sql.includes('INSERT INTO rent_invoices')) return { rows: [{ id: 41 }] };
      if (sql.includes('INSERT INTO rent_payment_transactions')) return { rows: [{ id: 91 }] };
      return { rows: [] };
    },
    release() {}
  };
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await migrateLegacyPaid({
    userId: 7,
    body: { entries: [request().body] }
  }, response.res);

  assert.equal(response.record.body.migrated, 1);
  const transaction = calls.find((call) => call.sql.includes('INSERT INTO rent_payment_transactions'));
  assert.match(transaction.sql, /WHERE NOT EXISTS/);
  assert.match(transaction.sql, /ON CONFLICT \(user_id, idempotency_key\)/);
  assert.equal(transaction.params[2], 3000000);
});

test('giao diện dùng API ledger thay cho đảo cờ paid và có màn hình đối soát', () => {
  const root = path.join(__dirname, '..', '..');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const apiSource = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

  assert.match(appSource, /API\.settleRentInvoice/);
  assert.match(appSource, /API\.getRentPaymentTransactions/);
  assert.match(appSource, /API\.reverseRentPaymentTransaction/);
  assert.match(appSource, /rentInvoicePaymentState/);
  assert.doesNotMatch(appSource, /\.paid\s*=\s*!/);
  assert.match(apiSource, /\/api\/rent-payments\/settle/);
  assert.match(apiSource, /\/api\/rent-payments\/transactions\/\$\{encodeURIComponent\(transactionId\)\}\/reverse/);
  assert.match(htmlSource, /id="rent-payment-modal"/);
  assert.match(htmlSource, /app\.js\?v=78/);
});
