'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('runbook xử lý sai HĐĐT giữ cổng nghiệp vụ và không giả lập provider', () => {
  const runbook = fs.readFileSync(
    path.join(root, 'docs/E_INVOICE_CORRECTION_RUNBOOK.md'),
    'utf8'
  );
  const checklist = fs.readFileSync(path.join(root, 'MONETIZATION_CHECKLIST.md'), 'utf8');
  const decisions = fs.readFileSync(path.join(root, 'docs/AI_DECISIONS.md'), 'utf8');

  assert.match(runbook, /Thông báo sai sót/);
  assert.match(runbook, /Chọn điều chỉnh \*\*hoặc\*\* thay thế/);
  assert.match(runbook, /chênh lệch theo nghiệp vụ thực tế/);
  assert.match(runbook, /recordProviderStatus/);
  assert.match(runbook, /không có nút giả lập bước này/i);
  assert.match(runbook, /`cancelled` không phải lựa chọn mặc định/);
  assert.match(runbook, /vanban\.chinhphu\.vn/);
  assert.match(runbook, /xaydungchinhsach\.chinhphu\.vn/);

  assert.match(
    checklist,
    /- \[x\] Có quy trình điều chỉnh hoặc thay thế hóa đơn sai\./
  );
  assert.match(decisions, /## D-044 — Xử lý sai HĐĐT bắt đầu bằng phân loại/);
});
