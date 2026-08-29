'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-handover-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createRentalHandover,
  handoverCode,
  handoverInput,
  listRentalHandovers
} = require('../rental-handovers');

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

function handoverBody(overrides = {}) {
  return {
    handoverType: 'check_in',
    occurredOn: '2026-08-10',
    lessorName: 'Trần Thị B',
    propertyAddress: '40 Vũ Hữu, Hải Châu, Đà Nẵng',
    electricityReading: 120.5,
    waterReading: 30,
    keyCount: 2,
    generalCondition: 'Phòng sạch và thiết bị hoạt động bình thường',
    notes: 'Hai bên đã cùng kiểm tra',
    items: [{
      name: 'Điều hòa',
      quantity: 1,
      unit: 'cái',
      condition: 'Hoạt động tốt',
      note: 'Đã vệ sinh'
    }],
    ...overrides
  };
}

function contractRow() {
  return {
    id: 36,
    user_id: 7,
    contract_code: 'HD-2026-000010',
    room_id: 'room-1',
    room_name_snapshot: 'P101',
    tenant_id: 'tenant-1',
    tenant_name_snapshot: 'Nguyễn Văn A',
    status: 'active',
    starts_on: '2026-08-10',
    ends_on: '2027-08-09',
    deposit_vnd: '3000000'
  };
}

function handoverRow(overrides = {}) {
  return {
    id: 72,
    user_id: 7,
    contract_id: 36,
    handover_code: 'BBBG-2026-IN-000020',
    handover_type: 'check_in',
    occurred_on: '2026-08-10',
    contract_code_snapshot: 'HD-2026-000010',
    room_id_snapshot: 'room-1',
    room_name_snapshot: 'P101',
    tenant_id_snapshot: 'tenant-1',
    tenant_name_snapshot: 'Nguyễn Văn A',
    lessor_name_snapshot: 'Trần Thị B',
    property_address_snapshot: '40 Vũ Hữu, Hải Châu, Đà Nẵng',
    deposit_account_id: 4,
    expected_deposit_vnd: '3000000',
    deposit_balance_snapshot_vnd: '2500000',
    electricity_reading: '120.500',
    water_reading: '30.000',
    key_count: 2,
    general_condition: 'Phòng sạch và thiết bị hoạt động bình thường',
    notes: 'Hai bên đã cùng kiểm tra',
    confirmed_at: '2026-08-29T01:00:00.000Z',
    created_at: '2026-08-29T01:00:00.000Z',
    ...overrides
  };
}

function itemRow(overrides = {}) {
  return {
    id: 90,
    user_id: 7,
    handover_id: 72,
    item_order: 1,
    item_name: 'Điều hòa',
    quantity: '1.00',
    unit: 'cái',
    item_condition: 'Hoạt động tốt',
    note: 'Đã vệ sinh',
    ...overrides
  };
}

test('input biên bản giới hạn loại, ngày, chỉ số và danh sách tài sản', () => {
  const normalized = handoverInput(handoverBody());
  assert.equal(normalized.electricityReading, 120.5);
  assert.equal(normalized.items[0].condition, 'Hoạt động tốt');
  assert.equal(handoverCode(72, 'check_in', '2026-08-10'), 'BBBG-2026-IN-000020');
  assert.equal(handoverCode(73, 'check_out', '2027-08-09'), 'BBBG-2027-OUT-000021');
  assert.throws(
    () => handoverInput(handoverBody({ handoverType: 'repair' })),
    (error) => error.code === 'INVALID_HANDOVER_TYPE'
  );
  assert.throws(
    () => handoverInput(handoverBody({ electricityReading: -1 })),
    (error) => error.code === 'INVALID_HANDOVER_READING'
  );
  assert.throws(
    () => handoverInput(handoverBody({ items: [] })),
    (error) => error.code === 'INVALID_HANDOVER_ITEMS'
  );
});

test('tạo biên bản chụp số dư từ ledger cọc và không tạo nguồn số dư thứ hai', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM rental_contracts') && sql.includes('FOR UPDATE')) {
        return { rows: [contractRow()] };
      }
      if (sql.includes('FROM tenant_deposit_accounts account')) {
        return { rows: [{ id: 4, balance_vnd: '2500000' }] };
      }
      if (sql.includes("nextval('rental_handover_records_id_seq')")) {
        return { rows: [{ id: 72 }] };
      }
      if (sql.includes('INSERT INTO rental_handover_records')) {
        return { rows: [handoverRow()] };
      }
      if (sql.includes('INSERT INTO rental_handover_items')) {
        return { rows: [itemRow()] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const response = responseRecorder();
  await createRentalHandover(
    { userId: 7, params: { id: '36' }, body: handoverBody() },
    response.res,
    { getClient: async () => client, enforceWrite: async () => {} }
  );

  assert.equal(response.record.statusCode, 201);
  assert.equal(response.record.body.handover.depositBalanceSnapshotVnd, 2500000);
  assert.equal(response.record.body.handover.expectedDepositVnd, 3000000);
  assert.equal(response.record.body.handover.items[0].name, 'Điều hòa');
  const insert = calls.find(call => call.sql.includes('INSERT INTO rental_handover_records'));
  assert.equal(insert.params[1], 7);
  assert.equal(insert.params[2], 36);
  assert.equal(insert.params[13], 4);
  assert.equal(insert.params[14], 3000000);
  assert.equal(insert.params[15], 2500000);
  assert.equal(
    calls.some(call => /INSERT INTO tenant_deposit_transactions|UPDATE tenant_deposit_transactions/.test(call.sql)),
    false
  );
  assert.equal(calls.some(call => call.sql === 'COMMIT'), true);
});

