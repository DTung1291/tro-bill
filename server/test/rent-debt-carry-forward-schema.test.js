'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
const migration = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '20260825_rent_debt_carry_forward.sql'),
  'utf8'
);
const receipts = schema.match(/CREATE TABLE IF NOT EXISTS rent_payment_receipts \(([\s\S]*?)\n\);/);
const transactions = schema.match(/CREATE TABLE IF NOT EXISTS rent_payment_transactions \(([\s\S]*?)\n\);/);

test('phiếu thu có mã/idempotency riêng và khóa đúng user', () => {
  assert.ok(receipts, 'Thiếu bảng rent_payment_receipts');
  assert.match(receipts[1], /UNIQUE \(user_id, id\)/);
  assert.match(receipts[1], /UNIQUE \(user_id, idempotency_key\)/);
  assert.match(receipts[1], /UNIQUE \(user_id, receipt_code\)/);
  assert.match(receipts[1], /amount_vnd\s+NUMERIC\(12, 0\) NOT NULL/);
  assert.match(receipts[1], /CHECK \(amount_vnd > 0\)/);
  assert.match(receipts[1], /target_period ~ '\^\[0-9\]/);
});

test('mỗi phiếu chỉ phân bổ một dòng cho mỗi hóa đơn cùng user', () => {
  assert.ok(transactions, 'Thiếu bảng rent_payment_transactions');
  assert.match(transactions[1], /receipt_id\s+BIGINT/);
  assert.match(
    transactions[1],
    /FOREIGN KEY \(user_id, receipt_id\)[\s\S]*REFERENCES rent_payment_receipts\(user_id, id\)/
  );
  assert.match(
    schema,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_rent_payment_receipt_invoice[\s\S]*\(user_id, receipt_id, invoice_id\)/
  );
});

test('runtime chỉ được thêm/đọc phiếu thu và không sửa hoặc xóa', () => {
  assert.match(
    schema,
    /REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rent_payment_receipts FROM tro_bill_runtime/
  );
  assert.match(schema, /GRANT SELECT, INSERT ON rent_payment_receipts TO tro_bill_runtime/);
  assert.match(
    schema,
    /GRANT USAGE, SELECT ON SEQUENCE rent_payment_receipts_id_seq TO tro_bill_runtime/
  );
});

test('migration nợ cũ chạy transaction, idempotent và tự kiểm tra quyền', () => {
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS receipt_id BIGINT/);
  assert.match(migration, /IF NOT EXISTS \([\s\S]*rent_payment_transactions_receipt_owner_fk/);
  assert.match(migration, /COMMIT;[\s\S]*receipts_ready/);
  assert.match(migration, /receipts_append_only/);
  assert.match(migration, /ledger_append_only/);
  assert.doesNotMatch(migration, /DROP\s+(TABLE|SCHEMA|DATABASE)/i);
  assert.doesNotMatch(migration, /^\s*TRUNCATE\s+/im);
});
