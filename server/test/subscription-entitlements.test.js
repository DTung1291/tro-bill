'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-entitlement-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.COOKIE_SECURE = 'false';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const { putState } = require('../state');
const {
  EntitlementError,
  enforceStateWrite,
  getUserEntitlements,
  resolveEntitlements,
  resolveLifecycle
} = require('../subscription');

const activeFreeRow = {
  subscription_id: 10,
  status: 'active',
  starts_at: '2026-08-01T00:00:00.000Z',
  ends_at: null,
  plan_id: 1,
  plan_code: 'free',
  plan_name: 'Free',
  room_limit: 10,
  staff_limit: 0
};

function responseRecorder() {
  const record = { statusCode: 200, body: null };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; }
  };
  return { record, res };
}

test('entitlement lấy giới hạn từ plan phía server', async () => {
  let captured = null;
  const entitlement = await getUserEntitlements(7, async (sql, params) => {
    captured = { sql, params };
    return { rows: [activeFreeRow] };
  });

  assert.match(captured.sql, /FROM subscriptions s[\s\S]*JOIN plans p/);
  assert.deepEqual(captured.params, [7]);
  assert.equal(entitlement.plan.code, 'free');
  assert.equal(entitlement.features.roomManagement.limit, 10);
  assert.equal(entitlement.features.roomManagement.enabled, true);
  assert.equal(entitlement.features.staffManagement.enabled, false);
  assert.equal(entitlement.features.dataExport.enabled, true);
});

test('gói hết hạn chỉ đọc nhưng vẫn được xuất dữ liệu', () => {
  const entitlement = resolveEntitlements({
    ...activeFreeRow,
    status: 'active',
    ends_at: '2026-08-10T00:00:00.000Z'
  }, new Date('2026-08-14T00:00:00.000Z'));

  assert.equal(entitlement.accessMode, 'read_only');
  assert.equal(entitlement.subscription.status, 'expired');
  assert.equal(entitlement.features.roomManagement.enabled, false);
  assert.equal(entitlement.features.dataExport.enabled, true);
});

test('gói đang hoạt động được báo sắp hết hạn trước 7 ngày', () => {
  const entitlement = resolveEntitlements({
    ...activeFreeRow,
    ends_at: '2026-08-20T00:00:00.000Z'
  }, new Date('2026-08-14T00:00:00.000Z'));

  assert.equal(entitlement.subscription.recordedStatus, 'active');
  assert.equal(entitlement.subscription.status, 'expiring_soon');
  assert.equal(entitlement.subscription.expiringSoon, true);
  assert.equal(entitlement.subscription.daysRemaining, 6);
  assert.equal(entitlement.accessMode, 'full');
});

test('gói trả phí có 3 ngày ân hạn rồi mới chuyển chỉ xem', () => {
  const row = { ...activeFreeRow, ends_at: '2026-08-10T00:00:00.000Z' };
  const grace = resolveEntitlements(row, new Date('2026-08-11T00:00:00.000Z'));
  const expired = resolveEntitlements(row, new Date('2026-08-13T00:00:00.001Z'));

  assert.equal(grace.subscription.status, 'grace_period');
  assert.equal(grace.subscription.graceDaysRemaining, 2);
  assert.equal(grace.accessMode, 'full');
  assert.equal(expired.subscription.status, 'expired');
  assert.equal(expired.accessMode, 'read_only');
});

test('trial hết hạn không đi qua ân hạn', () => {
  const lifecycle = resolveLifecycle({
    ...activeFreeRow,
    status: 'trialing',
    ends_at: '2026-08-10T00:00:00.000Z'
  }, new Date('2026-08-10T00:00:00.001Z'));
  assert.equal(lifecycle.status, 'expired');
  assert.equal(lifecycle.graceEndsAt, null);
});

test('server từ chối số phòng vượt giới hạn gói', async () => {
  const query = async () => ({ rows: [activeFreeRow] });
  await assert.doesNotReject(() => enforceStateWrite(7, 10, query));
  await assert.rejects(
    () => enforceStateWrite(7, 11, query),
    (error) => {
      assert.ok(error instanceof EntitlementError);
      assert.equal(error.code, 'ROOM_LIMIT_EXCEEDED');
      assert.deepEqual(error.details, { current: 11, limit: 10, planCode: 'free' });
      return true;
    }
  );
});

test('PUT state chặn trước khi xóa dữ liệu nếu vượt room limit', async (t) => {
  const originalGetClient = db.getClient;
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM subscriptions s')) {
        return { rows: [{ ...activeFreeRow, room_limit: 1 }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await putState({
    userId: 7,
    body: { rooms: [{ id: 'room-1' }, { id: 'room-2' }] }
  }, response.res);

  assert.equal(response.record.statusCode, 403);
  assert.equal(response.record.body.code, 'ROOM_LIMIT_EXCEEDED');
  assert.equal(calls.some(call => call.sql.includes('DELETE FROM rooms')), false);
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
});

test('client không còn cờ hoặc native callback tự mở khóa Premium', () => {
  const appSource = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
  assert.doesNotMatch(appSource, /PREMIUM_FEATURES_ENABLED/);
  assert.doesNotMatch(appSource, /isPremiumUser/);
  assert.doesNotMatch(appSource, /onPremiumStatusChanged/);
  assert.match(appSource, /API\.getSubscription\(\)/);
  assert.match(appSource, /SERVER_ENTITLEMENTS\.features\.roomManagement/);
});
