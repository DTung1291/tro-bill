'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-authorization-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.COOKIE_SECURE = 'false';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const jwt = require('jsonwebtoken');
const db = require('../db');
const app = require('../index');
const { buildState, putState } = require('../state');
const { revealTenantCccd } = require('../admin');

function listen(serverApp) {
  return new Promise((resolve, reject) => {
    const server = serverApp.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

function responseRecorder() {
  const record = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; },
    set(name, value) { record.headers[name] = value; return res; }
  };
  return { res, record };
}

test('mọi API dữ liệu đều từ chối request chưa đăng nhập', async (t) => {
  const server = await listen(app);
  t.after(() => close(server));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const protectedRequests = [
    ['GET', '/api/me'],
    ['GET', '/api/subscription'],
    ['GET', '/api/subscription/payments'],
    ['GET', '/api/subscription/payments/1/receipt'],
    ['POST', '/api/subscription/payments/1/refund-requests'],
    ['POST', '/api/subscription/refund-requests/1/cancel'],
    ['GET', '/api/plans'],
    ['POST', '/api/subscription/orders'],
    ['GET', '/api/rent-payments/summary'],
    ['POST', '/api/rent-payments/sync'],
    ['POST', '/api/rent-payments/settle'],
    ['POST', '/api/rent-payments/migrate-legacy'],
    ['GET', '/api/rent-payments/invoices/1/transactions'],
    ['POST', '/api/rent-payments/transactions/1/reverse'],
    ['POST', '/api/rent-invoices/1/share-links'],
    ['GET', '/api/rent-invoices/1/share-links'],
    ['POST', '/api/rent-invoice-share-links/1/revoke'],
    ['GET', '/api/rent-payment-channels'],
    ['POST', '/api/rent-payment-channels/sepay'],
    ['POST', '/api/rent-payment-channels/1/rotate-secret'],
    ['PATCH', '/api/rent-payment-channels/1/status'],
    ['PATCH', '/api/rent-payment-channels/1/account'],
    ['GET', '/api/rent-bank-transactions'],
    ['POST', '/api/rent-bank-transactions/1/match'],
    ['POST', '/api/rent-bank-transactions/1/ignore'],
    ['GET', '/api/state'],
    ['PUT', '/api/state'],
    ['GET', '/api/config'],
    ['POST', '/api/auth/logout-all'],
    ['GET', '/api/privacy/status'],
    ['POST', '/api/privacy/accept'],
    ['POST', '/api/privacy/tenants/t-1/reveal-cccd'],
    ['GET', '/api/privacy/audit-logs'],
    ['POST', '/api/privacy/export'],
    ['DELETE', '/api/account'],
    ['GET', '/api/admin/users'],
    ['GET', '/api/admin/users/2/state'],
    ['DELETE', '/api/admin/users/2'],
    ['POST', '/api/admin/users/2/password'],
    ['POST', '/api/admin/users/2/admin'],
    ['POST', '/api/admin/users/2/subscription/trial'],
    ['POST', '/api/admin/users/2/subscription/change'],
    ['GET', '/api/admin/subscription/manual-change-logs'],
    ['POST', '/api/admin/users/2/tenants/t-1/reveal-cccd'],
    ['GET', '/api/admin/sensitive-access-logs'],
    ['GET', '/api/admin/config'],
    ['PUT', '/api/admin/config'],
    ['PUT', '/api/admin/config/subscription-payment'],
    ['GET', '/api/admin/plans'],
    ['PUT', '/api/admin/plans/pro'],
    ['GET', '/api/admin/subscription/refund-requests'],
    ['POST', '/api/admin/subscription/refund-requests/1/transition'],
    ['GET', '/api/admin/revenue/summary']
  ];

  for (const [method, path] of protectedRequests) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', Origin: baseUrl },
      body: ['GET', 'HEAD'].includes(method) ? undefined : '{}'
    });
    assert.equal(response.status, 401, `${method} ${path} phải yêu cầu đăng nhập`);
  }
});

