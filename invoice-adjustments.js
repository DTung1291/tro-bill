/**
 * Tính các khoản điều chỉnh một lần trên hóa đơn TrọBill.
 * Dùng được trực tiếp trên trình duyệt và qua CommonJS để kiểm thử bằng Node.
 */
(function initInvoiceAdjustments(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.InvoiceAdjustments = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createInvoiceAdjustments() {
  'use strict';

  const MAX_VND = 999999999999;
  const FIELDS = ['discountAmount', 'surchargeAmount', 'lateFeeAmount'];

  function amount(value) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0) return 0;
    return Math.min(MAX_VND, Math.round(parsed));
  }

  function calculate(baseSubtotal, source = {}) {
    const subtotalVnd = amount(baseSubtotal);
    const surchargeAmount = amount(source.surchargeAmount);
    const lateFeeAmount = amount(source.lateFeeAmount);
    const requestedDiscountAmount = amount(source.discountAmount);
    const beforeDiscountVnd = subtotalVnd + surchargeAmount + lateFeeAmount;
    const discountAmount = Math.min(requestedDiscountAmount, beforeDiscountVnd);

    return {
      subtotalVnd,
      discountAmount,
      requestedDiscountAmount,
      surchargeAmount,
      lateFeeAmount,
      adjustmentNetVnd: surchargeAmount + lateFeeAmount - discountAmount,
      totalVnd: beforeDiscountVnd - discountAmount
    };
  }

  function hasAdjustments(source = {}) {
    return FIELDS.some((field) => amount(source[field]) > 0);
  }

  return { MAX_VND, FIELDS, amount, calculate, hasAdjustments };
});
