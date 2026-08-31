'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-bank-reconciliation-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const {
  ignoreBankTransaction,
  listBankTransactions,
  manuallyMatchTransaction
} = require('../rent-bank-reconciliation');

function responseRecorder() {
  const record = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; },
    set(name, value) { record.headers[name] = value; return res; }
  };
  return { record, res };
}

function bankRow(overrides = {}) {
  return {
    id: 99,
    user_id: 7,
    channel_id: 3,
    provider: 'sepay',
    provider_transaction_id: '92704',
    gateway: 'Vietcombank',
    account_number: '0123456789',
    amount_vnd: '1000000',
    transaction_content: 'Chuyen tien sai so tien',
    transaction_code: '',
    provider_reference: 'FT001',
    occurred_at: '2026-08-24T13:15:30.000Z',
    received_at: '2026-08-24T13:15:31.000Z',
    match_status: 'pending',
    match_reason: 'amount_mismatch',
    matched_invoice_id: null,
    matched_receipt_id: null,
    review_note: '',
    reviewed_at: null,
    ...overrides
  };
}

test('danh sách chỉ truy vấn giao dịch thuộc user và lọc trạng thái cho phép', async (t) => {
  const originalQuery = db.query;
  let captured;
  db.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [bankRow()] };
  };
  t.after(() => { db.query = originalQuery; });

  const response = responseRecorder();
  await listBankTransactions({ userId: 7, query: { status: 'pending', limit: '500' } }, response.res);
  assert.deepEqual(captured.params, [7, 'pending', 100]);
  assert.match(captured.sql, /WHERE bank\.user_id=\$1 AND bank\.match_status=\$2/);
  assert.equal(response.record.body.transactions[0].providerTransactionId, '92704');
  assert.equal(response.record.body.transactions[0].amountVnd, 1000000);
  assert.equal(response.record.headers['Cache-Control'], 'no-store');

  const invalid = responseRecorder();
  await listBankTransactions({ userId: 7, query: { status: 'deleted' } }, invalid.res);
  assert.equal(invalid.record.statusCode, 400);
  assert.equal(invalid.record.body.code, 'INVALID_MATCH_STATUS');
});

test('ghép thủ công cho phép thanh toán một phần và tạo phiếu thu có người rà soát', async (t) => {
  const originalGetClient = db.getClient;
  const calls = [];
  let ledgerId = 80;
  db.getClient = async () => ({
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT * FROM rent_bank_transactions')) return { rows: [bankRow()] };
      if (sql.includes('SELECT id, user_id, room_id, period')) {
        return { rows: [{ id: 41, user_id: 7, room_id: 'room-1', period: '2026-08' }] };
      }
      if (sql.includes('GREATEST(i.issued_total_vnd')) {
        return { rows: [{ id: 41, period: '2026-08', remaining_vnd: '3000000' }] };
      }
      if (sql.includes('AS tenancy_start_period')) {
        return { rows: [{ tenancy_start_period: '2026-08' }] };
      }
      if (sql.includes("nextval('rent_payment_receipts_id_seq')")) return { rows: [{ id: 51 }] };
      if (sql.includes('INSERT INTO rent_payment_transactions')) {
        ledgerId += 1;
        return { rows: [{ id: ledgerId }] };
      }
      return { rows: [] };
    },
    release() {}
  });
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await manuallyMatchTransaction({
    userId: 7,
    params: { id: '99' },
    body: { invoiceId: 41, note: 'Khách xác nhận chuyển thiếu và sẽ trả tiếp' }
  }, response.res);

  assert.equal(response.record.statusCode, 201);
  assert.equal(response.record.body.match.reason, 'matched_manual');
  assert.equal(response.record.body.match.allocations[0].amountVnd, 1000000);
  const receipt = calls.find((call) => call.sql.includes('INSERT INTO rent_payment_receipts'));
  assert.equal(receipt.params[7], 'sepay_manual');
  const ledger = calls.find((call) => call.sql.includes('INSERT INTO rent_payment_transactions'));
  assert.equal(ledger.params[6], 'sepay_manual');
  const review = calls.find((call) => call.sql.includes('reviewed_by_user_id'));
  assert.deepEqual(review.params.slice(3), [
    'matched_manual',
    'Khách xác nhận chuyển thiếu và sẽ trả tiếp',
    7
  ]);
  assert.equal(calls.some((call) => call.sql === 'COMMIT'), true);
});

test('không thể ghép giao dịch của user khác hoặc giao dịch đã xử lý', async (t) => {
  const originalGetClient = db.getClient;
  db.getClient = async () => ({
    async query(sql) {
      if (sql.includes('SELECT * FROM rent_bank_transactions')) return { rows: [] };
      return { rows: [] };
    },
    release() {}
  });
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await manuallyMatchTransaction({
    userId: 7,
    params: { id: '99' },
    body: { invoiceId: 41 }
  }, response.res);
  assert.equal(response.record.statusCode, 404);
  assert.equal(response.record.body.code, 'BANK_TRANSACTION_NOT_FOUND');
});

test('bỏ qua bắt buộc lý do và chỉ update dòng pending thuộc user', async (t) => {
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('UPDATE rent_bank_transactions')) {
      return { rows: [bankRow({
        match_status: 'ignored',
        match_reason: 'manual_ignored',
        review_note: params[2],
        reviewed_at: '2026-08-25T00:00:00.000Z'
      })] };
    }
    return { rows: [] };
  };
  t.after(() => { db.query = originalQuery; });

  const invalid = responseRecorder();
  await ignoreBankTransaction({ userId: 7, params: { id: '99' }, body: { reason: 'nhầm' } }, invalid.res);
  assert.equal(invalid.record.statusCode, 400);

  const response = responseRecorder();
  await ignoreBankTransaction({
    userId: 7,
    params: { id: '99' },
    body: { reason: 'Giao dịch cá nhân không liên quan tiền trọ' }
  }, response.res);
  assert.equal(response.record.body.transaction.matchStatus, 'ignored');
  const update = calls.find((call) => call.sql.includes('UPDATE rent_bank_transactions'));
  assert.deepEqual(update.params, [7, 99, 'Giao dịch cá nhân không liên quan tiền trọ']);
  assert.match(update.sql, /WHERE user_id=\$1 AND id=\$2 AND match_status='pending'/);
});

test('migration và UI có hàng chờ xử lý thủ công, không cấp quyền sửa payload ngân hàng', () => {
  const root = path.join(__dirname, '..', '..');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260825_rent_bank_review_queue.sql'),
    'utf8'
  );
  const apiSource = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const styleSource = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /review_note/);
  assert.match(migration, /reviewed_by_user_id BIGINT REFERENCES users\(id\) ON DELETE SET NULL/);
  assert.match(migration, /GRANT UPDATE \(match_status, match_reason, matched_invoice_id, matched_receipt_id, matched_at, review_note, reviewed_by_user_id, reviewed_at, updated_at\)/);
  assert.doesNotMatch(migration, /UPDATE \(.*transaction_content|UPDATE \(.*amount_vnd/);
  assert.match(apiSource, /function getRentBankTransactions/);
  assert.match(apiSource, /function matchRentBankTransaction/);
  assert.match(apiSource, /function ignoreRentBankTransaction/);
  assert.match(appSource, /function renderRentBankReconciliation/);
  assert.match(htmlSource, /id="bank-reconciliation"/);
  assert.match(htmlSource, /api\.js\?v=104[\s\S]*app\.js\?v=110/);
  assert.match(styleSource, /\.bank-reconciliation-controls/);
});
