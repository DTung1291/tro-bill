'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-maintenance-request-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'https://tro-bill.example';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  expiryDays,
  generatePortalToken,
  issueMaintenancePortal,
  portalTokenHash,
  publicRequestInput,
  requestCode,
  resolvePublicMaintenancePortal,
  submitPublicMaintenanceRequest,
  validatePortalRow
} = require('../tenant-maintenance-requests');

function responseRecorder() {
  const record = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; },
    set(name, value) { record.headers[name] = value; return res; }
  };
  return { record, res };
}

function request(overrides = {}) {
  return {
    userId: 7,
    actorUserId: 7,
    userEmail: 'owner@example.com',
    body: {},
    params: {},
    headers: {},
    ip: '127.0.0.1',
    protocol: 'https',
    get(name) {
      if (String(name).toLowerCase() === 'host') return 'request.example';
      if (String(name).toLowerCase() === 'user-agent') return 'maintenance-test-agent';
      return '';
    },
    ...overrides
  };
}

function portalRow(overrides = {}) {
  return {
    id: 12,
    user_id: 7,
    contract_id: 31,
    contract_code: 'HD-2026-00001F',
    room_id: 'room-a',
    room_name_snapshot: 'A101',
    tenant_id: 'tenant-secret-id',
    tenant_name_snapshot: 'Nguyễn Văn A',
    token_hash: 'a'.repeat(64),
    token_last4: 'Ab_9',
    expires_at: '2099-09-01T00:00:00.000Z',
    revoked_at: null,
    view_count: '0',
    last_viewed_at: null,
    created_at: '2026-09-01T00:00:00.000Z',
    contract_status: 'active',
    contract_date_expired: false,
    ...overrides
  };
}

function maintenanceRow(overrides = {}) {
  return {
    id: 44,
    user_id: 7,
    contract_id: 31,
    portal_link_id: 12,
    request_code: 'YC-2026-000018',
    room_id: 'room-a',
    room_name_snapshot: 'A101',
    tenant_id: 'tenant-secret-id',
    tenant_name_snapshot: 'Nguyễn Văn A',
    category: 'water',
    urgency: 'high',
    description: 'Ống nước dưới bồn rửa đang rò rỉ liên tục.',
    contact_phone: '0900000000',
    available_time: 'Sau 18 giờ',
    status: 'new',
    submitted_at: '2026-09-01T02:00:00.000Z',
    created_at: '2026-09-01T02:00:00.000Z',
    updated_at: '2026-09-01T02:00:00.000Z',
    idempotency_key: '7c321fc5-c449-4db0-a09f-0f856ae08a39',
    ...overrides
  };
}

test('token cổng báo sửa có 256-bit entropy, chỉ lưu SHA-256 và giới hạn 365 ngày', () => {
  const token = generatePortalToken();
  assert.match(token, /^tmrq_[A-Za-z0-9_-]{43}$/);
  assert.match(portalTokenHash(token), /^[a-f0-9]{64}$/);
  assert.equal(expiryDays(undefined), 90);
  assert.equal(expiryDays(365), 365);
  assert.throws(() => expiryDays(366), error => error.code === 'INVALID_MAINTENANCE_PORTAL_EXPIRY');
  assert.equal(requestCode(44, 2026), 'YC-2026-000018');
});

test('chuẩn hóa nội dung yêu cầu và từ chối mô tả quá ngắn', () => {
  assert.deepEqual(publicRequestInput({
    category: ' WATER ',
    urgency: 'HIGH',
    description: ' Ống nước bị rò\r\n\r\n\r\n  cần kiểm tra ',
    contactPhone: ' 0900  000 000 ',
    availableTime: ' Sau   18 giờ ',
    idempotencyKey: '7C321FC5-C449-4DB0-A09F-0F856AE08A39'
  }), {
    category: 'water',
    urgency: 'high',
    description: 'Ống nước bị rò\n\n cần kiểm tra',
    contactPhone: '0900 000 000',
    availableTime: 'Sau 18 giờ',
    idempotencyKey: '7c321fc5-c449-4db0-a09f-0f856ae08a39'
  });
  assert.throws(
    () => publicRequestInput({
      category: 'water', urgency: 'normal', description: 'Rò nước',
      idempotencyKey: '7c321fc5-c449-4db0-a09f-0f856ae08a39'
    }),
    error => error.code === 'INVALID_MAINTENANCE_REQUEST_DESCRIPTION'
  );
});

