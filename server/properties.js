'use strict';

const db = require('./db');
const { enforceStateWrite, sendEntitlementError } = require('./subscription');

const DEFAULT_PROPERTY_NAME = 'Khu trọ chính';
const MAX_PROPERTIES_PER_ACCOUNT = 100;

class PropertyError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'PropertyError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function propertyJson(row) {
  return {
    id: Number(row.id),
    name: row.name,
    address: row.address || '',
    note: row.note || '',
    isDefault: !!row.is_default,
    rentBankAccountId: row.rent_bank_account_id === null || row.rent_bank_account_id === undefined
      ? null
      : Number(row.rent_bank_account_id),
    roomCount: Math.max(0, Number(row.room_count) || 0),
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

function propertyInput(body = {}) {
  const name = String(body.name || '').trim();
  const address = String(body.address || '').trim();
  const note = String(body.note || '').trim();
  if (name.length < 1 || name.length > 200) {
    throw new PropertyError(400, 'INVALID_PROPERTY_NAME', 'Tên khu phải từ 1 đến 200 ký tự');
  }
  if (address.length > 1000) {
    throw new PropertyError(400, 'INVALID_PROPERTY_ADDRESS', 'Địa chỉ khu không được quá 1.000 ký tự');
  }
  if (note.length > 500) {
    throw new PropertyError(400, 'INVALID_PROPERTY_NOTE', 'Ghi chú khu không được quá 500 ký tự');
  }
  return { name, address, note };
}

function propertyId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new PropertyError(400, 'INVALID_PROPERTY_ID', 'ID khu không hợp lệ');
  }
  return id;
}

async function ensureDefaultProperty(userId, query = db.query) {
  await query(
    `INSERT INTO properties (user_id, name, is_default, sort_order)
     SELECT $1, $2, true, 0
     WHERE NOT EXISTS (SELECT 1 FROM properties WHERE user_id=$1)
     ON CONFLICT DO NOTHING`,
    [userId, DEFAULT_PROPERTY_NAME]
  );
  const result = await query(
    `SELECT * FROM properties
     WHERE user_id=$1
     ORDER BY is_default DESC, sort_order, id
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] || null;
}

async function propertyRows(userId, query = db.query) {
  await ensureDefaultProperty(userId, query);
  const result = await query(
    `SELECT property.*, COUNT(room.id)::int AS room_count
     FROM properties property
     LEFT JOIN rooms room
       ON room.user_id=property.user_id AND room.property_id=property.id
     WHERE property.user_id=$1
     GROUP BY property.id
     ORDER BY property.is_default DESC, property.sort_order, property.name, property.id`,
    [userId]
  );
  if (result.rows.length === 0) {
    throw new PropertyError(500, 'DEFAULT_PROPERTY_MISSING', 'Không khởi tạo được khu mặc định');
  }
  return result.rows;
}

async function enforcePropertyWrite(userId, query) {
  const countResult = await query(
    'SELECT COUNT(*)::int AS room_count FROM rooms WHERE user_id=$1',
    [userId]
  );
  await enforceStateWrite(
    userId,
    Math.max(0, Number(countResult.rows[0]?.room_count) || 0),
    query
  );
}

function sendPropertyError(res, error) {
  if (!(error instanceof PropertyError)) return false;
  res.status(error.statusCode).json({ error: error.message, code: error.code });
  return true;
}

async function listProperties(req, res, dependencies = {}) {
  const query = dependencies.query || db.query;
  if (req.workspace && !req.workspace.isOwner) {
    const propertyIds = Array.isArray(req.workspace.propertyIds) ? req.workspace.propertyIds : [];
    const result = await query(
      `SELECT property.*, COUNT(room.id)::int AS room_count
       FROM properties property
       LEFT JOIN rooms room
         ON room.user_id=property.user_id AND room.property_id=property.id
       WHERE property.user_id=$1 AND property.id=ANY($2::bigint[])
       GROUP BY property.id
       ORDER BY property.is_default DESC, property.sort_order, property.name, property.id`,
      [req.userId, propertyIds]
    );
    res.set('Cache-Control', 'no-store');
    return res.json({ properties: result.rows.map(propertyJson) });
  }
  res.set('Cache-Control', 'no-store');
  return res.json({ properties: (await propertyRows(req.userId, query)).map(propertyJson) });
}

async function createProperty(req, res, dependencies = {}) {
  let input;
  try {
    input = propertyInput(req.body);
  } catch (error) {
    if (sendPropertyError(res, error)) return res;
    throw error;
  }

  const getClient = dependencies.getClient || db.getClient;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(
         'state-write:' || $1::text, 0
       ))`,
      [req.userId]
    );
    await enforcePropertyWrite(req.userId, client.query.bind(client));
    await ensureDefaultProperty(req.userId, client.query.bind(client));
    const countResult = await client.query(
      'SELECT COUNT(*)::int AS property_count FROM properties WHERE user_id=$1',
      [req.userId]
    );
    if (Number(countResult.rows[0]?.property_count) >= MAX_PROPERTIES_PER_ACCOUNT) {
      throw new PropertyError(
        409,
        'PROPERTY_LIMIT_EXCEEDED',
        `Mỗi tài khoản được tạo tối đa ${MAX_PROPERTIES_PER_ACCOUNT} khu`
      );
    }
    const inserted = await client.query(
      `INSERT INTO properties (user_id, name, address, note, sort_order)
       VALUES (
         $1, $2, $3, $4,
         COALESCE((SELECT MAX(sort_order) + 1 FROM properties WHERE user_id=$1), 0)
       )
       RETURNING *`,
      [req.userId, input.name, input.address, input.note]
    );
    await client.query('COMMIT');
    res.status(201).json({ property: propertyJson(inserted.rows[0]) });
  } catch (error) {
    await client.query('ROLLBACK');
    if (sendEntitlementError(res, error) || sendPropertyError(res, error)) return res;
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'Tên khu đã tồn tại trong tài khoản',
        code: 'PROPERTY_NAME_EXISTS'
      });
    }
    throw error;
  } finally {
    client.release();
  }
}

