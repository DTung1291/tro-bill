'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');

test('migration lưu snapshot hạn hóa đơn, backfill dữ liệu cũ và khóa sửa hạn', () => {
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260912_invoice_due_date_policy.sql'),
    'utf8'
  );
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS invoice_due_days SMALLINT NOT NULL DEFAULT 10/);
  assert.match(migration, /invoice_due_days BETWEEN 1 AND 90/);
  assert.match(migration, /SET due_date=\(\(issued_at AT TIME ZONE 'Asia\/Ho_Chi_Minh'\)::date \+ 10\)/);
  assert.match(migration, /ALTER COLUMN due_date SET NOT NULL/);
  assert.match(migration, /NEW\.due_date IS DISTINCT FROM OLD\.due_date/);
  assert.match(migration, /REVOKE UPDATE ON rent_invoices/);
  assert.match(migration, /NOT has_column_privilege\('tro_bill_runtime_sql', 'rent_invoices', 'due_date', 'UPDATE'\)/);
  assert.match(migration, /COMMIT;/);
});

test('mọi đường phát hành đều chụp hạn từ setting và các consumer đọc due_date', () => {
  const payments = fs.readFileSync(path.join(root, 'server', 'rent-payments.js'), 'utf8');
  const schedules = fs.readFileSync(path.join(root, 'server', 'rent-invoice-schedules.js'), 'utf8');
  const links = fs.readFileSync(path.join(root, 'server', 'rent-invoice-links.js'), 'utf8');
  const insertStatements = [...payments.matchAll(/INSERT INTO rent_invoices[\s\S]*?ON CONFLICT/g)];

  assert.equal(insertStatements.length, 3);
  for (const [statement] of insertStatements) {
    assert.match(statement, /due_date/);
    assert.match(statement, /SELECT invoice_due_days FROM settings WHERE user_id=\$1/);
  }
  assert.match(payments, /i\.due_date/);
  assert.match(payments, /oldest_unpaid_due_date/);
  assert.match(schedules, /invoice\.due_date/);
  assert.doesNotMatch(schedules, /issued_at AT TIME ZONE 'Asia\/Ho_Chi_Minh'[\s\S]*\+ 10/);
  assert.match(links, /dueDate: row\.due_date/);
  assert.match(links, /invoice\.due_date/);
});
