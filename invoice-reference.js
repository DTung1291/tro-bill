/**
 * Mã chuyển khoản ngắn cho hóa đơn tiền trọ.
 * Khóa chính BIGSERIAL của hóa đơn là duy nhất toàn hệ thống; mã base36 giữ
 * tính duy nhất nhưng ngắn và dễ nhập hơn số thập phân dài.
 */
(function initInvoiceReference(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.InvoiceReference = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createInvoiceReference() {
  'use strict';

  const PREFIX = 'HD';
  const MIN_BODY_LENGTH = 8;
  const MAX_BIGINT = 9223372036854775807n;

  function invoiceId(value) {
    try {
      const parsed = BigInt(String(value));
      if (parsed < 1n || parsed > MAX_BIGINT) return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function fromInvoiceId(value) {
    const parsed = invoiceId(value);
    if (parsed === null) return '';
    const body = parsed.toString(36).toUpperCase().padStart(MIN_BODY_LENGTH, '0');
    return `${PREFIX}${body}`;
  }

  function parseBase36(value) {
    let result = 0n;
    for (const char of value) {
      const digit = parseInt(char, 36);
      if (!Number.isInteger(digit) || digit < 0 || digit >= 36) return null;
      result = result * 36n + BigInt(digit);
      if (result > MAX_BIGINT) return null;
    }
    return result > 0n ? result : null;
  }

  function toInvoiceId(value) {
    const normalized = String(value || '').trim().toUpperCase();
    const pattern = new RegExp(`^${PREFIX}([0-9A-Z]{${MIN_BODY_LENGTH},13})$`);
    const match = pattern.exec(normalized);
    if (!match) return '';
    const parsed = parseBase36(match[1]);
    return parsed === null ? '' : parsed.toString(10);
  }

  function isValid(value) {
    return toInvoiceId(value) !== '';
  }

  return {
    MAX_BIGINT,
    MIN_BODY_LENGTH,
    PREFIX,
    fromInvoiceId,
    isValid,
    toInvoiceId
  };
});
