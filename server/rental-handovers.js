'use strict';

const db = require('./db');
const subscription = require('./subscription');

const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;
const HANDOVER_TYPES = new Set(['check_in', 'check_out']);
const MAX_HANDOVER_ITEMS = 50;

class RentalHandoverError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'RentalHandoverError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function sendRentalHandoverError(res, error) {
  if (error instanceof RentalHandoverError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return true;
  }
  if (subscription.sendEntitlementError(res, error)) return true;
  return false;
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new RentalHandoverError(400, 'INVALID_HANDOVER_ID', `${label} không hợp lệ`);
  }
  return id;
}

function validDate(value, label) {
  const date = String(value || '').trim();
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!DATE_PATTERN.test(date)
      || Number.isNaN(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== date) {
    throw new RentalHandoverError(400, 'INVALID_HANDOVER_DATE', `${label} không hợp lệ`);
  }
  return date;
}

function optionalReading(value, label) {
  if (value === '' || value === null || value === undefined) return null;
  const reading = Number(value);
  if (!Number.isFinite(reading)
      || reading < 0
      || reading > 999999999999
      || Math.round(reading * 1000) / 1000 !== reading) {
    throw new RentalHandoverError(
      400,
      'INVALID_HANDOVER_READING',
      `${label} phải là số không âm, tối đa 3 chữ số thập phân`
    );
  }
  return reading;
}

function limitedText(value, label, { min = 0, max }) {
  const text = String(value || '').trim();
  if (text.length < min || text.length > max) {
    const range = min > 0 ? `từ ${min} đến ${max}` : `tối đa ${max}`;
    throw new RentalHandoverError(
      400,
      'INVALID_HANDOVER_TEXT',
      `${label} phải có ${range} ký tự`
    );
  }
  return text;
}

function itemInput(item = {}, index = 0) {
  const quantity = Number(item.quantity);
  if (!Number.isFinite(quantity)
      || quantity <= 0
      || quantity > 99999999
      || Math.round(quantity * 100) / 100 !== quantity) {
    throw new RentalHandoverError(
      400,
      'INVALID_HANDOVER_ITEM_QUANTITY',
      `Số lượng tài sản dòng ${index + 1} không hợp lệ`
    );
  }
  return {
    name: limitedText(item.name, `Tên tài sản dòng ${index + 1}`, { min: 1, max: 200 }),
    quantity,
    unit: limitedText(item.unit || 'cái', `Đơn vị dòng ${index + 1}`, { min: 1, max: 50 }),
    condition: limitedText(item.condition, `Tình trạng dòng ${index + 1}`, { min: 1, max: 500 }),
    note: limitedText(item.note, `Ghi chú dòng ${index + 1}`, { max: 500 })
  };
}

function handoverInput(body = {}) {
  const handoverType = String(body.handoverType || '').trim().toLowerCase();
  if (!HANDOVER_TYPES.has(handoverType)) {
    throw new RentalHandoverError(
      400,
      'INVALID_HANDOVER_TYPE',
      'Loại biên bản bàn giao không hợp lệ'
    );
  }
  const items = Array.isArray(body.items) ? body.items : [];
  if (items.length < 1 || items.length > MAX_HANDOVER_ITEMS) {
    throw new RentalHandoverError(
      400,
      'INVALID_HANDOVER_ITEMS',
      `Biên bản phải có từ 1 đến ${MAX_HANDOVER_ITEMS} tài sản`
    );
  }
  const keyCount = Number(body.keyCount ?? 0);
  if (!Number.isInteger(keyCount) || keyCount < 0 || keyCount > 1000) {
    throw new RentalHandoverError(400, 'INVALID_HANDOVER_KEY_COUNT', 'Số chìa khóa không hợp lệ');
  }
  return {
    handoverType,
    occurredOn: validDate(body.occurredOn, 'Ngày bàn giao'),
    lessorName: limitedText(body.lessorName, 'Họ tên bên cho thuê', { min: 1, max: 200 }),
    propertyAddress: limitedText(body.propertyAddress, 'Địa chỉ nhà cho thuê', { min: 1, max: 1000 }),
    electricityReading: optionalReading(body.electricityReading, 'Chỉ số điện'),
    waterReading: optionalReading(body.waterReading, 'Chỉ số nước'),
    keyCount,
    generalCondition: limitedText(body.generalCondition, 'Tình trạng chung', { min: 3, max: 2000 }),
    notes: limitedText(body.notes, 'Ghi chú', { max: 3000 }),
    items: items.map(itemInput)
  };
}

