'use strict';

const db = require('./db');
const subscription = require('./subscription');
const {
  contractCode,
  contractJson,
  syncRentRate
} = require('./rental-contracts');

const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;

class RentalLifecycleError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'RentalLifecycleError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function sendRentalLifecycleError(res, error) {
  if (error instanceof RentalLifecycleError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return true;
  }
  if (subscription.sendEntitlementError(res, error)) return true;
  return false;
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new RentalLifecycleError(400, 'INVALID_LIFECYCLE_ID', `${label} không hợp lệ`);
  }
  return id;
}

function identifier(value, label) {
  const result = String(value || '').trim();
  if (!result || result.length > 200) {
    throw new RentalLifecycleError(400, 'INVALID_LIFECYCLE_REFERENCE', `${label} không hợp lệ`);
  }
  return result;
}

function dateInput(value, label, { optional = false } = {}) {
  const result = String(value || '').trim();
  if (optional && !result) return null;
  const parsed = new Date(`${result}T00:00:00.000Z`);
  if (!DATE_PATTERN.test(result)
      || Number.isNaN(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== result) {
    throw new RentalLifecycleError(400, 'INVALID_LIFECYCLE_DATE', `${label} không hợp lệ`);
  }
  return result;
}

function textInput(value, label, { min = 0, max }) {
  const result = String(value || '').trim();
  if (result.length < min || result.length > max) {
    const range = min > 0 ? `từ ${min} đến ${max}` : `tối đa ${max}`;
    throw new RentalLifecycleError(
      400,
      'INVALID_LIFECYCLE_TEXT',
      `${label} phải có ${range} ký tự`
    );
  }
  return result;
}

function moneyInput(value, label, { optional = false } = {}) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 999999999999) {
    throw new RentalLifecycleError(400, 'INVALID_LIFECYCLE_AMOUNT', `${label} không hợp lệ`);
  }
  return amount;
}

function reservationInput(body = {}) {
  const reservedOn = dateInput(body.reservedOn, 'Ngày giữ chỗ');
  const expectedMoveInOn = dateInput(body.expectedMoveInOn, 'Ngày dự kiến nhận phòng');
  const expiresOn = dateInput(body.expiresOn, 'Ngày hết hạn giữ chỗ');
  if (expectedMoveInOn < reservedOn || expiresOn < reservedOn) {
    throw new RentalLifecycleError(
      400,
      'INVALID_RESERVATION_DATE_RANGE',
      'Ngày nhận phòng và ngày hết hạn không được trước ngày giữ chỗ'
    );
  }
  return {
    roomId: identifier(body.roomId, 'Phòng'),
    guestName: textInput(body.guestName, 'Tên người giữ chỗ', { min: 1, max: 200 }),
    guestPhone: textInput(body.guestPhone, 'Số điện thoại', { max: 50 }),
    reservedOn,
    expectedMoveInOn,
    expiresOn,
    expectedDepositVnd: moneyInput(body.expectedDepositVnd || 0, 'Tiền cọc dự kiến'),
    note: textInput(body.note, 'Ghi chú', { max: 1000 })
  };
}

function cancelReservationInput(body = {}) {
  return {
    reason: textInput(body.reason, 'Lý do hủy giữ chỗ', { min: 10, max: 500 }),
    occurredOn: dateInput(body.occurredOn, 'Ngày hủy')
  };
}

function transferInput(body = {}) {
  return {
    targetRoomId: identifier(body.targetRoomId, 'Phòng chuyển đến'),
    occurredOn: dateInput(body.occurredOn, 'Ngày chuyển phòng'),
    endsOn: dateInput(body.endsOn, 'Ngày kết thúc hợp đồng mới', { optional: true }),
    monthlyRentVnd: moneyInput(body.monthlyRentVnd, 'Tiền thuê phòng mới'),
    depositVnd: moneyInput(body.depositVnd, 'Tiền cọc hợp đồng mới', { optional: true }),
    reason: textInput(body.reason, 'Lý do chuyển phòng', { min: 10, max: 500 })
  };
}

function checkoutInput(body = {}) {
  return {
    occurredOn: dateInput(body.occurredOn, 'Ngày trả phòng'),
    reason: textInput(body.reason, 'Lý do trả phòng', { min: 10, max: 500 })
  };
}

