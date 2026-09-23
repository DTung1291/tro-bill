'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const selection = require('../../plan-selection');
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) || null, setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}
test('giữ gói và chu kỳ qua reload/xác minh email trong cùng phiên trình duyệt', () => {
  const store = storage();
  selection.capture('?plan=pro&cycle=yearly', store, 100);
  assert.deepEqual(selection.capture('?verify=example', store, 200), { plan: 'pro', cycle: 'yearly', createdAt: 100 });
  selection.clear(store);
  assert.equal(selection.read(store, 300), null);
});
test('từ chối gói/chu kỳ giả và hết hạn lựa chọn sau 24 giờ', () => {
  const store = storage();
  assert.equal(selection.capture('?plan=pro&cycle=invalid', store, 100), null);
  assert.equal(selection.capture('?plan=unknown&cycle=yearly', store, 100), null);
  selection.capture('?plan=standard&cycle=monthly', store, 100);
  assert.equal(selection.read(store, 100 + 86400000), null);
});
test('vẫn nhận lựa chọn trực tiếp khi storage bị chặn', () => {
  const store = { getItem() { throw Error(); }, setItem() { throw Error(); }, removeItem() { throw Error(); } };
  assert.equal(selection.capture('?plan=business&cycle=yearly', store, 100).plan, 'business');
  assert.equal(selection.read(store), null);
});