function dateJson(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function itemJson(row) {
  return {
    id: Number(row.id),
    order: Number(row.item_order),
    name: row.item_name,
    quantity: Number(row.quantity),
    unit: row.unit,
    condition: row.item_condition,
    note: row.note || ''
  };
}

function handoverJson(row, items = []) {
  return {
    id: Number(row.id),
    code: row.handover_code,
    contractId: Number(row.contract_id),
    contractCode: row.contract_code_snapshot,
    handoverType: row.handover_type,
    occurredOn: dateJson(row.occurred_on),
    roomId: row.room_id_snapshot,
    roomName: row.room_name_snapshot,
    tenantId: row.tenant_id_snapshot,
    tenantName: row.tenant_name_snapshot,
    lessorName: row.lessor_name_snapshot,
    propertyAddress: row.property_address_snapshot,
    depositAccountId: row.deposit_account_id === null || row.deposit_account_id === undefined
      ? null
      : Number(row.deposit_account_id),
    expectedDepositVnd: Number(row.expected_deposit_vnd) || 0,
    depositBalanceSnapshotVnd: Number(row.deposit_balance_snapshot_vnd) || 0,
    electricityReading: row.electricity_reading === null ? null : Number(row.electricity_reading),
    waterReading: row.water_reading === null ? null : Number(row.water_reading),
    keyCount: Number(row.key_count) || 0,
    generalCondition: row.general_condition,
    notes: row.notes || '',
    confirmedAt: row.confirmed_at,
    createdAt: row.created_at,
    items: items.map(itemJson)
  };
}

function handoverCode(id, handoverType, occurredOn) {
  const type = handoverType === 'check_out' ? 'OUT' : 'IN';
  return `BBBG-${String(occurredOn).slice(0, 4)}-${type}-${Number(id).toString(36).toUpperCase().padStart(6, '0')}`;
}

async function ensureWritable(query, userId, dependencies = {}) {
  if (dependencies.enforceWrite) return dependencies.enforceWrite(userId, query);
  const { rows } = await query('SELECT COUNT(*)::int AS room_count FROM rooms WHERE user_id=$1', [userId]);
  return subscription.enforceStateWrite(userId, Number(rows[0]?.room_count) || 0, query);
}

async function listRentalHandovers(req, res, dependencies = {}) {
  let contractId;
  try {
    contractId = positiveId(req.params?.id, 'Hợp đồng');
  } catch (error) {
    if (sendRentalHandoverError(res, error)) return res;
    throw error;
  }
  const query = dependencies.query || db.query;
  const owner = await query(
    'SELECT id FROM rental_contracts WHERE user_id=$1 AND id=$2',
    [req.userId, contractId]
  );
  if (!owner.rows[0]) {
    return res.status(404).json({ error: 'Không tìm thấy hợp đồng', code: 'CONTRACT_NOT_FOUND' });
  }
  const records = await query(
    `SELECT * FROM rental_handover_records
     WHERE user_id=$1 AND contract_id=$2
     ORDER BY occurred_on, id`,
    [req.userId, contractId]
  );
  const ids = records.rows.map((row) => Number(row.id));
  const itemRows = ids.length === 0
    ? []
    : (await query(
      `SELECT * FROM rental_handover_items
       WHERE user_id=$1 AND handover_id=ANY($2::bigint[])
       ORDER BY handover_id, item_order, id`,
      [req.userId, ids]
    )).rows;
  const byHandover = new Map();
  for (const row of itemRows) {
    const id = Number(row.handover_id);
    if (!byHandover.has(id)) byHandover.set(id, []);
    byHandover.get(id).push(row);
  }
  res.set('Cache-Control', 'no-store');
  return res.json({
    handovers: records.rows.map((row) => handoverJson(row, byHandover.get(Number(row.id)) || []))
  });
}

async function createRentalHandover(req, res, dependencies = {}) {
  let contractId;
  let input;
  try {
    contractId = positiveId(req.params?.id, 'Hợp đồng');
    input = handoverInput(req.body);
  } catch (error) {
    if (sendRentalHandoverError(res, error)) return res;
    throw error;
  }
  const getClient = dependencies.getClient || db.getClient;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await ensureWritable(client.query.bind(client), req.userId, dependencies);
    const contractResult = await client.query(
      'SELECT * FROM rental_contracts WHERE user_id=$1 AND id=$2 FOR UPDATE',
      [req.userId, contractId]
    );
    const contract = contractResult.rows[0];
    if (!contract) {
      throw new RentalHandoverError(404, 'CONTRACT_NOT_FOUND', 'Không tìm thấy hợp đồng');
    }
    if (contract.status === 'cancelled') {
      throw new RentalHandoverError(
        409,
        'CANCELLED_CONTRACT_HANDOVER_FORBIDDEN',
        'Không thể lập biên bản cho hợp đồng đã hủy'
      );
    }
    const startsOn = dateJson(contract.starts_on);
    const endsOn = dateJson(contract.ends_on);
    if (input.occurredOn < startsOn
        || (input.handoverType === 'check_in' && endsOn && input.occurredOn > endsOn)) {
      throw new RentalHandoverError(
        400,
        'HANDOVER_OUTSIDE_CONTRACT',
        'Ngày bàn giao không phù hợp với thời hạn hợp đồng'
      );
    }

    const depositResult = await client.query(
      `SELECT account.id,
              COALESCE(SUM(transaction.amount_vnd), 0) AS balance_vnd
       FROM tenant_deposit_accounts account
       LEFT JOIN tenant_deposit_transactions transaction
         ON transaction.user_id=account.user_id AND transaction.account_id=account.id
       WHERE account.user_id=$1 AND account.tenant_id=$2
       GROUP BY account.id`,
      [req.userId, contract.tenant_id]
    );
    const deposit = depositResult.rows[0] || null;
    const idResult = await client.query("SELECT nextval('rental_handover_records_id_seq') AS id");
    const id = Number(idResult.rows[0].id);
    const inserted = await client.query(
      `INSERT INTO rental_handover_records
         (id, user_id, contract_id, handover_code, handover_type, occurred_on,
          contract_code_snapshot, room_id_snapshot, room_name_snapshot,
          tenant_id_snapshot, tenant_name_snapshot, lessor_name_snapshot,
          property_address_snapshot, deposit_account_id,
          expected_deposit_vnd, deposit_balance_snapshot_vnd,
          electricity_reading, water_reading, key_count, general_condition, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       RETURNING *`,
      [
        id,
        req.userId,
        contractId,
        handoverCode(id, input.handoverType, input.occurredOn),
        input.handoverType,
        input.occurredOn,
        contract.contract_code,
        contract.room_id,
        contract.room_name_snapshot,
        contract.tenant_id,
        contract.tenant_name_snapshot,
        input.lessorName,
        input.propertyAddress,
        deposit?.id || null,
        Number(contract.deposit_vnd) || 0,
        Number(deposit?.balance_vnd) || 0,
        input.electricityReading,
        input.waterReading,
        input.keyCount,
        input.generalCondition,
        input.notes
      ]
    );
    const itemRows = [];
    for (let index = 0; index < input.items.length; index += 1) {
      const item = input.items[index];
      const result = await client.query(
        `INSERT INTO rental_handover_items
           (user_id, handover_id, item_order, item_name, quantity, unit,
            item_condition, note)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         RETURNING *`,
        [
          req.userId,
          id,
          index + 1,
          item.name,
          item.quantity,
          item.unit,
          item.condition,
          item.note
        ]
      );
      itemRows.push(result.rows[0]);
    }
    await client.query('COMMIT');
    return res.status(201).json({ handover: handoverJson(inserted.rows[0], itemRows) });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendRentalHandoverError(res, error)) return res;
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'Hợp đồng đã có biên bản cùng loại',
        code: 'HANDOVER_ALREADY_EXISTS'
      });
    }
    throw error;
  } finally {
    client.release();
  }
}

async function loadRentalHandoverExport(userId) {
  const [records, items] = await Promise.all([
    db.query(
      'SELECT * FROM rental_handover_records WHERE user_id=$1 ORDER BY id',
      [userId]
    ),
    db.query(
      'SELECT * FROM rental_handover_items WHERE user_id=$1 ORDER BY handover_id, item_order, id',
      [userId]
    )
  ]);
  const byHandover = new Map();
  for (const row of items.rows) {
    const id = Number(row.handover_id);
    if (!byHandover.has(id)) byHandover.set(id, []);
    byHandover.get(id).push(row);
  }
  return records.rows.map((row) => handoverJson(row, byHandover.get(Number(row.id)) || []));
}

module.exports = {
  HANDOVER_TYPES,
  MAX_HANDOVER_ITEMS,
  RentalHandoverError,
  createRentalHandover,
  handoverCode,
  handoverInput,
  handoverJson,
  itemInput,
  listRentalHandovers,
  loadRentalHandoverExport,
  optionalReading
};
