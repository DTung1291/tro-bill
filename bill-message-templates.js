/**
 * Mẫu tin nhắn hóa đơn và nhắc nợ TrọBill.
 * Chỉ nhận dữ liệu tổng hợp cần thiết, không đưa CCCD hoặc dữ liệu nhạy cảm
 * của khách thuê vào nội dung chia sẻ.
 */
(function initBillMessageTemplates(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BillMessageTemplates = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createBillMessageTemplates() {
  'use strict';

  const money = new Intl.NumberFormat('vi-VN', {
    style: 'currency',
    currency: 'VND',
    maximumFractionDigits: 0
  });

  function amount(value) {
    return Math.max(0, Math.round(Number(value) || 0));
  }

  function text(value, fallback = '') {
    const normalized = String(value || '').trim();
    return normalized || fallback;
  }

  function dateLabel(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text(value));
    return match ? `${match[3]}/${match[2]}/${match[1]}` : text(value, '—');
  }

  function commonContext(input = {}) {
    return {
      roomName: text(input.roomName, 'Phòng'),
      periodLabel: text(input.periodLabel, 'kỳ hiện tại'),
      invoiceTotalVnd: amount(input.invoiceTotalVnd),
      paidAmountVnd: amount(input.paidAmountVnd),
      priorDebtVnd: amount(input.priorDebtVnd),
      totalDueVnd: amount(input.totalDueVnd),
      dueDate: dateLabel(input.dueDate),
      overdueDays: Math.max(0, Math.floor(Number(input.overdueDays) || 0)),
      transferContent: text(input.transferContent),
      bankRecipient: text(input.bankRecipient),
      invoiceUrl: /^https:\/\//.test(text(input.invoiceUrl)) ? text(input.invoiceUrl) : ''
    };
  }

  function paymentLines(context) {
    return [
      `• Tiền kỳ này: ${money.format(context.invoiceTotalVnd)}`,
      context.paidAmountVnd > 0 ? `• Đã thanh toán kỳ này: ${money.format(context.paidAmountVnd)}` : '',
      context.priorDebtVnd > 0 ? `• Nợ kỳ trước: ${money.format(context.priorDebtVnd)}` : '',
      `💳 Tổng cần thanh toán: ${money.format(context.totalDueVnd)}`,
      `📅 Hạn thanh toán: ${context.dueDate}`,
      context.transferContent ? `🧾 Nội dung chuyển khoản: ${context.transferContent}` : '',
      context.bankRecipient ? `🏦 Người nhận: ${context.bankRecipient}` : '',
      context.invoiceUrl ? `🔗 Xem hóa đơn: ${context.invoiceUrl}` : ''
    ].filter(Boolean);
  }

  function invoice(input = {}) {
    const context = commonContext(input);
    const closingLine = context.totalDueVnd > 0
      ? 'Anh/chị vui lòng kiểm tra và thanh toán đúng nội dung chuyển khoản. Xin cảm ơn.'
      : 'Hóa đơn đã được ghi nhận thanh toán đủ. Anh/chị vui lòng kiểm tra lại thông tin. Xin cảm ơn.';
    return [
      `🏠 HÓA ĐƠN ${context.periodLabel.toUpperCase()} — ${context.roomName.toUpperCase()}`,
      '',
      'Chào anh/chị, TrọBill gửi thông tin hóa đơn mới:',
      ...paymentLines(context),
      '',
      closingLine
    ].join('\n');
  }

  function reminder(input = {}) {
    const context = commonContext(input);
    if (context.totalDueVnd <= 0) return '';
    const timingLine = context.overdueDays > 0
      ? `⚠️ Khoản thanh toán đã quá hạn ${context.overdueDays} ngày.`
      : `Anh/chị vui lòng thanh toán trước ngày ${context.dueDate}.`;
    return [
      `⏰ NHẮC THANH TOÁN — ${context.roomName.toUpperCase()}`,
      '',
      `Chào anh/chị, hóa đơn ${context.periodLabel} hiện còn ${money.format(context.totalDueVnd)} chưa thanh toán.`,
      timingLine,
      context.transferContent ? `🧾 Nội dung chuyển khoản: ${context.transferContent}` : '',
      context.bankRecipient ? `🏦 Người nhận: ${context.bankRecipient}` : '',
      context.invoiceUrl ? `🔗 Xem hóa đơn: ${context.invoiceUrl}` : '',
      '',
      'Nếu anh/chị đã chuyển khoản, vui lòng bỏ qua tin nhắn này hoặc gửi minh chứng để chủ trọ đối chiếu. Xin cảm ơn.'
    ].filter(Boolean).join('\n');
  }

  return { invoice, reminder };
});
