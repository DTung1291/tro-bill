'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

function modalMarkup(id, nextComment) {
  const start = html.indexOf(`id="${id}"`);
  assert.notEqual(start, -1, `missing ${id}`);
  const end = html.indexOf(nextComment, start);
  assert.notEqual(end, -1, `missing boundary after ${id}`);
  return html.slice(start, end);
}

test('các popup phụ dùng chung cấu trúc header, body cuộn và footer cố định', () => {
  assert.match(html, /class="modal auxiliary-modal donate-payment-modal" role="dialog" aria-modal="true"/);
  assert.match(html, /class="modal auxiliary-modal subscription-refund-modal" role="dialog" aria-modal="true"/);
  assert.match(html, /class="modal auxiliary-modal subscription-receipt-modal" role="dialog" aria-modal="true"/);
  assert.match(html, /class="modal auxiliary-modal privacy-action-modal" role="dialog" aria-modal="true"/);
  assert.match(css, /\.modal\.auxiliary-modal\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*overflow:\s*hidden;/s);
  assert.match(css, /\.auxiliary-modal-body\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;/s);
  assert.match(css, /\.auxiliary-modal-actions\s*\{[^}]*flex:\s*0 0 auto;[^}]*border-top:/s);
});

test('popup ủng hộ bỏ CSS nội tuyến và ưu tiên QR cùng thông tin đối chiếu', () => {
  const donate = modalMarkup('donate-modal', '<!-- MODAL: Thanh toán gói TrọBill -->');
  assert.doesNotMatch(donate, /style="/);
  assert.match(donate, /class="auxiliary-modal-body donate-payment-body"[\s\S]*class="donate-qr-panel"[\s\S]*class="donate-transfer-panel"/);
  assert.match(donate, /id="donate-account-num"[\s\S]*id="btn-copy-donate-account"/);
  assert.match(donate, /id="donate-modal-close-footer"/);
  assert.match(css, /\.donate-payment-body\s*\{[^}]*grid-template-columns:\s*minmax\(230px,\s*\.8fr\) minmax\(0,\s*1\.2fr\)/s);
  assert.match(app, /function closeDonateModal\(\)[\s\S]*qrImg\.removeAttribute\('src'\)/);
});

test('popup hỗ trợ thanh toán trình bày quy trình và trạng thái gửi rõ ràng', () => {
  assert.match(html, /class="auxiliary-flow" aria-label="Quy trình xử lý yêu cầu"/);
  assert.match(html, /class="subscription-refund-payment-card"[\s\S]*id="subscription-refund-payment"/);
  assert.match(html, /Yêu cầu không tự xác nhận thanh toán/);
  assert.match(app, /submitButton\.textContent = 'Đang gửi…';[\s\S]*form\.setAttribute\('aria-busy', 'true'\)/);
  assert.match(css, /\.subscription-refund-fields\s*\{[^}]*grid-template-columns:/s);
});

test('popup quyền riêng tư phân biệt xóa dữ liệu và đưa lỗi vào vùng truy cập được', () => {
  const privacy = modalMarkup('privacy-action-modal', '<!-- MODAL: OCR Camera -->');
  assert.doesNotMatch(privacy, /style="/);
  assert.match(privacy, /aria-describedby="privacy-action-description"/);
  assert.match(privacy, /id="privacy-action-error" role="alert" tabindex="-1" hidden/);
  assert.match(privacy, /class="privacy-action-audit-note"/);
  assert.match(app, /modal\.dataset\.mode = mode;/);
  assert.match(app, /errorEl\.hidden = false;\s*errorEl\.focus\(\);/);
  assert.match(css, /\.privacy-action-modal\[data-mode="delete"\] \.privacy-action-summary/);
});

test('popup phụ thu về một cột và nút toàn chiều rộng trên mobile', () => {
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.auxiliary-flow\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.donate-payment-body\s*\{\s*grid-template-columns:\s*minmax\(0,\s*1fr\)/);
  assert.match(css, /@media \(max-width: 560px\)[\s\S]*\.auxiliary-modal-actions \.btn\s*\{[^}]*width:\s*100%;/s);
  assert.match(html, /href="style\.css\?v=165"[\s\S]*src="app\.js\?v=164"/);
});
