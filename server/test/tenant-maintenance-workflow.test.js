'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-maintenance-workflow-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  assignMaintenanceRequest,
  listMaintenanceWork,
  statusTransitionInput,
  transitionMaintenanceRequestStatus
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
    accountUserId: 7,
    actorUserId: 7,
    userEmail: 'owner@example.com',
    workspace: { isOwner: true, propertyIds: null, operations: ['rooms'] },
    body: {},
    params: {},
    query: {},
    headers: {},
    ip: '127.0.0.1',
    get(name) {
      if (String(name).toLowerCase() === 'user-agent') return 'workflow-test-agent';
      return '';
    },
    ...overrides
  };
}

function workflowRow(overrides = {}) {
  return {
    id: 44,
    user_id: 7,
    contract_id: 31,
    portal_link_id: 12,
    request_code: 'YC-2026-000018',
    property_id: 4,
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
    assigned_member_user_id: null,
    assigned_member_email: '',
    assigned_at: null,
    assignment_updated_at: null,
    submitted_at: '2026-09-05T02:00:00.000Z',
    created_at: '2026-09-05T02:00:00.000Z',
    updated_at: '2026-09-05T02:00:00.000Z',
    ...overrides
  };
}

function entitlementRows(sql) {
  if (sql.includes('COUNT(*)::int AS room_count')) return { rows: [{ room_count: 2 }] };
  if (sql.includes('SELECT s.id AS subscription_id')) {
    return { rows: [{
      subscription_id: 1,
      status: 'active',
      billing_cycle: 'monthly',
      starts_at: '2026-01-01T00:00:00.000Z',
      ends_at: null,
      plan_id: 2,
      plan_code: 'standard',
      plan_name: 'Standard',
      room_limit: 50,
      staff_limit: 3,
      room_count: 2
    }] };
  }
  return null;
}

test('input trạng thái giữ chuyển tiếp hữu hạn và bắt buộc ghi chú khi kết thúc', () => {
  assert.deepEqual(statusTransitionInput({ status: 'in_progress', note: '' }), {
    status: 'in_progress',
    note: ''
  });
  assert.throws(
    () => statusTransitionInput({ status: 'resolved', note: '' }),
    error => error.code === 'MAINTENANCE_STATUS_NOTE_REQUIRED'
  );
  assert.throws(
    () => statusTransitionInput({ status: 'new', note: '' }),
    error => error.code === 'INVALID_MAINTENANCE_STATUS'
  );
});