function dateJson(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function reservationCode(id, reservedOn) {
  return `GC-${String(reservedOn).slice(0, 4)}-${Number(id).toString(36).toUpperCase().padStart(6, '0')}`;
}

function eventCode(id, occurredOn) {
  return `VDT-${String(occurredOn).slice(0, 4)}-${Number(id).toString(36).toUpperCase().padStart(6, '0')}`;
}

function reservationJson(row) {
  return {
    id: Number(row.id),
    code: row.reservation_code,
    roomId: row.room_id,
    roomName: row.room_name_snapshot,
    guestName: row.guest_name_snapshot,
    guestPhone: row.guest_phone_snapshot || '',
    reservedOn: dateJson(row.reserved_on),
    expectedMoveInOn: dateJson(row.expected_move_in_on),
    expiresOn: dateJson(row.expires_on),
    expectedDepositVnd: Number(row.expected_deposit_vnd) || 0,
    note: row.note || '',
    status: row.status,
    statusReason: row.status_reason || '',
    convertedContractId: row.converted_contract_id === null ? null : Number(row.converted_contract_id),
    convertedAt: row.converted_at || null,
    cancelledAt: row.cancelled_at || null,
    expiredAt: row.expired_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function eventJson(row) {
  return {
    id: Number(row.id),
    code: row.event_code,
    eventType: row.event_type,
    contractId: row.contract_id === null ? null : Number(row.contract_id),
    relatedContractId: row.related_contract_id === null ? null : Number(row.related_contract_id),
    reservationId: row.reservation_id === null ? null : Number(row.reservation_id),
    tenantId: row.tenant_id_snapshot || '',
    tenantName: row.tenant_name_snapshot || '',
    sourceRoomId: row.source_room_id_snapshot || '',
    sourceRoomName: row.source_room_name_snapshot || '',
    targetRoomId: row.target_room_id_snapshot || '',
    targetRoomName: row.target_room_name_snapshot || '',
    occurredOn: dateJson(row.occurred_on),
    reason: row.reason || '',
    metadata: row.metadata && typeof row.metadata === 'object' ? row.metadata : {},
    createdAt: row.created_at
  };
}

async function ensureWritable(query, userId, dependencies = {}) {
  if (dependencies.enforceWrite) return dependencies.enforceWrite(userId, query);
  const { rows } = await query('SELECT COUNT(*)::int AS room_count FROM rooms WHERE user_id=$1', [userId]);
  return subscription.enforceStateWrite(userId, Number(rows[0]?.room_count) || 0, query);
}

async function expireReservations(query, userId, roomId = null) {
  await query(
    `UPDATE rental_reservations
     SET status='expired', expired_at=now(), updated_at=now(),
         status_reason='Tự động hết hạn theo ngày giữ chỗ'
     WHERE user_id=$1 AND status='active' AND expires_on < CURRENT_DATE
       AND ($2::text IS NULL OR room_id=$2)`,
    [userId, roomId]
  );
}

async function insertEvent(query, userId, input) {
  const idResult = await query("SELECT nextval('rental_lifecycle_events_id_seq') AS id");
  const id = Number(idResult.rows[0].id);
  const inserted = await query(
    `INSERT INTO rental_lifecycle_events
       (id, user_id, event_code, event_type, contract_id, related_contract_id,
        reservation_id, tenant_id_snapshot, tenant_name_snapshot,
        source_room_id_snapshot, source_room_name_snapshot,
        target_room_id_snapshot, target_room_name_snapshot, occurred_on,
        reason, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16::jsonb)
     RETURNING *`,
    [
      id,
      userId,
      eventCode(id, input.occurredOn),
      input.eventType,
      input.contractId || null,
      input.relatedContractId || null,
      input.reservationId || null,
      input.tenantId || '',
      input.tenantName || '',
      input.sourceRoomId || '',
      input.sourceRoomName || '',
      input.targetRoomId || '',
      input.targetRoomName || '',
      input.occurredOn,
      input.reason || '',
      JSON.stringify(input.metadata || {})
    ]
  );
  return inserted.rows[0];
}

async function listLifecycle(req, res, dependencies = {}) {
  let roomId;
  try {
    roomId = identifier(req.query?.roomId, 'Phòng');
  } catch (error) {
    if (sendRentalLifecycleError(res, error)) return res;
    throw error;
  }
  const query = dependencies.query || db.query;
  const owner = await query('SELECT id FROM rooms WHERE user_id=$1 AND id=$2', [req.userId, roomId]);
  if (!owner.rows[0]) {
    return res.status(404).json({ error: 'Không tìm thấy phòng', code: 'ROOM_NOT_FOUND' });
  }
  await expireReservations(query, req.userId, roomId);
  const [reservations, events] = await Promise.all([
    query(
      `SELECT * FROM rental_reservations
       WHERE user_id=$1 AND room_id=$2
       ORDER BY created_at DESC, id DESC
       LIMIT 50`,
      [req.userId, roomId]
    ),
    query(
      `SELECT * FROM rental_lifecycle_events
       WHERE user_id=$1
         AND (source_room_id_snapshot=$2 OR target_room_id_snapshot=$2)
       ORDER BY occurred_on DESC, id DESC
       LIMIT 50`,
      [req.userId, roomId]
    )
  ]);
  res.set('Cache-Control', 'no-store');
  return res.json({
    reservations: reservations.rows.map(reservationJson),
    events: events.rows.map(eventJson)
  });
}

async function createReservation(req, res, dependencies = {}) {
  let input;
  try {
    input = reservationInput(req.body);
  } catch (error) {
    if (sendRentalLifecycleError(res, error)) return res;
    throw error;
  }
  const getClient = dependencies.getClient || db.getClient;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await ensureWritable(client.query.bind(client), req.userId, dependencies);
    const roomResult = await client.query(
      'SELECT id, name FROM rooms WHERE user_id=$1 AND id=$2 FOR UPDATE',
      [req.userId, input.roomId]
    );
    const room = roomResult.rows[0];
    if (!room) throw new RentalLifecycleError(404, 'ROOM_NOT_FOUND', 'Không tìm thấy phòng');
    await expireReservations(client.query.bind(client), req.userId, input.roomId);
    const occupied = await client.query(
      `SELECT id FROM rental_contracts
       WHERE user_id=$1 AND room_id=$2 AND status='active'
       LIMIT 1`,
      [req.userId, input.roomId]
    );
    if (occupied.rows[0]) {
      throw new RentalLifecycleError(
        409,
        'ROOM_ALREADY_OCCUPIED',
        'Phòng đang có hợp đồng hoạt động nên không thể giữ chỗ'
      );
    }
    const idResult = await client.query("SELECT nextval('rental_reservations_id_seq') AS id");
    const id = Number(idResult.rows[0].id);
    const inserted = await client.query(
      `INSERT INTO rental_reservations
         (id, user_id, reservation_code, room_id, room_name_snapshot,
          guest_name_snapshot, guest_phone_snapshot, reserved_on,
          expected_move_in_on, expires_on, expected_deposit_vnd, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       RETURNING *`,
      [
        id,
        req.userId,
        reservationCode(id, input.reservedOn),
        input.roomId,
        String(room.name || '').trim() || 'Phòng chưa đặt tên',
        input.guestName,
        input.guestPhone,
        input.reservedOn,
        input.expectedMoveInOn,
        input.expiresOn,
        input.expectedDepositVnd,
        input.note
      ]
    );
    const event = await insertEvent(client.query.bind(client), req.userId, {
      eventType: 'reservation_created',
      reservationId: id,
      targetRoomId: input.roomId,
      targetRoomName: room.name,
      tenantName: input.guestName,
      occurredOn: input.reservedOn,
      reason: input.note,
      metadata: { expectedMoveInOn: input.expectedMoveInOn, expiresOn: input.expiresOn }
    });
    await client.query('COMMIT');
    return res.status(201).json({
      reservation: reservationJson(inserted.rows[0]),
      event: eventJson(event)
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendRentalLifecycleError(res, error)) return res;
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'Phòng đã có một lượt giữ chỗ đang hoạt động',
        code: 'ACTIVE_RESERVATION_EXISTS'
      });
    }
    throw error;
  } finally {
    client.release();
  }
}

