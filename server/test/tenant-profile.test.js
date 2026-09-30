'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-tenant-profile-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeTenantProfile, updateTenantProfile } = require('../tenant-profile');
const { TENANT_DATA_NOTICE_VERSION } = require('../privacy-constants');

function responseRecorder() {
  const record = { statusCode: 200, body: null };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; }
  };
  return { record, res };
}

function profile(overrides = {}) {
  return {
    roomId: 'room-a', fullName: 'Khách thử', phone: '0900000000',
    email: 'test@example.com', cccd: '••••••••1234', issueDate: '2021-01-01',
    dob: '1999-01-01', gender: 'Nam', address: 'Địa chỉ thử',
    temporaryResidenceRegisteredOn: '2026-08-01',
    temporaryResidenceExpiresOn: '2027-08-01', dataNoticeAcknowledged: true,
    ...overrides
  };
}

function request(overrides = {}) {
  return {
    userId: 7, userEmail: 'owner@example.com', actorUserId: 7,
    workspace: { isOwner: true }, params: { tenantId: 'tenant-a' },
    body: profile(), ip: '127.0.0.1',
    get(name) { return name === 'user-agent' ? 'tenant-profile-test' : ''; },
    ...overrides
  };
}

function existingTenant() {
  return {
    id: 'tenant-a', full_name: 'Khách thử', phone: '0911111111',
    email: 'test@example.com', cccd: '079099001234',
    issue_date: '2021-01-01', dob: '1999-01-01', gender: 'Nam',
    address: 'Địa chỉ thử', temporary_residence_registered_on_iso: '2026-08-01',
    temporary_residence_expires_on_iso: '2027-08-01',
    data_notice_version: TENANT_DATA_NOTICE_VERSION,
    data_notice_acknowledged_at: new Date('2026-08-24T00:00:00Z')
  };
}

function fakeClient(tenant = existingTenant()) {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('COUNT(*)::int AS room_count')) return { rows: [{ room_count: 1 }] };
      if (sql.includes('FROM subscriptions s')) return {
        rows: [{ subscription_id: 1, status: 'active', starts_at: new Date(), ends_at: null,
          plan_id: 1, plan_code: 'free', plan_name: 'Free', room_limit: 10, staff_limit: 0 }]
      };
      if (sql.includes('FROM tenants tenant')) return { rows: tenant ? [tenant] : [] };
      return { rows: [] };
    },
    release() { calls.push({ sql: 'RELEASE' }); }
  };
  return { client, calls };
}

test('sửa một hồ sơ chỉ UPDATE tenant cùng chủ/phòng, giữ CCCD đã che và audit tên trường', async () => {
  const { client, calls } = fakeClient();
  const { record, res } = responseRecorder();
  await updateTenantProfile(request(), res, { getClient: async () => client });
  assert.equal(record.statusCode, 200);
  assert.deepEqual(record.body, { ok: true, tenantId: 'tenant-a', cccd: '••••••••1234' });
  const update = calls.find(call => call.sql.includes('UPDATE tenants SET'));
  assert.deepEqual(update.params.slice(0, 6), [
    'tenant-a', 7, 'Khách thử', '0900000000', 'test@example.com', '079099001234'
  ]);
  assert.match(calls.find(call => call.sql.includes('FROM tenants tenant')).sql,
    /tenant\.user_id=\$2 AND tenant\.room_id=\$3[\s\S]*FOR UPDATE OF tenant/);
  assert.equal(calls.some(call => call.sql.includes("'state-write:'")), true);
  assert.equal(calls.some(call => call.sql.includes('DELETE FROM rooms')), false);
  assert.equal(calls.some(call => call.sql.includes('INSERT INTO billing_entries')), false);
  const audit = calls.find(call => call.sql.includes('INSERT INTO data_audit_logs'));
  assert.deepEqual(audit.params[6], ['phone']);
  assert.equal(audit.params.includes('079099001234'), false);
  assert.equal(calls.some(call => call.sql === 'COMMIT'), true);
});