test('chủ trọ chỉ phân công nhân viên đủ quyền khu/rooms và ghi event cùng audit', async () => {
  const calls = [];
  let assigned = false;
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      const entitlement = entitlementRows(sql);
      if (entitlement) return entitlement;
      if (sql.includes('FROM tenant_maintenance_requests request') && sql.includes('request.id=$2')) {
        return { rows: [workflowRow(assigned ? {
          assigned_member_user_id: 9,
          assigned_member_email: 'manager@example.com',
          assigned_at: '2026-09-05T03:00:00.000Z',
          assignment_updated_at: '2026-09-05T03:00:00.000Z'
        } : {})] };
      }
      if (sql.includes('FROM account_memberships membership')) {
        return { rows: [{ member_user_id: 9, email: 'manager@example.com' }] };
      }
      if (sql.includes('INSERT INTO tenant_maintenance_request_assignments')) {
        assigned = true;
        return { rows: [] };
      }
      if (sql.includes('FROM tenant_maintenance_request_events')) {
        return { rows: [{
          id: 1,
          user_id: 7,
          request_id: 44,
          event_type: 'assignment_changed',
          actor_user_id: 7,
          actor_email_snapshot: 'owner@example.com',
          previous_assignee_user_id: null,
          previous_assignee_email_snapshot: '',
          new_assignee_user_id: 9,
          new_assignee_email_snapshot: 'manager@example.com',
          previous_status: null,
          new_status: null,
          note: '',
          created_at: '2026-09-05T03:00:00.000Z'
        }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const response = responseRecorder();
  await assignMaintenanceRequest(request({
    params: { id: '44' },
    body: { memberUserId: 9 }
  }), response.res, { getClient: async () => client });

  assert.equal(response.record.statusCode, 200);
  assert.equal(response.record.body.request.assignedTo.userId, 9);
  assert.equal(response.record.body.request.events[0].newAssignee.userId, 9);
  const eligibility = calls.find(call => call.sql.includes('account_member_property_access'));
  assert.deepEqual(eligibility.params, [7, 4]);
  assert.equal(calls.some(call => call.sql.includes("operation_access.operation='rooms'")), true);
  assert.equal(calls.some(call => call.sql.includes('INSERT INTO tenant_maintenance_request_events')), true);
  assert.equal(calls.some(call => call.sql.includes('INSERT INTO data_audit_logs')), true);
  assert.equal(calls.some(call => call.sql === 'COMMIT'), true);
});

test('phân công không đổi vẫn trả đầy đủ lịch sử và không ghi event/audit mới', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      const entitlement = entitlementRows(sql);
      if (entitlement) return entitlement;
      if (sql.includes('FROM tenant_maintenance_requests request') && sql.includes('request.id=$2')) {
        return { rows: [workflowRow({
          assigned_member_user_id: 9,
          assigned_member_email: 'manager@example.com'
        })] };
      }
      if (sql.includes('FROM tenant_maintenance_request_events')) {
        return { rows: [{
          id: 2,
          user_id: 7,
          request_id: 44,
          event_type: 'assignment_changed',
          actor_user_id: 7,
          actor_email_snapshot: 'owner@example.com',
          previous_assignee_user_id: null,
          previous_assignee_email_snapshot: '',
          new_assignee_user_id: 9,
          new_assignee_email_snapshot: 'manager@example.com',
          previous_status: null,
          new_status: null,
          note: '',
          created_at: '2026-09-05T03:00:00.000Z'
        }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const response = responseRecorder();
  await assignMaintenanceRequest(request({
    params: { id: '44' },
    body: { memberUserId: 9 }
  }), response.res, { getClient: async () => client });

  assert.equal(response.record.body.unchanged, true);
  assert.equal(response.record.body.request.events.length, 1);
  assert.equal(calls.some(call => call.sql.includes('INSERT INTO tenant_maintenance_request_events')), false);
  assert.equal(calls.some(call => call.sql.includes('INSERT INTO data_audit_logs')), false);
});

test('không thể phân công thành viên không có đúng khu và nghiệp vụ phòng', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      const entitlement = entitlementRows(sql);
      if (entitlement) return entitlement;
      if (sql.includes('FROM tenant_maintenance_requests request')) {
        return { rows: [workflowRow()] };
      }
      if (sql.includes('FROM account_memberships membership')) return { rows: [] };
      return { rows: [] };
    },
    release() {}
  };
  const response = responseRecorder();
  await assignMaintenanceRequest(request({
    params: { id: '44' },
    body: { memberUserId: 99 }
  }), response.res, { getClient: async () => client });
  assert.equal(response.record.statusCode, 409);
  assert.equal(response.record.body.code, 'MAINTENANCE_ASSIGNEE_NOT_ELIGIBLE');
  assert.equal(calls.some(call => call.sql === 'ROLLBACK'), true);
  assert.equal(calls.some(call => call.sql.includes('INSERT INTO tenant_maintenance_request_assignments')), false);
});

test('nhân viên được giao đúng khu cập nhật tiến độ và actor khác subject trong audit', async () => {
  const calls = [];
  const assigned = workflowRow({
    status: 'acknowledged',
    assigned_member_user_id: 9,
    assigned_member_email: 'manager@example.com',
    assigned_at: '2026-09-05T03:00:00.000Z',
    assignment_updated_at: '2026-09-05T03:00:00.000Z'
  });
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      const entitlement = entitlementRows(sql);
      if (entitlement) return entitlement;
      if (sql.includes('FROM tenant_maintenance_requests request')) return { rows: [assigned] };
      if (sql.includes('UPDATE tenant_maintenance_requests')) {
        return { rows: [{ ...assigned, status: 'in_progress', updated_at: '2026-09-05T04:00:00.000Z' }] };
      }
      if (sql.includes('FROM tenant_maintenance_request_events')) return { rows: [] };
      return { rows: [] };
    },
    release() {}
  };
  const response = responseRecorder();
  await transitionMaintenanceRequestStatus(request({
    actorUserId: 9,
    userEmail: 'manager@example.com',
    workspace: { isOwner: false, propertyIds: [4], operations: ['rooms'] },
    params: { id: '44' },
    body: { status: 'in_progress', note: 'Đã mang dụng cụ đến phòng' }
  }), response.res, { getClient: async () => client });

  assert.equal(response.record.statusCode, 200);
  assert.equal(response.record.body.request.status, 'in_progress');
  const event = calls.find(call => call.sql.includes('INSERT INTO tenant_maintenance_request_events'));
  assert.deepEqual(event.params.slice(0, 4), [7, 44, 9, 'manager@example.com']);
  const audit = calls.find(call => call.sql.includes('INSERT INTO data_audit_logs'));
  assert.equal(audit.params[0], 9);
  assert.equal(audit.params[2], 7);
  assert.equal(calls.some(call => call.sql === 'COMMIT'), true);
});

