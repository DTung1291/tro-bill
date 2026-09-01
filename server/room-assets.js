'use strict';

const db = require('./db');
const subscription = require('./subscription');
const { recordDataAudits, requestDataAuditEntry } = require('./data-audit');

const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;
const ASSET_CONDITIONS = Object.freeze(['good', 'fair', 'damaged', 'lost']);
const ASSET_STATUSES = Object.freeze(['active', 'archived']);

class RoomAssetError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'RoomAssetError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function sendRoomAssetError(res, error) {
  if (error instanceof RoomAssetError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return true;
  }
  if (subscription.sendEntitlementError(res, error)) return true;
  return false;
}

function positiveId(value, label = 'Tài sản') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new RoomAssetError(400, 'INVALID_ROOM_ASSET_ID', `${label} không hợp lệ`);
  }
  return id;
}

function limitedText(value, label, { min = 0, max }) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (text.length < min || text.length > max) {
    const range = min > 0 ? `từ ${min} đến ${max}` : `tối đa ${max}`;
    throw new RoomAssetError(400, 'INVALID_ROOM_ASSET_TEXT', `${label} phải có ${range} ký tự`);
  }
  return text;
}

function roomIdentifier(value) {
  const roomId = String(value || '').trim();
  if (!roomId || roomId.length > 200) {
    throw new RoomAssetError(400, 'INVALID_ROOM_ASSET_ROOM', 'Phòng không hợp lệ');
  }
  return roomId;
}

function optionalDate(value, label) {
  const date = String(value || '').trim();
  if (!date) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!DATE_PATTERN.test(date)
      || Number.isNaN(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== date) {
    throw new RoomAssetError(400, 'INVALID_ROOM_ASSET_DATE', `${label} không hợp lệ`);
  }
  return date;
}

function quantityInput(value) {
  const quantity = Number(value);
  if (!Number.isFinite(quantity)
      || quantity <= 0
      || quantity > 99999999
      || Math.round(quantity * 100) / 100 !== quantity) {
    throw new RoomAssetError(
      400,
      'INVALID_ROOM_ASSET_QUANTITY',
      'Số lượng phải lớn hơn 0 và có tối đa 2 chữ số thập phân'
    );
  }
  return quantity;
}

function purchasePriceInput(value) {
  if (value === '' || value === null || value === undefined) return null;
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 999999999999) {
    throw new RoomAssetError(
      400,
      'INVALID_ROOM_ASSET_PRICE',
      'Giá mua phải là số nguyên VND không âm'
    );
  }
  return amount;
}

function assetInput(body = {}) {
  const condition = String(body.condition || '').trim().toLowerCase();
  if (!ASSET_CONDITIONS.includes(condition)) {
    throw new RoomAssetError(400, 'INVALID_ROOM_ASSET_CONDITION', 'Tình trạng tài sản không hợp lệ');
  }
  return {
    roomId: roomIdentifier(body.roomId),
    name: limitedText(body.name, 'Tên tài sản', { min: 1, max: 200 }),
    quantity: quantityInput(body.quantity),
    unit: limitedText(body.unit || 'cái', 'Đơn vị', { min: 1, max: 50 }),
    condition,
    conditionNote: limitedText(body.conditionNote, 'Mô tả tình trạng', { max: 500 }),
    serialNumber: limitedText(body.serialNumber, 'Số serial/mã thiết bị', { max: 200 }),
    acquiredOn: optionalDate(body.acquiredOn, 'Ngày mua/tiếp nhận'),
    purchasePriceVnd: purchasePriceInput(body.purchasePriceVnd),
    note: limitedText(body.note, 'Ghi chú', { max: 1000 })
  };
}

