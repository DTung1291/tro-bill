/**
 * Tiện ích biểu phí theo kỳ cho TrọBill.
 * Dùng được trực tiếp trên trình duyệt và qua CommonJS để kiểm thử bằng Node.
 */
(function initRoomRates(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RoomRates = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function createRoomRates() {
  'use strict';

  const BASE_PERIOD = '1970-01';
  const RATE_FIELDS = [
    'rentPrice',
    'electricRate',
    'waterRate',
    'trashFee',
    'wifiFee',
    'manageFee'
  ];
  const DEFAULT_RATES = {
    rentPrice: 0,
    electricRate: 3200,
    waterRate: 50000,
    trashFee: 50000,
    wifiFee: 0,
    manageFee: 0
  };

  function isPeriod(value) {
    return /^\d{4}-(0[1-9]|1[0-2])$/.test(String(value || ''));
  }

  function amount(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  }

  function snapshot(source = {}, fallback = DEFAULT_RATES) {
    const rates = {};
    for (const field of RATE_FIELDS) {
      rates[field] = amount(source[field], amount(fallback[field], DEFAULT_RATES[field]));
    }
    return rates;
  }

  function normalizeEntry(entry, fallback = DEFAULT_RATES) {
    if (!entry || !isPeriod(entry.effectiveFrom)) return null;
    return {
      effectiveFrom: entry.effectiveFrom,
      ...snapshot(entry, fallback)
    };
  }

  function normalizeHistory(room = {}) {
    const fallback = snapshot(room);
    const byPeriod = new Map();
    const source = Array.isArray(room.rateHistory) ? room.rateHistory : [];

    for (const rawEntry of source) {
      const entry = normalizeEntry(rawEntry, fallback);
      if (entry) byPeriod.set(entry.effectiveFrom, entry);
    }

    if (byPeriod.size === 0) {
      byPeriod.set(BASE_PERIOD, { effectiveFrom: BASE_PERIOD, ...fallback });
    }

    return [...byPeriod.values()].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  }

  function resolve(room = {}, period) {
    const history = normalizeHistory(room);
    const target = isPeriod(period) ? period : '9999-12';
    let selected = history[0];

    for (const entry of history) {
      if (entry.effectiveFrom > target) break;
      selected = entry;
    }

    return { ...selected };
  }

  function latest(room = {}) {
    const history = normalizeHistory(room);
    return { ...history[history.length - 1] };
  }

  function sameRates(left = {}, right = {}) {
    return RATE_FIELDS.every((field) => amount(left[field]) === amount(right[field]));
  }

  return {
    BASE_PERIOD,
    RATE_FIELDS,
    DEFAULT_RATES,
    isPeriod,
    snapshot,
    normalizeEntry,
    normalizeHistory,
    resolve,
    latest,
    sameRates
  };
});
