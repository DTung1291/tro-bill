'use strict';

const db = require('./db');
const subscription = require('./subscription');

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-([0-2]\d|3[01])$/;
const CONTRACT_STATUSES = new Set(['draft', 'active']);
const STATUS_TRANSITIONS = {
  draft: new Set(['active', 'cancelled']),
  active: new Set(['ended', 'cancelled']),
  ended: new Set(),
  cancelled: new Set()
};

class RentalContractError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'RentalContractError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function sendRentalContractError(res, error) {
  if (error instanceof RentalContractError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return true;
  }
  if (subscription.sendEntitlementError(res, error)) return true;
  return false;
}

function cleanIdentifier(value, label) {
  const id = String(value || '').trim();
  if (!id || id.length > 200) {
    throw new RentalContractError(400, 'INVALID_CONTRACT_REFERENCE', `${label} không hợp lệ`);
  }
  return id;
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new RentalContractError(400, 'INVALID_CONTRACT_ID', `${label} không hợp lệ`);
  }
  return id;
}

function moneyVnd(value, label) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 999999999999) {
    throw new RentalContractError(400, 'INVALID_CONTRACT_AMOUNT', `${label} không hợp lệ`);
  }
  return amount;
}

function validDate(value, label, { optional = false } = {}) {
  const date = String(value || '').trim();
  if (optional && !date) return null;
  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (!DATE_PATTERN.test(date)
      || Number.isNaN(parsed.getTime())
      || parsed.toISOString().slice(0, 10) !== date) {
    throw new RentalContractError(400, 'INVALID_CONTRACT_DATE', `${label} không hợp lệ`);
  }
  return date;
}

function contractInput(body = {}) {
  const roomId = cleanIdentifier(body.roomId, 'Phòng');
  const tenantId = cleanIdentifier(body.tenantId, 'Khách thuê');
  const startsOn = validDate(body.startsOn, 'Ngày bắt đầu');
  const endsOn = validDate(body.endsOn, 'Ngày kết thúc', { optional: true });
  if (endsOn && endsOn < startsOn) {
    throw new RentalContractError(
      400,
      'INVALID_CONTRACT_DATE_RANGE',
      'Ngày kết thúc không được trước ngày bắt đầu'
    );
  }
  const status = String(body.status || 'active').trim().toLowerCase();
  if (!CONTRACT_STATUSES.has(status)) {
    throw new RentalContractError(400, 'INVALID_CONTRACT_STATUS', 'Trạng thái hợp đồng không hợp lệ');
  }
  const terms = String(body.terms || '').trim();
  if (terms.length > 5000) {
    throw new RentalContractError(400, 'INVALID_CONTRACT_TERMS', 'Điều khoản tối đa 5.000 ký tự');
  }
  return {
    roomId,
    tenantId,
    startsOn,
    endsOn,
    monthlyRentVnd: moneyVnd(body.monthlyRentVnd, 'Tiền thuê'),
    depositVnd: moneyVnd(body.depositVnd || 0, 'Tiền cọc'),
    terms,
    status
  };
}

function amendmentInput(body = {}) {
  const effectiveFrom = String(body.effectiveFrom || '').trim();
  if (!PERIOD_PATTERN.test(effectiveFrom)) {
    throw new RentalContractError(
      400,
      'INVALID_AMENDMENT_PERIOD',
      'Tháng áp dụng phụ lục không hợp lệ'
    );
  }
  const reason = String(body.reason || '').trim();
  if (reason.length < 10 || reason.length > 500) {
    throw new RentalContractError(
      400,
      'INVALID_AMENDMENT_REASON',
      'Lý do phụ lục phải từ 10 đến 500 ký tự'
    );
  }
  return {
    effectiveFrom,
    newMonthlyRentVnd: moneyVnd(body.newMonthlyRentVnd, 'Tiền thuê mới'),
    reason
  };
}

