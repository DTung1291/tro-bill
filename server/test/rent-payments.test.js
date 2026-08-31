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
  invoiceSyncEntries,
  legacyEntries,
  migrateLegacyPaid,
  paymentInput,
  receiptCode,
  reverseTransaction,
  settleInvoice,
  summaryJson,
  syncInvoices
} = require('../rent-payments');
const { publicInvoiceJson } = require('../rent-invoice-links');

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
    prior_debt_vnd: '0',
    prior_unpaid_invoice_count: 0,
    oldest_unpaid_period: null,
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
  assert.throws(
    () => paymentInput(request({ amountVnd: 0 }).body),
    (error) => error.code === 'INVALID_AMOUNT'
  );
  assert.throws(
    () => paymentInput(request({ paymentMethod: 'crypto' }).body),
    (error) => error.code === 'INVALID_PAYMENT_METHOD'
  );
  assert.throws(
    () => invoiceSyncEntries({ entries: Array.from({ length: 1001 }, () => ({})) }),
    (error) => error.code === 'INVOICE_SYNC_BATCH_TOO_LARGE'
  );
});

test('summary giữ riêng nợ cũ và tổng cần thu, không cộng lại vào tổng hóa đơn', () => {
  const summary = summaryJson(summaryRow({
    issued_total_vnd: '2000000',
    paid_amount_vnd: '500000',
    prior_debt_vnd: '700000',
    prior_unpaid_invoice_count: 2,
    oldest_unpaid_period: '2026-06'
  }), { now: '2026-08-25T05:00:00.000Z' });
  assert.equal(summary.invoiceTotalVnd, 2000000);
  assert.equal(summary.remainingVnd, 1500000);
  assert.equal(summary.priorDebtVnd, 700000);
  assert.equal(summary.totalDueVnd, 2200000);
  assert.equal(summary.priorUnpaidInvoiceCount, 2);
  assert.equal(summary.oldestUnpaidPeriod, '2026-06');
  assert.equal(summary.debtAgePeriod, '2026-06');
  assert.equal(summary.dueDate, '2026-06-30');
  assert.equal(summary.overdueDays, 56);
  assert.equal(summary.debtAgeBucket, 'overdue_31_plus');
  assert.equal(summary.transferContent, 'HD00000015');
  assert.equal(receiptCode(60, '2026-08'), 'PT-202608-00001O');
});

test('nợ trước ngày bắt đầu thuê hiện tại không chuyển sang khách mới', async (t) => {
  const originalQuery = db.query;
  let capturedSql = '';
  db.query = async (sql) => {
    capturedSql = sql;
    return { rows: [] };
  };
  t.after(() => { db.query = originalQuery; });

  const response = responseRecorder();
  const { listInvoiceSummaries } = require('../rent-payments');
  await listInvoiceSummaries({ userId: 7, query: { period: '2026-08' } }, response.res);

  assert.match(capturedSql, /current_room\.rent_start_date/);
  assert.match(capturedSql, /older\.period >= left\(current_room\.rent_start_date, 7\)/);
  assert.match(capturedSql, /LEFT JOIN rooms current_room/);
});