test('cổng báo sửa tự mất hiệu lực khi hợp đồng đã qua ngày kết thúc', () => {
  assert.throws(
    () => validatePortalRow(portalRow({ contract_date_expired: true })),
    error => error.code === 'MAINTENANCE_CONTRACT_INACTIVE' && error.statusCode === 410
  );
});

test('chủ trọ tạo link cho hợp đồng active, thu hồi link cũ và không lưu token rõ', async () => {
  const token = 'tmrq_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('COUNT(*)::int AS room_count')) return { rows: [{ room_count: 1 }] };
      if (sql.includes('SELECT s.id AS subscription_id')) {
        return { rows: [{
          subscription_id: 1, status: 'active', billing_cycle: 'monthly',
          starts_at: '2026-01-01T00:00:00.000Z', ends_at: null,
          plan_id: 1, plan_code: 'free', plan_name: 'Free',
          room_limit: 20, staff_limit: 0, room_count: 1
        }] };
      }
      if (sql.includes('FROM rental_contracts') && sql.includes('FOR UPDATE')) {
        return { rows: [{
          id: 31, contract_code: 'HD-2026-00001F', room_id: 'room-a',
          room_name_snapshot: 'A101', tenant_id: 'tenant-secret-id',
          tenant_name_snapshot: 'Nguyễn Văn A', status: 'active',
          ends_on: null, date_expired: false
        }] };
      }
      if (sql.includes('INSERT INTO tenant_maintenance_portal_links')) {
        return { rows: [portalRow({ token_hash: params[6], token_last4: params[7] })] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const response = responseRecorder();
  await issueMaintenancePortal(request({
    params: { id: '31' },
    body: { expiresInDays: 90 }
  }), response.res, {
    generateToken: () => token,
    getClient: async () => client
  });

  assert.equal(response.record.statusCode, 201);
  assert.match(response.record.body.publicUrl, /^https:\/\/tro-bill\.example\/maintenance\.html#t=tmrq_/);
  assert.equal(response.record.body.publicUrl.includes('?'), false);
  assert.equal(response.record.headers['Cache-Control'], 'no-store');
  assert.equal(calls.some(call => call.sql.includes('SET revoked_at=COALESCE')), true);
  const insert = calls.find(call => call.sql.includes('INSERT INTO tenant_maintenance_portal_links'));
  assert.equal(insert.params.includes(token), false);
  assert.equal(insert.params[6], portalTokenHash(token));
  assert.equal(calls.some(call => call.sql.includes('INSERT INTO data_audit_logs')), true);
  assert.equal(calls.some(call => call.sql === 'COMMIT'), true);
});

test('nhân viên không được quản lý cổng báo sửa của khách thuê', async () => {
  let opened = false;
  const response = responseRecorder();
  await issueMaintenancePortal(request({
    workspace: { isOwner: false, operations: ['rooms'] },
    params: { id: '31' },
    body: { expiresInDays: 90 }
  }), response.res, {
    getClient: async () => {
      opened = true;
      throw new Error('không được mở transaction');
    }
  });
  assert.equal(opened, false);
  assert.equal(response.record.statusCode, 403);
  assert.equal(response.record.body.code, 'TENANT_MAINTENANCE_OWNER_REQUIRED');
});

test('trang công khai chỉ trả thông tin tối thiểu và không lộ định danh khách thuê', async () => {
  const token = generatePortalToken();
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM tenant_maintenance_portal_links')) return { rows: [portalRow()] };
      if (sql.includes('FROM tenant_maintenance_requests')) return { rows: [maintenanceRow()] };
      return { rows: [] };
    },
    release() {}
  };
  const response = responseRecorder();
  await resolvePublicMaintenancePortal(request({ body: { token } }), response.res, {
    getClient: async () => client
  });

  assert.equal(response.record.body.portal.roomName, 'A101');
  assert.equal(response.record.body.requests[0].code, 'YC-2026-000018');
  const payload = JSON.stringify(response.record.body);
  assert.equal(payload.includes('tenant-secret-id'), false);
  assert.equal(payload.includes('Nguyễn Văn A'), false);
  assert.deepEqual(
    calls.find(call => call.sql.includes('FROM tenant_maintenance_portal_links')).params,
    [portalTokenHash(token)]
  );
  assert.equal(calls.some(call => call.sql.includes('view_count=view_count + 1')), true);
  assert.equal(calls.some(call => call.sql === 'COMMIT'), true);
});

test('gửi yêu cầu công khai là append-only, có audit và trả idempotent khi gửi lại', async () => {
  const token = generatePortalToken();
  const idempotencyKey = '7c321fc5-c449-4db0-a09f-0f856ae08a39';
  for (const duplicate of [false, true]) {
    const calls = [];
    const client = {
      async query(sql, params = []) {
        calls.push({ sql, params });
        if (sql.includes('FROM tenant_maintenance_portal_links')) return { rows: [portalRow()] };
        if (sql.includes("nextval('tenant_maintenance_requests_id_seq')")) {
          return { rows: [{ id: 44, code_year: 2026 }] };
        }
        if (sql.includes('INSERT INTO tenant_maintenance_requests')) {
          return { rows: duplicate ? [] : [maintenanceRow()] };
        }
        if (sql.includes('WHERE portal_link_id=$1 AND idempotency_key')) {
          return { rows: [maintenanceRow()] };
        }
        return { rows: [] };
      },
      release() {}
    };
    const response = responseRecorder();
    await submitPublicMaintenanceRequest(request({
      body: {
        token,
        category: 'water',
        urgency: 'high',
        description: 'Ống nước dưới bồn rửa đang rò rỉ liên tục.',
        contactPhone: '0900000000',
        availableTime: 'Sau 18 giờ',
        idempotencyKey
      }
    }), response.res, {
      checkRate: async () => true,
      recordRate: async () => true,
      getClient: async () => client
    });
    assert.equal(response.record.statusCode, duplicate ? 200 : 201);
    assert.equal(response.record.body.duplicate, duplicate);
    assert.equal(JSON.stringify(response.record.body).includes('tenant-secret-id'), false);
    assert.equal(
      calls.some(call => call.sql.includes('INSERT INTO data_audit_logs')),
      !duplicate
    );
    assert.equal(calls.some(call => call.sql === 'COMMIT'), true);
  }
});

test('schema, quyền runtime, routes và trang công khai giữ token ngoài query string', () => {
  const root = path.join(__dirname, '..', '..');
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260901_tenant_maintenance_requests.sql'),
    'utf8'
  );
  const serverSource = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  const maintenanceSource = fs.readFileSync(
    path.join(root, 'server', 'tenant-maintenance-requests.js'),
    'utf8'
  );
  const apiSource = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const publicHtml = fs.readFileSync(path.join(root, 'maintenance.html'), 'utf8');
  const publicJs = fs.readFileSync(path.join(root, 'maintenance-public.js'), 'utf8');

  for (const source of [schema, migration]) {
    const portalTable = source.match(/CREATE TABLE IF NOT EXISTS tenant_maintenance_portal_links \([\s\S]*?\n\);/)?.[0] || '';
    assert.match(portalTable, /token_hash\s+TEXT NOT NULL UNIQUE/);
    assert.doesNotMatch(portalTable, /token\s+TEXT|public_url/i);
    assert.match(source, /REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON tenant_maintenance_requests/);
    assert.match(source, /GRANT SELECT, INSERT ON tenant_maintenance_requests/);
  }
  assert.match(serverSource, /\/api\/public\/maintenance-portals\/resolve/);
  assert.match(serverSource, /\/api\/public\/maintenance-portals\/requests/);
  assert.match(serverSource, /\/api\/rental-contracts\/:id\/maintenance-portals/);
  assert.match(
    serverSource,
    /\/api\/rental-contracts\/:id\/maintenance-portals'[\s\S]*requireWorkspace\('rooms'\)[\s\S]*issueMaintenancePortal/
  );
  assert.match(apiSource, /function issueTenantMaintenancePortal/);
  assert.match(apiSource, /function getTenantMaintenanceRequests/);
  assert.match(appSource, /function openTenantMaintenanceModal/);
  assert.match(htmlSource, /id="tenant-maintenance-modal"/);
  assert.match(htmlSource, /style\.css\?v=113[\s\S]*api\.js\?v=106[\s\S]*app\.js\?v=116/);
  assert.match(publicHtml, /name="referrer" content="no-referrer"/);
  assert.match(publicHtml, /Content-Security-Policy/);
  assert.match(publicHtml, /maintenance-public\.css\?v=1[\s\S]*maintenance-public\.js\?v=2/);
  assert.match(publicJs, /location\.hash/);
  assert.match(publicJs, /history\.replaceState\(null, '', location\.pathname\)/);
  assert.match(publicJs, /credentials: 'same-origin'/);
  assert.match(publicJs, /crypto\.randomUUID\(\)/);
  assert.match(
    maintenanceSource,
    /contract\.ends_on < \(now\(\) AT TIME ZONE 'Asia\/Ho_Chi_Minh'\)::date/
  );
  assert.doesNotMatch(publicJs, /innerHTML/);
});
