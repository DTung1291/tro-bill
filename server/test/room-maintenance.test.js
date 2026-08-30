'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-room-maintenance-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  completeMaintenance,
  completionInput,
  createMaintenance,
  listMaintenance,
  maintenanceCode,
  maintenanceInput,
  operationalStatusJson
} = require('../room-maintenance');

const root = path.join(__dirname, '..', '..');

function responseRecorder() {
  const record = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; },
    set(name, value) { record.headers[String(name).toLowerCase()] = value; return res; }
  };
  return { record, res };
}

function maintenanceRow(overrides = {}) {
  return {
    id: 11,
    user_id: 7,
    maintenance_code: 'SUA-2026-00000B',
    room_id: 'room-1',
    room_name_snapshot: 'P101',
    status: 'active',
    starts_on: '2026-08-30',
    expected_ends_on: '2026-09-02',
    ended_on: null,
    reason: 'Sơn lại tường và sửa hệ thống điện',
    completion_note: '',
    completed_at: null,
    created_at: '2026-08-30T00:00:00.000Z',
    updated_at: '2026-08-30T00:00:00.000Z',
    ...overrides
  };
}

function lifecycleEventRow(overrides = {}) {
  return {
    id: 31,
    event_code: 'VDT-2026-00000V',
    event_type: 'maintenance_started',
    contract_id: null,
    related_contract_id: null,
    reservation_id: null,
    maintenance_id: 11,
    tenant_id_snapshot: '',
    tenant_name_snapshot: '',
    source_room_id_snapshot: '',
    source_room_name_snapshot: '',
    target_room_id_snapshot: 'room-1',
    target_room_name_snapshot: 'P101',
    occurred_on: '2026-08-30',
    reason: 'Sơn lại tường và sửa hệ thống điện',
    metadata: {},
    created_at: '2026-08-30T00:00:00.000Z',
    ...overrides
  };
}

test('input sửa phòng kiểm tra ngày, lý do và ghi chú hoàn thành', () => {
  const input = maintenanceInput({
    roomId: 'room-1',
    startsOn: '2026-08-30',
    expectedEndsOn: '2026-09-02',
    reason: 'Sơn lại tường và sửa hệ thống điện'
  });
  assert.equal(input.roomId, 'room-1');
  assert.equal(maintenanceCode(11, input.startsOn), 'SUA-2026-00000B');
  assert.throws(
    () => maintenanceInput({ ...input, expectedEndsOn: '2026-08-29' }),
    (error) => error.code === 'INVALID_MAINTENANCE_DATE_RANGE'
  );
  assert.throws(
    () => completionInput({ endedOn: '2026-09-02', completionNote: 'xong' }),
    (error) => error.code === 'INVALID_MAINTENANCE_TEXT'
  );
});

test('trạng thái phòng do server suy ra và đánh dấu dữ liệu xung đột', () => {
  assert.equal(operationalStatusJson({
    room_id: 'r1', room_name: 'P1', active_contract_id: 8,
    active_reservation_id: null, active_maintenance_id: null
  }).status, 'occupied');
  const conflict = operationalStatusJson({
    room_id: 'r2', room_name: 'P2', active_contract_id: 9,
    active_reservation_id: null, active_maintenance_id: 12
  });
  assert.equal(conflict.status, 'occupied');
  assert.equal(conflict.conflict, true);
  const legacyOccupied = operationalStatusJson({
    room_id: 'r3', room_name: 'P3', active_contract_id: null,
    active_tenant_count: 2, active_reservation_id: null, active_maintenance_id: null
  });
  assert.equal(legacyOccupied.status, 'occupied');
  assert.equal(legacyOccupied.activeTenantCount, 2);
});

