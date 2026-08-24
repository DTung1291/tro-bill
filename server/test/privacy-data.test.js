'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-privacy-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.COOKIE_SECURE = 'false';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const bcrypt = require('bcryptjs');
const db = require('../db');
const {
  acceptPolicies,
  deleteAccount,
  exportAccountData,
  getPrivacyStatus,
  listAuditLogs,
  revealTenantCccd
} = require('../privacy');
const { putState } = require('../state');

function responseRecorder() {
  const record = { statusCode: 200, body: null, headers: {}, clearedCookie: null };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; },
    set(name, value) { record.headers[name] = value; return res; },
    clearCookie(name, options) { record.clearedCookie = { name, options }; return res; }
  };
  return { record, res };
}

function privacyRequest(overrides = {}) {
  return {
    userId: 7,
    userEmail: 'owner@example.com',
    body: {},
    params: {},
    query: {},
    ip: '127.0.0.1',
    get(name) { return name === 'user-agent' ? 'privacy-test-agent' : ''; },
    ...overrides
  };
}

test('trạng thái chính sách và xác nhận được lưu theo phiên bản hiện tại', async (t) => {
  const originalQuery = db.query;
  const calls = [];
  t.after(() => { db.query = originalQuery; });
  db.query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('SELECT privacy_policy_version')) {
      return {
        rows: [{
          privacy_policy_version: '',
          privacy_accepted_at: null,
          terms_version: '',
          terms_accepted_at: null
        }]
      };
    }
    return { rows: [] };
  };

  const status = responseRecorder();
  await getPrivacyStatus(privacyRequest(), status.res);
  assert.equal(status.record.body.accepted, false);
  assert.equal(status.record.body.retention.backupDays, 30);
  assert.equal(status.record.body.retention.auditDays, 365);

  const rejected = responseRecorder();
  await acceptPolicies(privacyRequest({ body: { acceptPrivacy: true } }), rejected.res);
  assert.equal(rejected.record.statusCode, 400);

  const accepted = responseRecorder();
  await acceptPolicies(privacyRequest({
    body: { acceptPrivacy: true, acceptTerms: true }
  }), accepted.res);
  assert.equal(accepted.record.body.ok, true);
  assert.equal(calls.some(call => call.sql.includes('UPDATE users')), true);
  assert.equal(calls.some(call => call.sql.includes('INSERT INTO data_audit_logs')), true);
});

test('chủ tài khoản xem CCCD đầy đủ qua API có audit và response không cache', async (t) => {
  const originalQuery = db.query;
  let auditParams = null;
  t.after(() => { db.query = originalQuery; });
  db.query = async (sql, params = []) => {
    if (sql.includes('SELECT id, cccd FROM tenants')) {
      return { rows: [{ id: 'tenant-1', cccd: '079099001234' }] };
    }
    if (sql.includes('INSERT INTO data_audit_logs')) auditParams = params;
    return { rows: [] };
  };

  const response = responseRecorder();
  await revealTenantCccd(privacyRequest({
    params: { tenantId: 'tenant-1' },
    body: { purpose: 'edit' }
  }), response.res);

  assert.equal(response.record.body.cccd, '079099001234');
  assert.equal(response.record.body.audited, true);
  assert.equal(response.record.headers['Cache-Control'], 'no-store');
  assert.equal(auditParams[3], 'tenant_sensitive_view');
  assert.equal(auditParams[7], 'edit');
  assert.equal(auditParams.includes('079099001234'), false, 'audit không lưu CCCD');
});

test('nhật ký tài khoản hiển thị cả lần admin xem CCCD và lý do hỗ trợ', async (t) => {
  const originalQuery = db.query;
  t.after(() => { db.query = originalQuery; });
  db.query = async (sql, params = []) => {
    assert.match(sql, /admin_sensitive_access_logs/);
    assert.deepEqual(params, [7, 50]);
    return {
      rows: [{
        id: '12',
        action: 'admin_tenant_sensitive_view',
        resource_type: 'tenant',
        resource_id: 'tenant-1',
        changed_fields: [],
        purpose: 'Đối chiếu hồ sơ theo yêu cầu hỗ trợ',
        created_at: new Date('2026-08-24T10:00:00Z')
      }]
    };
  };

  const response = responseRecorder();
  await listAuditLogs(privacyRequest(), response.res);
  assert.equal(response.record.body.logs[0].action, 'admin_tenant_sensitive_view');
  assert.equal(response.record.body.logs[0].purpose, 'Đối chiếu hồ sơ theo yêu cầu hỗ trợ');
  assert.equal(response.record.headers['Cache-Control'], 'no-store');
});

test('xuất dữ liệu yêu cầu mật khẩu và chỉ endpoint export trả CCCD đầy đủ', async (t) => {
  const originalQuery = db.query;
  const passwordHash = await bcrypt.hash('matkhau123', 4);
  let auditParams = null;
  t.after(() => { db.query = originalQuery; });
  db.query = async (sql, params = []) => {
    if (sql.includes('SELECT password_hash FROM users')) return { rows: [{ password_hash: passwordHash }] };
    if (sql.includes('SELECT email, created_at')) {
      return {
        rows: [{
          email: 'owner@example.com',
          created_at: new Date('2026-01-01T00:00:00Z'),
          privacy_policy_version: '2026-08-24',
          privacy_accepted_at: new Date('2026-08-24T00:00:00Z'),
          terms_version: '2026-08-24',
          terms_accepted_at: new Date('2026-08-24T00:00:00Z')
        }]
      };
    }
    if (sql.includes('FROM rooms')) return { rows: [{ id: 'room-1', name: 'P1' }] };
    if (sql.includes('FROM tenants')) {
      return { rows: [{ id: 'tenant-1', room_id: 'room-1', full_name: 'A', cccd: '079099001234' }] };
    }
    if (sql.includes('INSERT INTO data_audit_logs')) auditParams = params;
    return { rows: [] };
  };

  const denied = responseRecorder();
  await exportAccountData(privacyRequest({ body: { password: 'sai' } }), denied.res);
  assert.equal(denied.record.statusCode, 403);

  const exported = responseRecorder();
  await exportAccountData(privacyRequest({ body: { password: 'matkhau123' } }), exported.res);
  assert.equal(exported.record.body.rooms[0].tenants[0].cccd, '079099001234');
  assert.deepEqual(exported.record.body.dataAuditLogs, []);
  assert.equal(exported.record.body.exportMetadata.account.email, 'owner@example.com');
  assert.equal(exported.record.headers['Cache-Control'], 'no-store');
  assert.match(exported.record.headers['Content-Disposition'], /trobill-data-/);
  assert.equal(auditParams[3], 'account_data_export');
  assert.equal(auditParams.includes('079099001234'), false);
});