test('ghi đủ tiền tạo invoice và transaction phần còn lại trong cùng transaction', async (t) => {
  const originalGetClient = db.getClient;
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('WHERE t.user_id=$1 AND t.idempotency_key=$2')) return { rows: [] };
      if (sql.includes('SELECT source.room_name')) return { rows: [{ room_name: 'P101' }] };
      if (sql.includes('INSERT INTO rent_invoices')) {
        return { rows: [{ id: 41, issued_total_vnd: '3000000' }] };
      }
      if (sql.includes('SELECT COALESCE(SUM(amount_vnd)')) {
        return { rows: [{ paid_amount_vnd: '500000', transaction_count: 1 }] };
      }
      if (sql.includes('SELECT i.id, i.period')) {
        return { rows: [{ id: 41, period: '2026-08', remaining_vnd: '2500000' }] };
      }
      if (sql.includes("nextval('rent_payment_receipts_id_seq')")) return { rows: [{ id: 51 }] };
      if (sql.includes('INSERT INTO rent_payment_receipts')) {
        return { rows: [{
          id: 51,
          room_id: 'room-1',
          target_period: '2026-08',
          receipt_code: 'PT-202608-00001F',
          amount_vnd: '2500000',
          payment_method: 'manual',
          note: 'Đã nhận đủ qua chuyển khoản',
          source: 'manual_current',
          occurred_at: '2026-08-25T01:00:00.000Z'
        }] };
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
  assert.equal(insert.params[3], 2500000);
  assert.equal(insert.params[4], 'manual');
  assert.equal(insert.params[6], 'manual_full');
  assert.match(sourceCheck.sql, /FROM billing_entries b/);
  assert.match(sourceCheck.sql, /b\.period=\$3/);
  assert.match(insert.sql, /VALUES \(\$1,\$2,\$3,'payment',\$4,\$5,\$6,\$7,\$8\)/);
  assert.deepEqual(
    calls.filter(call => call.sql.includes('INSERT INTO data_audit_logs')).map(call => call.params[3]),
    ['rent_payment_transaction_recorded', 'rent_invoice_payment_changed']
  );
  assert.equal(calls.some((call) => call.sql === 'COMMIT'), true);
  assert.equal(calls.some((call) => /UPDATE rent_payment_transactions|DELETE FROM rent_payment_transactions/.test(call.sql)), false);
});

test('thanh toán một phần ghi đúng số tiền và cho phép nhiều giao dịch kế tiếp', async (t) => {
  const originalGetClient = db.getClient;
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('WHERE t.user_id=$1 AND t.idempotency_key=$2')) return { rows: [] };
      if (sql.includes('SELECT source.room_name')) return { rows: [{ room_name: 'P101' }] };
      if (sql.includes('INSERT INTO rent_invoices')) {
        return { rows: [{ id: 41, issued_total_vnd: '3000000' }] };
      }
      if (sql.includes('SELECT COALESCE(SUM(amount_vnd)')) {
        return { rows: [{ paid_amount_vnd: '500000', transaction_count: 1 }] };
      }
      if (sql.includes('SELECT i.id, i.period')) {
        return { rows: [{ id: 41, period: '2026-08', remaining_vnd: '2500000' }] };
      }
      if (sql.includes("nextval('rent_payment_receipts_id_seq')")) return { rows: [{ id: 52 }] };
      if (sql.includes('INSERT INTO rent_payment_receipts')) {
        return { rows: [{
          id: 52,
          room_id: 'room-1',
          target_period: '2026-08',
          receipt_code: 'PT-202608-00001G',
          amount_vnd: '1000000',
          payment_method: 'bank_transfer',
          note: 'Đã nhận đủ qua chuyển khoản',
          source: 'manual_current',
          occurred_at: '2026-08-25T01:00:00.000Z'
        }] };
      }
      if (sql.includes('INSERT INTO rent_payment_transactions')) {
        return { rows: [{ id: 92, occurred_at: '2026-08-25T01:00:00.000Z' }] };
      }
      if (sql.includes('SELECT i.id')) {
        return { rows: [summaryRow({ paid_amount_vnd: '1500000', transaction_count: 2 })] };
      }
      return { rows: [] };
    },
    release() {}
  };
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await settleInvoice(request({
    amountVnd: 1000000,
    paymentMethod: 'bank_transfer',
    idempotencyKey: 'pay-partial-00000001'
  }), response.res);

  assert.equal(response.record.statusCode, 201);
  assert.equal(response.record.body.transaction.amountVnd, 1000000);
  assert.equal(response.record.body.transaction.paymentMethod, 'bank_transfer');
  assert.equal(response.record.body.transaction.source, 'manual_partial');
  assert.equal(response.record.body.invoice.status, 'partial');
  assert.equal(response.record.body.invoice.remainingVnd, 1500000);
  const insert = calls.find((call) => call.sql.includes('INSERT INTO rent_payment_transactions'));
  assert.deepEqual(insert.params.slice(3, 7), [
    1000000,
    'bank_transfer',
    'Đã nhận đủ qua chuyển khoản',
    'manual_partial'
  ]);
});

