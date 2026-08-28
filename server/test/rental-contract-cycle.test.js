'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const cycle = require('../../rental-contract-cycle');

test('chu kỳ tháng tính đúng hạn kế tiếp theo ngày hợp đồng', () => {
  const contract = {
    status: 'active',
    startsOn: '2026-07-01',
    endsOn: '2027-07-01',
    billingCycleMonths: 1,
    paymentDueDay: 5
  };
  assert.equal(cycle.nextPaymentDueOn(contract, { fromDate: '2026-08-28' }), '2026-09-05');
  assert.deepEqual(
    cycle.paymentDates(contract, { fromDate: '2026-08-01', take: 3 }),
    ['2026-08-05', '2026-09-05', '2026-10-05']
  );
});

test('kỳ đầu không thể đến hạn trước ngày bắt đầu thuê', () => {
  const contract = {
    status: 'active',
    startsOn: '2026-08-10',
    billingCycleMonths: 1,
    paymentDueDay: 5
  };
  assert.deepEqual(
    cycle.paymentDates(contract, { fromDate: '2026-08-01', take: 2 }),
    ['2026-08-10', '2026-09-05']
  );
});

test('chu kỳ 3 tháng dừng đúng ngày kết thúc hợp đồng', () => {
  const contract = {
    status: 'active',
    startsOn: '2026-01-10',
    endsOn: '2026-12-31',
    billingCycleMonths: 3,
    paymentDueDay: 5
  };
  assert.deepEqual(
    cycle.paymentDates(contract, { fromDate: '2026-01-01', take: 12 }),
    ['2026-01-10', '2026-04-05', '2026-07-05', '2026-10-05']
  );
  assert.equal(cycle.cycleLabel(3), '3 tháng/lần');
  assert.equal(cycle.nextPaymentDueOn({ ...contract, status: 'ended' }), null);
});

test('giá trị lịch không hợp lệ rơi về mặc định an toàn', () => {
  assert.equal(cycle.cycleMonths(2), 1);
  assert.equal(cycle.dueDay(31), 5);
  assert.deepEqual(cycle.paymentDates({ startsOn: 'không-hợp-lệ' }), []);
});

test('cảnh báo hết hạn dùng ngày lịch và phân loại đúng 30 ngày, hôm nay, quá hạn', () => {
  const contract = { status: 'active', endsOn: '2026-09-27' };
  assert.deepEqual(cycle.expiryStatus(contract, { fromDate: '2026-08-28' }), {
    level: 'warning', label: 'Còn 30 ngày', daysRemaining: 30
  });
  assert.equal(
    cycle.expiryStatus({ ...contract, endsOn: '2026-08-28' }, { fromDate: '2026-08-28' }).label,
    'Hết hạn hôm nay'
  );
  assert.equal(
    cycle.expiryStatus({ ...contract, endsOn: '2026-08-27' }, { fromDate: '2026-08-28' }).label,
    'Quá hạn 1 ngày'
  );
  assert.equal(
    cycle.expiryStatus({ ...contract, status: 'ended' }, { fromDate: '2026-08-28' }).level,
    'none'
  );
});
