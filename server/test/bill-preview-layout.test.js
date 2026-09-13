'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

test('popup hóa đơn có ngữ nghĩa dialog và phân nhóm hành động theo công việc', () => {
  assert.match(html, /class="modal bill-preview-modal"[^>]*role="dialog"[^>]*aria-modal="true"/);
  assert.match(html, /aria-labelledby="bill-preview-title"[^>]*aria-describedby="bill-preview-context"/);
  assert.match(html, /class="bill-preview-kicker">Kiểm tra và gửi hóa đơn/);
  assert.match(html, /class="bill-preview-delivery-actions"[^>]*aria-label="Gửi hóa đơn cho khách thuê"/);
  assert.match(html, /id="bill-preview-share-link">🔗 Tạo link/);
  assert.match(html, /id="bill-preview-message-template">💬 Soạn tin nhắn/);
  assert.match(html, /class="bill-preview-primary-actions"/);
});

test('nội dung ưu tiên trạng thái và tổng công nợ trước chi tiết khoản thu', () => {
  assert.match(app, /const paymentState = remaining === 0[\s\S]*'settled'[\s\S]*payment\.overdueDays > 0[\s\S]*'overdue'/);
  assert.match(app, /class="bill-preview-payment-hero bill-preview-payment-hero--\$\{paymentState\}"/);
  assert.match(app, /class="bill-preview-summary" aria-label="Tóm tắt công nợ"[\s\S]*class="bill-preview-meta"[\s\S]*class="bill-preview-details"/);
  assert.match(app, /class="bill-preview-summary-total"><span>Tổng cần trả/);
  assert.match(app, /document\.getElementById\('bill-preview-context'\)\.textContent = `\$\{periodLabel\(period\)\}/);
});

test('popup giữ header và footer trong viewport, chỉ cuộn nội dung', () => {
  assert.match(css, /\.modal\.bill-preview-modal\s*\{[\s\S]*?display:\s*flex;[\s\S]*?flex-direction:\s*column;[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.bill-preview-content\s*\{[\s\S]*?flex:\s*1 1 auto;[\s\S]*?overflow-y:\s*auto;/);
  assert.match(css, /\.bill-preview-footer\s*\{[\s\S]*?flex:\s*0 0 auto;/);
});

test('popup hóa đơn xếp hành động rõ ràng trên tablet và mobile', () => {
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.bill-preview-footer\s*\{[^}]*flex-direction:\s*column;/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?\.bill-preview-primary-actions\s*\{[^}]*grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*?\.bill-preview-primary-actions\s*\{[^}]*grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(css, /@media \(max-width: 480px\)[\s\S]*?\.bill-preview-footer \.btn\s*\{[^}]*width:\s*100%;/);
});

test('asset pin tải đúng CSS và JavaScript của lát cắt hóa đơn', () => {
  assert.match(html, /href="style\.css\?v=147"[\s\S]*src="app\.js\?v=149"/);
});