test('theo dõi xuyên suốt hóa đơn qua hai lần thu đến khi khách nhận đủ phiếu thu', async (t) => {
  const originalGetClient = db.getClient;
  const receipts = [];
  let paidAmountVnd = 0;
  let transactionCount = 0;
  let nextReceiptId = 51;
  let nextTransactionId = 91;
  const invoiceTotalVnd = 3000000;
  const occurredAt = '2026-08-25T01:00:00.000Z';
  const client = {
    async query(sql, params = []) {
      if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] };
      if (sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('SELECT * FROM rent_payment_receipts')) return { rows: [] };
      if (sql.includes('WHERE t.user_id=$1 AND t.idempotency_key=$2')) return { rows: [] };
      if (sql.includes('SELECT source.room_name')) return { rows: [{ room_name: 'P101' }] };
      if (sql.includes('INSERT INTO rent_invoices')) {
        return { rows: [{ id: 41, issued_total_vnd: String(invoiceTotalVnd) }] };
      }
      if (sql.includes('SELECT COALESCE(SUM(amount_vnd)')) {
        return {
          rows: [{
            paid_amount_vnd: String(paidAmountVnd),
            transaction_count: transactionCount
          }]
        };
      }
      if (sql.includes('SELECT id FROM rent_invoices')) return { rows: [{ id: 41 }] };
      if (sql.includes('SELECT i.id, i.period, i.issued_total_vnd')) {
        return {
          rows: [{
            id: 41,
            period: '2026-08',
            issued_total_vnd: String(invoiceTotalVnd),
            paid_amount_vnd: String(paidAmountVnd),
            remaining_vnd: String(invoiceTotalVnd - paidAmountVnd),
            current_tenancy_start_period: '2026-08'
          }]
        };
      }
      if (sql.includes("nextval('rent_payment_receipts_id_seq')")) {
        return { rows: [{ id: nextReceiptId++ }] };
      }
      if (sql.includes('INSERT INTO rent_payment_receipts')) {
        const receipt = {
          id: params[0],
          room_id: params[2],
          target_period: params[3],
          receipt_code: params[4],
          amount_vnd: String(params[5]),
          payment_method: params[6],
          note: params[7],
          source: params[8],
          occurred_at: params[10],
          created_at: params[10]
        };
        receipts.push(receipt);
        return { rows: [receipt] };
      }
      if (sql.includes('INSERT INTO rent_payment_transactions')) {
        paidAmountVnd += Number(params[3]);
        transactionCount += 1;
        return { rows: [{ id: nextTransactionId++, occurred_at: params[7] }] };
      }
      if (sql.includes('SELECT i.id')) {
        return {
          rows: [summaryRow({
            paid_amount_vnd: String(paidAmountVnd),
            transaction_count: transactionCount,
            last_payment_at: occurredAt
          })]
        };
      }
      return { rows: [] };
    },
    release() {}
  };
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const first = responseRecorder();
  await settleInvoice(request({
    amountVnd: 1000000,
    paymentMethod: 'bank_transfer',
    idempotencyKey: 'payment-lifecycle-part-1'
  }), first.res);
  assert.equal(first.record.statusCode, 201);
  assert.equal(first.record.body.invoice.status, 'partial');
  assert.equal(first.record.body.invoice.remainingVnd, 2000000);

  const second = responseRecorder();
  await settleInvoice(request({
    amountVnd: 2000000,
    paymentMethod: 'bank_transfer',
    idempotencyKey: 'payment-lifecycle-part-2'
  }), second.res);
  assert.equal(second.record.statusCode, 201);
  assert.equal(second.record.body.invoice.status, 'paid');
  assert.equal(second.record.body.invoice.remainingVnd, 0);
  assert.deepEqual(receipts.map((receipt) => receipt.receipt_code), [
    'PT-202608-00001F',
    'PT-202608-00001G'
  ]);

  const tenantView = publicInvoiceJson({
    invoice_id: 41,
    room_name_snapshot: 'P101',
    period: '2026-08',
    issued_total_vnd: String(invoiceTotalVnd),
    paid_amount_vnd: String(paidAmountVnd),
    detail_snapshot: {},
    expires_at: '2026-08-31T16:59:59.000Z',
    receipts: receipts.map((receipt) => ({
      receipt_code: receipt.receipt_code,
      receipt_total_vnd: receipt.amount_vnd,
      allocated_amount_vnd: receipt.amount_vnd,
      payment_method: receipt.payment_method,
      occurred_at: receipt.occurred_at
    }))
  });
  assert.equal(tenantView.invoice.status, 'paid');
  assert.equal(tenantView.invoice.paidAmountVnd, invoiceTotalVnd);
  assert.equal(tenantView.payment, null);
  assert.equal(tenantView.receipts.length, 2);
  assert.equal(
    tenantView.receipts.reduce((sum, receipt) => sum + receipt.allocatedAmountVnd, 0),
    invoiceTotalVnd
  );
});

