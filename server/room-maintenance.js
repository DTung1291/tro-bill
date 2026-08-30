'use strict';

const db = require('./db');
const subscription = require('./subscription');
const { eventJson, expireReservations, insertEvent } = require('./rental-lifecycle');

const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;

class RoomMaintenanceError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'RoomMaintenanceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function sendMaintenanceError(res, error) {
  if (error instanceof RoomMaintenanceError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return true;
  }
  if (subscription.sendEntitlementError(res, error)) return true;
  return false;
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new RoomMaintenanceError(400, 'INVALID_MAINTENANCE_ID', `${label} không hợp lệ`);
  }
  return id;
}

function identifier(value, label) {
  const result = String(value || '').trim();
  if (!result || result.length > 200) {
    throw new RoomMaintenanceError(400, 'INVALID_MAINTENANCE_REFERENCE', `${label} không hợp lệ`);
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
    throw new RoomMaintenanceError(400, 'INVALID_MAINTENANCE_DATE', `${label} không hợp lệ`);
  }
  return result;
}

function textInput(value, label, { min = 0, max }) {
  const result = String(value || '').trim();
  if (result.length < min || result.length > max) {
    const range = min > 0 ? `từ ${min} đến ${max}` : `tối đa ${max}`;
    throw new RoomMaintenanceError(
      400,
      'INVALID_MAINTENANCE_TEXT',
      `${label} phải có ${range} ký tự`
    );
  }
  return result;
}

function maintenanceInput(body = {}) {
  const startsOn = dateInput(body.startsOn, 'Ngày bắt đầu sửa');
  const expectedEndsOn = dateInput(body.expectedEndsOn, 'Ngày dự kiến hoàn thành', { optional: true });
  if (expectedEndsOn && expectedEndsOn < startsOn) {
    throw new RoomMaintenanceError(
      400,
      'INVALID_MAINTENANCE_DATE_RANGE',
      'Ngày dự kiến hoàn thành không được trước ngày bắt đầu'
    );
  }
  return {
    roomId: identifier(body.roomId, 'Phòng'),
    startsOn,
    expectedEndsOn,
    reason: textInput(body.reason, 'Lý do sửa chữa', { min: 10, max: 500 })
  };
}

function completionInput(body = {}) {
  return {
    endedOn: dateInput(body.endedOn, 'Ngày hoàn thành'),
    completionNote: textInput(body.completionNote, 'Ghi chú hoàn thành', { min: 10, max: 500 })
  };
}

