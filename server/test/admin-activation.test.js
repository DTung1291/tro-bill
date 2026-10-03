'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const { activationSummaryJson, getActivationSummary } = require('../admin-activation');

const root = path.resolve(__dirname, '../..');

test('hai nhóm mốc chỉ trả số tổng hợp và xử lý nhóm rỗng', () => {
  const summary = activationSummaryJson({
    all_accounts: '10', all_property: '10', all_room: '6', all_reading: '4', all_bill: '2',
    recent_accounts: '0', recent_property: '0', recent_room: '0', recent_reading: '0', recent_bill: '0',
    generated_at: '2026-10-03T00:00:00.000Z', email: 'must-not-leak@example.test'
  });
  assert.deepEqual(summary.allTime, { accounts: 10, property: 10, room: 6, reading: 4, bill: 2 });
  assert.deepEqual(summary.last30Days, { accounts: 0, property: 0, room: 0, reading: 0, bill: 0 });
  assert.equal(summary.generatedAt, '2026-10-03T00:00:00.000Z');
  assert.equal(JSON.stringify(summary).includes('must-not-leak'), false);
});

test('truy vấn đúng dữ liệu nghiệp vụ, loại tài khoản nhân viên và không cache', async t => {
  const originalQuery = db.query;
  let sql = '';
  db.query = async statement => {
    sql = statement;
    return { rows: [{ all_accounts: 2, all_property: 2, all_room: 1, all_reading: 1, all_bill: 1 }] };
  };
  t.after(() => { db.query = originalQuery; });
  const headers = {};
  let body;
  const res = {
    set(name, value) { headers[name] = value; return res; },
    json(value) { body = value; return res; }
  };
  await getActivationSummary({}, res);
  for (const table of ['users', 'account_memberships', 'properties', 'rooms',
    'billing_entries', 'rent_invoices', 'history_snapshots', 'history_bills']) {
    assert.match(sql, new RegExp(`\\b${table}\\b`));
  }
  assert.match(sql, /email_verified_at IS NOT NULL/);
  assert.match(sql, /membership\.role <> 'owner'/);
  assert.match(sql, /entry\.electric_new IS NOT NULL/);
  assert.match(sql, /entry\.water_new IS NOT NULL/);
  assert.match(sql, /room\.water_type='người'/);
  assert.match(sql, /has_property OR has_bill AS reached_property/);
  assert.match(sql, /has_reading OR has_bill AS reached_reading/);
  assert.match(sql, /interval '30 days'/);
  assert.equal(headers['Cache-Control'], 'no-store');
  assert.equal(body.summary.allTime.bill, 1);
});

test('API chỉ cho Super Admin và giao diện giải thích tỷ lệ ảnh chụp', () => {
  const server = fs.readFileSync(path.join(root, 'server/index.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  const client = fs.readFileSync(path.join(root, 'admin.js'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  assert.match(server, /\/api\/admin\/activation\/summary', adminGuard/);
  assert.match(api, /getActivationSummary: \(\) => request\('GET', '\/api\/admin\/activation\/summary'\)/);
  assert.match(html, /id="admin-activation-section"[\s\S]*ảnh chụp hiện tại/);
  assert.match(html, /data-activation-cohort="allTime"[\s\S]*data-activation-cohort="last30Days"/);
  assert.match(client, /API\.admin\.getActivationSummary\(\)/);
  assert.match(client, /row\.querySelector\('strong'\)\.textContent/);
});