test('thu gồm nợ cũ được phân bổ từ hóa đơn cũ nhất và dùng chung một phiếu thu', async (t) => {
  const originalGetClient = db.getClient;
  const calls = [];
  let transactionId = 90;
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT * FROM rent_payment_receipts')) return { rows: [] };
      if (sql.includes('WHERE t.user_id=$1 AND t.idempotency_key=$2')) return { rows: [] };
      if (sql.includes('SELECT source.room_name')) return { rows: [{ room_name: 'P101' }] };
      if (sql.includes('INSERT INTO rent_invoices')) {
        return { rows: [{ id: 42, issued_total_vnd: '2000000' }] };
      }
      if (sql.includes('SELECT COALESCE(SUM(amount_vnd)')) {
        return { rows: [{ paid_amount_vnd: '0', transaction_count: 0 }] };
      }
      if (sql.includes('SELECT i.id, i.period')) {
        return { rows: [
          { id: 41, period: '2026-07', remaining_vnd: '500000' },
          {
            id: 42,
            period: '2026-08',
            remaining_vnd: '2000000',
            current_tenancy_start_period: '2026-07'
          }
        ] };
      }
      if (sql.includes("nextval('rent_payment_receipts_id_seq')")) return { rows: [{ id: 60 }] };
      if (sql.includes('INSERT INTO rent_payment_receipts')) {
        return { rows: [{
          id: 60,
          room_id: 'room-1',
          target_period: '2026-08',
          receipt_code: 'PT-202608-00001O',
          amount_vnd: '1000000',
          payment_method: 'bank_transfer',
          note: '',
          source: 'manual_carry_forward',
          occurred_at: '2026-08-25T01:00:00.000Z'
        }] };
      }
      if (sql.includes('INSERT INTO rent_payment_transactions')) {
        transactionId += 1;
        return { rows: [{ id: transactionId, occurred_at: '2026-08-25T01:00:00.000Z' }] };
      }
      if (sql.includes('SELECT i.id')) {
        return { rows: [summaryRow({
          id: 42,
          issued_total_vnd: '2000000',
          paid_amount_vnd: '500000',
          prior_debt_vnd: '0'
        })] };
      }
      return { rows: [] };
    },
    release() {}
  };
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await settleInvoice(request({
    invoiceTotalVnd: 2000000,
    amountVnd: 1000000,
    paymentMethod: 'bank_transfer',
    includePriorDebt: true,
    note: '',
    idempotencyKey: 'carry-forward-00000001'
  }), response.res);

  assert.equal(response.record.statusCode, 201);
  assert.equal(response.record.body.receipt.code, 'PT-202608-00001O');
  assert.equal(response.record.body.receipt.source, 'manual_carry_forward');
  assert.deepEqual(
    response.record.body.allocations.map(({ period, amountVnd }) => ({ period, amountVnd })),
    [
      { period: '2026-07', amountVnd: 500000 },
      { period: '2026-08', amountVnd: 500000 }
    ]
  );
  const inserts = calls.filter((call) => call.sql.includes('INSERT INTO rent_payment_transactions'));
  assert.equal(inserts[0].params[2], 60);
  assert.equal(inserts[0].params[3], 500000);
  assert.equal(inserts[0].params[6], 'manual_prior_debt');
  assert.equal(inserts[1].params[3], 500000);
  assert.equal(inserts[1].params[6], 'manual_partial');
});