function statusInput(body = {}) {
  const status = String(body.status || '').trim().toLowerCase();
  if (!['active', 'ended', 'cancelled'].includes(status)) {
    throw new RentalContractError(400, 'INVALID_CONTRACT_STATUS', 'Trạng thái hợp đồng không hợp lệ');
  }
  const reason = String(body.reason || '').trim();
  if (reason.length > 500 || (['ended', 'cancelled'].includes(status) && reason.length < 10)) {
    throw new RentalContractError(
      400,
      'INVALID_CONTRACT_STATUS_REASON',
      'Kết thúc hoặc hủy hợp đồng phải có lý do từ 10 đến 500 ký tự'
    );
  }
  return { status, reason };
}

function dateJson(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function amendmentJson(row) {
  return {
    id: Number(row.id),
    code: row.amendment_code,
    contractId: Number(row.contract_id),
    effectiveFrom: row.effective_from,
    previousMonthlyRentVnd: Number(row.previous_monthly_rent_vnd) || 0,
    newMonthlyRentVnd: Number(row.new_monthly_rent_vnd) || 0,
    reason: row.reason,
    createdAt: row.created_at
  };
}

function contractJson(row, amendments = []) {
  const normalizedAmendments = amendments.map(amendmentJson);
  const latest = normalizedAmendments[normalizedAmendments.length - 1];
  return {
    id: Number(row.id),
    code: row.contract_code,
    roomId: row.room_id,
    roomName: row.room_name_snapshot,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name_snapshot,
    status: row.status,
    startsOn: dateJson(row.starts_on),
    endsOn: dateJson(row.ends_on),
    monthlyRentVnd: Number(row.monthly_rent_vnd) || 0,
    currentMonthlyRentVnd: latest
      ? latest.newMonthlyRentVnd
      : (Number(row.monthly_rent_vnd) || 0),
    depositVnd: Number(row.deposit_vnd) || 0,
    terms: row.terms || '',
    statusReason: row.status_reason || '',
    activatedAt: row.activated_at || null,
    endedAt: row.ended_at || null,
    cancelledAt: row.cancelled_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    amendments: normalizedAmendments
  };
}

function contractCode(id, startsOn) {
  return `HD-${String(startsOn).slice(0, 4)}-${Number(id).toString(36).toUpperCase().padStart(6, '0')}`;
}

function amendmentCode(id, effectiveFrom) {
  return `PL-${String(effectiveFrom).replace('-', '')}-${Number(id).toString(36).toUpperCase().padStart(6, '0')}`;
}

async function ensureWritable(query, userId, dependencies = {}) {
  if (dependencies.enforceWrite) return dependencies.enforceWrite(userId, query);
  const { rows } = await query('SELECT COUNT(*)::int AS room_count FROM rooms WHERE user_id=$1', [userId]);
  return subscription.enforceStateWrite(
    userId,
    Number(rows[0]?.room_count) || 0,
    query
  );
}

async function syncRentRate(query, userId, roomId, effectiveFrom, rentVnd, options = {}) {
  const { rows: rateRows } = await query(
    `SELECT rent_price, electric_rate, water_rate, trash_fee, wifi_fee, manage_fee
     FROM room_rate_history
     WHERE user_id=$1 AND room_id=$2 AND effective_from <= $3
     ORDER BY effective_from DESC
     LIMIT 1`,
    [userId, roomId, effectiveFrom]
  );
  let base = rateRows[0];
  if (!base) {
    const fallback = await query(
      `SELECT rent_price, electric_rate, water_rate, trash_fee, wifi_fee, manage_fee
       FROM rooms WHERE user_id=$1 AND id=$2`,
      [userId, roomId]
    );
    base = fallback.rows[0];
  }
  if (!base) {
    throw new RentalContractError(404, 'CONTRACT_ROOM_NOT_FOUND', 'Phòng không còn tồn tại');
  }
  const rateResult = await query(
    `INSERT INTO room_rate_history
       (user_id, room_id, effective_from, rent_price, electric_rate, water_rate,
        trash_fee, wifi_fee, manage_fee)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     ON CONFLICT (user_id, room_id, effective_from) DO UPDATE SET rent_price=EXCLUDED.rent_price
     RETURNING *`,
    [
      userId,
      roomId,
      effectiveFrom,
      rentVnd,
      Number(base.electric_rate) || 0,
      Number(base.water_rate) || 0,
      Number(base.trash_fee) || 0,
      Number(base.wifi_fee) || 0,
      Number(base.manage_fee) || 0
    ]
  );
  await query(
    `UPDATE rooms
     SET rent_price=CASE WHEN NOT EXISTS (
           SELECT 1 FROM room_rate_history future
           WHERE future.user_id=$1 AND future.room_id=$2 AND future.effective_from>$3
         ) THEN $4 ELSE rent_price END,
         rent_start_date=CASE WHEN $5<>'' THEN $5 ELSE rent_start_date END
     WHERE user_id=$1 AND id=$2`,
    [userId, roomId, effectiveFrom, rentVnd, options.rentStartDate || '']
  );
  const row = rateResult.rows[0];
  return {
    roomId: row.room_id,
    effectiveFrom: row.effective_from,
    rentPrice: Number(row.rent_price) || 0,
    electricRate: Number(row.electric_rate) || 0,
    waterRate: Number(row.water_rate) || 0,
    trashFee: Number(row.trash_fee) || 0,
    wifiFee: Number(row.wifi_fee) || 0,
    manageFee: Number(row.manage_fee) || 0,
    rentStartDate: options.rentStartDate || null
  };
}

async function restoreContractRateMilestones(query, userId) {
  const { rows } = await query(
    `SELECT event.contract_id, event.room_id, event.effective_from,
            event.rent_vnd, event.rent_start_date
     FROM (
       SELECT contract.id AS contract_id,
              contract.room_id,
              to_char(contract.starts_on, 'YYYY-MM') AS effective_from,
              contract.monthly_rent_vnd AS rent_vnd,
              CASE WHEN contract.status='active'
                THEN to_char(contract.starts_on, 'YYYY-MM-DD')
                ELSE NULL
              END AS rent_start_date,
              0 AS event_order,
              contract.id AS event_id
       FROM rental_contracts contract
       WHERE contract.user_id=$1 AND contract.activated_at IS NOT NULL

       UNION ALL

       SELECT amendment.contract_id,
              contract.room_id,
              amendment.effective_from,
              amendment.new_monthly_rent_vnd AS rent_vnd,
              NULL AS rent_start_date,
              1 AS event_order,
              amendment.id AS event_id
       FROM rental_contract_amendments amendment
       JOIN rental_contracts contract
         ON contract.user_id=amendment.user_id AND contract.id=amendment.contract_id
       WHERE amendment.user_id=$1 AND contract.activated_at IS NOT NULL
     ) event
     WHERE EXISTS (
       SELECT 1 FROM rooms room
       WHERE room.user_id=$1 AND room.id=event.room_id
     )
     ORDER BY event.effective_from, event.contract_id, event.event_order, event.event_id`,
    [userId]
  );
  const restored = [];
  for (const row of rows) {
    restored.push(await syncRentRate(
      query,
      userId,
      row.room_id,
      row.effective_from,
      Number(row.rent_vnd),
      { rentStartDate: row.rent_start_date || '' }
    ));
  }
  return restored;
}

async function listContracts(req, res, dependencies = {}) {
  const query = dependencies.query || db.query;
  let roomId = null;
  try {
    if (req.query?.roomId) roomId = cleanIdentifier(req.query.roomId, 'Phòng');
  } catch (error) {
    if (sendRentalContractError(res, error)) return res;
    throw error;
  }
  const contractResult = await query(
    `SELECT * FROM rental_contracts
     WHERE user_id=$1 AND ($2::text IS NULL OR room_id=$2)
     ORDER BY starts_on DESC, id DESC`,
    [req.userId, roomId]
  );
  const ids = contractResult.rows.map((row) => Number(row.id));
  const amendmentResult = ids.length === 0
    ? { rows: [] }
    : await query(
      `SELECT * FROM rental_contract_amendments
       WHERE user_id=$1 AND contract_id=ANY($2::bigint[])
       ORDER BY effective_from, id`,
      [req.userId, ids]
    );
  const byContract = new Map();
  for (const row of amendmentResult.rows) {
    const id = Number(row.contract_id);
    if (!byContract.has(id)) byContract.set(id, []);
    byContract.get(id).push(row);
  }
  res.set('Cache-Control', 'no-store');
  return res.json({
    contracts: contractResult.rows.map((row) => contractJson(row, byContract.get(Number(row.id)) || []))
  });
}

async function createContract(req, res, dependencies = {}) {
  let input;
  try {
    input = contractInput(req.body);
  } catch (error) {
    if (sendRentalContractError(res, error)) return res;
    throw error;
  }
  const getClient = dependencies.getClient || db.getClient;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await ensureWritable(client.query.bind(client), req.userId, dependencies);
    const owner = await client.query(
      `SELECT room.id AS room_id, room.name AS room_name,
              tenant.id AS tenant_id, tenant.full_name AS tenant_name
       FROM rooms room
       JOIN tenants tenant
         ON tenant.user_id=room.user_id AND tenant.room_id=room.id AND tenant.id=$3
       WHERE room.user_id=$1 AND room.id=$2
       FOR UPDATE OF room, tenant`,
      [req.userId, input.roomId, input.tenantId]
    );
    if (!owner.rows[0]) {
      throw new RentalContractError(
        404,
        'CONTRACT_TENANCY_NOT_FOUND',
        'Không tìm thấy khách thuê thuộc phòng này'
      );
    }
    const idResult = await client.query("SELECT nextval('rental_contracts_id_seq') AS id");
    const id = Number(idResult.rows[0].id);
    const code = contractCode(id, input.startsOn);
    const insert = await client.query(
      `INSERT INTO rental_contracts
         (id, user_id, contract_code, room_id, room_name_snapshot,
          tenant_id, tenant_name_snapshot, status, starts_on, ends_on,
          monthly_rent_vnd, deposit_vnd, terms, activated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,
               CASE WHEN $8='active' THEN now() ELSE NULL END)
       RETURNING *`,
      [
        id,
        req.userId,
        code,
        input.roomId,
        String(owner.rows[0].room_name || '').trim() || 'Phòng chưa đặt tên',
        input.tenantId,
        String(owner.rows[0].tenant_name || '').trim() || 'Khách chưa đặt tên',
        input.status,
        input.startsOn,
        input.endsOn,
        input.monthlyRentVnd,
        input.depositVnd,
        input.terms
      ]
    );
    const rate = input.status === 'active'
      ? await syncRentRate(
        client.query.bind(client),
        req.userId,
        input.roomId,
        input.startsOn.slice(0, 7),
        input.monthlyRentVnd,
        { rentStartDate: input.startsOn }
      )
      : null;
    await client.query('COMMIT');
    return res.status(201).json({ contract: contractJson(insert.rows[0]), rate });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendRentalContractError(res, error)) return res;
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'Phòng đã có hợp đồng đang hoạt động hoặc mã hợp đồng bị trùng',
        code: 'ACTIVE_CONTRACT_EXISTS'
      });
    }
    throw error;
  } finally {
    client.release();
  }
}

