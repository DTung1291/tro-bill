'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const templates = require('../../bill-message-templates');

const root = path.join(__dirname, '..', '..');

function context(overrides = {}) {
  return {
    roomName: 'Phòng 403',
    periodLabel: 'Tháng 8/2026',
    invoiceTotalVnd: 3000000,
    paidAmountVnd: 500000,
    priorDebtVnd: 250000,
    totalDueVnd: 2750000,
    dueDate: '2026-08-11',
    overdueDays: 5,
    transferContent: 'TB-202608-P403',
    bankRecipient: 'NGUYEN VAN A · VCB · 0123456789',
    ...overrides
  };
}

test('mẫu thông báo hóa đơn có đủ dữ liệu thanh toán cần thiết', () => {
  const message = templates.invoice(context({
    invoiceUrl: 'https://tro-bill.example/invoice.html#t=secure',
    cccd: '012345678901',
    tenantName: 'Dữ liệu không được dùng'
  }));

  assert.match(message, /HÓA ĐƠN THÁNG 8\/2026 — PHÒNG 403/);
  assert.match(message, /3\.000\.000\s₫/);
  assert.match(message, /500\.000\s₫/);
  assert.match(message, /250\.000\s₫/);
  assert.match(message, /2\.750\.000\s₫/);
  assert.match(message, /11\/08\/2026/);
  assert.match(message, /TB-202608-P403/);
  assert.match(message, /NGUYEN VAN A · VCB · 0123456789/);
  assert.match(message, /https:\/\/tro-bill\.example\/invoice\.html#t=secure/);
  assert.doesNotMatch(message, /012345678901|Dữ liệu không được dùng/);
});

test('mẫu nhắc nợ thể hiện số ngày quá hạn và số tiền còn phải trả', () => {
  const message = templates.reminder(context());
  assert.match(message, /NHẮC THANH TOÁN — PHÒNG 403/);
  assert.match(message, /2\.750\.000\s₫ chưa thanh toán/);
  assert.match(message, /quá hạn 5 ngày/);
  assert.match(message, /TB-202608-P403/);
});

test('không tạo nhắc nợ khi tài khoản đã thanh toán đủ', () => {
  assert.equal(templates.reminder(context({ totalDueVnd: 0, overdueDays: 0 })), '');
});

test('thông báo hóa đơn đã thu đủ không yêu cầu khách thanh toán lại', () => {
  const message = templates.invoice(context({
    paidAmountVnd: 3000000,
    priorDebtVnd: 0,
    totalDueVnd: 0,
    overdueDays: 0
  }));
  assert.match(message, /đã được ghi nhận thanh toán đủ/i);
  assert.doesNotMatch(message, /vui lòng kiểm tra và thanh toán đúng/i);
});

test('chỉ đưa liên kết HTTPS vào mẫu tin nhắn', () => {
  const message = templates.invoice(context({ invoiceUrl: 'javascript:alert(1)' }));
  assert.doesNotMatch(message, /javascript:|Xem hóa đơn/);
});

test('giao diện tải bộ mẫu trước app và có thao tác sao chép, chia sẻ', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const checklist = fs.readFileSync(path.join(root, 'MONETIZATION_CHECKLIST.md'), 'utf8');

  assert.match(html, /id="bill-preview-message-template"/);
  assert.match(html, /id="bill-message-modal"/);
  assert.match(html, /bill-message-templates\.js\?v=1[\s\S]*app\.js\?v=93/);
  assert.match(app, /function billMessageContext\(/);
  assert.match(app, /BillMessageTemplates\.invoice\(context\)/);
  assert.match(app, /BillMessageTemplates\.reminder\(context\)/);
  assert.match(app, /shareBillNative\(/);
  assert.match(css, /\.modal\.bill-message-modal/);
  assert.match(checklist, /\[x\] Có mẫu tin nhắn hóa đơn và mẫu nhắc nợ\./);
});