test('thu kỳ mới không phân bổ vào nợ của khách thuê trước', async (t) => {
  const originalGetClient = db.getClient;
  const calls = [];
  let transactionId = 100;
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT * FROM rent_payment_receipts')) return { rows: [] };
      if (sql.includes('WHERE t.user_id=$1 AND t.idempotency_key=$2')) return { rows: [] };
      if (sql.includes('SELECT source.room_name')) return { rows: [{ room_name: 'P101' }] };
      if (sql.includes('INSERT INTO rent_invoices')) {
        return { rows: [{ id: 43, issued_total_vnd: '2000000' }] };
      }
      if (sql.includes('SELECT COALESCE(SUM(amount_vnd)')) {
        return { rows: [{ transaction_count: 0 }] };
      }
      if (sql.includes('SELECT i.id, i.period')) {
        return { rows: [
          { id: 41, period: '2026-06', remaining_vnd: '700000' },
          { id: 43, period: '2026-08', remaining_vnd: '2000000', current_tenancy_start_period: '2026-08' }
        ] };
      }
      if (sql.includes("nextval('rent_payment_receipts_id_seq')")) return { rows: [{ id: 61 }] };
      if (sql.includes('INSERT INTO rent_payment_receipts')) {
        return { rows: [{
          id: 61,
          room_id: 'room-1',
          target_period: '2026-08',
          receipt_code: 'PT-202608-00001P',
          amount_vnd: '2000000',
          payment_method: 'bank_transfer',
          note: '',
          source: 'manual_current',
          occurred_at: '2026-08-25T01:00:00.000Z'
        }] };
      }
      if (sql.includes('INSERT INTO rent_payment_transactions')) {
        transactionId += 1;
        return { rows: [{ id: transactionId, occurred_at: '2026-08-25T01:00:00.000Z' }] };
      }
      if (sql.includes('SELECT i.id')) {
        return { rows: [summaryRow({ id: 43, issued_total_vnd: '2000000' })] };
      }
      return { rows: [] };
    },
    release() {}
  };
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await settleInvoice(request({
    invoiceTotalVnd: 2000000,
    amountVnd: 2000000,
    paymentMethod: 'bank_transfer',
    includePriorDebt: true,
    note: '',
    idempotencyKey: 'new-tenant-00000001'
  }), response.res);

  assert.equal(response.record.statusCode, 201);
  assert.deepEqual(
    response.record.body.allocations.map(({ period, amountVnd }) => ({ period, amountVnd })),
    [{ period: '2026-08', amountVnd: 2000000 }]
  );
  assert.equal(response.record.body.receipt.source, 'manual_current');
  assert.equal(calls.filter((call) => call.sql.includes('INSERT INTO rent_payment_transactions')).length, 1);
});

