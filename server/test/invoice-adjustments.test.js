'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const InvoiceAdjustments = require('../../invoice-adjustments');

const root = path.join(__dirname, '..', '..');
const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
const migration = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '20260825_invoice_adjustments.sql'),
  'utf8'
);
const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

test('giảm giá, phụ thu và phí chậm được tính riêng trên tổng hóa đơn', () => {
  const result = InvoiceAdjustments.calculate(3000000, {
    discountAmount: 100000,
    surchargeAmount: 50000,
    lateFeeAmount: 20000
  });

  assert.deepEqual(result, {
    subtotalVnd: 3000000,
    discountAmount: 100000,
    requestedDiscountAmount: 100000,
    surchargeAmount: 50000,
    lateFeeAmount: 20000,
    adjustmentNetVnd: -30000,
    totalVnd: 2970000
  });
  assert.equal(InvoiceAdjustments.hasAdjustments(result), true);
  assert.equal(InvoiceAdjustments.hasAdjustments({}), false);
  assert.equal(InvoiceAdjustments.hasAdjustments({ lateFeeAmount: 1 }), true);
});

test('giảm giá không làm tổng hóa đơn âm và số tiền được làm tròn theo VND', () => {
  const result = InvoiceAdjustments.calculate(100000.4, {
    discountAmount: 500000,
    surchargeAmount: 99.6
  });

  assert.equal(result.subtotalVnd, 100000);
  assert.equal(result.surchargeAmount, 100);
  assert.equal(result.discountAmount, 100100);
  assert.equal(result.totalVnd, 0);
  assert.equal(InvoiceAdjustments.amount(-1), 0);
});

test('schema và migration lưu điều chỉnh ở dữ liệu tháng lẫn lịch sử', () => {
  for (const field of ['discount_amount', 'surcharge_amount', 'late_fee_amount']) {
    assert.match(schema, new RegExp(`${field}\\s+NUMERIC\\(12, 0\\) NOT NULL DEFAULT 0`));
    assert.match(migration, new RegExp(`ADD COLUMN IF NOT EXISTS ${field}`));
  }
  assert.match(schema, /billing_entries_adjustments_nonnegative/);
  assert.match(schema, /history_bills_adjustments_nonnegative/);
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;[\s\S]*billing_adjustments_ready/);
  assert.doesNotMatch(migration, /DROP\s+(TABLE|SCHEMA|DATABASE)/i);
});

test('giao diện nhập đủ ba khoản và khóa điều chỉnh sau khi đã thu tiền', () => {
  assert.match(htmlSource, /invoice-adjustments\.js\?v=81/);
  assert.match(appSource, /data-adjustment-field="discountAmount"/);
  assert.match(appSource, /data-adjustment-field="surchargeAmount"/);
  assert.match(appSource, /data-adjustment-field="lateFeeAmount"/);
  assert.match(appSource, /adjustmentsLocked/);
  assert.match(appSource, /InvoiceAdjustments\.calculate/);
  assert.match(appSource, /Phí chậm thanh toán/);
});
