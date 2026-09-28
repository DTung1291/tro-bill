'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');
const { toIso, toDisplay } = require('../../date-input');

test('ngày hiển thị dd/mm/yyyy nhưng app vẫn nhận ISO', () => {
  assert.equal(toDisplay('2026-09-28', false), '28/09/2026');
  assert.equal(toIso('28/09/2026', false), '2026-09-28');
  assert.equal(toIso('1/2/2028', false), '2028-02-01');
  assert.equal(toIso('', false), '');
});

test('từ chối ngày không tồn tại và thứ tự mm/dd/yyyy', () => {
  assert.equal(toIso('29/02/2028', false), '2028-02-29');
  assert.equal(toIso('29/02/2026', false), null);
  assert.equal(toIso('31/04/2026', false), null);
  assert.equal(toIso('2026-09-28', false), null);
});

test('ngày giờ xác nhận payment cũng hiển thị ngày trước tháng', () => {
  assert.equal(toDisplay('2026-09-28T13:05', true), '28/09/2026 13:05');
  assert.equal(toIso('28/09/2026 13:05', true), '2026-09-28T13:05');
  assert.equal(toIso('28/09/2026 24:05', true), null);
});

test('trang chủ và admin đều nạp date control trước code màn hình', () => {
  for (const page of ['index.html', 'admin.html']) {
    const html = fs.readFileSync(path.join(root, page), 'utf8');
    assert.match(html, /date-input\.css\?v=1/);
    assert.match(html, /date-input\.js\?v=4/);
    assert.ok(html.indexOf('date-input.js?v=4') < html.indexOf(page === 'index.html' ? 'app.js?v=' : 'admin.js?v='));
  }
});
