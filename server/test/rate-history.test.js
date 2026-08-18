'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const RoomRates = require('../../rate-history');

const baseRoom = {
  rentPrice: 2000000,
  electricRate: 3200,
  waterRate: 50000,
  trashFee: 50000,
  wifiFee: 40000,
  manageFee: 0
};

test('dữ liệu phòng cũ được chuyển thành một mốc giá ban đầu', () => {
  const history = RoomRates.normalizeHistory(baseRoom);

  assert.equal(history.length, 1);
  assert.equal(history[0].effectiveFrom, '1970-01');
  assert.equal(history[0].rentPrice, 2000000);
  assert.equal(history[0].electricRate, 3200);
});

test('chọn đúng biểu phí gần nhất có hiệu lực trong tháng hóa đơn', () => {
  const room = {
    ...baseRoom,
    rateHistory: [
      { effectiveFrom: '2026-01', ...baseRoom },
      { effectiveFrom: '2026-02', ...baseRoom, rentPrice: 2200000 },
      { effectiveFrom: '2026-04', ...baseRoom, rentPrice: 2500000 }
    ]
  };

  assert.equal(RoomRates.resolve(room, '2026-01').rentPrice, 2000000);
  assert.equal(RoomRates.resolve(room, '2026-02').rentPrice, 2200000);
  assert.equal(RoomRates.resolve(room, '2026-03').rentPrice, 2200000);
  assert.equal(RoomRates.resolve(room, '2026-04').rentPrice, 2500000);
  assert.equal(RoomRates.resolve(room, '2027-01').rentPrice, 2500000);
});

test('một mốc biểu phí lưu đầy đủ mọi khoản cố định', () => {
  const changed = {
    effectiveFrom: '2026-04',
    rentPrice: 2500000,
    electricRate: 4000,
    waterRate: 60000,
    trashFee: 60000,
    wifiFee: 50000,
    manageFee: 100000
  };
  const room = { ...baseRoom, rateHistory: [{ effectiveFrom: '2026-01', ...baseRoom }, changed] };

  assert.deepEqual(RoomRates.resolve(room, '2026-04'), changed);
  assert.equal(RoomRates.resolve(room, '2026-03').electricRate, 3200);
  assert.equal(RoomRates.resolve(room, '2026-03').manageFee, 0);
});

test('mốc trùng tháng được chuẩn hóa thành một dòng cuối cùng', () => {
  const history = RoomRates.normalizeHistory({
    ...baseRoom,
    rateHistory: [
      { effectiveFrom: '2026-02', ...baseRoom, rentPrice: 2100000 },
      { effectiveFrom: '2026-02', ...baseRoom, rentPrice: 2200000 }
    ]
  });

  assert.equal(history.length, 1);
  assert.equal(history[0].rentPrice, 2200000);
});

test('so sánh biểu phí không bị sai khi giá bằng 0', () => {
  const withoutWifi = { ...baseRoom, wifiFee: 0 };

  assert.equal(RoomRates.sameRates(withoutWifi, { ...withoutWifi }), true);
  assert.equal(RoomRates.sameRates(withoutWifi, { ...withoutWifi, wifiFee: 40000 }), false);
});
