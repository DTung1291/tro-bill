'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('hóa đơn công khai ưu tiên thanh toán và thu gọn an toàn trên mobile', () => {
  const html = fs.readFileSync(path.join(root, 'invoice.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'invoice-public.css'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'invoice-public.js'), 'utf8');
  const refreshCss = css.slice(css.indexOf('HÓA ĐƠN CÔNG KHAI'));

  assert.match(html, /class="public-invoice-security"[\s\S]*Liên kết bảo mật/);
  assert.match(
    html,
    /id="invoice-remaining"[\s\S]*id="invoice-next-step"[\s\S]*id="invoice-payment"[\s\S]*id="invoice-payment-proof"[\s\S]*id="invoice-receipts"[\s\S]*id="invoice-details"[\s\S]*id="invoice-history"/
  );
  assert.equal((html.match(/class="public-invoice-copy-button"/g) || []).length, 2);
  assert.match(html, /invoice-public\.css\?v=8[\s\S]*invoice-public\.js\?v=8/);

  assert.match(js, /function renderNextStep\(invoice, options = \{\}\)/);
  assert.match(js, /invoice\?\.status === 'paid' \|\| remainingVnd === 0/);
  assert.match(js, /options\.hasProof[\s\S]*options\.hasPayment/);
  assert.match(js, /function copyInvoiceValue\(button\)/);
  assert.match(js, /navigator\.clipboard\?\.writeText/);
  assert.match(js, /renderNextStep\(activeInvoice \|\| \{ remainingVnd: 1 \}/);
  assert.match(js, /querySelectorAll\('\.public-invoice-copy-button'\)/);
  assert.doesNotMatch(js, /localStorage|sessionStorage|innerHTML|insertAdjacentHTML/);

  assert.match(refreshCss, /\.public-invoice-shell\s*\{[^}]*width:\s*min\(900px,/s);
  assert.match(refreshCss, /\.public-invoice-next-step\s*\{[^}]*grid-template-columns:\s*42px minmax\(0,\s*1fr\)/s);
  assert.match(refreshCss, /\.public-invoice-payment-layout\s*\{[^}]*minmax\(220px,\s*280px\)/s);
  assert.match(
    refreshCss,
    /@media\s*\(max-width:\s*680px\)[\s\S]*?\.public-invoice-payment-layout\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/
  );
  assert.match(
    refreshCss,
    /@media\s*\(max-width:\s*520px\)[\s\S]*?\.public-invoice-copy-row\s*\{[^}]*flex-direction:\s*column[\s\S]*?\.public-invoice-receipt-item button\s*\{[^}]*width:\s*100%/
  );
});