test('nhân viên không xem/sửa yêu cầu của người khác và không được tự hủy', async () => {
  for (const variant of ['other_assignee', 'cancel']) {
    const client = {
      async query(sql) {
        const entitlement = entitlementRows(sql);
        if (entitlement) return entitlement;
        if (sql.includes('FROM tenant_maintenance_requests request')) {
          return { rows: [workflowRow({
            assigned_member_user_id: variant === 'other_assignee' ? 10 : 9,
            assigned_member_email: 'manager@example.com'
          })] };
        }
        return { rows: [] };
      },
      release() {}
    };
    const response = responseRecorder();
    await transitionMaintenanceRequestStatus(request({
      actorUserId: 9,
      userEmail: 'manager@example.com',
      workspace: { isOwner: false, propertyIds: [4], operations: ['rooms'] },
      params: { id: '44' },
      body: variant === 'cancel'
        ? { status: 'cancelled', note: 'Chủ trọ yêu cầu hủy' }
        : { status: 'acknowledged', note: '' }
    }), response.res, { getClient: async () => client });
    assert.equal(response.record.statusCode, 403);
    assert.equal(
      response.record.body.code,
      variant === 'cancel'
        ? 'MAINTENANCE_STATUS_OWNER_REQUIRED'
        : 'MAINTENANCE_REQUEST_ACCESS_DENIED'
    );
  }
});

test('danh sách công việc staff khóa theo room, property và chính assignee', async () => {
  const calls = [];
  const response = responseRecorder();
  await listMaintenanceWork(request({
    actorUserId: 9,
    workspace: { isOwner: false, propertyIds: [4], operations: ['rooms'] },
    query: { roomId: 'room-a' }
  }), response.res, {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM rooms')) return { rows: [{ id: 'room-a', property_id: 4 }] };
      if (sql.includes('FROM tenant_maintenance_requests request')) {
        return { rows: [workflowRow({
          assigned_member_user_id: 9,
          assigned_member_email: 'manager@example.com'
        })] };
      }
      if (sql.includes('FROM tenant_maintenance_request_events')) return { rows: [] };
      return { rows: [] };
    }
  });
  assert.equal(response.record.body.requests.length, 1);
  assert.equal(response.record.body.access.isOwner, false);
  assert.deepEqual(response.record.body.assignees, []);
  const listCall = calls.find(call => call.sql.includes('CASE request.status'));
  assert.match(listCall.sql, /assignment\.member_user_id=\$3/);
  assert.deepEqual(listCall.params, [7, 'room-a', 9]);
});

test('schema/API/UI giữ workflow append-only và quyền UPDATE hẹp', () => {
  const root = path.join(__dirname, '..', '..');
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260905_tenant_maintenance_workflow.sql'),
    'utf8'
  );
  const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  for (const source of [schema, migration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS tenant_maintenance_request_assignments/);
    assert.match(source, /CREATE TABLE IF NOT EXISTS tenant_maintenance_request_events/);
    assert.match(source, /tenant_maintenance_assignment_membership_fk/);
    assert.match(source, /GRANT UPDATE \(status, updated_at\) ON tenant_maintenance_requests/);
    assert.match(source, /REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON tenant_maintenance_request_events/);
  }
  assert.match(server, /\/api\/tenant-maintenance-work/);
  assert.match(server, /\/api\/tenant-maintenance-requests\/:id\/assignment/);
  assert.match(server, /\/api\/tenant-maintenance-requests\/:id\/status/);
  assert.match(api, /function assignTenantMaintenanceRequest/);
  assert.match(api, /function updateTenantMaintenanceRequestStatus/);
  assert.match(
    fs.readFileSync(path.join(root, 'server', 'tenant-maintenance-requests.js'), 'utf8'),
    /LEFT JOIN rooms room ON room\.user_id=request\.user_id AND room\.id=request\.room_id/
  );
  assert.match(app, /function renderRoomTenantMaintenanceWorkSection/);
  assert.match(app, /data-maintenance-assignment/);
  assert.match(app, /data-maintenance-status/);
});
