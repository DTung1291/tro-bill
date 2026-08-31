'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-lifecycle-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  cancelReservationInput,
  checkoutContract,
  createReservation,
  reservationCode,
  reservationInput,
  transferContract,
  transferInput
} = require('../rental-lifecycle');
const { createContract } = require('../rental-contracts');

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

function reservationBody(overrides = {}) {
  return {
    roomId: 'room-2',
    guestName: 'Nguyễn Văn B',
    guestPhone: '0901234567',
    reservedOn: '2026-08-29',
    expectedMoveInOn: '2026-09-05',
    expiresOn: '2026-09-05',
    expectedDepositVnd: 2000000,
    note: 'Giữ phòng đến ngày nhận',
    ...overrides
  };
}

function reservationRow(overrides = {}) {
  return {
    id: 5,
    user_id: 7,
    reservation_code: 'GC-2026-000005',
    room_id: 'room-2',
    room_name_snapshot: 'P202',
    guest_name_snapshot: 'Nguyễn Văn B',
    guest_phone_snapshot: '0901234567',
    reserved_on: '2026-08-29',
    expected_move_in_on: '2026-09-05',
    expires_on: '2026-09-05',
    expected_deposit_vnd: '2000000',
    note: 'Giữ phòng đến ngày nhận',
    status: 'active',
    status_reason: '',
    converted_contract_id: null,
    converted_at: null,
    cancelled_at: null,
    expired_at: null,
    created_at: '2026-08-29T01:00:00.000Z',
    updated_at: '2026-08-29T01:00:00.000Z',
    ...overrides
  };
}

function contractRow(overrides = {}) {
  return {
    id: 36,
    user_id: 7,
    contract_code: 'HD-2026-000010',
    room_id: 'room-1',
    room_name_snapshot: 'P101',
    tenant_id: 'tenant-1',
    tenant_name_snapshot: 'Nguyễn Văn A',
    tenant_phone_snapshot: '0909000000',
    tenant_cccd_snapshot: '048123456789',
    tenant_issue_date_snapshot: '2021-01-01',
    tenant_dob_snapshot: '1998-02-03',
    tenant_gender_snapshot: 'Nam',
    tenant_address_snapshot: 'Đà Nẵng',
    status: 'active',
    starts_on: '2026-08-10',
    ends_on: '2027-08-09',
    billing_cycle_months: 1,
    payment_due_day: 5,
    monthly_rent_vnd: '3000000',
    deposit_vnd: '3000000',
    terms: 'Điều khoản cũ',
    status_reason: '',
    activated_at: '2026-08-10T00:00:00.000Z',
    ended_at: null,
    cancelled_at: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
    ...overrides
  };
}

function eventRow(overrides = {}) {
  return {
    id: 9,
    user_id: 7,
    event_code: 'VDT-2026-000009',
    event_type: 'reservation_created',
    contract_id: null,
    related_contract_id: null,
    reservation_id: 5,
    tenant_id_snapshot: '',
    tenant_name_snapshot: 'Nguyễn Văn B',
    source_room_id_snapshot: '',
    source_room_name_snapshot: '',
    target_room_id_snapshot: 'room-2',
    target_room_name_snapshot: 'P202',
    occurred_on: '2026-08-29',
    reason: 'Giữ phòng đến ngày nhận',
    metadata: {},
    created_at: '2026-08-29T01:00:00.000Z',
    ...overrides
  };
}

