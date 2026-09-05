'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-room-assets-tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  archiveRoomAsset,
  assetCode,
  assetInput,
  createRoomAsset,
  listRoomAssets,
  restoreRoomAsset
} = require('../room-assets');

function responseRecorder() {
  const record = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; },
    set(name, value) { record.headers[name] = value; return res; }
  };
  return { record, res };
}

function assetRow(overrides = {}) {
  return {
    id: 11,
    user_id: 7,
    asset_code: 'TS-2026-00000B',
    room_id: 'room-a',
    room_name_snapshot: 'A101',
    name: 'Máy lạnh Panasonic',
    quantity: '1.00',
    unit: 'cái',
    condition_status: 'good',
    condition_note: 'Hoạt động bình thường',
    serial_number: 'SN-001',
    acquired_on: '2026-09-01',
    purchase_price_vnd: '8500000',
    note: '',
    status: 'active',
    archived_reason: '',
    archived_at: null,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    current_room_name: 'A101',
    property_id: 3,
    property_name: 'Khu A',
    ...overrides
  };
}

test('chuẩn hóa tài sản, giá VND và tình trạng theo danh mục cố định', () => {
  assert.deepEqual(assetInput({
    roomId: ' room-a ',
    name: ' Máy lạnh   Panasonic ',
    quantity: '1.5',
    unit: ' bộ ',
    condition: 'GOOD',
    conditionNote: ' Hoạt động  bình thường ',
    serialNumber: ' SN-001 ',
    acquiredOn: '2026-09-01',
    purchasePriceVnd: '8500000',
    note: ''
  }), {
    roomId: 'room-a',
    name: 'Máy lạnh Panasonic',
    quantity: 1.5,
    unit: 'bộ',
    condition: 'good',
    conditionNote: 'Hoạt động bình thường',
    serialNumber: 'SN-001',
    acquiredOn: '2026-09-01',
    purchasePriceVnd: 8500000,
    note: ''
  });
  assert.equal(assetCode(11, 2026), 'TS-2026-00000B');
  assert.throws(
    () => assetInput({
      roomId: 'room-a', name: 'Máy lạnh', quantity: 0,
      unit: 'cái', condition: 'good'
    }),
    error => error.code === 'INVALID_ROOM_ASSET_QUANTITY'
  );
  assert.throws(
    () => assetInput({
      roomId: 'room-a', name: 'Máy lạnh', quantity: 1,
      unit: 'cái', condition: 'unknown'
    }),
    error => error.code === 'INVALID_ROOM_ASSET_CONDITION'
  );
});

test('nhân viên chỉ nhận tài sản thuộc khu được giao', async () => {
  const calls = [];
  const response = responseRecorder();
  await listRoomAssets({
    userId: 7,
    workspace: { isOwner: false, propertyIds: [3] },
    query: { roomId: 'room-a', status: 'all' }
  }, response.res, {
    query: async (sql, params) => {
      calls.push({ sql, params });
      return { rows: [assetRow()] };
    }
  });
  assert.equal(response.record.body.assets.length, 1);
  assert.equal(response.record.body.assets[0].propertyId, 3);
  assert.deepEqual(calls[0].params, [7, 'room-a', 'all', true, [3]]);
  assert.match(calls[0].sql, /room\.property_id=ANY\(\$5::bigint\[\]\)/);
});

test('tạo tài sản khóa state, kiểm tra ownership phòng và ghi audit trong transaction', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('COUNT(*)::int AS room_count')) return { rows: [{ room_count: 1 }] };
      if (sql.includes('SELECT s.id AS subscription_id')) {
        return {
          rows: [{
            subscription_id: 1,
            status: 'active',
            billing_cycle: 'monthly',
            starts_at: '2026-01-01T00:00:00.000Z',
            ends_at: null,
            plan_id: 1,
            plan_code: 'free',
            plan_name: 'Free',
            room_limit: 20,
            staff_limit: 0,
            room_count: 1
          }]
        };
      }
      if (sql.includes('FROM rooms room')) {
        return { rows: [{ id: 'room-a', name: 'A101', property_id: 3 }] };
      }
      if (sql.includes("nextval('room_assets_id_seq')")) {
        return { rows: [{ id: 11, code_year: 2026 }] };
      }
      if (sql.includes('INSERT INTO room_assets')) return { rows: [assetRow()] };
      return { rows: [] };
    },
    release() {}
  };
  const response = responseRecorder();
  await createRoomAsset({
    userId: 7,
    actorUserId: 7,
    userEmail: 'owner@example.com',
    workspace: { isOwner: true },
    headers: {},
    body: {
      roomId: 'room-a',
      name: 'Máy lạnh Panasonic',
      quantity: 1,
      unit: 'cái',
      condition: 'good',
      conditionNote: 'Hoạt động bình thường',
      serialNumber: 'SN-001',
      acquiredOn: '2026-09-01',
      purchasePriceVnd: 8500000,
      note: ''
    }
  }, response.res, { getClient: async () => client });

  assert.equal(response.record.statusCode, 201);
  assert.equal(response.record.body.asset.code, 'TS-2026-00000B');
  assert.equal(calls.some(call => call.sql.includes("'state-write:'")), true);
  assert.equal(calls.some(call => call.sql.includes('FOR SHARE')), true);
  assert.equal(calls.some(call => call.sql.includes("'room_asset_created'")), false);
  assert.equal(calls.some(call => call.sql.includes('INSERT INTO data_audit_logs')), true);
  assert.equal(calls.some(call => call.sql === 'COMMIT'), true);
});