test('API danh sách khóa hợp đồng và tài sản theo đúng user', async () => {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.startsWith('SELECT id FROM rental_contracts')) return { rows: [{ id: 36 }] };
    if (sql.includes('FROM rental_handover_records')) return { rows: [handoverRow()] };
    if (sql.includes('FROM rental_handover_items')) return { rows: [itemRow()] };
    return { rows: [] };
  };
  const response = responseRecorder();
  await listRentalHandovers(
    { userId: 7, params: { id: '36' } },
    response.res,
    { query }
  );
  assert.equal(response.record.body.handovers.length, 1);
  assert.equal(response.record.body.handovers[0].items.length, 1);
  assert.equal(response.record.headers['cache-control'], 'no-store');
  assert.equal(calls.every(call => call.params[0] === 7), true);

  const missing = responseRecorder();
  await listRentalHandovers(
    { userId: 99, params: { id: '36' } },
    missing.res,
    { query: async () => ({ rows: [] }) }
  );
  assert.equal(missing.record.statusCode, 404);
});

test('schema và migration giữ biên bản append-only, ownership và một bản mỗi loại', () => {
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260829_rental_handover_records.sql'),
    'utf8'
  );
  for (const source of [schema, migration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS rental_handover_records/);
    assert.match(source, /CREATE TABLE IF NOT EXISTS rental_handover_items/);
    assert.match(source, /rental_handover_records_contract_owner_fk/);
    assert.match(source, /rental_handover_records_deposit_owner_fk/);
    assert.match(source, /UNIQUE \(user_id, contract_id, handover_type\)/);
    assert.match(source, /REVOKE UPDATE, DELETE, TRUNCATE[\s\S]*rental_handover_records/);
    assert.match(source, /GRANT SELECT, INSERT ON rental_handover_records/);
    assert.match(source, /'tro_bill_runtime_sql'/);
  }
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;/);
  assert.match(migration, /append_only_ready/);
});

test('API, giao diện và bản in cùng hỗ trợ bàn giao và đối chiếu ledger cọc', () => {
  const api = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const health = fs.readFileSync(path.join(root, 'server', 'health.js'), 'utf8');
  assert.match(api, /getRentalHandovers/);
  assert.match(api, /createRentalHandover/);
  assert.match(app, /data-contract-handover/);
  assert.match(app, /data-contract-deposit/);
  assert.match(html, /id="rental-handover-modal"/);
  assert.match(html, /Xác nhận &amp; khóa biên bản/);
  assert.match(css, /print-area--rental-handover/);
  assert.match(health, /rental_handover_records/);
  assert.match(health, /rental_handover_records_deposit_owner_fk/);
});

require(path.join(root, 'handover-template.js'));

test('mẫu biên bản escape dữ liệu và hiển thị cọc, tài sản, chữ ký', () => {
  const html = globalThis.RentalHandoverTemplate.build({
    ...handoverRow(),
    id: 72,
    code: 'BBBG-2026-IN-000020',
    contractId: 36,
    contractCode: 'HD-2026-000010',
    handoverType: 'check_in',
    occurredOn: '2026-08-10',
    roomId: 'room-1',
    roomName: 'P101',
    tenantName: '<img src=x onerror=alert(1)>',
    lessorName: 'Trần Thị B',
    propertyAddress: '40 Vũ Hữu',
    expectedDepositVnd: 3000000,
    depositBalanceSnapshotVnd: 2500000,
    electricityReading: 120.5,
    waterReading: 30,
    keyCount: 2,
    generalCondition: '<script>alert(1)</script>',
    notes: 'Đối chiếu khi trả phòng',
    items: [{ name: 'Điều hòa', quantity: 1, unit: 'cái', condition: 'Tốt', note: '' }]
  });
  assert.match(html, /BIÊN BẢN NHẬN PHÒNG/);
  assert.match(html, /3\.000\.000 đồng/);
  assert.match(html, /2\.500\.000 đồng/);
  assert.match(html, /Điều hòa/);
  assert.match(html, /BÊN CHO THUÊ\/BÊN GIAO/);
  assert.doesNotMatch(html, /<script>|<img src=x/);
  assert.match(html, /&lt;script&gt;/);
});
