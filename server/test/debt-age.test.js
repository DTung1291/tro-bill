'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const DebtAge = require('../../debt-age');

test('hạn hóa đơn là ngày cuối tháng và ngày kế tiếp mới quá hạn', () => {
  const atDueDate = DebtAge.classify('2026-08', 3000000, {
    now: '2026-08-31T16:59:59.000Z'
  });
  assert.equal(atDueDate.dueDate, '2026-08-31');
  assert.equal(atDueDate.overdueDays, 0);
  assert.equal(atDueDate.bucket, DebtAge.BUCKETS.NOT_DUE);

  const nextVietnamDay = DebtAge.classify('2026-08', 3000000, {
    now: '2026-08-31T17:00:00.000Z'
  });
  assert.equal(nextVietnamDay.overdueDays, 1);
  assert.equal(nextVietnamDay.bucket, DebtAge.BUCKETS.OVERDUE_1_7);
});

test('phân loại đúng các mốc 7, 8, 30 và 31 ngày', () => {
  const classifyAtVietnamNoon = (day) => DebtAge.classify('2026-08', 1, {
    now: `${day}T05:00:00.000Z`
  });

  assert.equal(classifyAtVietnamNoon('2026-09-07').bucket, DebtAge.BUCKETS.OVERDUE_1_7);
  assert.equal(classifyAtVietnamNoon('2026-09-07').overdueDays, 7);
  assert.equal(classifyAtVietnamNoon('2026-09-08').bucket, DebtAge.BUCKETS.OVERDUE_8_30);
  assert.equal(classifyAtVietnamNoon('2026-09-30').overdueDays, 30);
  assert.equal(classifyAtVietnamNoon('2026-10-01').bucket, DebtAge.BUCKETS.OVERDUE_31_PLUS);
  assert.equal(classifyAtVietnamNoon('2026-10-01').overdueDays, 31);
});

test('không gắn tuổi quá hạn khi đã thu đủ và hỗ trợ tháng nhuận', () => {
  const settled = DebtAge.classify('2026-01', 0, { now: '2026-08-25T05:00:00.000Z' });
  assert.equal(settled.bucket, DebtAge.BUCKETS.SETTLED);
  assert.equal(settled.isOverdue, false);
  assert.equal(DebtAge.dueDate('2028-02'), '2028-02-29');
});

test('giao diện nạp bộ phân loại trước app và hiển thị tuổi nợ', () => {
  const root = path.join(__dirname, '..', '..');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const styleSource = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(htmlSource, /debt-age\.js\?v=83[\s\S]*app\.js\?v=85/);
  assert.match(appSource, /oldestPriorDebtPeriodFromLoadedInvoices/);
  assert.match(appSource, /debtAgeBadge\(payment\)/);
  assert.match(appSource, /debtAgeMessageLine\(payment\)/);
  assert.match(styleSource, /debt-age-badge--overdue-31-plus/);
});
