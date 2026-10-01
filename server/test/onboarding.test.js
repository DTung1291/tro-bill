'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { getProgress } = require('../../onboarding');

const root = path.resolve(__dirname, '../..');
const room = { id: 'room-1', waterType: 'khối' };

test('tiến độ bắt đầu lấy từ dữ liệu thật và khu mặc định được tính đúng', () => {
  assert.equal(getProgress().completed, 0);
  assert.deepEqual(getProgress({ properties: [{ id: 1 }] }), {
    steps: [
      { id: 'property', status: 'done' },
      { id: 'room', status: 'pending' },
      { id: 'reading', status: 'pending' },
      { id: 'bill', status: 'pending' }
    ],
    completed: 1,
    next: 'room'
  });
  assert.equal(getProgress({ properties: [{ id: 1 }], rooms: [room] }).next, 'reading');
});

test('chỉ số thiếu nước chưa hoàn tất; hóa đơn chưa xác minh không bị nhận nhầm', () => {
  const base = { properties: [{ id: 1 }], rooms: [room] };
  assert.equal(getProgress({ ...base, billingData: { '2026-10': { 'room-1': { electricNew: 15 } } } }).completed, 2);
  const reading = { ...base, billingData: { '2026-10': { 'room-1': { electricNew: 15, waterNew: 4 } } } };
  assert.equal(getProgress(reading).steps[2].status, 'done');
  assert.equal(getProgress(reading).steps[3].status, 'unknown');
  assert.equal(getProgress({ ...reading, invoicesAvailable: true }).steps[3].status, 'pending');
  assert.equal(getProgress({ ...reading, invoices: [{ id: 1 }] }).completed, 4);
});

test('bill lịch sử giữ tài khoản đã bắt đầu hoàn tất ngay cả khi dọn phòng cũ', () => {
  const progress = getProgress({ history: [{ period: '2026-09', bills: [{ roomId: 'old-room' }] }] });
  assert.equal(progress.completed, 4);
  assert.equal(progress.next, null);
  assert.equal(getProgress({ rooms: [{ id: 'room-2', waterType: 'người', peopleCount: 2 }],
    billingData: { '2026-10': { 'room-2': { electricNew: 0 } } } }).steps[2].status, 'done');
});

test('checklist chỉ ở dashboard chủ trọ, script nạp trước app và không thêm API/schema', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.match(html, /id="onboarding-card"[^>]*hidden/);
  assert.match(html, /onboarding\.js\?v=1/);
  assert.ok(html.indexOf('onboarding.js?v=1') < html.indexOf('app.js?v=175'));
  assert.match(app, /if \(!isOwnerWorkspace\(\) \|\| !SERVER_ENTITLEMENTS\.features\?\.roomManagement\?\.enabled\)/);
  assert.match(app, /function renderDashboard\(\) \{[\s\S]*?renderOnboarding\(\)/);
});
