'use strict';

const db = require('./db');
const subscription = require('./subscription');

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

async function ensureWritable(query, userId, dependencies = {}) {
  if (dependencies.enforceWrite) return dependencies.enforceWrite(userId, query);
  const { rows } = await query('SELECT COUNT(*)::int AS room_count FROM rooms WHERE user_id=$1', [userId]);
  return subscription.enforceStateWrite(userId, Number(rows[0]?.room_count) || 0, query);
}

async function listMaintenance(req, res, dependencies = {}) {
  const query = dependencies.query || db.query;
  try {
    const result = await query(
      `SELECT * FROM room_maintenance_periods
       WHERE user_id=$1
       ORDER BY status DESC, starts_on DESC, id DESC
       LIMIT 100`,
      [req.userId]
    );
    res.set('Cache-Control', 'no-store');
    return res.json({ maintenancePeriods: result.rows.map(maintenanceJson) });
  } catch (error) {
    // If table doesn't exist yet, return empty array
    if (error.code === '42P01') {
      res.set('Cache-Control', 'no-store');
      return res.json({ maintenancePeriods: [] });
    }
    throw error;
  }
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
    await client.query('COMMIT');
    return res.status(201).json({ maintenance: maintenanceJson(inserted.rows[0]) });
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
    const updated = await client.query(
      `UPDATE room_maintenance_periods
       SET status='completed', ended_on=$3, completion_note=$4,
           completed_at=now(), updated_at=now()
       WHERE user_id=$1 AND id=$2
       RETURNING *`,
      [req.userId, maintenanceId, input.endedOn, input.completionNote]
    );
    await client.query('COMMIT');
    return res.json({ maintenance: maintenanceJson(updated.rows[0]) });
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
  maintenanceJson
};
