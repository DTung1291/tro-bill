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
  assert.match(app, /class="bill-preview-summary" aria-label="Tóm tắt công nợ"[\s\S]*class="bill-preview-layout"[\s\S]*class="bill-preview-meta"[\s\S]*class="bill-preview-details"/);
  assert.match(app, /class="bill-preview-summary-total"><span>Tổng cần trả/);
  assert.match(app, /document\.getElementById\('bill-preview-context'\)\.textContent = `\$\{periodLabel\(period\)\}/);
});

test('hóa đơn tải, upload và hiển thị ảnh đồng hồ điện nước theo đúng phòng và kỳ', () => {
  assert.match(app, /function billPreviewMeterPhotosMarkup/);
  assert.match(app, /data-meter-photo-upload="\$\{type\}"/);
  assert.match(app, /API\.getRentMeterPhotos\(room\.id, period\)/);
  assert.match(app, /API\.upsertRentMeterPhoto\(\{[\s\S]*?roomId: preview\.room\.id,[\s\S]*?period: preview\.period,[\s\S]*?meterType/);
  assert.match(app, /\{ photoOnly: true \}/);
  assert.match(css, /\.bill-preview-meter-grid\s*\{[\s\S]*?grid-template-columns:\s*repeat\(2, minmax\(0, 1fr\)\);/);
  assert.match(css, /\.bill-preview-meter-photo-frame\s*\{[\s\S]*?height:\s*clamp\(150px, 22vw, 240px\);/);
  assert.match(css, /#bill-preview-modal \.bill-preview-layout\s*\{[^}]*column-gap:\s*24px;[^}]*row-gap:\s*24px;/);
  assert.match(css, /#bill-preview-modal \.bill-preview-info,[\s\S]*?#bill-preview-modal \.bill-preview-qr-panel\s*\{[^}]*margin:\s*0;/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?#bill-preview-modal \.bill-preview-layout\s*\{[^}]*row-gap:\s*20px;/);
  assert.match(css, /@media \(max-width: 760px\)[\s\S]*?#bill-preview-modal \.bill-preview-qr-panel\s*\{[^}]*margin-top:\s*0;/);
});

test('bản in hóa đơn dùng trang A4 riêng và bố cục compact một trang', () => {
  assert.match(app, /printArea\.innerHTML\s*=\s*`[\s\S]*?<article class="single-bill-print">[\s\S]*?<div class="bill-preview-content">[\s\S]*?buildBillPreviewContent\(room, rec, bill, period, meterPhotoState\)/);
  assert.match(css, /body:has\(\.single-bill-print\)\s*\{\s*page:\s*singleBill;/);
  assert.match(css, /@page singleBill\s*\{[\s\S]*?size:\s*A4 portrait;[\s\S]*?margin:\s*8mm;/);
  assert.match(css, /\.single-bill-print \.bill-preview-content\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1fr\) 66mm;[\s\S]*?column-gap:\s*5mm;/);
  assert.match(css, /\.single-bill-print \.bill-preview-payment-hero\s*\{\s*display:\s*none;/);
  assert.match(css, /\.single-bill-print \.bill-preview-layout,[\s\S]*?\.single-bill-print \.bill-preview-info\s*\{\s*display:\s*contents !important;/);
  assert.match(css, /\.single-bill-print \.bill-preview-summary\s*\{[^}]*grid-column:\s*1;[^}]*grid-row:\s*3;/);
  assert.match(css, /\.single-bill-print \.bill-preview-meter-photos\s*\{[^}]*grid-column:\s*1 \/ -1;[^}]*grid-row:\s*4;/);
  assert.match(css, /\.single-bill-print \.bill-preview-qr-panel\s*\{[^}]*max-width:\s*66mm;[^}]*overflow:\s*hidden;/);
  assert.match(css, /\.single-bill-print \.bill-preview-meter-photo-frame\s*\{[^}]*width:\s*100%;[^}]*height:\s*auto;[^}]*aspect-ratio:\s*16 \/ 9;[^}]*max-height:\s*none;/);
  assert.match(css, /\.single-bill-print \.bill-preview-meter-photo-card\s*\{[^}]*border:\s*0;/);
  assert.match(css, /\.single-bill-print \.bill-preview-qr-frame\s*\{[^}]*padding:\s*6px;[^}]*border:\s*1px solid #ddd;/);
  assert.match(css, /\.single-bill-print \.bill-preview-summary-total strong\s*\{\s*color:\s*var\(--primary\);/);
  assert.match(css, /\.single-bill-print \.bill-preview-transfer-reference \.btn\s*\{[^}]*display:\s*inline-flex;/);
  assert.match(css, /\.single-bill-print \.bill-preview-meter-photos\.is-empty\s*\{\s*display:\s*none;/);
  assert.match(css, /\.single-bill-print \.bill-preview-meter-upload\s*\{\s*display:\s*none;/);
  assert.match(app, /bill-preview-print-debt-age[\s\S]*?Tuổi nợ:/);
  assert.match(css, /\.single-bill-print \.bill-preview-print-debt-age\s*\{\s*display:\s*flex;/);
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
  assert.match(html, /href="style\.css\?v=157"[\s\S]*src="api\.js\?v=117"[\s\S]*src="ocr\.js\?v=94"[\s\S]*src="app\.js\?v=154"/);
});
