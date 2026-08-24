'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-state-rate-history-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.COOKIE_SECURE = 'false';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { buildState, putState } = require('../state');

const roomRow = {
  id: 'room-1',
  user_id: 7,
  name: 'Phòng 1',
  rent_start_date: '2026-08-10',
  rent_price: '2500000',
  electric_rate: '4000',
  water_rate: '60000',
  water_type: 'người',
  people_count: '2',
  trash_fee: '60000',
  wifi_fee: '50000',
  manage_fee: '100000',
  electric_prev: '10',
  water_prev: '0',
  notes: '',
  sort_order: 0
};

test('buildState gắn lịch sử biểu phí vào đúng phòng', async (t) => {
  const originalQuery = db.query;
  t.after(() => { db.query = originalQuery; });

  db.query = async (sql) => {
    if (sql.includes('FROM room_rate_history')) {
      return {
        rows: [
          { ...roomRow, room_id: 'room-1', effective_from: '2026-01', rent_price: '2000000', electric_rate: '3200', water_rate: '50000', trash_fee: '50000', wifi_fee: '40000', manage_fee: '0' },
          { ...roomRow, room_id: 'room-1', effective_from: '2026-04' }
        ]
      };
    }
    if (sql.includes('FROM rooms')) return { rows: [roomRow] };
    if (sql.includes('FROM settings')) return { rows: [] };
    if (sql.includes('FROM history_snapshots')) {
      return { rows: [{ id: 99, period: '2026-08', deduction: '0', created_at: '1' }] };
    }
    if (sql.includes('FROM history_bills')) {
      return {
        rows: [{
          snapshot_id: 99,
          room_id: 'room-1',
          room_name: 'Phòng 1',
          rent_price: '2200000',
          rent_base_price: '3100000',
          rent_days: 22,
          rent_days_in_month: 31,
          rent_prorated: true,
          rent_starts_after_period: false,
          total: '2200000'
        }]
      };
    }
    return { rows: [] };
  };

  const state = await buildState(7);

  assert.equal(state.rooms.length, 1);
  assert.equal(state.rooms[0].rateHistory.length, 2);
  assert.equal(state.rooms[0].rateHistory[0].effectiveFrom, '2026-01');
  assert.equal(state.rooms[0].rateHistory[0].rentPrice, 2000000);
  assert.equal(state.rooms[0].rateHistory[1].effectiveFrom, '2026-04');
  assert.equal(state.rooms[0].rateHistory[1].rentPrice, 2500000);
  assert.equal(state.rooms[0].rentStartDate, '2026-08-10');
  assert.equal(state.history[0].bills[0].rentBasePrice, 3100000);
  assert.equal(state.history[0].bills[0].rentDays, 22);
  assert.equal(state.history[0].bills[0].rentDaysInMonth, 31);
  assert.equal(state.history[0].bills[0].rentProrated, true);
});

test('putState ghi từng mốc biểu phí trong cùng transaction', async (t) => {
  const originalGetClient = db.getClient;
  const calls = [];
  const client = {
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO history_snapshots')) return { rows: [{ id: 99 }] };
      return { rows: [] };
    },
    release: () => {}
  };
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const room = {
    id: 'room-1',
    name: 'Phòng 1',
    rentStartDate: '2026-08-10',
    waterType: 'người',
    peopleCount: 2,
    electricPrev: 10,
    waterPrev: 0,
    tenants: [],
    rateHistory: [
      { effectiveFrom: '2026-01', rentPrice: 2000000, electricRate: 3200, waterRate: 50000, trashFee: 50000, wifiFee: 40000, manageFee: 0 },
      { effectiveFrom: '2026-04', rentPrice: 2500000, electricRate: 4000, waterRate: 60000, trashFee: 60000, wifiFee: 50000, manageFee: 100000 }
    ]
  };
  let responseBody = null;
  const res = {
    json: (body) => { responseBody = body; },
    status: () => res
  };

  const history = [{
    period: '2026-08',
    deduction: 0,
    timestamp: 1,
    bills: [{
      roomId: 'room-1',
      roomName: 'Phòng 1',
      rentPrice: 2200000,
      rentBasePrice: 3100000,
      rentDays: 22,
      rentDaysInMonth: 31,
      rentProrated: true,
      rentStartsAfterPeriod: false,
      total: 2200000
    }]
  }];

  await putState({ userId: 7, body: { rooms: [room], history } }, res);

  const rateInserts = calls.filter(call => call.sql.includes('INSERT INTO room_rate_history'));
  const roomInsert = calls.find(call => call.sql.includes('INSERT INTO rooms'));
  assert.equal(rateInserts.length, 2);
  assert.deepEqual(rateInserts.map(call => call.params[2]), ['2026-01', '2026-04']);
  const historyBillInsert = calls.find(call => call.sql.includes('INSERT INTO history_bills'));
  assert.equal(roomInsert.params[3], '2026-08-10');
  assert.equal(roomInsert.params[4], 2500000, 'rooms.rent_price giữ giá mới nhất để tương thích bản cũ');
  assert.deepEqual(historyBillInsert.params.slice(3, 9), [2200000, 3100000, 22, 31, true, false]);
  assert.deepEqual(responseBody, { ok: true });
  assert.equal(calls[0].sql, 'BEGIN');
  assert.equal(calls.at(-1).sql, 'COMMIT');
});
