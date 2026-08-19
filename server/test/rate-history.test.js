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

test('tính tiền thuê theo số ngày thực tế của tháng bắt đầu thuê', () => {
  const rent = RoomRates.calculateRent(3100000, '2026-08', '2026-08-10');

  assert.equal(rent.daysInMonth, 31);
  assert.equal(rent.chargedDays, 21);
  assert.equal(rent.amount, 2100000);
  assert.equal(rent.prorated, true);
});

test('làm tròn tiền thuê theo ngày đến đơn vị đồng', () => {
  const rent = RoomRates.calculateRent(2200000, '2026-08', '2026-08-10');

  assert.equal(rent.amount, 1490323);
});

test('xử lý đúng tháng nhuận và chỉ chia tiền ở tháng bắt đầu', () => {
  const firstMonth = RoomRates.calculateRent(2900000, '2024-02', '2024-02-10');
  const nextMonth = RoomRates.calculateRent(2900000, '2024-03', '2024-02-10');
  const previousMonth = RoomRates.calculateRent(2900000, '2024-01', '2024-02-10');

  assert.equal(firstMonth.daysInMonth, 29);
  assert.equal(firstMonth.chargedDays, 19);
  assert.equal(firstMonth.amount, 1900000);
  assert.equal(nextMonth.amount, 2900000);
  assert.equal(nextMonth.prorated, false);
  assert.equal(previousMonth.amount, 0);
  assert.equal(previousMonth.startsAfterPeriod, true);
});

test('không có ngày bắt đầu thuê thì vẫn thu đủ giá tháng', () => {
  const rent = RoomRates.calculateRent(2200000, '2026-08', '');

  assert.equal(rent.amount, 2200000);
  assert.equal(rent.chargedDays, 31);
  assert.equal(rent.prorated, false);
});

test('xác định đúng số ngày cho tháng 28, 29, 30 và 31 ngày', () => {
  const cases = [
    ['2025-02', '2025-02-10', 28, 18],
    ['2024-02', '2024-02-10', 29, 19],
    ['2026-04', '2026-04-10', 30, 20],
    ['2026-08', '2026-08-10', 31, 21]
  ];

  for (const [period, startDate, daysInMonth, chargedDays] of cases) {
    const rent = RoomRates.calculateRent(daysInMonth * 100000, period, startDate);
    assert.equal(rent.daysInMonth, daysInMonth);
    assert.equal(rent.chargedDays, chargedDays);
    assert.equal(rent.amount, chargedDays * 100000);
  }
});
