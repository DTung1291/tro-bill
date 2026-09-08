'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-security-reporting-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');

test('quy trình báo cáo bảo mật dùng kênh riêng tư và không hứa SLA chưa duyệt', () => {
  const security = fs.readFileSync(path.join(root, 'SECURITY.md'), 'utf8');
  const operations = fs.readFileSync(path.join(root, 'OPERATIONS.md'), 'utf8');

  assert.match(security, /Report a vulnerability/);
  assert.match(security, /Không đăng[^\n]+cookie[^\n]+CCCD/);
  assert.match(security, /dữ liệu giả/);
  assert.match(security, /Chưa có SLA phản hồi công khai/);
  assert.match(operations, /GitHub Private Vulnerability Reporting/);
  assert.match(operations, /rotate credential/);
});