test('xóa tài khoản yêu cầu mật khẩu và cụm xác nhận rồi cascade user', async (t) => {
  const originalQuery = db.query;
  const originalGetClient = db.getClient;
  const passwordHash = await bcrypt.hash('matkhau123', 4);
  const calls = [];
  t.after(() => {
    db.query = originalQuery;
    db.getClient = originalGetClient;
  });
  db.query = async (sql) => {
    if (sql.includes('SELECT password_hash FROM users')) return { rows: [{ password_hash: passwordHash }] };
    return { rows: [] };
  };
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('DELETE FROM users')) return { rowCount: 1, rows: [{ id: 7 }] };
      return { rows: [] };
    },
    release() {}
  };
  db.getClient = async () => client;

  const missingConfirmation = responseRecorder();
  await deleteAccount(privacyRequest({
    body: { password: 'matkhau123', confirmation: 'xóa' }
  }), missingConfirmation.res);
  assert.equal(missingConfirmation.record.statusCode, 400);

  const deleted = responseRecorder();
  await deleteAccount(privacyRequest({
    body: { password: 'matkhau123', confirmation: 'XOA TAI KHOAN' }
  }), deleted.res);
  assert.equal(deleted.record.body.deleted, true);
  assert.equal(deleted.record.clearedCookie.name, 'trobill_session');
  assert.equal(calls.some(call => call.sql.includes('INSERT INTO data_audit_logs')), true);
  assert.equal(calls.some(call => call.sql.includes('DELETE FROM users')), true);
  assert.equal(calls[0].sql, 'BEGIN');
  assert.equal(calls.at(-1).sql, 'COMMIT');
  assert.equal(calls.flatMap(call => call.params).includes('matkhau123'), false, 'audit không lưu mật khẩu');
});

test('putState giữ CCCD gốc khi client gửi bản che và audit trường đã sửa', async (t) => {
  const originalGetClient = db.getClient;
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM subscriptions s')) {
        return {
          rows: [{
            subscription_id: 10, status: 'active', starts_at: new Date(), ends_at: null,
            plan_id: 1, plan_code: 'free', plan_name: 'Free', room_limit: 10, staff_limit: 0
          }]
        };
      }
      if (sql.includes('SELECT id, full_name, phone, cccd')) {
        return {
          rows: [{
            id: 'tenant-1',
            full_name: 'Nguyễn Văn A',
            phone: '0900000000',
            cccd: '079099001234',
            issue_date: '2021-01-01',
            dob: '1999-01-01',
            gender: 'Nam',
            address: 'Đà Nẵng',
            data_notice_version: '2026-08-24',
            data_notice_acknowledged_at: new Date('2026-08-24T00:00:00Z')
          }]
        };
      }
      return { rows: [] };
    },
    release() {}
  };
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await putState(privacyRequest({
    body: {
      rooms: [{
        id: 'room-1',
        tenants: [{
          id: 'tenant-1',
          fullName: 'Nguyễn Văn A',
          phone: '0911111111',
          cccd: '••••••••1234',
          issueDate: '2021-01-01',
          dob: '1999-01-01',
          gender: 'Nam',
          address: 'Đà Nẵng',
          dataNoticeAcknowledged: true
        }]
      }]
    }
  }), response.res);

  const tenantInsert = calls.find(call => call.sql.includes('INSERT INTO tenants'));
  const auditInsert = calls.find(call => call.sql.includes('INSERT INTO data_audit_logs'));
  assert.equal(tenantInsert.params[5], '079099001234', 'không ghi dấu che vào database');
  assert.deepEqual(auditInsert.params[6], ['phone']);
  assert.equal(auditInsert.params.includes('079099001234'), false, 'audit không lưu dữ liệu nhạy cảm');
  assert.equal(response.record.body.ok, true);
});

test('khách thuê mới bắt buộc xác nhận đã thông báo mục đích thu thập', async (t) => {
  const originalGetClient = db.getClient;
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM subscriptions s')) {
        return {
          rows: [{
            subscription_id: 10, status: 'active', starts_at: new Date(), ends_at: null,
            plan_id: 1, plan_code: 'free', plan_name: 'Free', room_limit: 10, staff_limit: 0
          }]
        };
      }
      if (sql.includes('SELECT id, full_name, phone, cccd')) return { rows: [] };
      return { rows: [] };
    },
    release() {}
  };
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await putState(privacyRequest({
    body: {
      rooms: [{
        id: 'room-1',
        tenants: [{ id: 'tenant-new', fullName: 'A', cccd: '012345678901' }]
      }]
    }
  }), response.res);
  assert.equal(response.record.statusCode, 400);
  assert.equal(response.record.body.code, 'TENANT_DATA_NOTICE_REQUIRED');
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
});
