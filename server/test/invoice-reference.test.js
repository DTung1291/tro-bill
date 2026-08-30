'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const InvoiceReference = require('../../invoice-reference');

test('mã chuyển khoản ngắn, ổn định và khôi phục đúng invoice ID', () => {
  assert.equal(InvoiceReference.fromInvoiceId(1), 'HD00000001');
  assert.equal(InvoiceReference.fromInvoiceId(35), 'HD0000000Z');
  assert.equal(InvoiceReference.fromInvoiceId(36), 'HD00000010');
  assert.equal(InvoiceReference.fromInvoiceId(41), 'HD00000015');
  assert.equal(InvoiceReference.toInvoiceId('hd00000015'), '41');
  assert.equal(InvoiceReference.isValid('HD00000015'), true);
});

test('mỗi invoice ID tạo đúng một mã và chặn dữ liệu ngoài BIGSERIAL', () => {
  const references = new Set(
    Array.from({ length: 1000 }, (_, index) => InvoiceReference.fromInvoiceId(index + 1))
  );
  assert.equal(references.size, 1000);
  assert.equal(InvoiceReference.fromInvoiceId(0), '');
  assert.equal(InvoiceReference.fromInvoiceId(-1), '');
  assert.equal(InvoiceReference.fromInvoiceId('abc'), '');
  assert.equal(InvoiceReference.fromInvoiceId(InvoiceReference.MAX_BIGINT + 1n), '');
  assert.equal(InvoiceReference.toInvoiceId('HD00000000'), '');
  assert.equal(InvoiceReference.toInvoiceId('TB00000001'), '');
});

test('giao diện dùng mã riêng cho VietQR, bill và thao tác sao chép', () => {
  const root = path.join(__dirname, '..', '..');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const styleSource = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(htmlSource, /invoice-reference\.js\?v=84[\s\S]*app\.js\?v=105/);
  assert.match(htmlSource, /tự tạo mã chuyển khoản ngắn/);
  assert.doesNotMatch(htmlSource, /id="bank-pattern-input"/);
  assert.match(appSource, /InvoiceReference\.fromInvoiceId/);
  assert.match(appSource, /data-copy-transfer-reference/);
  assert.match(appSource, /NỘI DUNG CHUYỂN KHOẢN/);
  assert.match(styleSource, /bill-preview-transfer-reference/);
});
