/**
 * Phân loại tuổi nợ hóa đơn TrọBill.
 * Hạn thanh toán là ngày cuối cùng của kỳ và được tính theo múi giờ Việt Nam.
 * Dùng được trực tiếp trên trình duyệt và qua CommonJS để kiểm thử bằng Node.
 */
(function initDebtAge(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.DebtAge = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createDebtAge() {
  'use strict';

  const DEFAULT_TIME_ZONE = 'Asia/Ho_Chi_Minh';
  const DAY_MS = 24 * 60 * 60 * 1000;
  const BUCKETS = Object.freeze({
    SETTLED: 'settled',
    NOT_DUE: 'not_due',
    OVERDUE_1_7: 'overdue_1_7',
    OVERDUE_8_30: 'overdue_8_30',
    OVERDUE_31_PLUS: 'overdue_31_plus'
  });

  function isPeriod(value) {
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''));
  }

  function daysInPeriod(period) {
    if (!isPeriod(period)) return 0;
    const [year, month] = period.split('-').map(Number);
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  function dueDate(period) {
    const day = daysInPeriod(period);
    return day ? `${period}-${String(day).padStart(2, '0')}` : '';
  }

  function zonedDateParts(value = new Date(), timeZone = DEFAULT_TIME_ZONE) {
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new TypeError('Thời điểm tính tuổi nợ không hợp lệ');
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).formatToParts(date);
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
      year: Number(byType.year),
      month: Number(byType.month),
      day: Number(byType.day)
    };
  }

  function serialDay({ year, month, day }) {
    return Math.floor(Date.UTC(year, month - 1, day) / DAY_MS);
  }

  function classify(period, outstandingVnd, options = {}) {
    if (!isPeriod(period)) throw new TypeError('Kỳ hóa đơn không hợp lệ');
    const dueDay = daysInPeriod(period);
    const [year, month] = period.split('-').map(Number);
    const due = dueDate(period);
    const outstanding = Math.max(0, Number(outstandingVnd) || 0);
    const today = zonedDateParts(options.now || new Date(), options.timeZone || DEFAULT_TIME_ZONE);
    const overdueDays = Math.max(0, serialDay(today) - serialDay({ year, month, day: dueDay }));

    let bucket = BUCKETS.SETTLED;
    if (outstanding > 0 && overdueDays === 0) bucket = BUCKETS.NOT_DUE;
    else if (outstanding > 0 && overdueDays <= 7) bucket = BUCKETS.OVERDUE_1_7;
    else if (outstanding > 0 && overdueDays <= 30) bucket = BUCKETS.OVERDUE_8_30;
    else if (outstanding > 0) bucket = BUCKETS.OVERDUE_31_PLUS;

    return {
      period,
      dueDate: due,
      outstandingVnd: outstanding,
      overdueDays,
      bucket,
      isOverdue: outstanding > 0 && overdueDays > 0
    };
  }

  function label(bucket) {
    const labels = {
      [BUCKETS.SETTLED]: 'Đã thu đủ',
      [BUCKETS.NOT_DUE]: 'Chưa đến hạn',
      [BUCKETS.OVERDUE_1_7]: 'Quá hạn 1–7 ngày',
      [BUCKETS.OVERDUE_8_30]: 'Quá hạn 8–30 ngày',
      [BUCKETS.OVERDUE_31_PLUS]: 'Quá hạn trên 30 ngày'
    };
    return labels[bucket] || labels[BUCKETS.NOT_DUE];
  }

  return {
    BUCKETS,
    DEFAULT_TIME_ZONE,
    classify,
    daysInPeriod,
    dueDate,
    isPeriod,
    label,
    zonedDateParts
  };
});