test('không ghi khi hồ sơ không đổi', async () => {
  const { client, calls } = fakeClient(existingTenant());
  const { record, res } = responseRecorder();
  await updateTenantProfile(request({ body: profile({ phone: '0911111111' }) }), res,
    { getClient: async () => client });
  assert.equal(record.body.ok, true);
  assert.equal(calls.some(call => call.sql.includes('UPDATE tenants SET')), false);
  assert.equal(calls.some(call => call.sql.includes('INSERT INTO data_audit_logs')), false);
});

test('thay ngày tạm trú được lưu và audit tên trường, không ghi dữ liệu cá nhân vào audit', async () => {
  const { client, calls } = fakeClient();
  const { record, res } = responseRecorder();
  await updateTenantProfile(request({ body: profile({
    phone: '0911111111', temporaryResidenceExpiresOn: '2027-09-01'
  }) }), res, { getClient: async () => client });
  assert.equal(record.statusCode, 200);
  const update = calls.find(call => call.sql.includes('UPDATE tenants SET'));
  assert.equal(update.params[11], '2027-09-01');
  const audit = calls.find(call => call.sql.includes('INSERT INTO data_audit_logs'));
  assert.deepEqual(audit.params[6], ['temporaryResidenceExpiresOn']);
  assert.equal(audit.params.includes('2027-09-01'), false);
});

test('chặn nhân viên và ID không thuộc phòng trước khi sửa', async () => {
  const staff = responseRecorder();
  await updateTenantProfile(request({ workspace: { isOwner: false } }), staff.res,
    { getClient: async () => { throw new Error('Không được mở DB'); } });
  assert.equal(staff.record.statusCode, 403);
  const { client, calls } = fakeClient(null);
  const missing = responseRecorder();
  await updateTenantProfile(request(), missing.res, { getClient: async () => client });
  assert.equal(missing.record.statusCode, 404);
  assert.equal(calls.some(call => call.sql.includes('UPDATE tenants SET')), false);
  assert.equal(calls.some(call => call.sql === 'ROLLBACK'), true);
});

test('từ chối ngày tạm trú và email sai trước khi mở transaction', async () => {
  assert.deepEqual(normalizeTenantProfile(profile({
    temporaryResidenceExpiresOn: '2026-07-31'
  })).error[0], 'INVALID_TENANT_DATES');
  const invalid = responseRecorder();
  await updateTenantProfile(request({ body: profile({ email: 'sai-email' }) }), invalid.res,
    { getClient: async () => { throw new Error('Không được mở DB'); } });
  assert.equal(invalid.record.statusCode, 400);
  assert.equal(invalid.record.body.code, 'INVALID_TENANT_EMAIL');
});

test('giao diện phản hồi trạng thái lưu và edit dùng API hồ sơ thay vì PUT toàn bộ state', () => {
  const app = fs.readFileSync(path.join(__dirname, '..', '..', 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', '..', 'index.html'), 'utf8');
  const api = fs.readFileSync(path.join(__dirname, '..', '..', 'api.js'), 'utf8');
  const server = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(html, /id="tenant-save-status"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(app, /submit\.textContent = saving \? 'Đang lưu…' : 'Lưu'/);
  assert.match(app, /if \(e\.currentTarget\.dataset\.saving === 'true'\) return/);
  assert.match(app, /if \(id\) \{[\s\S]*?persistTenantProfile\(id,[\s\S]*?\} else \{[\s\S]*?saveState\(\)/);
  assert.match(api, /function updateTenantProfile\(tenantId, profile\)/);
  assert.match(server, /'\/api\/tenants\/:tenantId\/profile',[\s\S]*?requireAuth,[\s\S]*?requireWorkspace\('rooms'\)[\s\S]*?tenantProfile\.updateTenantProfile/);
});
