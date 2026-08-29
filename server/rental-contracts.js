'use strict';

const db = require('./db');
const subscription = require('./subscription');
const { recordDataAudit, requestAuditContext } = require('./data-audit');
const RentalContractCycle = require('../rental-contract-cycle');

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
  const billingCycleMonths = Number(body.billingCycleMonths ?? 1);
  if (!RentalContractCycle.ALLOWED_CYCLE_MONTHS.includes(billingCycleMonths)) {
    throw new RentalContractError(
      400,
      'INVALID_CONTRACT_BILLING_CYCLE',
      'Chu kỳ thanh toán phải là 1, 3, 6 hoặc 12 tháng'
    );
  }
  const paymentDueDay = Number(body.paymentDueDay ?? 5);
  if (!Number.isInteger(paymentDueDay) || paymentDueDay < 1 || paymentDueDay > 28) {
    throw new RentalContractError(
      400,
      'INVALID_CONTRACT_PAYMENT_DUE_DAY',
      'Ngày hạn thanh toán phải từ ngày 1 đến 28'
    );
  }
  const reservationId = body.reservationId === null
    || body.reservationId === undefined
    || body.reservationId === ''
    ? null
    : positiveId(body.reservationId, 'Lượt giữ chỗ');
  if (reservationId && status !== 'active') {
    throw new RentalContractError(
      400,
      'RESERVATION_REQUIRES_ACTIVE_CONTRACT',
      'Chuyển lượt giữ chỗ chỉ áp dụng khi tạo hợp đồng đang hoạt động'
    );
  }
  return {
    roomId,
    tenantId,
    startsOn,
    endsOn,
    billingCycleMonths,
    paymentDueDay,
    monthlyRentVnd: moneyVnd(body.monthlyRentVnd, 'Tiền thuê'),
    depositVnd: moneyVnd(body.depositVnd || 0, 'Tiền cọc'),
    terms,
    status,
    reservationId
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

function documentPurposeInput(body = {}) {
  const purpose = String(body.purpose || '').trim();
  if (purpose.length < 10 || purpose.length > 500) {
    throw new RentalContractError(
      400,
      'INVALID_CONTRACT_DOCUMENT_PURPOSE',
      'Lý do tạo bản hợp đồng phải từ 10 đến 500 ký tự'
    );
  }
  return purpose;
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
    billingCycleMonths: Number(row.billing_cycle_months) || 1,
    paymentDueDay: Number(row.payment_due_day) || 5,
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

function contractDocumentJson(row, amendments = []) {
  return {
    template: {
      id: 'HopDongThuePhongNew',
      version: '2026-08-16',
      source: 'document/HopDongThuePhongNew.docx'
    },
    contract: contractJson(row, amendments),
    tenant: {
      fullName: row.tenant_name_snapshot || '',
      phone: row.tenant_phone_snapshot || '',
      cccd: row.tenant_cccd_snapshot || '',
      issueDate: row.tenant_issue_date_snapshot || '',
      dob: row.tenant_dob_snapshot || '',
      gender: row.tenant_gender_snapshot || '',
      address: row.tenant_address_snapshot || ''
    }
  };
}

function contractCode(id, startsOn) {
  return `HD-${String(startsOn).slice(0, 4)}-${Number(id).toString(36).toUpperCase().padStart(6, '0')}`;
}

function amendmentCode(id, effectiveFrom) {
  return `PL-${String(effectiveFrom).replace('-', '')}-${Number(id).toString(36).toUpperCase().padStart(6, '0')}`;
}

function lifecycleEventCode(id, occurredOn) {
  return `VDT-${String(occurredOn).slice(0, 4)}-${Number(id).toString(36).toUpperCase().padStart(6, '0')}`;
}

async function convertReservation(query, userId, reservation, contract) {
  await query(
    `UPDATE rental_reservations
     SET status='converted', status_reason=$4, converted_contract_id=$3,
         converted_at=now(), updated_at=now()
     WHERE user_id=$1 AND id=$2`,
    [userId, Number(reservation.id), Number(contract.id), `Đã chuyển thành hợp đồng ${contract.contract_code}`]
  );
  const idResult = await query("SELECT nextval('rental_lifecycle_events_id_seq') AS id");
  const eventId = Number(idResult.rows[0].id);
  await query(
    `INSERT INTO rental_lifecycle_events
       (id, user_id, event_code, event_type, contract_id, reservation_id,
        tenant_id_snapshot, tenant_name_snapshot, target_room_id_snapshot,
        target_room_name_snapshot, occurred_on, reason, metadata)
     VALUES ($1,$2,$3,'reservation_converted',$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb)`,
    [
      eventId,
      userId,
      lifecycleEventCode(eventId, dateJson(contract.starts_on)),
      Number(contract.id),
      Number(reservation.id),
      contract.tenant_id,
      contract.tenant_name_snapshot,
      contract.room_id,
      contract.room_name_snapshot,
      dateJson(contract.starts_on),
      `Chuyển lượt giữ chỗ ${reservation.reservation_code} thành hợp đồng`,
      JSON.stringify({ reservationCode: reservation.reservation_code, contractCode: contract.contract_code })
    ]
  );
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
    `SELECT id, user_id, contract_code, room_id, room_name_snapshot,
            tenant_id, tenant_name_snapshot, status, starts_on, ends_on,
            billing_cycle_months, payment_due_day,
            monthly_rent_vnd, deposit_vnd, terms, status_reason,
            activated_at, ended_at, cancelled_at, created_at, updated_at
     FROM rental_contracts
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
              tenant.id AS tenant_id, tenant.full_name AS tenant_name,
              tenant.phone AS tenant_phone, tenant.cccd AS tenant_cccd,
              tenant.issue_date AS tenant_issue_date, tenant.dob AS tenant_dob,
              tenant.gender AS tenant_gender, tenant.address AS tenant_address
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
    await client.query(
      `UPDATE rental_reservations
       SET status='expired', expired_at=now(), updated_at=now(),
           status_reason='Tự động hết hạn theo ngày giữ chỗ'
       WHERE user_id=$1 AND room_id=$2 AND status='active' AND expires_on < CURRENT_DATE`,
      [req.userId, input.roomId]
    );
    const activeReservationResult = await client.query(
      `SELECT * FROM rental_reservations
       WHERE user_id=$1 AND room_id=$2 AND status='active'
       FOR UPDATE`,
      [req.userId, input.roomId]
    );
    const activeReservation = activeReservationResult.rows[0] || null;
    if (activeReservation && (
      input.status !== 'active' || Number(activeReservation.id) !== input.reservationId
    )) {
      throw new RentalContractError(
        409,
        'ACTIVE_RESERVATION_REQUIRES_CONVERSION',
        'Phòng đang được giữ chỗ; hãy chọn đúng lượt giữ chỗ khi tạo hợp đồng'
      );
    }
    if (input.reservationId && !activeReservation) {
      throw new RentalContractError(
        409,
        'RESERVATION_NOT_ACTIVE',
        'Lượt giữ chỗ không còn hoạt động hoặc không thuộc phòng này'
      );
    }
    const idResult = await client.query("SELECT nextval('rental_contracts_id_seq') AS id");
    const id = Number(idResult.rows[0].id);
    const code = contractCode(id, input.startsOn);
    const insert = await client.query(
      `INSERT INTO rental_contracts
         (id, user_id, contract_code, room_id, room_name_snapshot,
          tenant_id, tenant_name_snapshot, tenant_phone_snapshot,
          tenant_cccd_snapshot, tenant_issue_date_snapshot, tenant_dob_snapshot,
          tenant_gender_snapshot, tenant_address_snapshot,
          status, starts_on, ends_on, billing_cycle_months, payment_due_day,
          monthly_rent_vnd, deposit_vnd, terms, activated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,
               CASE WHEN $14='active' THEN now() ELSE NULL END)
       RETURNING *`,
      [
        id,
        req.userId,
        code,
        input.roomId,
        String(owner.rows[0].room_name || '').trim() || 'Phòng chưa đặt tên',
        input.tenantId,
        String(owner.rows[0].tenant_name || '').trim() || 'Khách chưa đặt tên',
        String(owner.rows[0].tenant_phone || '').trim(),
        String(owner.rows[0].tenant_cccd || '').trim(),
        String(owner.rows[0].tenant_issue_date || '').trim(),
        String(owner.rows[0].tenant_dob || '').trim(),
        String(owner.rows[0].tenant_gender || '').trim(),
        String(owner.rows[0].tenant_address || '').trim(),
        input.status,
        input.startsOn,
        input.endsOn,
        input.billingCycleMonths,
        input.paymentDueDay,
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
    if (activeReservation && input.status === 'active') {
      await convertReservation(
        client.query.bind(client),
        req.userId,
        activeReservation,
        insert.rows[0]
      );
    }
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

async function getContractDocument(req, res, dependencies = {}) {
  let contractId;
  let purpose;
  try {
    contractId = positiveId(req.params?.id, 'Hợp đồng');
    purpose = documentPurposeInput(req.body);
  } catch (error) {
    if (sendRentalContractError(res, error)) return res;
    throw error;
  }
  const query = dependencies.query || db.query;
  const contractResult = await query(
    `SELECT * FROM rental_contracts
     WHERE user_id=$1 AND id=$2`,
    [req.userId, contractId]
  );
  const contract = contractResult.rows[0];
  if (!contract) {
    return res.status(404).json({ error: 'Không tìm thấy hợp đồng', code: 'CONTRACT_NOT_FOUND' });
  }
  const amendments = await query(
    `SELECT * FROM rental_contract_amendments
     WHERE user_id=$1 AND contract_id=$2
     ORDER BY effective_from, id`,
    [req.userId, contractId]
  );
  await recordDataAudit(query, {
    actorUserId: req.userId,
    actorEmail: req.userEmail,
    subjectUserId: req.userId,
    action: 'rental_contract_document_export',
    resourceType: 'rental_contract',
    resourceId: String(contractId),
    changedFields: ['fullName', 'phone', 'cccd', 'issueDate', 'dob', 'gender', 'address'],
    purpose,
    ...requestAuditContext(req)
  });
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  return res.json({
    ...contractDocumentJson(contract, amendments.rows),
    audited: true
  });
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
    if (input.status === 'active') {
      await client.query(
        `UPDATE rental_reservations
         SET status='expired', expired_at=now(), updated_at=now(),
             status_reason='Tự động hết hạn theo ngày giữ chỗ'
         WHERE user_id=$1 AND room_id=$2 AND status='active' AND expires_on < CURRENT_DATE`,
        [req.userId, contract.room_id]
      );
      const reservation = await client.query(
        `SELECT id FROM rental_reservations
         WHERE user_id=$1 AND room_id=$2 AND status='active'
         LIMIT 1
         FOR UPDATE`,
        [req.userId, contract.room_id]
      );
      if (reservation.rows[0]) {
        throw new RentalContractError(
          409,
          'ACTIVE_RESERVATION_REQUIRES_CONVERSION',
          'Phòng đang được giữ chỗ; hãy hủy bản nháp và tạo hợp đồng từ lượt giữ chỗ'
        );
      }
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
  contractDocumentJson,
  contractInput,
  contractJson,
  createAmendment,
  createContract,
  documentPurposeInput,
  getContractDocument,
  listContracts,
  restoreContractRateMilestones,
  statusInput,
  syncRentRate
};