async function updateProperty(req, res, dependencies = {}) {
  let id;
  let input;
  try {
    id = propertyId(req.params.id);
    input = propertyInput(req.body);
  } catch (error) {
    if (sendPropertyError(res, error)) return res;
    throw error;
  }

  const getClient = dependencies.getClient || db.getClient;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(
         'state-write:' || $1::text, 0
       ))`,
      [req.userId]
    );
    await enforcePropertyWrite(req.userId, client.query.bind(client));
    const updated = await client.query(
      `UPDATE properties
       SET name=$3, address=$4, note=$5, updated_at=now()
       WHERE user_id=$1 AND id=$2
       RETURNING *`,
      [req.userId, id, input.name, input.address, input.note]
    );
    if (!updated.rows[0]) {
      throw new PropertyError(404, 'PROPERTY_NOT_FOUND', 'Không tìm thấy khu');
    }
    const rooms = await client.query(
      'SELECT COUNT(*)::int AS room_count FROM rooms WHERE user_id=$1 AND property_id=$2',
      [req.userId, id]
    );
    await client.query('COMMIT');
    res.json({ property: propertyJson({ ...updated.rows[0], ...rooms.rows[0] }) });
  } catch (error) {
    await client.query('ROLLBACK');
    if (sendEntitlementError(res, error) || sendPropertyError(res, error)) return res;
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'Tên khu đã tồn tại trong tài khoản',
        code: 'PROPERTY_NAME_EXISTS'
      });
    }
    throw error;
  } finally {
    client.release();
  }
}

async function deleteProperty(req, res, dependencies = {}) {
  let id;
  try {
    id = propertyId(req.params.id);
  } catch (error) {
    if (sendPropertyError(res, error)) return res;
    throw error;
  }

  const getClient = dependencies.getClient || db.getClient;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(
         'state-write:' || $1::text, 0
       ))`,
      [req.userId]
    );
    await enforcePropertyWrite(req.userId, client.query.bind(client));
    const found = await client.query(
      `SELECT * FROM properties
       WHERE user_id=$1 AND id=$2
       FOR UPDATE`,
      [req.userId, id]
    );
    const property = found.rows[0];
    if (!property) throw new PropertyError(404, 'PROPERTY_NOT_FOUND', 'Không tìm thấy khu');
    if (property.is_default) {
      throw new PropertyError(409, 'DEFAULT_PROPERTY_REQUIRED', 'Không thể xóa khu mặc định');
    }
    const roomCountResult = await client.query(
      'SELECT COUNT(*)::int AS room_count FROM rooms WHERE user_id=$1 AND property_id=$2',
      [req.userId, id]
    );
    if (Number(roomCountResult.rows[0]?.room_count) > 0) {
      throw new PropertyError(
        409,
        'PROPERTY_HAS_ROOMS',
        'Hãy chuyển hết phòng sang khu khác trước khi xóa khu này'
      );
    }
    const expenseCountResult = await client.query(
      'SELECT COUNT(*)::int AS expense_count FROM expense_entries WHERE user_id=$1 AND property_id=$2',
      [req.userId, id]
    );
    if (Number(expenseCountResult.rows[0]?.expense_count) > 0) {
      throw new PropertyError(
        409,
        'PROPERTY_HAS_EXPENSES',
        'Hãy chuyển các khoản chi sang khu khác hoặc chi phí chung trước khi xóa khu này'
      );
    }
    await client.query('DELETE FROM properties WHERE user_id=$1 AND id=$2', [req.userId, id]);
    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (error) {
    await client.query('ROLLBACK');
    if (sendEntitlementError(res, error) || sendPropertyError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  DEFAULT_PROPERTY_NAME,
  MAX_PROPERTIES_PER_ACCOUNT,
  PropertyError,
  createProperty,
  deleteProperty,
  ensureDefaultProperty,
  listProperties,
  propertyId,
  propertyInput,
  propertyJson,
  propertyRows,
  updateProperty
};
