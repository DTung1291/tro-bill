'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-admin-subscription-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const admin = require('../admin');
const { listAdminManualChangeLogs } = require('../subscription');

function responseRecorder() {
  const record = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { record.statusCode = code; return res; },
    set(name, value) { record.headers[String(name).toLowerCase()] = value; return res; },
    json(body) { record.body = body; return res; }
  };
  return { record, res };
}

test('danh sách user kèm gói hiện tại và trạng thái vòng đời từ server', async (t) => {
  const originalQuery = db.query;
  let capturedSql = '';
  db.query = async (sql) => {
    capturedSql = sql;
    return {
      rows: [{
        id: '7',
        email: 'owner@example.com',
        is_admin: false,
        created_at: '2026-01-01T00:00:00.000Z',
        subscription_id: '11',
        subscription_status: 'active',
        billing_cycle: 'monthly',
        subscription_starts_at: '2026-08-01T00:00:00.000Z',
        subscription_ends_at: new Date(Date.now() + 5 * 86400000).toISOString(),
        trial_used_at: '2026-01-01T00:00:00.000Z',
        plan_code: 'pro',
        plan_name: 'Pro',
        room_limit: 50,
        trial_days: 14,
        room_count: 12,
        history_count: 3
      }]
    };
  };
  t.after(() => { db.query = originalQuery; });

  const response = responseRecorder();
  await admin.listUsers({}, response.res);

  assert.match(capturedSql, /LEFT JOIN subscriptions s ON s\.user_id=u\.id/);
  assert.match(capturedSql, /LEFT JOIN plans p ON p\.id=s\.plan_id/);
  assert.equal(response.record.headers['cache-control'], 'no-store');
  assert.deepEqual(response.record.body.users[0].subscription, {
    id: 11,
    planCode: 'pro',
    planName: 'Pro',
    roomLimit: 50,
    trialDays: 14,
    status: 'expiring_soon',
    recordedStatus: 'active',
    billingCycle: 'monthly',
    startsAt: '2026-08-01T00:00:00.000Z',
    endsAt: response.record.body.users[0].subscription.endsAt,
    trialUsed: true
  });
});

test('API audit chỉ liệt kê thao tác gói thủ công và thu hẹp metadata', async (t) => {
  const originalQuery = db.query;
  let captured = null;
  db.query = async (sql, params) => {
    captured = { sql, params };
    return {
      rows: [{
        id: '91',
        actor_user_id: '1',
        actor_email_snapshot: 'admin@example.com',
        target_user_id: '7',
        target_email_snapshot: 'owner@example.com',
        action: 'subscription_renewed',
        previous_plan_code: 'pro',
        new_plan_code: 'pro',
        previous_status: 'active',
        new_status: 'active',
        reason: 'Đã xác minh giao dịch hỗ trợ thủ công',
        metadata: { billingCycle: 'yearly', providerSecret: 'must-not-leak' },
        created_at: '2026-08-25T00:00:00.000Z'
      }]
    };
  };
  t.after(() => { db.query = originalQuery; });

  const response = responseRecorder();
  await listAdminManualChangeLogs({ query: { limit: '9999' } }, response.res);

  assert.match(captured.sql, /actor_user_id IS NOT NULL/);
  assert.match(captured.sql, /action IN \('trial_started', 'subscription_upgraded', 'subscription_renewed'\)/);
  assert.deepEqual(captured.params, [200]);
  assert.equal(response.record.headers['cache-control'], 'no-store');
  assert.equal(response.record.body.changeLogs[0].billingCycle, 'yearly');
  assert.equal('metadata' in response.record.body.changeLogs[0], false);
  assert.equal(JSON.stringify(response.record.body).includes('must-not-leak'), false);
});

test('UI quản trị có form lý do, API thao tác và bảng audit gói', () => {
  const root = path.join(__dirname, '..', '..');
  const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  const adminSource = fs.readFileSync(path.join(root, 'admin.js'), 'utf8');
  const apiSource = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  assert.match(html, /id="subscription-change-log-table"/);
  assert.match(html, /admin\.js\?v=77/);
  assert.match(adminSource, /id="admin-subscription-reason"/);
  assert.match(adminSource, /API\.admin\.startSubscriptionTrial/);
  assert.match(adminSource, /API\.admin\.changeSubscription/);
  assert.match(apiSource, /\/api\/admin\/subscription\/manual-change-logs/);
});