test('input lifecycle kiểm tra chặt ngày, tiền và lý do', () => {
  const reservation = reservationInput(reservationBody());
  assert.equal(reservation.expectedDepositVnd, 2000000);
  assert.equal(reservationCode(5, reservation.reservedOn), 'GC-2026-000005');
  assert.throws(
    () => reservationInput(reservationBody({ expiresOn: '2026-08-20' })),
    (error) => error.code === 'INVALID_RESERVATION_DATE_RANGE'
  );
  assert.throws(
    () => transferInput({
      targetRoomId: 'room-2',
      occurredOn: '2026-09-01',
      monthlyRentVnd: 2500000,
      reason: 'quá ngắn'
    }),
    (error) => error.code === 'INVALID_LIFECYCLE_TEXT'
  );
  assert.equal(
    cancelReservationInput({ occurredOn: '2026-08-30', reason: 'Khách đổi kế hoạch thuê phòng' }).reason,
    'Khách đổi kế hoạch thuê phòng'
  );
});

test('tạo giữ chỗ khóa phòng, chặn phòng đang thuê và ghi event cùng transaction', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM rooms') && sql.includes('FOR UPDATE')) {
        return { rows: [{ id: 'room-2', name: 'P202' }] };
      }
      if (sql.includes('FROM rental_contracts') && sql.includes("status='active'")) {
        return { rows: [] };
      }
      if (sql.includes("nextval('rental_reservations_id_seq')")) return { rows: [{ id: 5 }] };
      if (sql.includes('INSERT INTO rental_reservations')) return { rows: [reservationRow()] };
      if (sql.includes("nextval('rental_lifecycle_events_id_seq')")) return { rows: [{ id: 9 }] };
      if (sql.includes('INSERT INTO rental_lifecycle_events')) return { rows: [eventRow()] };
      return { rows: [] };
    },
    release() {}
  };
  const response = responseRecorder();
  await createReservation(
    { userId: 7, body: reservationBody() },
    response.res,
    { getClient: async () => client, enforceWrite: async () => {} }
  );
  assert.equal(response.record.statusCode, 201);
  assert.equal(response.record.body.reservation.code, 'GC-2026-000005');
  assert.equal(response.record.body.event.eventType, 'reservation_created');
  assert.equal(calls.some(call => call.sql === 'COMMIT'), true);
  assert.equal(calls.some(call => call.sql.includes("SET status='expired'")), true);
});

test('tạo hợp đồng từ đúng lượt giữ chỗ sẽ convert reservation trong cùng transaction', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM rooms room') && sql.includes('JOIN tenants')) {
        return { rows: [{
          room_id: 'room-2', room_name: 'P202', tenant_id: 'tenant-2',
          tenant_name: 'Nguyễn Văn B', tenant_phone: '0901234567',
          tenant_cccd: '048123456700', tenant_issue_date: '2021-01-01',
          tenant_dob: '1999-01-01', tenant_gender: 'Nam', tenant_address: 'Đà Nẵng'
        }] };
      }
      if (sql.includes('FROM rental_reservations') && sql.includes('FOR UPDATE')) {
        return { rows: [reservationRow()] };
      }
      if (sql.includes("nextval('rental_contracts_id_seq')")) return { rows: [{ id: 36 }] };
      if (sql.includes('INSERT INTO rental_contracts')) return { rows: [contractRow({
        room_id: 'room-2', room_name_snapshot: 'P202', tenant_id: 'tenant-2',
        tenant_name_snapshot: 'Nguyễn Văn B'
      })] };
      if (sql.includes('FROM room_rate_history')) {
        return { rows: [{ rent_price: '3000000', electric_rate: '3500', water_rate: '50000', trash_fee: '50000', wifi_fee: '0', manage_fee: '0' }] };
      }
      if (sql.includes('INSERT INTO room_rate_history')) {
        return { rows: [{ room_id: 'room-2', effective_from: '2026-08', rent_price: '3000000', electric_rate: '3500', water_rate: '50000', trash_fee: '50000', wifi_fee: '0', manage_fee: '0' }] };
      }
      if (sql.includes("nextval('rental_lifecycle_events_id_seq')")) return { rows: [{ id: 10 }] };
      return { rows: [] };
    },
    release() {}
  };
  const response = responseRecorder();
  await createContract(
    {
      userId: 7,
      body: {
        roomId: 'room-2', tenantId: 'tenant-2', status: 'active',
        startsOn: '2026-08-29', endsOn: '2027-08-28', billingCycleMonths: 1,
        paymentDueDay: 5, monthlyRentVnd: 3000000, depositVnd: 2000000,
        terms: '', reservationId: 5
      }
    },
    response.res,
    { getClient: async () => client, enforceWrite: async () => {} }
  );
  assert.equal(response.record.statusCode, 201);
  assert.equal(calls.some(call => call.sql.includes("SET status='converted'")), true);
  assert.equal(calls.some(call => call.sql.includes("'reservation_converted'")), true);
  assert.equal(calls.some(call => call.sql === 'COMMIT'), true);
});

