'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('ICP pilot chốt đúng mẫu nhưng không tự khai bằng chứng phỏng vấn', () => {
  const profile = fs.readFileSync(path.join(root, 'docs/PILOT_CUSTOMER_PROFILE.md'), 'utf8');
  const log = fs.readFileSync(path.join(root, 'docs/PILOT_INTERVIEW_LOG.md'), 'utf8');
  const checklist = fs.readFileSync(path.join(root, 'MONETIZATION_CHECKLIST.md'), 'utf8');
  const decisions = fs.readFileSync(path.join(root, 'docs/AI_DECISIONS.md'), 'utf8');

  assert.match(profile, /chủ trọ trực tiếp vận hành 10–50 phòng/i);
  assert.match(profile, /ít nhất hai kỳ bill/i);
  assert.match(profile, /Không commit tên, email, số điện thoại, địa chỉ, CCCD/i);
  assert.match(profile, /Chỉ đánh dấu mục “phỏng vấn ít nhất 10 chủ trọ” khi có đủ 10 biên bản/);
  assert.equal((log.match(/\| I\d{2} \| Chưa thực hiện \|/g) || []).length, 10);
  assert.match(log, /Một hàng\s+`Chưa thực hiện` chỉ là chỗ giữ chỗ và \*\*không\*\* được tính/);
  assert.match(log, /Không ghi tên, email, số điện thoại, địa chỉ cụ thể, CCCD/);

  assert.match(
    checklist,
    /- \[x\] Xác định khách hàng mục tiêu ban đầu: chủ trọ có 10–50 phòng\./
  );
  assert.match(
    checklist,
    /- \[ \] Phỏng vấn ít nhất 10 chủ trọ về quy trình lập bill, thu tiền và nhắc nợ\./
  );
  assert.match(decisions, /## D-045 — Pilot đầu tiên chỉ tính đúng mẫu chủ trọ/);
});
