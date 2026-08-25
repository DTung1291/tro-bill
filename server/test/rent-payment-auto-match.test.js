'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  autoMatchBankTransaction,
  invoiceReferences
} = require('../rent-payment-auto-match');

function bankTransaction(overrides = {}) {
  return {
    id: 99,
    user_id: 7,
    channel_id: 3,
    provider_transaction_id: '92704',
    transaction_code: 'HD00000015',
    transaction_content: 'Thanh toan HD00000015',
    amount_vnd: '3000000',
    occurred_at: '2026-08-24T13:15:30.000Z',
    match_status: 'pending',
    match_reason: '',
    ...overrides
  };
}

function matchingClient(options = {}) {
  const calls = [];
  const balances = options.balances || [
    { id: 41, period: '2026-08', remaining_vnd: '3000000' }
  ];
  let transactionId = 90;
  return {
    calls,
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT id, user_id, room_id, period')) {
        return { rows: options.invoiceMissing ? [] : [{
          id: 41,
          user_id: 7,
          room_id: 'room-1',
          period: '2026-08'
        }] };
      }
      if (sql.includes('GREATEST(i.issued_total_vnd')) return { rows: balances };
      if (sql.includes('AS tenancy_start_period')) {
        return { rows: [{ tenancy_start_period: options.tenancyStart || '2026-01' }] };
      }
      if (sql.includes("nextval('rent_payment_receipts_id_seq')")) return { rows: [{ id: 51 }] };
      if (sql.includes('INSERT INTO rent_payment_transactions')) {
        transactionId += 1;
        return { rows: [{ id: transactionId }] };
      }
      return { rows: [] };
    }
  };
}

test('chỉ nhận đúng một mã hóa đơn hợp lệ trong code hoặc nội dung', () => {
  assert.deepEqual(invoiceReferences('', 'thanh toan HD00000015'), ['HD00000015']);
  assert.deepEqual(
    invoiceReferences('HD00000015', 'lap lai hd00000015'),
    ['HD00000015']
  );
  assert.deepEqual(invoiceReferences('', 'HD123'), []);
  assert.deepEqual(
    invoiceReferences('HD00000015', 'kem HD00000016'),
    ['HD00000015', 'HD00000016']
  );
});

test('khớp chính xác tạo phiếu thu, bút toán và liên kết giao dịch ngân hàng', async () => {
  const client = matchingClient();
  const result = await autoMatchBankTransaction(client, bankTransaction());

  assert.equal(result.matched, true);
  assert.equal(result.receiptCode, 'PT-202608-00001F');
  assert.equal(result.allocations.length, 1);
  assert.equal(result.allocations[0].amountVnd, 3000000);

  const receipt = client.calls.find((call) => call.sql.includes('INSERT INTO rent_payment_receipts'));
  assert.deepEqual(receipt.params.slice(0, 6), [
    51, 7, 'room-1', '2026-08', 'PT-202608-00001F', 3000000
  ]);
  assert.match(receipt.sql, /'bank_transfer'/);
  assert.equal(receipt.params[7], 'sepay_auto');
  assert.equal(receipt.params[8], 'sepay:3:92704');

  const ledger = client.calls.find((call) => call.sql.includes('INSERT INTO rent_payment_transactions'));
  assert.deepEqual(ledger.params.slice(0, 5), [7, 41, 51, 3000000, 'sepay:92704']);
  assert.equal(ledger.params[6], 'sepay_auto');

  const matched = client.calls.find((call) => call.sql.includes("match_status='matched'"));
  assert.deepEqual(matched.params, [99, 41, 51, 'matched_exact', '', null]);
  assert.match(matched.sql, /matched_receipt_id=\$3/);
});

test('số tiền đúng tổng nợ được phân bổ từ kỳ cũ nhất tới hóa đơn mang mã', async () => {
  const client = matchingClient({ balances: [
    { id: 40, period: '2026-07', remaining_vnd: '500000' },
    { id: 41, period: '2026-08', remaining_vnd: '2500000' }
  ] });
  const result = await autoMatchBankTransaction(client, bankTransaction());

  assert.equal(result.matched, true);
  assert.deepEqual(result.allocations.map((entry) => [entry.invoiceId, entry.amountVnd]), [
    [40, 500000],
    [41, 2500000]
  ]);
  const ledgerCalls = client.calls.filter(
    (call) => call.sql.includes('INSERT INTO rent_payment_transactions')
  );
  assert.equal(ledgerCalls[0].params[6], 'sepay_prior_debt');
  assert.equal(ledgerCalls[1].params[6], 'sepay_auto');
});

test('không tự ghi tiền khi sai số tiền, thiếu mã, nhiều mã hoặc hóa đơn không tồn tại', async () => {
  const cases = [
    [bankTransaction({ amount_vnd: '2999999' }), matchingClient(), 'amount_mismatch'],
    [bankTransaction({ transaction_code: '', transaction_content: 'khong co ma' }), matchingClient(), 'transfer_reference_missing'],
    [bankTransaction({ transaction_content: 'HD00000015 HD00000016' }), matchingClient(), 'multiple_transfer_references'],
    [bankTransaction(), matchingClient({ invoiceMissing: true }), 'invoice_not_found']
  ];
  for (const [transaction, client, reason] of cases) {
    const result = await autoMatchBankTransaction(client, transaction);
    assert.equal(result.matched, false);
    assert.equal(result.reason, reason);
    assert.equal(
      client.calls.some((call) => call.sql.includes('INSERT INTO rent_payment_receipts')),
      false,
      reason
    );
    const pending = client.calls.find((call) => call.sql.includes("match_status='pending'"));
    assert.equal(pending.params[1], reason);
  }
});

test('không chuyển nợ của khách cũ trước ngày thuê hiện tại', async () => {
  const client = matchingClient({
    tenancyStart: '2026-08',
    balances: [
      { id: 39, period: '2026-06', remaining_vnd: '1000000' },
      { id: 41, period: '2026-08', remaining_vnd: '3000000' }
    ]
  });
  const result = await autoMatchBankTransaction(client, bankTransaction());
  assert.equal(result.matched, true);
  assert.deepEqual(result.allocations.map((entry) => entry.invoiceId), [41]);
});

test('migration liên kết bank transaction với phiếu thu và chỉ cấp quyền update cột đối soát', () => {
  const root = path.join(__dirname, '..', '..');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260825_rent_payment_auto_match.sql'),
    'utf8'
  );
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  for (const source of [migration, schema]) {
    assert.match(source, /matched_receipt_id/);
    assert.match(source, /rent_bank_transactions_receipt_owner_fk/);
    assert.match(source, /REFERENCES rent_payment_receipts\(user_id, id\) ON DELETE RESTRICT/);
    assert.match(source, /match_reason/);
    assert.match(source, /GRANT UPDATE \(match_status, match_reason, matched_invoice_id, matched_receipt_id, matched_at,[^)]*updated_at\)/);
  }
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;[\s\S]*runtime_match_update_ready/);
});
