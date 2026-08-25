'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { publicInvoiceJson } = require('../rent-invoice-links');

test('link hóa đơn chỉ trả phiếu thu đã phân bổ cho đúng hóa đơn', () => {
  const result = publicInvoiceJson({
    invoice_id: 41,
    room_name_snapshot: 'P403',
    period: '2026-08',
    issued_total_vnd: '3000000',
    paid_amount_vnd: '1200000',
    expires_at: '2099-08-28T00:00:00.000Z',
    receipts: [{
      receipt_code: 'PT-202608-00001F',
      receipt_total_vnd: '2200000',
      allocated_amount_vnd: '1200000',
      payment_method: 'bank_transfer',
      occurred_at: '2026-08-25T01:00:00.000Z'
    }]
  });

  assert.deepEqual(result.receipts, [{
    code: 'PT-202608-00001F',
    receiptTotalVnd: 2200000,
    allocatedAmountVnd: 1200000,
    paymentMethod: 'bank_transfer',
    occurredAt: '2026-08-25T01:00:00.000Z'
  }]);
  assert.equal('userId' in result.receipts[0], false);
  assert.equal('note' in result.receipts[0], false);
  assert.equal('source' in result.receipts[0], false);
});

test('truy vấn phiếu thu khóa user, invoice và loại giao dịch đã hoàn tác', () => {
  const root = path.join(__dirname, '..', '..');
  const source = fs.readFileSync(path.join(root, 'server', 'rent-invoice-links.js'), 'utf8');
  const query = source.match(
    /SELECT receipt\.receipt_code,[\s\S]*?LIMIT 20`/
  )?.[0] || '';

  assert.match(query, /WHERE tx\.user_id=\$1 AND tx\.invoice_id=\$2/);
  assert.match(query, /tx\.entry_type='payment' AND tx\.amount_vnd > 0/);
  assert.match(query, /reversal\.reverses_transaction_id=tx\.id/);
  assert.match(query, /HAVING SUM\(tx\.amount_vnd\) > 0/);
  assert.match(query, /JOIN rent_payment_receipts receipt/);
  assert.doesNotMatch(query, /receipt\.note|receipt\.source/);
});

test('trang khách thuê tải phiếu thu PNG từ dữ liệu xác nhận, không chèn HTML động', () => {
  const root = path.join(__dirname, '..', '..');
  const html = fs.readFileSync(path.join(root, 'invoice.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'invoice-public.js'), 'utf8');

  assert.match(html, /id="invoice-receipts"/);
  assert.match(html, /id="invoice-receipt-list"/);
  assert.match(html, /invoice-public\.css\?v=6[\s\S]*invoice-public\.js\?v=6/);
  assert.match(js, /function renderReceipts/);
  assert.match(js, /function downloadReceipt/);
  assert.match(js, /canvas\.toBlob\(resolve, 'image\/png'\)/);
  assert.match(js, /anchor\.download = `phieu-thu-/);
  assert.doesNotMatch(js, /innerHTML|document\.write/);
});