test('GET trả cả lịch sử sửa và trạng thái bốn loại, không cache', async () => {
  const response = responseRecorder();
  const calls = [];
  await listMaintenance(
    { userId: 7 },
    response.res,
    {
      query: async (sql, params = []) => {
        calls.push({ sql, params });
        if (sql.includes('UPDATE rental_reservations')) return { rows: [] };
        if (sql.includes('SELECT * FROM room_maintenance_periods')) {
          return { rows: [maintenanceRow()] };
        }
        if (sql.includes('FROM rooms room')) {
          return { rows: [
            { room_id: 'r1', room_name: 'P1', active_contract_id: null, active_tenant_count: 0, active_reservation_id: null, active_maintenance_id: null },
            { room_id: 'r2', room_name: 'P2', active_contract_id: null, active_reservation_id: 4, active_maintenance_id: null },
            { room_id: 'r3', room_name: 'P3', active_contract_id: 5, active_reservation_id: null, active_maintenance_id: null },
            { room_id: 'room-1', room_name: 'P101', active_contract_id: null, active_reservation_id: null, active_maintenance_id: 11 }
          ] };
        }
        return { rows: [] };
      }
    }
  );
  assert.equal(response.record.statusCode, 200);
  assert.deepEqual(response.record.body.roomStatuses.map(item => item.status), [
    'vacant', 'reserved', 'occupied', 'maintenance'
  ]);
  assert.equal(response.record.body.maintenancePeriods[0].code, 'SUA-2026-00000B');
  assert.equal(response.record.headers['cache-control'], 'no-store');
  assert.equal(calls[0].sql.includes('UPDATE rental_reservations'), true);
});

test('không cho bắt đầu sửa khi phòng đang thuê hoặc giữ chỗ', async () => {
  const response = responseRecorder();
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM rooms WHERE')) return { rows: [{ id: 'room-1', name: 'P101' }] };
      if (sql.includes('UPDATE rental_reservations')) return { rows: [] };
      if (sql.includes('AS has_contract')) return { rows: [{ has_contract: true, has_reservation: false }] };
      return { rows: [] };
    },
    release() {}
  };
  await createMaintenance(
    {
      userId: 7,
      body: {
        roomId: 'room-1', startsOn: '2026-08-30', expectedEndsOn: '',
        reason: 'Sơn lại tường và sửa hệ thống điện'
      }
    },
    response.res,
    { getClient: async () => client, enforceWrite: async () => {} }
  );
  assert.equal(response.record.statusCode, 409);
  assert.equal(response.record.body.code, 'ROOM_NOT_VACANT');
  assert.equal(calls.some(call => call.sql.includes('INSERT INTO room_maintenance_periods')), false);
  assert.equal(calls.some(call => call.sql === 'ROLLBACK'), true);
});

test('không xem phòng có khách cũ là trống dù chưa tạo hợp đồng điện tử', async () => {
  const response = responseRecorder();
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM rooms WHERE')) return { rows: [{ id: 'room-1', name: 'P101' }] };
      if (sql.includes('UPDATE rental_reservations')) return { rows: [] };
      if (sql.includes('AS has_contract')) {
        return { rows: [{ has_contract: false, has_reservation: false, has_tenant: true }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  await createMaintenance(
    {
      userId: 7,
      body: {
        roomId: 'room-1', startsOn: '2026-08-30', expectedEndsOn: '',
        reason: 'Sơn lại tường và sửa hệ thống điện'
      }
    },
    response.res,
    { getClient: async () => client, enforceWrite: async () => {} }
  );
  assert.equal(response.record.statusCode, 409);
  assert.equal(response.record.body.code, 'ROOM_NOT_VACANT');
  assert.equal(calls.some(call => call.sql.includes('FROM tenants')), true);
});

test('bắt đầu sửa ghi maintenance và lifecycle event trong cùng transaction', async () => {
  const response = responseRecorder();
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('FROM rooms WHERE')) return { rows: [{ id: 'room-1', name: 'P101' }] };
      if (sql.includes('UPDATE rental_reservations')) return { rows: [] };
      if (sql.includes('AS has_contract')) return { rows: [{ has_contract: false, has_reservation: false }] };
      if (sql.includes("nextval('room_maintenance_periods_id_seq')")) return { rows: [{ id: 11 }] };
      if (sql.includes('INSERT INTO room_maintenance_periods')) return { rows: [maintenanceRow()] };
      if (sql.includes("nextval('rental_lifecycle_events_id_seq')")) return { rows: [{ id: 31 }] };
      if (sql.includes('INSERT INTO rental_lifecycle_events')) return { rows: [lifecycleEventRow()] };
      return { rows: [] };
    },
    release() {}
  };
  await createMaintenance(
    {
      userId: 7,
      body: {
        roomId: 'room-1', startsOn: '2026-08-30', expectedEndsOn: '2026-09-02',
        reason: 'Sơn lại tường và sửa hệ thống điện'
      }
    },
    response.res,
    { getClient: async () => client, enforceWrite: async () => {} }
  );
  assert.equal(response.record.statusCode, 201);
  assert.equal(response.record.body.event.maintenanceId, 11);
  const eventInsert = calls.find(call => call.sql.includes('INSERT INTO rental_lifecycle_events'));
  assert.equal(eventInsert.params[3], 'maintenance_started');
  assert.equal(eventInsert.params[7], 11);
  assert.equal(calls.some(call => call.sql === 'COMMIT'), true);
});

