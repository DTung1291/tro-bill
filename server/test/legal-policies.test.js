'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  PRIVACY_POLICY_VERSION,
  TERMS_VERSION
} = require('../privacy-constants');

const root = path.join(__dirname, '..', '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('điều khoản và bảo mật dùng phiên bản mới, nêu đúng provider email hiện tại', () => {
  const terms = read('terms.html');
  const privacy = read('privacy.html');

  assert.equal(PRIVACY_POLICY_VERSION, '2026-09-08');
  assert.equal(TERMS_VERSION, '2026-09-08');
  assert.match(terms, /Phiên bản 08\/09\/2026/);
  assert.match(terms, /href="\/refund-policy\.html"/);
  assert.match(terms, /không.*loại trừ quyền khiếu nại/is);
  assert.match(privacy, /Phiên bản 08\/09\/2026/);
  assert.match(privacy, /Neon[\s\S]*Vercel[\s\S]*Brevo/);
  assert.match(privacy, /bổ sung thông tin pháp nhân\/kênh liên hệ/);
});

test('chính sách hoàn tiền tách tiền gói khỏi tiền thuê và phản ánh đúng workflow', () => {
  const refund = read('refund-policy.html');

  assert.match(refund, /Chính sách này chỉ áp dụng cho khoản thanh toán.*gói phần mềm TrọBill/s);
  assert.match(refund, /Tiền thuê phòng, tiền cọc[\s\S]*không thuộc chính sách/);
  assert.match(refund, /Cài đặt → Lịch sử thanh toán gói/);
  assert.match(refund, /chờ xử lý, đang kiểm tra, đã duyệt, từ chối, đã hoàn hoặc đã hủy/);
  assert.match(refund, /Gửi yêu cầu không tự động chuyển tiền/);
  assert.match(refund, /mã tham chiếu giao dịch hoàn/);
  assert.match(refund, /không hạn chế quyền khiếu nại/);
});

test('chính sách hoàn tiền được liên kết ở landing, onboarding, cài đặt và luồng payment', () => {
  for (const file of ['landing.html', 'quick-start.html', 'index.html']) {
    assert.match(read(file), /refund-policy\.html/, `${file} phải liên kết chính sách hoàn tiền`);
  }
  const app = read('app.js');
  const server = read('server/subscription-refunds.js');
  assert.match(app, /API\.createSubscriptionRefundRequest/);
  assert.match(server, /request_type[\s\S]*requested_amount_vnd[\s\S]*reason/);
  assert.match(server, /refund_reference/);
});