async function changeContractStatus(req, res, dependencies = {}) {
  let contractId;
  let input;
  try {
    contractId = positiveId(req.params?.id, 'Hợp đồng');
    input = statusInput(req.body);
  } catch (error) {
    if (sendRentalContractError(res, error)) return res;
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
    if (!contract) {
      throw new RentalContractError(404, 'CONTRACT_NOT_FOUND', 'Không tìm thấy hợp đồng');
    }
    if (!STATUS_TRANSITIONS[contract.status]?.has(input.status)) {
      throw new RentalContractError(
        409,
        'CONTRACT_STATUS_TRANSITION_INVALID',
        'Không thể chuyển hợp đồng sang trạng thái đã chọn'
      );
    }
    const updated = await client.query(
      `UPDATE rental_contracts
       SET status=$3, status_reason=$4,
           activated_at=CASE WHEN $3='active' THEN COALESCE(activated_at, now()) ELSE activated_at END,
           ended_at=CASE WHEN $3='ended' THEN now() ELSE NULL END,
           cancelled_at=CASE WHEN $3='cancelled' THEN now() ELSE NULL END,
           updated_at=now()
       WHERE user_id=$1 AND id=$2
       RETURNING *`,
      [req.userId, contractId, input.status, input.reason]
    );
    const rate = input.status === 'active'
      ? await syncRentRate(
        client.query.bind(client),
        req.userId,
        contract.room_id,
        dateJson(contract.starts_on).slice(0, 7),
        Number(contract.monthly_rent_vnd),
        { rentStartDate: dateJson(contract.starts_on) }
      )
      : null;
    await client.query('COMMIT');
    return res.json({ contract: contractJson(updated.rows[0]), rate });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendRentalContractError(res, error)) return res;
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Phòng đã có hợp đồng đang hoạt động', code: 'ACTIVE_CONTRACT_EXISTS' });
    }
    throw error;
  } finally {
    client.release();
  }
}

