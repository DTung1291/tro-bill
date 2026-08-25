'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
const migration = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '20260825_rent_payment_ledger.sql'),
  'utf8'
);
const invoices = schema.match(/CREATE TABLE IF NOT EXISTS rent_invoices \(([\s\S]*?)\n\);/);
const transactions = schema.match(/CREATE TABLE IF NOT EXISTS rent_payment_transactions \(([\s\S]*?)\n\);/);

test('hóa đơn tiền trọ có định danh user/phòng/tháng và không cascade theo rooms', () => {
  assert.ok(invoices, 'Thiếu bảng rent_invoices');
  assert.match(invoices[1], /UNIQUE \(user_id, room_id, period\)/);
  assert.match(invoices[1], /UNIQUE \(user_id, id\)/);
  assert.match(invoices[1], /issued_total_vnd\s+NUMERIC\(12, 0\) NOT NULL/);
  assert.doesNotMatch(invoices[1], /REFERENCES rooms/);
});

test('transaction thuộc đúng hóa đơn của user và hoàn tác bằng bút toán âm', () => {
  assert.ok(transactions, 'Thiếu bảng rent_payment_transactions');
  assert.match(
    transactions[1],
    /FOREIGN KEY \(user_id, invoice_id\)[\s\S]*REFERENCES rent_invoices\(user_id, id\)/
  );
  assert.match(
    transactions[1],
    /FOREIGN KEY \(user_id, reverses_transaction_id\)[\s\S]*REFERENCES rent_payment_transactions\(user_id, id\)/
  );
  assert.match(transactions[1], /entry_type = 'payment' AND amount_vnd > 0/);
  assert.match(transactions[1], /entry_type = 'reversal' AND amount_vnd < 0/);
  assert.match(schema, /idx_rent_payment_one_reversal/);
  assert.match(schema, /idx_rent_payment_idempotency/);
});

test('runtime ledger là append-only và migration paid cũ idempotent', () => {
  assert.match(schema, /Role runtime được tạo trực tiếp bằng SQL/);
  assert.match(
    schema,
    /REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rent_payment_transactions FROM tro_bill_runtime/
  );
  assert.match(schema, /GRANT SELECT, INSERT ON rent_payment_transactions TO tro_bill_runtime/);
  assert.doesNotMatch(schema, /GRANT[^;]*UPDATE[^;]*rent_payment_transactions TO tro_bill_runtime/);
  assert.doesNotMatch(schema, /GRANT[^;]*DELETE[^;]*rent_payment_transactions TO tro_bill_runtime/);
  assert.match(schema, /INSERT INTO rent_invoices[\s\S]*FROM history_bills/);
  assert.match(schema, /'legacy:' \|\| ri\.period \|\| ':' \|\| ri\.room_id/);
  assert.match(
    schema,
    /ON CONFLICT \(user_id, idempotency_key\) WHERE idempotency_key IS NOT NULL DO NOTHING/
  );
});

test('migration triển khai chạy trong transaction và tự kiểm tra quyền append-only', () => {
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;[\s\S]*invoices_ready/);
  assert.match(migration, /ledger_append_only/);
  assert.match(migration, /runtime_role_least_privilege/);
  assert.match(migration, /member\.rolname = 'tro_bill_runtime'/);
  assert.match(migration, /rolsuper OR rolcreatedb OR rolcreaterole OR rolinherit/);
  assert.match(
    migration,
    /REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rent_payment_transactions FROM tro_bill_runtime/
  );
  assert.match(migration, /GRANT SELECT, INSERT ON rent_payment_transactions TO tro_bill_runtime/);
  for (const privilege of ['UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER']) {
    assert.match(
      migration,
      new RegExp(`NOT has_table_privilege\\('tro_bill_runtime', 'rent_payment_transactions', '${privilege}'\\)`)
    );
  }
  assert.doesNotMatch(migration, /DROP\s+(TABLE|SCHEMA|DATABASE)/i);
  assert.doesNotMatch(migration, /^\s*TRUNCATE\s+/im);
});
