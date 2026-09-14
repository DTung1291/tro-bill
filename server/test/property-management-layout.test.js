'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

test('popup quản lý khu có ngữ nghĩa dialog và phần tổng quan vận hành', () => {
  assert.match(
    html,
    /id="property-modal"[\s\S]*role="dialog" aria-modal="true" aria-labelledby="property-modal-title" aria-describedby="property-modal-description"/
  );
  assert.match(html, /class="property-overview"[\s\S]*id="property-total-count"[\s\S]*id="property-room-total"[\s\S]*id="property-default-name"/);
  assert.match(app, /function renderPropertyOverview\(\)[\s\S]*STATE\.properties\.length[\s\S]*STATE\.rooms\.length/);
});

test('danh sách khu và form thêm sửa là hai bề mặt có phân cấp riêng', () => {
  assert.match(
    html,
    /class="property-workspace"[\s\S]*class="property-directory"[\s\S]*id="property-list"[\s\S]*id="property-form" data-mode="create"/
  );
  assert.match(html, /id="property-form-mode"[\s\S]*id="property-form-title"[\s\S]*id="property-form-help"/);
  assert.match(app, /form\.dataset\.mode = 'create'/);
  assert.match(app, /property-form'\)\.dataset\.mode = 'edit'/);
  assert.match(app, /property-card\.is-editing/);
});

test('thẻ khu ưu tiên số phòng, trạng thái mặc định và giải thích điều kiện xóa', () => {
  assert.match(app, /class="property-card__room-count">\$\{count\} phòng/);
  assert.match(app, /class="property-default-label">Mặc định/);
  assert.match(app, /Chuyển hết phòng sang khu khác để có thể xóa\./);
  assert.match(app, /property\.address \? `<span>📍 \$\{escapeHtml\(property\.address\)\}/);
  assert.match(app, /property\.note \? `<span>📝 \$\{escapeHtml\(property\.note\)\}/);
});

test('popup khóa chiều cao, chỉ cuộn thân và form bám khi xem danh sách dài', () => {
  assert.match(css, /\.modal\.property-modal\s*\{[\s\S]*?display:\s*flex;[\s\S]*?overflow:\s*hidden;/);
  assert.match(css, /\.property-modal-body\s*\{[\s\S]*?overflow-y:\s*auto;[\s\S]*?overscroll-behavior:\s*contain;/);
  assert.match(css, /\.property-workspace\s*\{[\s\S]*?grid-template-columns:\s*minmax\(0, 1\.25fr\) minmax\(280px, \.75fr\)/);
  assert.match(css, /\.property-form\s*\{[\s\S]*?position:\s*sticky;[\s\S]*?top:\s*0;/);
});

test('tablet và mobile thu bố cục an toàn, asset pin được tăng', () => {
  assert.match(css, /@media \(max-width:\s*760px\)[\s\S]*?\.property-workspace\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(css, /@media \(max-width:\s*480px\)[\s\S]*?\.property-card\s*\{\s*grid-template-columns:\s*auto minmax\(0, 1fr\);/);
  assert.match(css, /@media \(max-width:\s*480px\)[\s\S]*?\.property-form-actions\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\);/);
  assert.match(html, /href="style\.css\?v=157"[\s\S]*src="app\.js\?v=154"/);
});