async function createAmendment(req, res, dependencies = {}) {
  let contractId;
  let input;
  try {
    contractId = positiveId(req.params?.id, 'Hợp đồng');
    input = amendmentInput(req.body);
  } catch (error) {
    if (sendRentalContractError(res, error)) return res;
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
    if (!contract) {
      throw new RentalContractError(404, 'CONTRACT_NOT_FOUND', 'Không tìm thấy hợp đồng');
    }
    if (contract.status !== 'active') {
      throw new RentalContractError(
        409,
        'CONTRACT_NOT_ACTIVE',
        'Chỉ hợp đồng đang hoạt động mới được tạo phụ lục giá'
      );
    }
    const startsPeriod = dateJson(contract.starts_on).slice(0, 7);
    const endsPeriod = dateJson(contract.ends_on)?.slice(0, 7) || null;
    if (input.effectiveFrom < startsPeriod || (endsPeriod && input.effectiveFrom > endsPeriod)) {
      throw new RentalContractError(
        400,
        'AMENDMENT_OUTSIDE_CONTRACT',
        'Tháng áp dụng phụ lục phải nằm trong thời hạn hợp đồng'
      );
    }
    const previous = await client.query(
      `SELECT effective_from, new_monthly_rent_vnd
       FROM rental_contract_amendments
       WHERE user_id=$1 AND contract_id=$2
       ORDER BY effective_from DESC, id DESC
       LIMIT 1`,
      [req.userId, contractId]
    );
    if (previous.rows[0] && input.effectiveFrom <= previous.rows[0].effective_from) {
      throw new RentalContractError(
        409,
        'AMENDMENT_PERIOD_NOT_AFTER_LATEST',
        'Phụ lục mới phải áp dụng sau phụ lục gần nhất để giữ nguyên lịch sử đã phát hành'
      );
    }
    const previousRent = previous.rows[0]
      ? Number(previous.rows[0].new_monthly_rent_vnd)
      : Number(contract.monthly_rent_vnd);
    if (previousRent === input.newMonthlyRentVnd) {
      throw new RentalContractError(
        409,
        'AMENDMENT_RENT_UNCHANGED',
        'Giá thuê mới phải khác giá đang áp dụng'
      );
    }
    const idResult = await client.query("SELECT nextval('rental_contract_amendments_id_seq') AS id");
    const id = Number(idResult.rows[0].id);
    const insert = await client.query(
      `INSERT INTO rental_contract_amendments
         (id, user_id, contract_id, amendment_code, effective_from,
          previous_monthly_rent_vnd, new_monthly_rent_vnd, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING *`,
      [
        id,
        req.userId,
        contractId,
        amendmentCode(id, input.effectiveFrom),
        input.effectiveFrom,
        previousRent,
        input.newMonthlyRentVnd,
        input.reason
      ]
    );
    const rate = await syncRentRate(
      client.query.bind(client),
      req.userId,
      contract.room_id,
      input.effectiveFrom,
      input.newMonthlyRentVnd
    );
    await client.query('COMMIT');
    return res.status(201).json({ amendment: amendmentJson(insert.rows[0]), rate });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendRentalContractError(res, error)) return res;
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'Tháng này đã có phụ lục giá; phụ lục đã phát hành không được ghi đè',
        code: 'AMENDMENT_PERIOD_EXISTS'
      });
    }
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  RentalContractError,
  amendmentCode,
  amendmentInput,
  changeContractStatus,
  contractCode,
  contractInput,
  contractJson,
  createAmendment,
  createContract,
  listContracts,
  restoreContractRateMilestones,
  statusInput,
  syncRentRate
};