test('tài khoản thường không thể gọi API admin', async (t) => {
  const originalQuery = db.query;
  db.query = async (sql) => {
    if (sql.includes('SELECT email, is_admin, token_version FROM users')) {
      return { rows: [{ email: 'user@example.com', is_admin: false, token_version: 0 }] };
    }
    if (sql.includes('SELECT is_admin FROM users')) return { rows: [{ is_admin: false }] };
    throw new Error(`Truy vấn phân quyền không mong đợi: ${sql}`);
  };
  const server = await listen(app);
  t.after(async () => {
    db.query = originalQuery;
    await close(server);
  });

  const token = jwt.sign(
    { uid: 22, email: 'user@example.com', admin: false, ver: 0 },
    process.env.JWT_SECRET,
    { expiresIn: '5m' }
  );
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/admin/users`, {
    headers: { Cookie: `trobill_session=${token}` }
  });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: 'Không đủ quyền' });
});

test('admin chỉ nhận CCCD đã che khi xem state', async (t) => {
  const originalQuery = db.query;
  t.after(() => { db.query = originalQuery; });
  db.query = async (sql, params = []) => {
    assert.deepEqual(params, [7], 'mọi truy vấn state phải dùng userId đích');
    if (sql.includes('FROM rooms')) {
      return { rows: [{ id: 'r-1', user_id: 7, name: 'P1' }] };
    }
    if (sql.includes('FROM tenants')) {
      return {
        rows: [{
          id: 't-1', room_id: 'r-1', user_id: 7, full_name: 'Nguyễn Văn A',
          cccd: '079099001234'
        }]
      };
    }
    return { rows: [] };
  };

  const ownerState = await buildState(7);
  const adminState = await buildState(7, { maskCccd: true });
  const exportState = await buildState(7, { maskCccd: false });
  assert.equal(ownerState.rooms[0].tenants[0].cccd, '••••••••1234');
  assert.equal(adminState.rooms[0].tenants[0].cccd, '••••••••1234');
  assert.equal(exportState.rooms[0].tenants[0].cccd, '079099001234');
});

test('xem CCCD đầy đủ bắt buộc lý do và ghi log không chứa CCCD', async (t) => {
  const originalQuery = db.query;
  let auditParams = null;
  t.after(() => { db.query = originalQuery; });
  db.query = async (sql, params = []) => {
    if (sql.includes('FROM tenants t')) {
      return {
        rows: [{
          id: 'tenant-1',
          full_name: 'Nguyễn Văn A',
          cccd: '079099001234',
          target_email: 'owner@example.com'
        }]
      };
    }
    if (sql.includes('INSERT INTO admin_sensitive_access_logs')) {
      auditParams = params;
      return { rows: [] };
    }
    if (sql.includes('DELETE FROM admin_sensitive_access_logs')) return { rows: [] };
    throw new Error(`Truy vấn CCCD không mong đợi: ${sql}`);
  };

  const shortReason = responseRecorder();
  await revealTenantCccd({
    params: { id: '7', tenantId: 'tenant-1' },
    body: { reason: 'xem thử' }
  }, shortReason.res);
  assert.equal(shortReason.record.statusCode, 400);

  const response = responseRecorder();
  await revealTenantCccd({
    params: { id: '7', tenantId: 'tenant-1' },
    body: { reason: 'Khách hàng yêu cầu đối chiếu hồ sơ thuê' },
    userId: 1,
    userEmail: 'admin@example.com',
    ip: '127.0.0.1',
    get(name) { return name === 'user-agent' ? 'test-agent' : ''; }
  }, response.res);

  assert.equal(response.record.statusCode, 200);
  assert.equal(response.record.body.cccd, '079099001234');
  assert.equal(response.record.body.audited, true);
  assert.equal(response.record.headers['Cache-Control'], 'no-store');
  assert.equal(auditParams.includes('079099001234'), false, 'audit log không lưu CCCD');
  assert.equal(auditParams.includes('Khách hàng yêu cầu đối chiếu hồ sơ thuê'), true);
});

test('putState từ chối roomId không thuộc danh sách phòng của tài khoản', async () => {
  const response = responseRecorder();
  await putState({
    userId: 7,
    body: {
      rooms: [{ id: 'room-owned' }],
      billingData: { '2026-08': { 'room-of-another-user': { paid: false } } }
    }
  }, response.res);
  assert.equal(response.record.statusCode, 400);
  assert.deepEqual(response.record.body, {
    error: 'Dữ liệu hóa đơn chứa phòng không thuộc tài khoản'
  });
});

test('putState từ chối điều chỉnh hóa đơn âm hoặc không phải số VND nguyên', async () => {
  for (const invalidEntry of [
    { discountAmount: -1 },
    { surchargeAmount: 1.5 },
    { lateFeeAmount: 'không hợp lệ' }
  ]) {
    const response = responseRecorder();
    await putState({
      userId: 7,
      body: {
        rooms: [{ id: 'room-owned' }],
        billingData: { '2026-08': { 'room-owned': invalidEntry } }
      }
    }, response.res);
    assert.equal(response.record.statusCode, 400);
    assert.equal(response.record.body.code, 'INVALID_INVOICE_ADJUSTMENT');
  }
});
