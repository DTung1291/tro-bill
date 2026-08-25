'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const { getRevenueSummary, revenueSummaryJson } = require('../admin-revenue');

function responseRecorder() {
  const record = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { record.statusCode = code; return res; },
    set(name, value) { record.headers[String(name).toLowerCase()] = value; return res; },
    json(body) { record.body = body; return res; }
  };
  return { record, res };
}

function metricRow(overrides = {}) {
  return {
    total_accounts: '20',
    trialing_accounts: '3',
    paying_accounts: '8',
    expired_accounts: '2',
    expiring_soon_accounts: '4',
    trial_ever_count: '10',
    trial_converted_count: '4',
    month_gross_vnd: '5000000',
    month_refunded_vnd: '500000',
    year_gross_vnd: '30000000',
    year_refunded_vnd: '1000000',
    mrr_vnd: '712500.4',
    generated_at: '2026-08-25T00:00:00.000Z',
    ...overrides
  };
}

test('summary tính doanh thu thuần, MRR/ARR và tỷ lệ chuyển đổi', () => {
  const summary = revenueSummaryJson(metricRow());
  assert.deepEqual(summary.accounts, {
    total: 20,
    trialing: 3,
    paying: 8,
    expired: 2,
    expiringSoon: 4
  });
  assert.equal(summary.revenue.monthNetVnd, 4500000);
  assert.equal(summary.revenue.yearNetVnd, 29000000);
  assert.equal(summary.revenue.mrrVnd, 712500);
  assert.equal(summary.revenue.arrVnd, 8550005);
  assert.equal(summary.trialConversion.ratePercent, 40);
});

test('tỷ lệ chuyển đổi bằng 0 khi chưa từng có trial', () => {
  const summary = revenueSummaryJson(metricRow({
    trial_ever_count: 0,
    trial_converted_count: 0
  }));
  assert.equal(summary.trialConversion.ratePercent, 0);
});

test('API tổng hợp dùng múi giờ Việt Nam, trừ refund và không cache', async (t) => {
  const originalQuery = db.query;
  let capturedSql = '';
  db.query = async (sql) => {
    capturedSql = sql;
    return { rows: [metricRow()] };
  };
  t.after(() => { db.query = originalQuery; });
  const response = responseRecorder();

  await getRevenueSummary({}, response.res);

  assert.match(capturedSql, /Asia\/Ho_Chi_Minh/);
  assert.match(capturedSql, /subscription_refund_requests/);
  assert.match(capturedSql, /rr\.status='refunded'/);
  assert.match(capturedSql, /p\.yearly_price_vnd \/ 12\.0/);
  assert.equal(response.record.headers['cache-control'], 'no-store');
  assert.equal(response.record.body.summary.revenue.monthNetVnd, 4500000);
});