async function cancelReservation(req, res, dependencies = {}) {
  let reservationId;
  let input;
  try {
    reservationId = positiveId(req.params?.id, 'Lượt giữ chỗ');
    input = cancelReservationInput(req.body);
  } catch (error) {
    if (sendRentalLifecycleError(res, error)) return res;
    throw error;
  }
  const getClient = dependencies.getClient || db.getClient;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await ensureWritable(client.query.bind(client), req.userId, dependencies);
    const locked = await client.query(
      'SELECT * FROM rental_reservations WHERE user_id=$1 AND id=$2 FOR UPDATE',
      [req.userId, reservationId]
    );
    const reservation = locked.rows[0];
    if (!reservation) {
      throw new RentalLifecycleError(404, 'RESERVATION_NOT_FOUND', 'Không tìm thấy lượt giữ chỗ');
    }
    if (reservation.status !== 'active') {
      throw new RentalLifecycleError(
        409,
        'RESERVATION_NOT_ACTIVE',
        'Chỉ lượt giữ chỗ đang hoạt động mới có thể hủy'
      );
    }
    const updated = await client.query(
      `UPDATE rental_reservations
       SET status='cancelled', status_reason=$3, cancelled_at=now(), updated_at=now()
       WHERE user_id=$1 AND id=$2
       RETURNING *`,
      [req.userId, reservationId, input.reason]
    );
    const event = await insertEvent(client.query.bind(client), req.userId, {
      eventType: 'reservation_cancelled',
      reservationId,
      targetRoomId: reservation.room_id,
      targetRoomName: reservation.room_name_snapshot,
      tenantName: reservation.guest_name_snapshot,
      occurredOn: input.occurredOn,
      reason: input.reason
    });
    await client.query('COMMIT');
    return res.json({ reservation: reservationJson(updated.rows[0]), event: eventJson(event) });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendRentalLifecycleError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

async function requireCheckoutHandover(query, userId, contractId, occurredOn) {
  const result = await query(
    `SELECT id, occurred_on FROM rental_handover_records
     WHERE user_id=$1 AND contract_id=$2 AND handover_type='check_out'
     LIMIT 1`,
    [userId, contractId]
  );
  const handover = result.rows[0];
  if (!handover) {
    throw new RentalLifecycleError(
      409,
      'CHECKOUT_HANDOVER_REQUIRED',
      'Cần xác nhận biên bản trả phòng trước khi chuyển hoặc trả phòng'
    );
  }
  if (dateJson(handover.occurred_on) > occurredOn) {
    throw new RentalLifecycleError(
      409,
      'CHECKOUT_BEFORE_HANDOVER',
      'Ngày chuyển/trả phòng không được trước ngày trên biên bản trả phòng'
    );
  }
  return handover;
}

async function transferContract(req, res, dependencies = {}) {
  let contractId;
  let input;
  try {
    contractId = positiveId(req.params?.id, 'Hợp đồng');
    input = transferInput(req.body);
  } catch (error) {
    if (sendRentalLifecycleError(res, error)) return res;
    throw error;
  }
  const getClient = dependencies.getClient || db.getClient;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await ensureWritable(client.query.bind(client), req.userId, dependencies);
    const initial = await client.query(
      'SELECT * FROM rental_contracts WHERE user_id=$1 AND id=$2',
      [req.userId, contractId]
    );
    let contract = initial.rows[0];
    if (!contract) throw new RentalLifecycleError(404, 'CONTRACT_NOT_FOUND', 'Không tìm thấy hợp đồng');
    if (contract.room_id === input.targetRoomId) {
      throw new RentalLifecycleError(409, 'TRANSFER_SAME_ROOM', 'Phòng chuyển đến phải khác phòng hiện tại');
    }
    const roomResult = await client.query(
      `SELECT id, name FROM rooms
       WHERE user_id=$1 AND id=ANY($2::text[])
       ORDER BY id
       FOR UPDATE`,
      [req.userId, [contract.room_id, input.targetRoomId]]
    );
    const roomById = new Map(roomResult.rows.map(row => [row.id, row]));
    const sourceRoom = roomById.get(contract.room_id);
    const targetRoom = roomById.get(input.targetRoomId);
    if (!sourceRoom || !targetRoom) {
      throw new RentalLifecycleError(404, 'TRANSFER_ROOM_NOT_FOUND', 'Phòng hiện tại hoặc phòng chuyển đến không còn tồn tại');
    }
    const locked = await client.query(
      'SELECT * FROM rental_contracts WHERE user_id=$1 AND id=$2 FOR UPDATE',
      [req.userId, contractId]
    );
    contract = locked.rows[0];
    if (!contract) throw new RentalLifecycleError(404, 'CONTRACT_NOT_FOUND', 'Không tìm thấy hợp đồng');
    if (contract.status !== 'active') {
      throw new RentalLifecycleError(409, 'CONTRACT_NOT_ACTIVE', 'Chỉ hợp đồng đang hoạt động mới được chuyển phòng');
    }
    if (contract.room_id !== sourceRoom.id) {
      throw new RentalLifecycleError(409, 'TRANSFER_CONTRACT_CHANGED', 'Hợp đồng đã thay đổi trong lúc chuyển phòng');
    }
    if (input.occurredOn < dateJson(contract.starts_on)) {
      throw new RentalLifecycleError(400, 'TRANSFER_BEFORE_CONTRACT', 'Ngày chuyển phòng không được trước ngày bắt đầu hợp đồng');
    }
    if (input.endsOn && input.endsOn < input.occurredOn) {
      throw new RentalLifecycleError(400, 'INVALID_TRANSFER_END_DATE', 'Ngày kết thúc hợp đồng mới không được trước ngày chuyển phòng');
    }
    await requireCheckoutHandover(client.query.bind(client), req.userId, contractId, input.occurredOn);
    const tenantResult = await client.query(
      `SELECT * FROM tenants
       WHERE user_id=$1 AND id=$2 AND room_id=$3
       FOR UPDATE`,
      [req.userId, contract.tenant_id, contract.room_id]
    );
    const tenant = tenantResult.rows[0];
    if (!tenant) {
      throw new RentalLifecycleError(409, 'TRANSFER_TENANCY_CHANGED', 'Khách thuê không còn thuộc phòng theo hợp đồng');
    }
    await expireReservations(client.query.bind(client), req.userId, input.targetRoomId);
    const conflicts = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM rental_contracts
         WHERE user_id=$1 AND room_id=$2 AND status='active'
       ) AS has_contract,
       EXISTS (
         SELECT 1 FROM rental_reservations
         WHERE user_id=$1 AND room_id=$2 AND status='active'
       ) AS has_reservation`,
      [req.userId, input.targetRoomId]
    );
    if (conflicts.rows[0]?.has_contract || conflicts.rows[0]?.has_reservation) {
      throw new RentalLifecycleError(
        409,
        'TARGET_ROOM_UNAVAILABLE',
        'Phòng chuyển đến đang được thuê hoặc đang được giữ chỗ'
      );
    }
    const updatedOld = await client.query(
      `UPDATE rental_contracts
       SET status='ended', status_reason=$3, ended_at=now(), updated_at=now()
       WHERE user_id=$1 AND id=$2
       RETURNING *`,
      [req.userId, contractId, input.reason]
    );
    const idResult = await client.query("SELECT nextval('rental_contracts_id_seq') AS id");
    const newContractId = Number(idResult.rows[0].id);
    const targetEndsOn = input.endsOn
      || (dateJson(contract.ends_on) >= input.occurredOn ? dateJson(contract.ends_on) : null);
    const targetDeposit = input.depositVnd === null
      ? Number(contract.deposit_vnd) || 0
      : input.depositVnd;
    const inserted = await client.query(
      `INSERT INTO rental_contracts
         (id, user_id, contract_code, room_id, room_name_snapshot,
          tenant_id, tenant_name_snapshot, tenant_phone_snapshot,
          tenant_cccd_snapshot, tenant_issue_date_snapshot, tenant_dob_snapshot,
          tenant_gender_snapshot, tenant_address_snapshot,
          status, starts_on, ends_on, billing_cycle_months, payment_due_day,
          monthly_rent_vnd, deposit_vnd, terms, status_reason, activated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
               'active',$14,$15,$16,$17,$18,$19,$20,$21,now())
       RETURNING *`,
      [
        newContractId,
        req.userId,
        contractCode(newContractId, input.occurredOn),
        input.targetRoomId,
        String(targetRoom.name || '').trim() || 'Phòng chưa đặt tên',
        contract.tenant_id,
        String(tenant.full_name || '').trim() || contract.tenant_name_snapshot,
        tenant.phone || '',
        tenant.cccd || '',
        tenant.issue_date || '',
        tenant.dob || '',
        tenant.gender || '',
        tenant.address || '',
        input.occurredOn,
        targetEndsOn,
        Number(contract.billing_cycle_months) || 1,
        Number(contract.payment_due_day) || 5,
        input.monthlyRentVnd,
        targetDeposit,
        contract.terms || '',
        `Chuyển từ ${sourceRoom.name}: ${input.reason}`.slice(0, 500)
      ]
    );
    await client.query(
      'UPDATE tenants SET room_id=$3 WHERE user_id=$1 AND id=$2',
      [req.userId, contract.tenant_id, input.targetRoomId]
    );
    const rate = await syncRentRate(
      client.query.bind(client),
      req.userId,
      input.targetRoomId,
      input.occurredOn.slice(0, 7),
      input.monthlyRentVnd,
      { rentStartDate: input.occurredOn }
    );
    const event = await insertEvent(client.query.bind(client), req.userId, {
      eventType: 'room_transferred',
      contractId,
      relatedContractId: newContractId,
      tenantId: contract.tenant_id,
      tenantName: tenant.full_name || contract.tenant_name_snapshot,
      sourceRoomId: contract.room_id,
      sourceRoomName: sourceRoom.name,
      targetRoomId: input.targetRoomId,
      targetRoomName: targetRoom.name,
      occurredOn: input.occurredOn,
      reason: input.reason,
      metadata: {
        oldContractCode: contract.contract_code,
        newContractCode: inserted.rows[0].contract_code,
        monthlyRentVnd: input.monthlyRentVnd,
        depositVnd: targetDeposit
      }
    });
    await client.query('COMMIT');
    return res.status(201).json({
      previousContract: contractJson(updatedOld.rows[0]),
      contract: contractJson(inserted.rows[0]),
      event: eventJson(event),
      rate
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendRentalLifecycleError(res, error)) return res;
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Phòng chuyển đến không còn trống', code: 'TARGET_ROOM_UNAVAILABLE' });
    }
    throw error;
  } finally {
    client.release();
  }
}

async function checkoutContract(req, res, dependencies = {}) {
  let contractId;
  let input;
  try {
    contractId = positiveId(req.params?.id, 'Hợp đồng');
    input = checkoutInput(req.body);
  } catch (error) {
    if (sendRentalLifecycleError(res, error)) return res;
    throw error;
  }
  const getClient = dependencies.getClient || db.getClient;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await ensureWritable(client.query.bind(client), req.userId, dependencies);
    const locked = await client.query(
      'SELECT * FROM rental_contracts WHERE user_id=$1 AND id=$2 FOR UPDATE',
      [req.userId, contractId]
    );
    const contract = locked.rows[0];
    if (!contract) throw new RentalLifecycleError(404, 'CONTRACT_NOT_FOUND', 'Không tìm thấy hợp đồng');
    if (contract.status !== 'active') {
      throw new RentalLifecycleError(409, 'CONTRACT_NOT_ACTIVE', 'Chỉ hợp đồng đang hoạt động mới được trả phòng');
    }
    if (input.occurredOn < dateJson(contract.starts_on)) {
      throw new RentalLifecycleError(400, 'CHECKOUT_BEFORE_CONTRACT', 'Ngày trả phòng không được trước ngày bắt đầu hợp đồng');
    }
    await requireCheckoutHandover(client.query.bind(client), req.userId, contractId, input.occurredOn);
    const updated = await client.query(
      `UPDATE rental_contracts
       SET status='ended', status_reason=$3, ended_at=now(), updated_at=now()
       WHERE user_id=$1 AND id=$2
       RETURNING *`,
      [req.userId, contractId, input.reason]
    );
    const event = await insertEvent(client.query.bind(client), req.userId, {
      eventType: 'checked_out',
      contractId,
      tenantId: contract.tenant_id,
      tenantName: contract.tenant_name_snapshot,
      sourceRoomId: contract.room_id,
      sourceRoomName: contract.room_name_snapshot,
      occurredOn: input.occurredOn,
      reason: input.reason
    });
    await client.query('COMMIT');
    return res.json({ contract: contractJson(updated.rows[0]), event: eventJson(event) });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendRentalLifecycleError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

async function loadRentalLifecycleExport(userId) {
  const [reservations, events] = await Promise.all([
    db.query('SELECT * FROM rental_reservations WHERE user_id=$1 ORDER BY id', [userId]),
    db.query('SELECT * FROM rental_lifecycle_events WHERE user_id=$1 ORDER BY id', [userId])
  ]);
  return {
    reservations: reservations.rows.map(reservationJson),
    events: events.rows.map(eventJson)
  };
}

module.exports = {
  RentalLifecycleError,
  cancelReservation,
  cancelReservationInput,
  checkoutContract,
  checkoutInput,
  createReservation,
  eventCode,
  eventJson,
  expireReservations,
  insertEvent,
  listLifecycle,
  loadRentalLifecycleExport,
  moneyInput,
  reservationCode,
  reservationInput,
  reservationJson,
  requireCheckoutHandover,
  transferContract,
  transferInput
};