function dateJson(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function assetJson(row) {
  return {
    id: Number(row.id),
    code: row.asset_code,
    roomId: row.room_id,
    roomName: row.current_room_name || row.room_name_snapshot,
    propertyId: row.property_id == null ? null : Number(row.property_id),
    propertyName: row.property_name || '',
    name: row.name,
    quantity: Number(row.quantity),
    unit: row.unit,
    condition: row.condition_status,
    conditionNote: row.condition_note || '',
    serialNumber: row.serial_number || '',
    acquiredOn: dateJson(row.acquired_on),
    purchasePriceVnd: row.purchase_price_vnd == null ? null : Number(row.purchase_price_vnd),
    note: row.note || '',
    status: row.status,
    archivedReason: row.archived_reason || '',
    archivedAt: row.archived_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function assetCode(id, year) {
  return `TS-${Number(year)}-${Number(id).toString(36).toUpperCase().padStart(6, '0')}`;
}

function requireOwnerWrite(req) {
  if (req.workspace && !req.workspace.isOwner) {
    throw new RoomAssetError(
      403,
      'ROOM_ASSET_WRITE_OWNER_REQUIRED',
      'Workspace nhân viên chỉ được xem danh mục tài sản'
    );
  }
}

async function ensureWritable(query, userId) {
  const result = await query(
    'SELECT COUNT(*)::int AS room_count FROM rooms WHERE user_id=$1',
    [userId]
  );
  await subscription.enforceStateWrite(
    userId,
    Math.max(0, Number(result.rows[0]?.room_count) || 0),
    query
  );
}

async function lockStateWrite(query, userId) {
  await query(
    `SELECT pg_advisory_xact_lock(hashtextextended(
       'state-write:' || $1::text, 0
     ))`,
    [userId]
  );
}

async function findRoom(query, userId, roomId) {
  const result = await query(
    `SELECT room.id, room.name, room.property_id
     FROM rooms room
     WHERE room.user_id=$1 AND room.id=$2
     FOR SHARE`,
    [userId, roomId]
  );
  if (!result.rows[0]) {
    throw new RoomAssetError(404, 'ROOM_NOT_FOUND', 'Không tìm thấy phòng thuộc tài khoản');
  }
  return result.rows[0];
}

async function roomAssetRows(userId, options = {}, query = db.query) {
  const roomId = options.roomId ? roomIdentifier(options.roomId) : '';
  const status = String(options.status || 'active').trim().toLowerCase();
  if (status !== 'all' && !ASSET_STATUSES.includes(status)) {
    throw new RoomAssetError(400, 'INVALID_ROOM_ASSET_STATUS', 'Trạng thái tài sản không hợp lệ');
  }
  const scoped = Array.isArray(options.propertyIds);
  const result = await query(
    `SELECT asset.*, room.name AS current_room_name, room.property_id,
            property.name AS property_name
     FROM room_assets asset
     LEFT JOIN rooms room
       ON room.user_id=asset.user_id AND room.id=asset.room_id
     LEFT JOIN properties property
       ON property.user_id=room.user_id AND property.id=room.property_id
     WHERE asset.user_id=$1
       AND ($2::text='' OR asset.room_id=$2)
       AND ($3::text='all' OR asset.status=$3)
       AND ($4::boolean=false OR room.property_id=ANY($5::bigint[]))
     ORDER BY asset.status, property.name NULLS LAST,
              COALESCE(room.name, asset.room_name_snapshot), asset.name, asset.id`,
    [userId, roomId, status, scoped, scoped ? options.propertyIds : []]
  );
  return result.rows;
}

async function listRoomAssets(req, res, dependencies = {}) {
  try {
    const propertyIds = req.workspace && !req.workspace.isOwner
      ? (Array.isArray(req.workspace.propertyIds) ? req.workspace.propertyIds : [])
      : null;
    const rows = await roomAssetRows(req.userId, {
      roomId: req.query?.roomId,
      status: req.query?.status,
      propertyIds
    }, dependencies.query || db.query);
    res.set('Cache-Control', 'no-store');
    return res.json({ assets: rows.map(assetJson) });
  } catch (error) {
    if (sendRoomAssetError(res, error)) return res;
    throw error;
  }
}

async function createRoomAsset(req, res, dependencies = {}) {
  let input;
  try {
    requireOwnerWrite(req);
    input = assetInput(req.body);
  } catch (error) {
    if (sendRoomAssetError(res, error)) return res;
    throw error;
  }
  const client = await (dependencies.getClient || db.getClient)();
  try {
    await client.query('BEGIN');
    await lockStateWrite(client.query.bind(client), req.userId);
    await ensureWritable(client.query.bind(client), req.userId);
    const room = await findRoom(client.query.bind(client), req.userId, input.roomId);
    const idResult = await client.query(
      `SELECT nextval('room_assets_id_seq') AS id,
              EXTRACT(YEAR FROM CURRENT_DATE)::int AS code_year`
    );
    const id = Number(idResult.rows[0].id);
    const inserted = await client.query(
      `INSERT INTO room_assets
         (id, user_id, asset_code, room_id, room_name_snapshot, name, quantity,
          unit, condition_status, condition_note, serial_number, acquired_on,
          purchase_price_vnd, note)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       RETURNING *`,
      [
        id,
        req.userId,
        assetCode(id, idResult.rows[0].code_year),
        room.id,
        room.name,
        input.name,
        input.quantity,
        input.unit,
        input.condition,
        input.conditionNote,
        input.serialNumber,
        input.acquiredOn,
        input.purchasePriceVnd,
        input.note
      ]
    );
    await recordDataAudits(client.query.bind(client), [requestDataAuditEntry(
      req,
      'room_asset_created',
      'room_asset',
      String(id),
      {
        changedFields: [
          'roomId', 'name', 'quantity', 'unit', 'condition', 'conditionNote',
          'serialNumber', 'acquiredOn', 'purchasePriceVnd', 'note'
        ],
        purpose: 'Thêm tài sản vào phòng'
      }
    )]);
    await client.query('COMMIT');
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({
      asset: assetJson({
        ...inserted.rows[0],
        current_room_name: room.name,
        property_id: room.property_id
      })
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendRoomAssetError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

async function updateRoomAsset(req, res, dependencies = {}) {
  let id;
  let input;
  try {
    requireOwnerWrite(req);
    id = positiveId(req.params?.id);
    input = assetInput(req.body);
  } catch (error) {
    if (sendRoomAssetError(res, error)) return res;
    throw error;
  }
  const client = await (dependencies.getClient || db.getClient)();
  try {
    await client.query('BEGIN');
    await lockStateWrite(client.query.bind(client), req.userId);
    await ensureWritable(client.query.bind(client), req.userId);
    const currentResult = await client.query(
      'SELECT * FROM room_assets WHERE user_id=$1 AND id=$2 FOR UPDATE',
      [req.userId, id]
    );
    const current = currentResult.rows[0];
    if (!current) {
      throw new RoomAssetError(404, 'ROOM_ASSET_NOT_FOUND', 'Không tìm thấy tài sản');
    }
    if (current.status !== 'active') {
      throw new RoomAssetError(
        409,
        'ROOM_ASSET_ARCHIVED',
        'Hãy khôi phục tài sản trước khi chỉnh sửa'
      );
    }
    const room = await findRoom(client.query.bind(client), req.userId, input.roomId);
    const updated = await client.query(
      `UPDATE room_assets
       SET room_id=$3, room_name_snapshot=$4, name=$5, quantity=$6, unit=$7,
           condition_status=$8, condition_note=$9, serial_number=$10,
           acquired_on=$11, purchase_price_vnd=$12, note=$13, updated_at=now()
       WHERE user_id=$1 AND id=$2
       RETURNING *`,
      [
        req.userId,
        id,
        room.id,
        room.name,
        input.name,
        input.quantity,
        input.unit,
        input.condition,
        input.conditionNote,
        input.serialNumber,
        input.acquiredOn,
        input.purchasePriceVnd,
        input.note
      ]
    );
    const fields = [
      ['room_id', 'roomId', room.id],
      ['name', 'name', input.name],
      ['quantity', 'quantity', input.quantity],
      ['unit', 'unit', input.unit],
      ['condition_status', 'condition', input.condition],
      ['condition_note', 'conditionNote', input.conditionNote],
      ['serial_number', 'serialNumber', input.serialNumber],
      ['acquired_on', 'acquiredOn', input.acquiredOn],
      ['purchase_price_vnd', 'purchasePriceVnd', input.purchasePriceVnd],
      ['note', 'note', input.note]
    ].filter(([databaseField, , nextValue]) => String(current[databaseField] ?? '') !== String(nextValue ?? ''))
      .map(([, clientField]) => clientField);
    if (fields.length > 0) {
      await recordDataAudits(client.query.bind(client), [requestDataAuditEntry(
        req,
        'room_asset_updated',
        'room_asset',
        String(id),
        { changedFields: fields, purpose: 'Cập nhật tài sản phòng' }
      )]);
    }
    await client.query('COMMIT');
    res.set('Cache-Control', 'no-store');
    return res.json({
      asset: assetJson({
        ...updated.rows[0],
        current_room_name: room.name,
        property_id: room.property_id
      })
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendRoomAssetError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

function archiveReason(body = {}) {
  return limitedText(body.reason, 'Lý do ngừng sử dụng', { min: 3, max: 500 });
}

async function archiveRoomAsset(req, res, dependencies = {}) {
  let id;
  let reason;
  try {
    requireOwnerWrite(req);
    id = positiveId(req.params?.id);
    reason = archiveReason(req.body);
  } catch (error) {
    if (sendRoomAssetError(res, error)) return res;
    throw error;
  }
  const client = await (dependencies.getClient || db.getClient)();
  try {
    await client.query('BEGIN');
    await lockStateWrite(client.query.bind(client), req.userId);
    await ensureWritable(client.query.bind(client), req.userId);
    const updated = await client.query(
      `UPDATE room_assets
       SET status='archived', archived_reason=$3, archived_at=now(), updated_at=now()
       WHERE user_id=$1 AND id=$2 AND status='active'
       RETURNING *`,
      [req.userId, id, reason]
    );
    if (!updated.rows[0]) {
      const exists = await client.query(
        'SELECT status FROM room_assets WHERE user_id=$1 AND id=$2',
        [req.userId, id]
      );
      if (!exists.rows[0]) {
        throw new RoomAssetError(404, 'ROOM_ASSET_NOT_FOUND', 'Không tìm thấy tài sản');
      }
      throw new RoomAssetError(409, 'ROOM_ASSET_ALREADY_ARCHIVED', 'Tài sản đã ngừng sử dụng');
    }
    await recordDataAudits(client.query.bind(client), [requestDataAuditEntry(
      req,
      'room_asset_archived',
      'room_asset',
      String(id),
      { changedFields: ['status', 'archivedReason'], purpose: reason }
    )]);
    await client.query('COMMIT');
    res.set('Cache-Control', 'no-store');
    return res.json({ asset: assetJson(updated.rows[0]) });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendRoomAssetError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

async function restoreRoomAsset(req, res, dependencies = {}) {
  let id;
  let submittedRoomId = null;
  try {
    requireOwnerWrite(req);
    id = positiveId(req.params?.id);
    if (req.body?.roomId !== undefined && req.body?.roomId !== null && req.body?.roomId !== '') {
      submittedRoomId = roomIdentifier(req.body.roomId);
    }
  } catch (error) {
    if (sendRoomAssetError(res, error)) return res;
    throw error;
  }
  const client = await (dependencies.getClient || db.getClient)();
  try {
    await client.query('BEGIN');
    await lockStateWrite(client.query.bind(client), req.userId);
    await ensureWritable(client.query.bind(client), req.userId);
    const currentResult = await client.query(
      'SELECT * FROM room_assets WHERE user_id=$1 AND id=$2 FOR UPDATE',
      [req.userId, id]
    );
    const current = currentResult.rows[0];
    if (!current) {
      throw new RoomAssetError(404, 'ROOM_ASSET_NOT_FOUND', 'Không tìm thấy tài sản');
    }
    if (current.status !== 'archived') {
      throw new RoomAssetError(409, 'ROOM_ASSET_ALREADY_ACTIVE', 'Tài sản đang được sử dụng');
    }
    const room = await findRoom(
      client.query.bind(client),
      req.userId,
      submittedRoomId || current.room_id
    );
    const updated = await client.query(
      `UPDATE room_assets
       SET room_id=$3, room_name_snapshot=$4, status='active', archived_reason='',
           archived_at=NULL, updated_at=now()
       WHERE user_id=$1 AND id=$2
       RETURNING *`,
      [req.userId, id, room.id, room.name]
    );
    await recordDataAudits(client.query.bind(client), [requestDataAuditEntry(
      req,
      'room_asset_restored',
      'room_asset',
      String(id),
      {
        changedFields: ['roomId', 'status', 'archivedReason'],
        purpose: 'Khôi phục tài sản vào danh mục đang sử dụng'
      }
    )]);
    await client.query('COMMIT');
    res.set('Cache-Control', 'no-store');
    return res.json({
      asset: assetJson({
        ...updated.rows[0],
        current_room_name: room.name,
        property_id: room.property_id
      })
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendRoomAssetError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

async function loadRoomAssetsExport(userId, query = db.query) {
  const rows = await roomAssetRows(userId, { status: 'all' }, query);
  return rows.map(assetJson);
}

module.exports = {
  ASSET_CONDITIONS,
  ASSET_STATUSES,
  RoomAssetError,
  archiveReason,
  archiveRoomAsset,
  assetCode,
  assetInput,
  assetJson,
  createRoomAsset,
  listRoomAssets,
  loadRoomAssetsExport,
  positiveId,
  restoreRoomAsset,
  roomAssetRows,
  sendRoomAssetError,
  updateRoomAsset
};