test('hoàn thành sửa khóa phòng và ghi event trước khi commit', async () => {
  const response = responseRecorder();
  const calls = [];
  const completed = maintenanceRow({
    status: 'completed', ended_on: '2026-09-02',
    completion_note: 'Đã sơn tường và kiểm tra lại toàn bộ điện',
    completed_at: '2026-09-02T00:00:00.000Z'
  });
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return { rows: [] };
      if (sql.includes('SELECT * FROM room_maintenance_periods')) return { rows: [maintenanceRow()] };
      if (sql.includes('SELECT id FROM rooms')) return { rows: [{ id: 'room-1' }] };
      if (sql.includes('UPDATE room_maintenance_periods')) return { rows: [completed] };
      if (sql.includes("nextval('rental_lifecycle_events_id_seq')")) return { rows: [{ id: 32 }] };
      if (sql.includes('INSERT INTO rental_lifecycle_events')) {
        return { rows: [lifecycleEventRow({ id: 32, event_type: 'maintenance_completed', occurred_on: '2026-09-02' })] };
      }
      return { rows: [] };
    },
    release() {}
  };
  await completeMaintenance(
    {
      userId: 7,
      params: { id: '11' },
      body: {
        endedOn: '2026-09-02',
        completionNote: 'Đã sơn tường và kiểm tra lại toàn bộ điện'
      }
    },
    response.res,
    { getClient: async () => client, enforceWrite: async () => {} }
  );
  assert.equal(response.record.statusCode, 200);
  assert.equal(response.record.body.maintenance.status, 'completed');
  assert.equal(calls.some(call => call.sql.includes('SELECT id FROM rooms') && call.sql.includes('FOR UPDATE')), true);
  assert.equal(calls.find(call => call.sql.includes('INSERT INTO rental_lifecycle_events')).params[3], 'maintenance_completed');
});

test('schema, chốt chặn và UI không dùng trạng thái client hoặc inline onclick', () => {
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260830_room_operational_statuses.sql'),
    'utf8'
  );
  const lifecycle = fs.readFileSync(path.join(root, 'server', 'rental-lifecycle.js'), 'utf8');
  const contracts = fs.readFileSync(path.join(root, 'server', 'rental-contracts.js'), 'utf8');
  const state = fs.readFileSync(path.join(root, 'server', 'state.js'), 'utf8');
  const health = fs.readFileSync(path.join(root, 'server', 'health.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const source of [schema, migration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS room_maintenance_periods/);
    assert.match(source, /idx_room_maintenance_one_active_room/);
    assert.match(source, /rental_lifecycle_events_maintenance_owner_fk/);
    assert.match(source, /maintenance_started/);
    assert.match(source, /maintenance_completed/);
    assert.match(source, /REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON room_maintenance_periods/);
  }
  assert.match(lifecycle, /ROOM_UNDER_MAINTENANCE/);
  assert.match(lifecycle, /has_maintenance/);
  assert.match(lifecycle, /FROM tenants/);
  assert.match(contracts, /ROOM_UNDER_MAINTENANCE/);
  assert.match(state, /ACTIVE_MAINTENANCE_ROOM_REQUIRED/);
  assert.match(state, /ACTIVE_MAINTENANCE_TENANT_CONFLICT/);
  assert.match(health, /idx_room_maintenance_one_active_room/);
  assert.match(app, /ROOM_OPERATIONAL_STATUS_BY_ROOM/);
  assert.match(app, /syncModalScrollLock\(\)/);
  assert.doesNotMatch(app, /onclick="(?:open|close).*Maintenance/);
  assert.match(html, /style\.css\?v=104[\s\S]*api\.js\?v=101[\s\S]*app\.js\?v=106/);
});