function dateJson(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function maintenanceCode(id, startsOn) {
  return `SUA-${String(startsOn).slice(0, 4)}-${Number(id).toString(36).toUpperCase().padStart(6, '0')}`;
}

function maintenanceJson(row) {
  return {
    id: Number(row.id),
    code: row.maintenance_code,
    roomId: row.room_id,
    roomName: row.room_name_snapshot,
    status: row.status,
    startsOn: dateJson(row.starts_on),
    expectedEndsOn: dateJson(row.expected_ends_on),
    endedOn: dateJson(row.ended_on),
    reason: row.reason,
    completionNote: row.completion_note || '',
    completedAt: row.completed_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function operationalStatusJson(row) {
  const tenantCount = Number(row.active_tenant_count) || 0;
  const occupied = !!row.active_contract_id || tenantCount > 0;
  const sources = [
    occupied ? 'occupied' : null,
    row.active_reservation_id ? 'reserved' : null,
    row.active_maintenance_id ? 'maintenance' : null
  ].filter(Boolean);
  const status = occupied
    ? 'occupied'
    : row.active_reservation_id
      ? 'reserved'
      : row.active_maintenance_id
        ? 'maintenance'
        : 'vacant';
  return {
    roomId: row.room_id,
    roomName: row.room_name,
    status,
    conflict: sources.length > 1,
    activeTenantCount: tenantCount,
    activeContractId: row.active_contract_id == null ? null : Number(row.active_contract_id),
    activeReservationId: row.active_reservation_id == null
      ? null
      : Number(row.active_reservation_id),
    activeMaintenanceId: row.active_maintenance_id == null
      ? null
      : Number(row.active_maintenance_id)
  };
}

async function ensureWritable(query, userId, dependencies = {}) {
  if (dependencies.enforceWrite) return dependencies.enforceWrite(userId, query);
  const { rows } = await query('SELECT COUNT(*)::int AS room_count FROM rooms WHERE user_id=$1', [userId]);
  return subscription.enforceStateWrite(userId, Number(rows[0]?.room_count) || 0, query);
}

async function listMaintenance(req, res, dependencies = {}) {
  const query = dependencies.query || db.query;
  await expireReservations(query, req.userId);
  const [maintenanceResult, statusResult] = await Promise.all([
    query(
      `SELECT * FROM room_maintenance_periods
       WHERE user_id=$1
       ORDER BY (status='active') DESC, starts_on DESC, id DESC
       LIMIT 100`,
      [req.userId]
    ),
    query(
      `SELECT room.id AS room_id, room.name AS room_name,
              contract.id AS active_contract_id,
              tenant.active_tenant_count,
              reservation.id AS active_reservation_id,
              maintenance.id AS active_maintenance_id
       FROM rooms room
       LEFT JOIN LATERAL (
         SELECT id FROM rental_contracts
         WHERE user_id=room.user_id AND room_id=room.id AND status='active'
         ORDER BY id DESC LIMIT 1
       ) contract ON TRUE
       LEFT JOIN LATERAL (
         SELECT COUNT(*)::int AS active_tenant_count FROM tenants
         WHERE user_id=room.user_id AND room_id=room.id
       ) tenant ON TRUE
       LEFT JOIN LATERAL (
         SELECT id FROM rental_reservations
         WHERE user_id=room.user_id AND room_id=room.id AND status='active'
         ORDER BY id DESC LIMIT 1
       ) reservation ON TRUE
       LEFT JOIN LATERAL (
         SELECT id FROM room_maintenance_periods
         WHERE user_id=room.user_id AND room_id=room.id AND status='active'
         ORDER BY id DESC LIMIT 1
       ) maintenance ON TRUE
       WHERE room.user_id=$1
       ORDER BY room.sort_order, room.id`,
      [req.userId]
    )
  ]);
  res.set('Cache-Control', 'no-store');
  return res.json({
    maintenancePeriods: maintenanceResult.rows.map(maintenanceJson),
    roomStatuses: statusResult.rows.map(operationalStatusJson)
  });
}

async function createMaintenance(req, res, dependencies = {}) {
  let input;
  try {
    input = maintenanceInput(req.body);
  } catch (error) {
    if (sendMaintenanceError(res, error)) return res;
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
    if (!room) {
      throw new RoomMaintenanceError(404, 'ROOM_NOT_FOUND', 'Không tìm thấy phòng');
    }
    await expireReservations(client.query.bind(client), req.userId, input.roomId);
    const conflicts = await client.query(
      `SELECT EXISTS (
         SELECT 1 FROM rental_contracts
         WHERE user_id=$1 AND room_id=$2 AND status='active'
       ) AS has_contract,
       EXISTS (
         SELECT 1 FROM rental_reservations
         WHERE user_id=$1 AND room_id=$2 AND status='active'
       ) AS has_reservation,
       EXISTS (
         SELECT 1 FROM tenants
         WHERE user_id=$1 AND room_id=$2
       ) AS has_tenant`,
      [req.userId, input.roomId]
    );
    if (conflicts.rows[0]?.has_contract || conflicts.rows[0]?.has_reservation
        || conflicts.rows[0]?.has_tenant) {
      throw new RoomMaintenanceError(
        409,
        'ROOM_NOT_VACANT',
        'Chỉ phòng trống mới có thể bắt đầu sửa chữa'
      );
    }
    const idResult = await client.query("SELECT nextval('room_maintenance_periods_id_seq') AS id");
    const id = Number(idResult.rows[0].id);
    const inserted = await client.query(
      `INSERT INTO room_maintenance_periods
         (id, user_id, maintenance_code, room_id, room_name_snapshot,
          starts_on, expected_ends_on, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        id,
        req.userId,
        maintenanceCode(id, input.startsOn),
        input.roomId,
        String(room.name || '').trim() || 'Phòng chưa đặt tên',
        input.startsOn,
        input.expectedEndsOn,
        input.reason
      ]
    );
    const event = await insertEvent(client.query.bind(client), req.userId, {
      eventType: 'maintenance_started',
      maintenanceId: id,
      targetRoomId: input.roomId,
      targetRoomName: room.name,
      occurredOn: input.startsOn,
      reason: input.reason,
      metadata: { expectedEndsOn: input.expectedEndsOn }
    });
    await client.query('COMMIT');
    return res.status(201).json({
      maintenance: maintenanceJson(inserted.rows[0]),
      event: eventJson(event)
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendMaintenanceError(res, error)) return res;
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'Phòng đang trong quá trình sửa chữa',
        code: 'ACTIVE_MAINTENANCE_EXISTS'
      });
    }
    throw error;
  } finally {
    client.release();
  }
}

async function completeMaintenance(req, res, dependencies = {}) {
  let maintenanceId;
  let input;
  try {
    maintenanceId = positiveId(req.params?.id, 'Đợt sửa chữa');
    input = completionInput(req.body);
  } catch (error) {
    if (sendMaintenanceError(res, error)) return res;
    throw error;
  }
  const getClient = dependencies.getClient || db.getClient;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await ensureWritable(client.query.bind(client), req.userId, dependencies);
    const locked = await client.query(
      'SELECT * FROM room_maintenance_periods WHERE user_id=$1 AND id=$2 FOR UPDATE',
      [req.userId, maintenanceId]
    );
    const maintenance = locked.rows[0];
    if (!maintenance) {
      throw new RoomMaintenanceError(404, 'MAINTENANCE_NOT_FOUND', 'Không tìm thấy đợt sửa chữa');
    }
    if (maintenance.status !== 'active') {
      throw new RoomMaintenanceError(
        409,
        'MAINTENANCE_NOT_ACTIVE',
        'Chỉ đợt sửa chữa đang hoạt động mới có thể hoàn thành'
      );
    }
    if (input.endedOn < dateJson(maintenance.starts_on)) {
      throw new RoomMaintenanceError(
        400,
        'COMPLETION_BEFORE_START',
        'Ngày hoàn thành không được trước ngày bắt đầu'
      );
    }
    await client.query(
      'SELECT id FROM rooms WHERE user_id=$1 AND id=$2 FOR UPDATE',
      [req.userId, maintenance.room_id]
    );
    const updated = await client.query(
      `UPDATE room_maintenance_periods
       SET status='completed', ended_on=$3, completion_note=$4,
           completed_at=now(), updated_at=now()
       WHERE user_id=$1 AND id=$2
       RETURNING *`,
      [req.userId, maintenanceId, input.endedOn, input.completionNote]
    );
    const event = await insertEvent(client.query.bind(client), req.userId, {
      eventType: 'maintenance_completed',
      maintenanceId,
      sourceRoomId: maintenance.room_id,
      sourceRoomName: maintenance.room_name_snapshot,
      occurredOn: input.endedOn,
      reason: input.completionNote,
      metadata: {
        startsOn: dateJson(maintenance.starts_on),
        initialReason: maintenance.reason
      }
    });
    await client.query('COMMIT');
    return res.json({
      maintenance: maintenanceJson(updated.rows[0]),
      event: eventJson(event)
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendMaintenanceError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

async function loadMaintenanceExport(userId) {
  const result = await db.query(
    'SELECT * FROM room_maintenance_periods WHERE user_id=$1 ORDER BY id',
    [userId]
  );
  return result.rows.map(maintenanceJson);
}

module.exports = {
  RoomMaintenanceError,
  completeMaintenance,
  completionInput,
  createMaintenance,
  listMaintenance,
  loadMaintenanceExport,
  maintenanceCode,
  maintenanceInput,
  maintenanceJson,
  operationalStatusJson
};
