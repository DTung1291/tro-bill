/**
 * Chu kỳ thanh toán hợp đồng thuê TrọBill.
 * Dùng chung trên trình duyệt và Node để lịch hiển thị khớp với dữ liệu máy chủ.
 */
(function initRentalContractCycle(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RentalContractCycle = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRentalContractCycle() {
  'use strict';

  const ALLOWED_CYCLE_MONTHS = Object.freeze([1, 3, 6, 12]);
  const CYCLE_LABELS = Object.freeze({
    1: 'Hàng tháng',
    3: '3 tháng/lần',
    6: '6 tháng/lần',
    12: '12 tháng/lần'
  });

  function dateParts(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year
        || date.getUTCMonth() !== month - 1
        || date.getUTCDate() !== day) return null;
    return { year, month, day };
  }

  function dateKey(year, month, day) {
    return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }

  function cycleMonths(value) {
    const normalized = Number(value);
    return ALLOWED_CYCLE_MONTHS.includes(normalized) ? normalized : 1;
  }

  function dueDay(value) {
    const normalized = Number(value);
    return Number.isInteger(normalized) && normalized >= 1 && normalized <= 28
      ? normalized
      : 5;
  }

  function monthAt(start, offsetMonths) {
    const date = new Date(Date.UTC(start.year, start.month - 1 + offsetMonths, 1));
    return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
  }

  function paymentDates(contract = {}, options = {}) {
    const start = dateParts(contract.startsOn);
    if (!start) return [];
    const end = contract.endsOn ? dateParts(contract.endsOn) : null;
    if (contract.endsOn && !end) return [];
    const months = cycleMonths(contract.billingCycleMonths);
    const day = dueDay(contract.paymentDueDay);
    const fromDate = String(options.fromDate || contract.startsOn);
    const take = Math.min(120, Math.max(1, Number(options.take) || 6));
    const dates = [];

    // Giới hạn 100 năm để hợp đồng không thời hạn không thể tạo vòng lặp vô hạn.
    for (let cycleIndex = 0; cycleIndex < 1200 && dates.length < take; cycleIndex += 1) {
      const month = monthAt(start, cycleIndex * months);
      let due = dateKey(month.year, month.month, day);
      if (cycleIndex === 0 && due < contract.startsOn) due = contract.startsOn;
      if (end && due > contract.endsOn) break;
      if (due >= fromDate) dates.push(due);
    }
    return dates;
  }

  function nextPaymentDueOn(contract = {}, options = {}) {
    if (!['draft', 'active'].includes(String(contract.status || 'active'))) return null;
    return paymentDates(contract, { ...options, take: 1 })[0] || null;
  }

  function cycleLabel(value) {
    return CYCLE_LABELS[cycleMonths(value)];
  }

  return {
    ALLOWED_CYCLE_MONTHS,
    CYCLE_LABELS,
    cycleLabel,
    cycleMonths,
    dueDay,
    nextPaymentDueOn,
    paymentDates
  };
});