test('workspace nhân viên bị chặn trước khi mở transaction ghi tài sản', async () => {
  let opened = false;
  const response = responseRecorder();
  await createRoomAsset({
    userId: 7,
    workspace: { isOwner: false },
    body: {
      roomId: 'room-a', name: 'Máy lạnh', quantity: 1,
      unit: 'cái', condition: 'good'
    }
  }, response.res, {
    getClient: async () => {
      opened = true;
      throw new Error('không được mở transaction');
    }
  });
  assert.equal(opened, false);
  assert.equal(response.record.statusCode, 403);
  assert.equal(response.record.body.code, 'ROOM_ASSET_WRITE_OWNER_REQUIRED');
});

test('ngừng sử dụng tài sản lưu lý do và audit trong cùng transaction', async () => {
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
      if (sql.includes("SET status='archived'")) {
        return { rows: [assetRow({
          status: 'archived',
          archived_reason: 'Đã thanh lý thiết bị',
          archived_at: '2026-09-01T01:00:00.000Z'
        })] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const response = responseRecorder();
  await archiveRoomAsset({
    userId: 7,
    actorUserId: 7,
    userEmail: 'owner@example.com',
    workspace: { isOwner: true },
    headers: {},
    params: { id: '11' },
    body: { reason: 'Đã thanh lý thiết bị' }
  }, response.res, { getClient: async () => client });

  assert.equal(response.record.statusCode, 200);
  assert.equal(response.record.body.asset.status, 'archived');
  assert.equal(response.record.body.asset.archivedReason, 'Đã thanh lý thiết bị');
  assert.equal(calls.some(call => call.sql.includes('INSERT INTO data_audit_logs')), true);
  assert.equal(calls.some(call => call.sql === 'COMMIT'), true);
});

test('khôi phục tài sản xác minh lại phòng trước khi kích hoạt', async () => {
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
      if (sql.includes('SELECT * FROM room_assets')) {
        return { rows: [assetRow({
          status: 'archived',
          archived_reason: 'Tạm cất kho',
          archived_at: '2026-09-01T01:00:00.000Z'
        })] };
      }
      if (sql.includes('FROM rooms room')) {
        return { rows: [{ id: 'room-b', name: 'B201', property_id: 4 }] };
      }
      if (sql.includes("SET room_id=$3")) {
        return { rows: [assetRow({ room_id: 'room-b', room_name_snapshot: 'B201' })] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const response = responseRecorder();
  await restoreRoomAsset({
    userId: 7,
    actorUserId: 7,
    userEmail: 'owner@example.com',
    workspace: { isOwner: true },
    headers: {},
    params: { id: '11' },
    body: { roomId: 'room-b' }
  }, response.res, { getClient: async () => client });

  assert.equal(response.record.statusCode, 200);
  assert.equal(response.record.body.asset.roomId, 'room-b');
  assert.equal(response.record.body.asset.roomName, 'B201');
  assert.equal(calls.some(call => call.sql.includes('FOR SHARE')), true);
  assert.equal(calls.some(call => call.sql.includes('INSERT INTO data_audit_logs')), true);
  assert.equal(calls.some(call => call.sql === 'COMMIT'), true);
});

test('schema, migration, API, privacy export và UI giữ lịch sử tài sản không xóa vật lý', () => {
  const root = path.join(__dirname, '..', '..');
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260901_room_assets.sql'),
    'utf8'
  );
  const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  const state = fs.readFileSync(path.join(root, 'server', 'state.js'), 'utf8');
  const privacy = fs.readFileSync(path.join(root, 'server', 'privacy.js'), 'utf8');
  const health = fs.readFileSync(path.join(root, 'server', 'health.js'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const source of [schema, migration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS room_assets/);
    assert.match(source, /room_assets_archive_valid/);
    assert.match(source, /idx_room_assets_user_room_status/);
    assert.match(source, /REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON room_assets/);
  }
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;[\s\S]*room_assets_active_ownership_ready/);
  assert.match(server, /\/api\/room-assets\/\:id\/archive/);
  assert.match(server, /requireWorkspace\('rooms'\)/);
  assert.match(state, /ACTIVE_ROOM_ASSET_REQUIRED/);
  assert.match(privacy, /loadRoomAssetsExport/);
  assert.match(health, /room_assets_archive_valid/);
  assert.match(api, /restoreRoomAsset/);
  assert.match(app, /rentalHandoverItemsText\(assetResult\.assets\)/);
  assert.match(app, /data-room-asset-add/);
  assert.match(app, /isOwnerWorkspace\(\) \? API\.getRoomMaintenance\(\) : Promise\.resolve\(null\)/);
  assert.match(html, /api\.js\?v=106/);
  assert.match(html, /app\.js\?v=116/);
  assert.match(html, /style\.css\?v=113/);
  assert.match(fs.readFileSync(path.join(root, 'style.css'), 'utf8'), /#confirm-modal \{ z-index: 1500; \}/);
  assert.doesNotMatch(server, /app\.delete\('\/api\/room-assets/);
});