test('không cho thu vượt công nợ còn lại', async (t) => {
  const originalGetClient = db.getClient;
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('WHERE t.user_id=$1 AND t.idempotency_key=$2')) return { rows: [] };
      if (sql.includes('SELECT source.room_name')) return { rows: [{ room_name: 'P101' }] };
      if (sql.includes('INSERT INTO rent_invoices')) {
        return { rows: [{ id: 41, issued_total_vnd: '3000000' }] };
      }
      if (sql.includes('SELECT COALESCE(SUM(amount_vnd)')) {
        return { rows: [{ paid_amount_vnd: '2500000', transaction_count: 2 }] };
      }
      if (sql.includes('SELECT i.id, i.period')) {
        return { rows: [{ id: 41, period: '2026-08', remaining_vnd: '500000' }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await settleInvoice(request({ amountVnd: 600000 }), response.res);

  assert.equal(response.record.statusCode, 409);
  assert.equal(response.record.body.code, 'PAYMENT_EXCEEDS_REMAINING');
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO rent_payment_transactions')), false);
  assert.equal(calls.some((call) => call.sql === 'ROLLBACK'), true);
});

test('không âm thầm đổi tổng hóa đơn sau khi đã có giao dịch', async (t) => {
  const originalGetClient = db.getClient;
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('WHERE t.user_id=$1 AND t.idempotency_key=$2')) return { rows: [] };
      if (sql.includes('SELECT source.room_name')) return { rows: [{ room_name: 'P101' }] };
      if (sql.includes('INSERT INTO rent_invoices')) {
        return { rows: [{ id: 41, issued_total_vnd: '2800000' }] };
      }
      if (sql.includes('SELECT COALESCE(SUM(amount_vnd)')) {
        return { rows: [{ paid_amount_vnd: '500000', transaction_count: 1 }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await settleInvoice(request({ amountVnd: 100000 }), response.res);

  assert.equal(response.record.statusCode, 409);
  assert.equal(response.record.body.code, 'INVOICE_TOTAL_MISMATCH');
  assert.equal(calls.some((call) => call.sql.includes('UPDATE rent_invoices')), false);
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO rent_payment_transactions')), false);
});

test('idempotency key dùng lại với số tiền khác bị từ chối', async (t) => {
  const originalGetClient = db.getClient;
  const client = {
    async query(sql) {
      if (sql.includes('WHERE t.user_id=$1 AND t.idempotency_key=$2')) {
        return {
          rows: [{
            id: 91,
            invoice_id: 41,
            amount_vnd: '1000000',
            payment_method: 'bank_transfer',
            room_id: 'room-1',
            period: '2026-08',
            issued_total_vnd: '3000000'
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
  await settleInvoice(request({
    amountVnd: 2000000,
    paymentMethod: 'bank_transfer'
  }), response.res);

  assert.equal(response.record.statusCode, 409);
  assert.equal(response.record.body.code, 'IDEMPOTENCY_KEY_REUSED');
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
  assert.deepEqual(
    calls.filter(call => call.sql.includes('INSERT INTO data_audit_logs')).map(call => call.params[3]),
    ['rent_payment_transaction_reversed', 'rent_invoice_payment_changed']
  );
  assert.equal(calls.some((call) => /UPDATE rent_payment_transactions|DELETE FROM rent_payment_transactions/.test(call.sql)), false);
});

test('đồng bộ tạo cả hóa đơn chưa thu để kỳ sau tính được nợ cũ', async (t) => {
  const originalGetClient = db.getClient;
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('source.server_paid')) {
        return { rows: [{ room_name: 'P101', server_total: '2000000', server_paid: false }] };
      }
      if (sql.includes('INSERT INTO rent_invoices')) {
        return { rows: [{ id: 71, issued_total_vnd: '2000000' }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await syncInvoices({
    userId: 7,
    body: { entries: [{
      roomId: 'room-1',
      roomName: 'P101',
      period: '2026-07',
      invoiceTotalVnd: 2000000
    }] }
  }, response.res);

  assert.deepEqual(response.record.body, {
    created: 1,
    updated: 0,
    migratedPaid: 0,
    unchanged: 0,
    skipped: 0
  });
  const sourceCheck = calls.find((call) => call.sql.includes('source.server_paid'));
  assert.doesNotMatch(sourceCheck.sql, /hb\.paid=true|b\.paid=true/);
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO rent_payment_transactions')), false);
  assert.equal(
    calls.find(call => call.sql.includes('INSERT INTO data_audit_logs')).params[3],
    'rent_invoice_created'
  );
  assert.equal(calls.some((call) => call.sql === 'COMMIT'), true);
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
  assert.deepEqual(
    calls.filter(call => call.sql.includes('INSERT INTO data_audit_logs')).map(call => call.params[3]),
    ['rent_invoice_created', 'rent_payment_transaction_recorded']
  );
});

test('giao diện dùng API ledger thay cho đảo cờ paid và có màn hình đối soát', () => {
  const root = path.join(__dirname, '..', '..');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const apiSource = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

  assert.match(appSource, /API\.settleRentInvoice/);
  assert.match(appSource, /API\.syncRentInvoices/);
  assert.match(appSource, /includePriorDebt/);
  assert.match(appSource, /priorDebtVnd/);
  assert.match(appSource, /totalDueVnd/);
  assert.match(appSource, /receiptCode/);
  assert.match(appSource, /amountVnd/);
  assert.match(appSource, /paymentMethod/);
  assert.match(appSource, /API\.getRentPaymentTransactions/);
  assert.match(appSource, /API\.reverseRentPaymentTransaction/);
  assert.match(appSource, /rentInvoicePaymentState/);
  assert.doesNotMatch(appSource, /\.paid\s*=\s*!/);
  assert.match(apiSource, /\/api\/rent-payments\/settle/);
  assert.match(apiSource, /\/api\/rent-payments\/sync/);
  assert.match(apiSource, /\/api\/rent-payments\/transactions\/\$\{encodeURIComponent\(transactionId\)\}\/reverse/);
  assert.match(htmlSource, /id="rent-payment-modal"/);
  assert.match(htmlSource, /id="rent-payment-entry-form"/);
  assert.match(htmlSource, /app\.js\?v=112/);
});
