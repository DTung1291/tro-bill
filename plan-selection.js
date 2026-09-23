(function (root, factory) {
  const selection = factory();
  if (typeof module === 'object' && module.exports) module.exports = selection;
  else root.PlanSelection = selection;
})(typeof window === 'object' ? window : globalThis, function () {
  'use strict';
  const key = 'trobill_plan_selection_v1';
  const lifetime = 24 * 60 * 60 * 1000;
  function valid(value) {
    return value && ['free', 'standard', 'pro', 'business'].includes(value.plan)
      && ['monthly', 'yearly'].includes(value.cycle);
  }
  function read(storage, now = Date.now()) {
    try {
      const value = JSON.parse(storage.getItem(key));
      if (valid(value) && Number.isFinite(value.createdAt) && now >= value.createdAt && now - value.createdAt < lifetime) return value;
      storage.removeItem(key);
    } catch (_) {}
    return null;
  }
  function capture(search, storage, now = Date.now()) {
    const params = new URLSearchParams(search);
    const value = { plan: params.get('plan'), cycle: params.get('cycle') || 'monthly', createdAt: now };
    if (valid(value)) {
      try { storage.setItem(key, JSON.stringify(value)); } catch (_) {}
      return value;
    }
    return read(storage, now);
  }
  function clear(storage) { try { storage.removeItem(key); } catch (_) {} }
  return { capture, read, clear };
});