test('chuyển phòng yêu cầu biên bản trả, kết thúc hợp đồng cũ và tạo hợp đồng mới nguyên tử', async () => {
  const calls = [];
  const oldContract = contractRow();
  const newContract = contractRow({
    id: 40,
    contract_code: 'HD-2026-000014',
    room_id: 'room-2',
    room_name_snapshot: 'P202',
    starts_on: '2026-09-01',
    monthly_rent_vnd: '3500000',
    status_reason: 'Chuyển từ P101: Khách chuyển sang phòng lớn hơn'
  });
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM rental_contracts') && sql.includes('WHERE user_id=$1 AND id=$2')) {
        return { rows: [oldContract] };
      }
      if (sql.includes('FROM rental_handover_records')) {
        return { rows: [{ id: 72, occurred_on: '2026-09-01' }] };
      }
      if (sql.includes('FROM rooms') && sql.includes('ANY($2::text[])')) {
        return { rows: [{ id: 'room-1', name: 'P101' }, { id: 'room-2', name: 'P202' }] };
      }
      if (sql.includes('FROM tenants') && sql.includes('FOR UPDATE')) {
        return { rows: [{
          id: 'tenant-1', room_id: 'room-1', full_name: 'Nguyễn Văn A',
          phone: '0909000000', cccd: '048123456789', issue_date: '2021-01-01',
          dob: '1998-02-03', gender: 'Nam', address: 'Đà Nẵng'
        }] };
      }
      if (sql.includes('SELECT EXISTS')) return { rows: [{ has_contract: false, has_reservation: false }] };
      if (sql.includes('UPDATE rental_contracts') && sql.includes("status='ended'")) {
        return { rows: [contractRow({ status: 'ended', status_reason: 'Khách chuyển sang phòng lớn hơn', ended_at: '2026-09-01T01:00:00.000Z' })] };
      }
      if (sql.includes("nextval('rental_contracts_id_seq')")) return { rows: [{ id: 40 }] };
      if (sql.includes('INSERT INTO rental_contracts')) return { rows: [newContract] };
      if (sql.includes('FROM room_rate_history')) {
        return { rows: [{ rent_price: '3200000', electric_rate: '3500', water_rate: '50000', trash_fee: '50000', wifi_fee: '0', manage_fee: '0' }] };
      }
      if (sql.includes('INSERT INTO room_rate_history')) {
        return { rows: [{ room_id: 'room-2', effective_from: '2026-09', rent_price: '3500000', electric_rate: '3500', water_rate: '50000', trash_fee: '50000', wifi_fee: '0', manage_fee: '0' }] };
      }
      if (sql.includes("nextval('rental_lifecycle_events_id_seq')")) return { rows: [{ id: 12 }] };
      if (sql.includes('INSERT INTO rental_lifecycle_events')) {
        return { rows: [eventRow({
          id: 12,
          event_code: 'VDT-2026-00000C',
          event_type: 'room_transferred',
          contract_id: 36,
          related_contract_id: 40,
          reservation_id: null,
          tenant_id_snapshot: 'tenant-1',
          tenant_name_snapshot: 'Nguyễn Văn A',
          source_room_id_snapshot: 'room-1',
          source_room_name_snapshot: 'P101',
          target_room_id_snapshot: 'room-2',
          target_room_name_snapshot: 'P202',
          occurred_on: '2026-09-01'
        })] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const response = responseRecorder();
  await transferContract(
    {
      userId: 7,
      params: { id: '36' },
      body: {
        targetRoomId: 'room-2',
        occurredOn: '2026-09-01',
        endsOn: '2027-08-09',
        monthlyRentVnd: 3500000,
        depositVnd: 3000000,
        reason: 'Khách chuyển sang phòng lớn hơn'
      }
    },
    response.res,
    { getClient: async () => client, enforceWrite: async () => {} }
  );
  assert.equal(response.record.statusCode, 201);
  assert.equal(response.record.body.previousContract.status, 'ended');
  assert.equal(response.record.body.contract.roomId, 'room-2');
  assert.equal(response.record.body.event.eventType, 'room_transferred');
  assert.equal(calls.some(call => call.sql.includes('UPDATE tenants SET room_id=$3')), true);
  assert.deepEqual(
    calls.filter(call => call.sql.includes('INSERT INTO data_audit_logs')).map(call => call.params[3]),
    [
      'rental_contract_transferred',
      'rental_contract_created_from_transfer',
      'room_rate_created'
    ]
  );
  assert.equal(calls.some(call => call.sql === 'COMMIT'), true);
});

test('trả phòng bị chặn rõ ràng khi chưa có biên bản trả phòng', async () => {
  const client = {
    async query(sql) {
      if (sql.includes('FROM rental_contracts')) return { rows: [contractRow()] };
      if (sql.includes('FROM rental_handover_records')) return { rows: [] };
      return { rows: [] };
    },
    release() {}
  };
  const response = responseRecorder();
  await checkoutContract(
    {
      userId: 7,
      params: { id: '36' },
      body: { occurredOn: '2026-09-01', reason: 'Khách hoàn tất trả phòng đúng hạn' }
    },
    response.res,
    { getClient: async () => client, enforceWrite: async () => {} }
  );
  assert.equal(response.record.statusCode, 409);
  assert.equal(response.record.body.code, 'CHECKOUT_HANDOVER_REQUIRED');
});

test('schema và migration khóa ownership, một giữ chỗ active và event append-only', () => {
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260829_rental_lifecycle.sql'),
    'utf8'
  );
  for (const source of [schema, migration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS rental_reservations/);
    assert.match(source, /CREATE TABLE IF NOT EXISTS rental_lifecycle_events/);
    assert.match(source, /idx_rental_reservations_one_active_room/);
    assert.match(source, /rental_reservations_converted_contract_owner_fk/);
    assert.match(source, /rental_lifecycle_events_contract_owner_fk/);
    assert.match(source, /REVOKE UPDATE, DELETE, TRUNCATE[\s\S]*rental_lifecycle_events/);
    assert.match(source, /GRANT SELECT, INSERT ON rental_lifecycle_events/);
  }
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;/);
  assert.match(migration, /events_append_only_ready/);
});

test('API và UI có đủ giữ chỗ, chuyển phòng, trả phòng và readiness', () => {
  const api = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const health = fs.readFileSync(path.join(root, 'server', 'health.js'), 'utf8');
  const state = fs.readFileSync(path.join(root, 'server', 'state.js'), 'utf8');
  assert.match(api, /createRentalReservation/);
  assert.match(api, /transferRentalContract/);
  assert.match(api, /checkoutRentalContract/);
  assert.match(app, /data-contract-lifecycle="transfer"/);
  assert.match(app, /data-contract-lifecycle="checkout"/);
  assert.match(html, /id="rental-reservation-form"/);
  assert.match(html, /id="rental-lifecycle-modal"/);
  assert.match(health, /rental_lifecycle_events/);
  assert.match(state, /ACTIVE_RESERVATION_ROOM_REQUIRED/);
});
