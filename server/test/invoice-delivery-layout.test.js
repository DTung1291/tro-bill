'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

test('popup soạn tin có cấu trúc dialog và ba bước gửi hóa đơn rõ ràng', () => {
  assert.match(
    html,
    /id="bill-message-modal"[\s\S]*role="dialog" aria-modal="true" aria-labelledby="bill-message-title"/
  );
  assert.match(html, /aria-label="Quy trình gửi hóa đơn"/);
  assert.match(html, /Chọn người nhận[\s\S]*Kiểm tra nội dung[\s\S]*Gửi hoặc hẹn lịch/);
  assert.match(html, /id="bill-message-recipient-title"[\s\S]*id="bill-message-preview-title"[\s\S]*id="bill-message-schedule-title"/);
});

test('link bảo mật và luồng Zalo nằm cạnh nội dung, footer giữ các kênh còn lại', () => {
  assert.match(
    html,
    /id="bill-message-preview-title"[\s\S]*id="bill-message-create-link"[\s\S]*id="bill-message-content"/
  );
  assert.match(
    html,
    /class="bill-message-preview-grid"[\s\S]*id="bill-message-content"[\s\S]*id="bill-message-zalo-title">Gửi vào nhóm Zalo[\s\S]*id="bill-message-share">💬 Chuẩn bị &amp; chia sẻ Zalo[\s\S]*id="bill-message-zalo-web"[^>]*href="https:\/\/chat\.zalo\.me\/"/
  );
  const footer = html.match(/<div class="modal-actions bill-message-actions">([\s\S]*?)<\/div>\s*<\/div>\s*<\/div>\s*\n\s*<!-- MODAL: Secure tenant invoice link -->/)?.[1] || '';
  assert.match(footer, /id="bill-message-email"[\s\S]*id="bill-message-copy"/);
  assert.doesNotMatch(footer, /id="bill-message-create-link"|id="bill-message-share"/);
  assert.match(html, /id="bill-message-zalo-status" role="status" aria-live="polite"/);
  assert.match(app, /async function shareBillNative\([\s\S]*return 'shared';[\s\S]*return 'cancelled';[\s\S]*return copied === false \? 'copy_failed' : 'copied';/);
  assert.match(app, /async function shareBillMessageTemplate\([\s\S]*ensureBillMessageSystemLink\(\)[\s\S]*await shareBillNative\([\s\S]*updateBillMessageZaloStatus\(outcome\)/);
});

test('popup link hóa đơn giải thích tạo, gửi và theo dõi trước phần minh chứng', () => {
  assert.match(
    html,
    /id="invoice-share-modal"[\s\S]*role="dialog" aria-modal="true" aria-labelledby="invoice-share-title"/
  );
  assert.match(html, /aria-label="Quy trình chia sẻ hóa đơn"/);
  assert.match(html, /Tạo link[\s\S]*Gửi khách[\s\S]*Theo dõi/);
  assert.match(
    html,
    /id="invoice-share-create-title"[\s\S]*id="invoice-share-result"[\s\S]*id="invoice-share-history-title"[\s\S]*id="invoice-payment-proof-title"/
  );
  assert.match(html, /Minh chứng chỉ để kiểm tra[\s\S]*đối chiếu ngân hàng/);
});

test('hai popup khóa chiều cao, chỉ cuộn thân và thu thao tác về một cột trên mobile', () => {
  assert.match(css, /\.modal\.bill-message-modal\s*\{[\s\S]*?display:\s*flex;[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.modal\.invoice-share-modal\s*\{[\s\S]*?display:\s*flex;[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.bill-message-body\s*\{[\s\S]*?overflow-y:\s*auto;[\s\S]*?overscroll-behavior:\s*contain;/);
  assert.match(css, /\.invoice-share-body\s*\{[\s\S]*?overflow-y:\s*auto;[\s\S]*?overscroll-behavior:\s*contain;/);
  assert.match(css, /@media \(max-width:\s*480px\)[\s\S]*?\.bill-message-fields\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(css, /@media \(max-width:\s*480px\)[\s\S]*?\.bill-message-send-group > div\s*\{\s*display:\s*grid;\s*grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(css, /\.bill-message-preview-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1\.45fr\) minmax\(260px, \.8fr\);/s);
  assert.match(css, /@media \(max-width:\s*760px\)[\s\S]*?\.bill-message-preview-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(css, /@media \(max-width:\s*480px\)[\s\S]*?\.bill-message-zalo-panel\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
});

test('popup ưu tiên focus thao tác đầu, báo trạng thái tải và tăng asset pin', () => {
  assert.match(app, /bill-message-template-type'\)\?\.focus\(\)/);
  assert.match(app, /invoice-share-body'\);[\s\S]*setAttribute\('aria-busy', 'true'\)[\s\S]*removeAttribute\('aria-busy'\)/);
  assert.match(html, /href="style\.css\?v=164"[\s\S]*src="app\.js\?v=161"/);
});
