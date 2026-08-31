'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-business-audit-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  recordDataAudits,
  requestDataAuditEntry
} = require('../data-audit');
const { stateBusinessAuditEntries } = require('../state');

test('audit nghiệp vụ giữ actor khác subject, lọc field và chỉ dọn retention một lần', async () => {
  const calls = [];
  const req = {
    userId: 7,
    actorUserId: 8,
    accountUserId: 7,
    userEmail: 'staff@example.com',
    ip: '203.0.113.10',
    get(name) { return name === 'user-agent' ? 'Audit Test' : ''; }
  };
  const first = requestDataAuditEntry(req, 'room_rate_updated', 'room_rate', 'r1:2026-08', {
    changedFields: ['rentPrice', 'cccd-value-must-not-pass'],
    purpose: 'Điều chỉnh theo phụ lục'
  });
  const second = requestDataAuditEntry(req, 'rent_invoice_updated', 'rent_invoice', '12', {
    changedFields: ['issuedTotalVnd']
  });
  await recordDataAudits(async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [] };
  }, [first, second]);

  const inserts = calls.filter(call => call.sql.includes('INSERT INTO data_audit_logs'));
  assert.equal(inserts.length, 2);
  assert.equal(calls.filter(call => call.sql.includes('DELETE FROM data_audit_logs')).length, 1);
  assert.deepEqual(inserts[0].params.slice(0, 3), [8, 'staff@example.com', 7]);
  assert.deepEqual(inserts[0].params[6], ['rentPrice']);
  assert.equal(inserts[0].params.includes('203.0.113.10'), false);
});

test('state chỉ tạo audit khi biểu phí hoặc nguồn hóa đơn thật sự thay đổi', () => {
  const req = { userId: 7, userEmail: 'owner@example.com', get: () => '' };
  const existingRates = [{
    room_id: 'room-1', effective_from: '2026-08', rent_price: '2000000',
    electric_rate: '3500', water_rate: '50000', trash_fee: '50000',
    wifi_fee: '0', manage_fee: '0'
  }];
  const existingBilling = [{
    period: '2026-08', room_id: 'room-1', electric_new: '20', water_units: '2',
    water_new: null, electric_old_override: null, water_old_override: null,
    note: null, utility_only: false, discount_amount: '0', surcharge_amount: '0',
    late_fee_amount: '0', paid: false
  }];
  const rooms = [{
    id: 'room-1', rentStartDate: '2026-08-01', rentPrice: 2200000,
    electricRate: 3500, waterRate: 50000, trashFee: 50000,
    wifiFee: 0, manageFee: 0,
    rateHistory: [{
      effectiveFrom: '2026-08', rentPrice: 2200000, electricRate: 3500,
      waterRate: 50000, trashFee: 50000, wifiFee: 0, manageFee: 0
    }]
  }];
  const billingData = {
    '2026-08': {
      'room-1': { electricNew: 25, waterUnits: 2 }
    }
  };

  const audits = stateBusinessAuditEntries(
    req, existingRates, existingBilling, rooms, billingData
  );
  assert.deepEqual(audits.map(entry => entry.action), [
    'room_rate_updated', 'rent_invoice_source_updated'
  ]);
  assert.deepEqual(audits[0].changedFields, ['effectiveFrom', 'rentPrice']);
  assert.deepEqual(audits[1].changedFields, ['electricNew']);

  const unchanged = stateBusinessAuditEntries(
    req,
    [{ ...existingRates[0], rent_price: '2200000' }],
    [{ ...existingBilling[0], electric_new: '25' }],
    rooms,
    billingData
  );
  assert.deepEqual(unchanged, []);
});

test('UI hiển thị actor và nhãn cho bốn nhóm audit nghiệp vụ', () => {
  const root = path.join(__dirname, '..', '..');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const action of [
    'room_rate_updated',
    'rent_invoice_updated',
    'rent_payment_transaction_recorded',
    'rental_contract_amended'
  ]) {
    assert.match(app, new RegExp(`${action}:`));
  }
  assert.match(app, /log\.actorEmail \|\| 'Hệ thống'/);
  assert.match(html, /Xem nhật ký dữ liệu &amp; nghiệp vụ|Xem nhật ký dữ liệu & nghiệp vụ/);
});
