'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const DebtAge = require('../../debt-age');

test('hạn hóa đơn cũ là issued_at + 10 ngày và hỗ trợ xem trước số ngày cấu hình', () => {
  // Phát hành 2026-08-01, hạn = 2026-08-11
  const withIssuedAt = DebtAge.classify('2026-08', 3000000, {
    issuedAt: '2026-08-01T08:00:00.000Z',
    now: '2026-08-11T16:59:59.000Z'
  });
  assert.equal(withIssuedAt.dueDate, '2026-08-11');
  assert.equal(withIssuedAt.overdueDays, 0);
  assert.equal(withIssuedAt.bucket, DebtAge.BUCKETS.NOT_DUE);

  // Ngày tiếp theo (12/08) thì quá hạn
  const nextDay = DebtAge.classify('2026-08', 3000000, {
    issuedAt: '2026-08-01T08:00:00.000Z',
    now: '2026-08-11T17:00:00.000Z'
  });
  assert.equal(nextDay.overdueDays, 1);
  assert.equal(nextDay.bucket, DebtAge.BUCKETS.OVERDUE_1_7);
  assert.equal(DebtAge.dueDate('khong-hop-le', '2026-08-01T08:00:00.000Z'), '');
  assert.equal(
    DebtAge.dueDate('2026-08', '2026-08-01T18:00:00.000Z', 'Asia/Ho_Chi_Minh'),
    '2026-08-12'
  );
  assert.equal(
    DebtAge.dueDate('2026-08', '2026-08-01T18:00:00.000Z', 'Asia/Ho_Chi_Minh', 20),
    '2026-08-22'
  );
});

test('snapshot dueDate được ưu tiên và không bị tính lại từ issuedAt', () => {
  const result = DebtAge.classify('2026-08', 3000000, {
    issuedAt: '2026-08-01T08:00:00.000Z',
    dueDate: '2026-09-01',
    now: '2026-08-31T17:00:00.000Z'
  });
  assert.equal(result.dueDate, '2026-09-01');
  assert.equal(result.overdueDays, 0);
  assert.equal(result.bucket, DebtAge.BUCKETS.NOT_DUE);
  assert.equal(DebtAge.isDateKey('2026-02-29'), false);
  assert.equal(DebtAge.isDateKey('2028-02-29'), true);
});

test('fallback về cuối tháng khi không có issuedAt (hóa đơn cũ)', () => {
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
  // Fallback về cuối tháng khi không có issuedAt
  assert.equal(DebtAge.dueDate('2028-02'), '2028-02-29');
  // Với issuedAt, tính issued_at + 10 ngày
  assert.equal(DebtAge.dueDate('2028-02', '2028-02-01T00:00:00Z'), '2028-02-11');
});

test('giao diện nạp bộ phân loại trước app và hiển thị tuổi nợ', () => {
  const root = path.join(__dirname, '..', '..');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const styleSource = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(htmlSource, /debt-age\.js\?v=85[\s\S]*app\.js\?v=148/);
  assert.match(appSource, /oldestPriorDebtInvoiceFromLoadedInvoices/);
  assert.match(appSource, /issuedAt: debtAgeIssuedAt/);
  assert.match(appSource, /debtAgeBadge\(payment\)/);
  assert.match(appSource, /debtAgeMessageLine\(payment\)/);
  assert.match(styleSource, /debt-age-badge--overdue-31-plus/);
});
