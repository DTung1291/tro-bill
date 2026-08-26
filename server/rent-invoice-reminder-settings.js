'use strict';

const BEFORE_DAY_OPTIONS = Object.freeze([14, 7, 5, 3, 2, 1]);
const AFTER_DAY_OPTIONS = Object.freeze([1, 2, 3, 5, 7, 14, 30]);
const DEFAULT_BEFORE_DAYS = Object.freeze([3, 1]);
const DEFAULT_AFTER_DAYS = Object.freeze([1, 3, 7]);

class RentInvoiceReminderSettingsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RentInvoiceReminderSettingsError';
    this.statusCode = 400;
    this.code = code;
  }
}

function normalizeDays(value, allowed, defaults, fieldLabel, options = {}) {
  if (value === undefined && options.allowMissing) return null;
  const source = value === undefined ? defaults : value;
  if (!Array.isArray(source)) {
    throw new RentInvoiceReminderSettingsError(
      'INVALID_INVOICE_REMINDER_DAYS',
      `${fieldLabel} phải là danh sách số ngày hợp lệ`
    );
  }
  const allowedSet = new Set(allowed);
  const parsed = source.map(Number);
  if (parsed.some((day) => !Number.isSafeInteger(day) || !allowedSet.has(day))) {
    throw new RentInvoiceReminderSettingsError(
      'INVALID_INVOICE_REMINDER_DAYS',
      `${fieldLabel} chứa mốc ngày không được hỗ trợ`
    );
  }
  const selected = new Set(parsed);
  return allowed.filter((day) => selected.has(day));
}

function normalizeInvoiceReminderSettings(settings = {}, options = {}) {
  const hasEnabled = Object.prototype.hasOwnProperty.call(settings, 'invoiceReminderEnabled');
  const hasBefore = Object.prototype.hasOwnProperty.call(settings, 'invoiceReminderBeforeDays');
  const hasAfter = Object.prototype.hasOwnProperty.call(settings, 'invoiceReminderAfterDays');
  const allowMissing = options.allowMissing === true;
  if (hasEnabled && typeof settings.invoiceReminderEnabled !== 'boolean') {
    throw new RentInvoiceReminderSettingsError(
      'INVALID_INVOICE_REMINDER_ENABLED',
      'Trạng thái nhắc hóa đơn tự động không hợp lệ'
    );
  }
  const enabled = hasEnabled
    ? settings.invoiceReminderEnabled === true
    : (allowMissing ? null : false);
  const beforeDays = normalizeDays(
    hasBefore ? settings.invoiceReminderBeforeDays : undefined,
    BEFORE_DAY_OPTIONS,
    DEFAULT_BEFORE_DAYS,
    'Mốc nhắc trước hạn',
    { allowMissing: allowMissing && !hasBefore }
  );
  const afterDays = normalizeDays(
    hasAfter ? settings.invoiceReminderAfterDays : undefined,
    AFTER_DAY_OPTIONS,
    DEFAULT_AFTER_DAYS,
    'Mốc nhắc sau hạn',
    { allowMissing: allowMissing && !hasAfter }
  );
  if (enabled === true && (beforeDays || []).length + (afterDays || []).length === 0) {
    throw new RentInvoiceReminderSettingsError(
      'INVOICE_REMINDER_DAYS_REQUIRED',
      'Cần chọn ít nhất một mốc nhắc trước hạn hoặc sau hạn'
    );
  }
  return { enabled, beforeDays, afterDays };
}

module.exports = {
  AFTER_DAY_OPTIONS,
  BEFORE_DAY_OPTIONS,
  DEFAULT_AFTER_DAYS,
  DEFAULT_BEFORE_DAYS,
  RentInvoiceReminderSettingsError,
  normalizeInvoiceReminderSettings
};
