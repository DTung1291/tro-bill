'use strict';

const crypto = require('crypto');
const db = require('./db');
const subscription = require('./subscription');
const { publicBaseUrl } = require('./rent-invoice-links');
const { checkAuthRateLimit, recordAuthAttempt } = require('./rate-limit');
const {
  recordDataAudits,
  requestAuditContext,
  requestDataAuditEntry
} = require('./data-audit');

const PORTAL_TOKEN_PATTERN = /^tmrq_[A-Za-z0-9_-]{43}$/;
const IDEMPOTENCY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_PORTAL_DAYS = 365;
const REQUEST_CATEGORIES = Object.freeze([
  'electricity', 'water', 'appliance', 'structure', 'security', 'other'
]);
const REQUEST_URGENCIES = Object.freeze(['low', 'normal', 'high', 'emergency']);
const REQUEST_STATUSES = Object.freeze([
  'new', 'acknowledged', 'in_progress', 'resolved', 'cancelled'
]);
const STATUS_TRANSITIONS = Object.freeze({
  new: Object.freeze(['acknowledged', 'in_progress', 'cancelled']),
  acknowledged: Object.freeze(['in_progress', 'cancelled']),
  in_progress: Object.freeze(['resolved', 'cancelled']),
  resolved: Object.freeze([]),
  cancelled: Object.freeze([])
});

class TenantMaintenanceError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'TenantMaintenanceError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function sendMaintenanceRequestError(res, error) {
  if (error instanceof TenantMaintenanceError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return true;
  }
  if (subscription.sendEntitlementError(res, error)) return true;
  return false;
}

function positiveId(value, label = 'Hợp đồng') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new TenantMaintenanceError(400, 'INVALID_MAINTENANCE_REFERENCE', `${label} không hợp lệ`);
  }
  return id;
}

function simpleText(value, label, { min = 0, max }) {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (text.length < min || text.length > max) {
    const range = min > 0 ? `từ ${min} đến ${max}` : `tối đa ${max}`;
    throw new TenantMaintenanceError(
      400,
      'INVALID_MAINTENANCE_REQUEST_TEXT',
      `${label} phải có ${range} ký tự`
    );
  }
  return text;
}

function descriptionText(value) {
  const text = String(value || '')
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (text.length < 10 || text.length > 2000) {
    throw new TenantMaintenanceError(
      400,
      'INVALID_MAINTENANCE_REQUEST_DESCRIPTION',
      'Mô tả sự cố phải có từ 10 đến 2000 ký tự'
    );
  }
  return text;
}

function expiryDays(value) {
  const days = Number(value ?? 90);
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_PORTAL_DAYS) {
    throw new TenantMaintenanceError(
      400,
      'INVALID_MAINTENANCE_PORTAL_EXPIRY',
      'Thời hạn cổng báo sửa phải từ 1 đến 365 ngày'
    );
  }
  return days;
}

function optionalMemberId(value) {
  if (value === null || value === undefined || value === '') return null;
  return positiveId(value, 'Nhân viên');
}

function statusTransitionInput(body = {}) {
  const status = String(body.status || '').trim().toLowerCase();
  if (!REQUEST_STATUSES.includes(status) || status === 'new') {
    throw new TenantMaintenanceError(
      400,
      'INVALID_MAINTENANCE_STATUS',
      'Trạng thái xử lý không hợp lệ'
    );
  }
  const note = simpleText(body.note, 'Ghi chú xử lý', { max: 500 });
  if (['resolved', 'cancelled'].includes(status) && note.length < 3) {
    throw new TenantMaintenanceError(
      400,
      'MAINTENANCE_STATUS_NOTE_REQUIRED',
      'Hoàn tất hoặc hủy yêu cầu cần ghi chú từ 3 đến 500 ký tự'
    );
  }
  return { status, note };
}

function generatePortalToken() {
  return `tmrq_${crypto.randomBytes(32).toString('base64url')}`;
}

function portalTokenHash(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function publicRequestInput(body = {}) {
  const category = String(body.category || '').trim().toLowerCase();
  const urgency = String(body.urgency || '').trim().toLowerCase();
  const idempotencyKey = String(body.idempotencyKey || '').trim().toLowerCase();
  if (!REQUEST_CATEGORIES.includes(category)) {
    throw new TenantMaintenanceError(
      400,
      'INVALID_MAINTENANCE_REQUEST_CATEGORY',
      'Nhóm sự cố không hợp lệ'
    );
  }
  if (!REQUEST_URGENCIES.includes(urgency)) {
    throw new TenantMaintenanceError(
      400,
      'INVALID_MAINTENANCE_REQUEST_URGENCY',
      'Mức độ ưu tiên không hợp lệ'
    );
  }
  if (!IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    throw new TenantMaintenanceError(
      400,
      'INVALID_MAINTENANCE_REQUEST_KEY',
      'Mã chống gửi trùng không hợp lệ'
    );
  }
  return {
    idempotencyKey,
    category,
    urgency,
    description: descriptionText(body.description),
    contactPhone: simpleText(body.contactPhone, 'Số điện thoại liên hệ', { max: 50 }),
    availableTime: simpleText(body.availableTime, 'Thời gian có thể vào kiểm tra', { max: 200 })
  };
}

function requestCode(id, year) {
  return `YC-${Number(year)}-${Number(id).toString(36).toUpperCase().padStart(6, '0')}`;
}

function portalJson(row) {
  const expired = new Date(row.expires_at).getTime() <= Date.now();
  return {
    id: Number(row.id),
    contractId: Number(row.contract_id),
    contractCode: row.contract_code || '',
    roomId: row.room_id,
    roomName: row.room_name_snapshot,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name_snapshot,
    tokenLast4: row.token_last4,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at || null,
    viewCount: Number(row.view_count) || 0,
    lastViewedAt: row.last_viewed_at || null,
    createdAt: row.created_at,
    status: row.revoked_at ? 'revoked' : (expired ? 'expired' : 'active')
  };
}

function requestJson(row) {
  const result = {
    id: Number(row.id),
    code: row.request_code,
    contractId: Number(row.contract_id),
    roomId: row.room_id,
    roomName: row.room_name_snapshot,
    tenantId: row.tenant_id,
    tenantName: row.tenant_name_snapshot,
    category: row.category,
    urgency: row.urgency,
    description: row.description,
    contactPhone: row.contact_phone || '',
    availableTime: row.available_time || '',
    status: row.status,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at
  };
  result.propertyId = Number(row.property_id) || null;
  result.assignedTo = row.assigned_member_user_id
    ? {
        userId: Number(row.assigned_member_user_id),
        email: row.assigned_member_email || '',
        assignedAt: row.assigned_at || null,
        updatedAt: row.assignment_updated_at || null
      }
    : null;
  if (Array.isArray(row.events)) result.events = row.events.map(eventJson);
  return result;
}

function eventJson(row) {
  return {
    id: Number(row.id),
    type: row.event_type,
    actorUserId: row.actor_user_id ? Number(row.actor_user_id) : null,
    actorEmail: row.actor_email_snapshot || '',
    previousAssignee: row.previous_assignee_user_id
      ? {
          userId: Number(row.previous_assignee_user_id),
          email: row.previous_assignee_email_snapshot || ''
        }
      : null,
    newAssignee: row.new_assignee_user_id
      ? {
          userId: Number(row.new_assignee_user_id),
          email: row.new_assignee_email_snapshot || ''
        }
      : null,
    previousStatus: row.previous_status || null,
    newStatus: row.new_status || null,
    note: row.note || '',
    createdAt: row.created_at
  };
}

function publicRequestJson(row) {
  return {
    code: row.request_code,
    category: row.category,
    urgency: row.urgency,
    description: row.description,
    contactPhone: row.contact_phone || '',
    availableTime: row.available_time || '',
    status: row.status,
    submittedAt: row.submitted_at,
    updatedAt: row.updated_at
  };
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

function requireOwnerWorkspace(req) {
  if (req.workspace && !req.workspace.isOwner) {
    throw new TenantMaintenanceError(
      403,
      'TENANT_MAINTENANCE_OWNER_REQUIRED',
      'Chỉ chủ tài khoản được quản lý cổng yêu cầu sửa chữa của khách thuê'
    );
  }
}

function actorUserId(req) {
  return Number(req.actorUserId || req.userId);
}

function workspacePropertyIds(req) {
  return Array.isArray(req.workspace?.propertyIds)
    ? req.workspace.propertyIds.map(Number).filter(Number.isSafeInteger)
    : [];
}

async function requestEventsByRequest(query, userId, requestIds) {
  const ids = requestIds.map(Number).filter(Number.isSafeInteger);
  if (ids.length === 0) return new Map();
  const result = await query(
    `SELECT * FROM tenant_maintenance_request_events
     WHERE user_id=$1 AND request_id=ANY($2::bigint[])
     ORDER BY created_at, id`,
    [userId, ids]
  );
  const byRequest = new Map();
  for (const row of result.rows) {
    const id = Number(row.request_id);
    if (!byRequest.has(id)) byRequest.set(id, []);
    byRequest.get(id).push(row);
  }
  return byRequest;
}

async function requestRowsJson(query, userId, rows) {
  const events = await requestEventsByRequest(query, userId, rows.map(row => row.id));
  return rows.map(row => requestJson({
    ...row,
    events: events.get(Number(row.id)) || []
  }));
}

async function eligibleMaintenanceAssignees(query, userId, propertyId) {
  const result = await query(
    `SELECT membership.member_user_id, member.email
     FROM account_memberships membership
     JOIN users member ON member.id=membership.member_user_id
     JOIN account_member_property_access property_access
       ON property_access.account_user_id=membership.account_user_id
      AND property_access.member_user_id=membership.member_user_id
      AND property_access.property_id=$2
     JOIN account_member_operation_access operation_access
       ON operation_access.account_user_id=membership.account_user_id
      AND operation_access.member_user_id=membership.member_user_id
      AND operation_access.operation='rooms'
     WHERE membership.account_user_id=$1
       AND membership.role<>'owner'
     ORDER BY member.email, membership.member_user_id`,
    [userId, propertyId]
  );
  return result.rows.map(row => ({
    userId: Number(row.member_user_id),
    email: row.email
  }));
}

async function maintenanceRequestRow(query, userId, requestId, { forUpdate = false } = {}) {
  const result = await query(
    `SELECT request.*, room.property_id,
            assignment.member_user_id AS assigned_member_user_id,
            assignment.assigned_at,
            assignment.updated_at AS assignment_updated_at,
            assigned_member.email AS assigned_member_email
     FROM tenant_maintenance_requests request
     JOIN tenant_maintenance_portal_links portal
       ON portal.user_id=request.user_id
      AND portal.contract_id=request.contract_id
      AND portal.id=request.portal_link_id
     JOIN rooms room ON room.user_id=request.user_id AND room.id=request.room_id
     LEFT JOIN tenant_maintenance_request_assignments assignment
       ON assignment.user_id=request.user_id AND assignment.request_id=request.id
     LEFT JOIN users assigned_member ON assigned_member.id=assignment.member_user_id
     WHERE request.user_id=$1 AND request.id=$2
     ${forUpdate ? 'FOR UPDATE OF request' : ''}`,
    [userId, requestId]
  );
  return result.rows[0] || null;
}

function ensureStaffRequestAccess(req, row) {
  if (req.workspace?.isOwner !== false) return;
  const properties = workspacePropertyIds(req);
  if (
    !properties.includes(Number(row.property_id))
    || Number(row.assigned_member_user_id) !== actorUserId(req)
  ) {
    throw new TenantMaintenanceError(
      403,
      'MAINTENANCE_REQUEST_ACCESS_DENIED',
      'Yêu cầu này chưa được giao cho bạn trong khu được phép'
    );
  }
}

function validatePortalRow(row) {
  if (!row) {
    throw new TenantMaintenanceError(
      404,
      'MAINTENANCE_PORTAL_INVALID',
      'Liên kết báo sửa không hợp lệ'
    );
  }
  if (row.revoked_at) {
    throw new TenantMaintenanceError(
      410,
      'MAINTENANCE_PORTAL_REVOKED',
      'Liên kết báo sửa đã được thu hồi'
    );
  }
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    throw new TenantMaintenanceError(
      410,
      'MAINTENANCE_PORTAL_EXPIRED',
      'Liên kết báo sửa đã hết hạn'
    );
  }
  if (row.contract_status !== 'active' || row.contract_date_expired) {
    throw new TenantMaintenanceError(
      410,
      'MAINTENANCE_CONTRACT_INACTIVE',
      'Hợp đồng không còn hoạt động'
    );
  }
  return row;
}

async function issueMaintenancePortal(req, res, dependencies = {}) {
  let contractId;
  let days;
  try {
    requireOwnerWorkspace(req);
    contractId = positiveId(req.params?.id);
    days = expiryDays(req.body?.expiresInDays);
  } catch (error) {
    if (sendMaintenanceRequestError(res, error)) return res;
    throw error;
  }
  const token = (dependencies.generateToken || generatePortalToken)();
  const hash = portalTokenHash(token);
  const client = await (dependencies.getClient || db.getClient)();
  try {
    await client.query('BEGIN');
    await ensureWritable(client.query.bind(client), req.userId);
    const contractResult = await client.query(
      `SELECT contract.id, contract.contract_code, contract.room_id,
              contract.room_name_snapshot, contract.tenant_id,
              contract.tenant_name_snapshot, contract.status, contract.ends_on,
              (contract.ends_on IS NOT NULL AND
               contract.ends_on < (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date) AS date_expired
       FROM rental_contracts contract
       JOIN rooms room
         ON room.user_id=contract.user_id AND room.id=contract.room_id
       WHERE contract.user_id=$1 AND contract.id=$2
       FOR UPDATE OF contract`,
      [req.userId, contractId]
    );
    const contract = contractResult.rows[0];
    if (!contract) {
      throw new TenantMaintenanceError(404, 'CONTRACT_NOT_FOUND', 'Không tìm thấy hợp đồng');
    }
    if (contract.status !== 'active') {
      throw new TenantMaintenanceError(
        409,
        'MAINTENANCE_CONTRACT_INACTIVE',
        'Chỉ hợp đồng đang hoạt động mới tạo được cổng báo sửa'
      );
    }
    if (contract.date_expired) {
      throw new TenantMaintenanceError(
        409,
        'MAINTENANCE_CONTRACT_EXPIRED',
        'Hợp đồng đã qua ngày kết thúc'
      );
    }
    await client.query(
      `UPDATE tenant_maintenance_portal_links
       SET revoked_at=COALESCE(revoked_at, now())
       WHERE user_id=$1 AND contract_id=$2 AND revoked_at IS NULL`,
      [req.userId, contractId]
    );
    const inserted = await client.query(
      `INSERT INTO tenant_maintenance_portal_links
         (user_id, contract_id, room_id, room_name_snapshot, tenant_id,
          tenant_name_snapshot, token_hash, token_last4, expires_at)
       VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,
         CASE WHEN $10::date IS NULL
           THEN now() + ($9::int * interval '1 day')
           ELSE LEAST(
             now() + ($9::int * interval '1 day'),
             $10::date::timestamptz + interval '1 day'
           )
         END
       )
       RETURNING *`,
      [
        req.userId,
        contractId,
        contract.room_id,
        contract.room_name_snapshot,
        contract.tenant_id,
        contract.tenant_name_snapshot,
        hash,
        token.slice(-4),
        days,
        contract.ends_on
      ]
    );
    await recordDataAudits(client.query.bind(client), [requestDataAuditEntry(
      req,
      'tenant_maintenance_portal_issued',
      'tenant_maintenance_portal',
      String(inserted.rows[0].id),
      { changedFields: ['status', 'endsOn'], purpose: 'Cấp cổng báo sửa cho khách thuê' }
    )]);
    await client.query('COMMIT');
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({
      portal: portalJson({ ...inserted.rows[0], contract_code: contract.contract_code }),
      publicUrl: `${publicBaseUrl(req)}/maintenance.html#t=${encodeURIComponent(token)}`
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendMaintenanceRequestError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

async function listMaintenancePortals(req, res, dependencies = {}) {
  let contractId;
  try {
    requireOwnerWorkspace(req);
    contractId = positiveId(req.params?.id);
  } catch (error) {
    if (sendMaintenanceRequestError(res, error)) return res;
    throw error;
  }
  const query = dependencies.query || db.query;
  const contract = await query(
    'SELECT id FROM rental_contracts WHERE user_id=$1 AND id=$2',
    [req.userId, contractId]
  );
  if (!contract.rows[0]) {
    return res.status(404).json({ error: 'Không tìm thấy hợp đồng', code: 'CONTRACT_NOT_FOUND' });
  }
  const result = await query(
    `SELECT link.*, contract.contract_code
     FROM tenant_maintenance_portal_links link
     JOIN rental_contracts contract
       ON contract.user_id=link.user_id AND contract.id=link.contract_id
     WHERE link.user_id=$1 AND link.contract_id=$2
     ORDER BY link.created_at DESC, link.id DESC
     LIMIT 30`,
    [req.userId, contractId]
  );
  res.set('Cache-Control', 'no-store');
  return res.json({ portals: result.rows.map(portalJson) });
}

async function revokeMaintenancePortal(req, res, dependencies = {}) {
  let portalId;
  try {
    requireOwnerWorkspace(req);
    portalId = positiveId(req.params?.id, 'Liên kết');
  } catch (error) {
    if (sendMaintenanceRequestError(res, error)) return res;
    throw error;
  }
  const client = await (dependencies.getClient || db.getClient)();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `UPDATE tenant_maintenance_portal_links
       SET revoked_at=COALESCE(revoked_at, now())
       WHERE user_id=$1 AND id=$2
       RETURNING *`,
      [req.userId, portalId]
    );
    if (!result.rows[0]) {
      throw new TenantMaintenanceError(
        404,
        'MAINTENANCE_PORTAL_NOT_FOUND',
        'Không tìm thấy cổng báo sửa'
      );
    }
    await recordDataAudits(client.query.bind(client), [requestDataAuditEntry(
      req,
      'tenant_maintenance_portal_revoked',
      'tenant_maintenance_portal',
      String(portalId),
      { changedFields: ['status'], purpose: 'Thu hồi cổng báo sửa' }
    )]);
    await client.query('COMMIT');
    res.set('Cache-Control', 'no-store');
    return res.json({ portal: portalJson(result.rows[0]) });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendMaintenanceRequestError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

async function listMaintenanceRequests(req, res, dependencies = {}) {
  let contractId;
  try {
    requireOwnerWorkspace(req);
    contractId = positiveId(req.params?.id);
  } catch (error) {
    if (sendMaintenanceRequestError(res, error)) return res;
    throw error;
  }
  const query = dependencies.query || db.query;
  const contract = await query(
    `SELECT contract.id, room.property_id
     FROM rental_contracts contract
     LEFT JOIN rooms room ON room.user_id=contract.user_id AND room.id=contract.room_id
     WHERE contract.user_id=$1 AND contract.id=$2`,
    [req.userId, contractId]
  );
  if (!contract.rows[0]) {
    return res.status(404).json({ error: 'Không tìm thấy hợp đồng', code: 'CONTRACT_NOT_FOUND' });
  }
  const result = await query(
    `SELECT request.*, room.property_id,
            assignment.member_user_id AS assigned_member_user_id,
            assignment.assigned_at,
            assignment.updated_at AS assignment_updated_at,
            assigned_member.email AS assigned_member_email
     FROM tenant_maintenance_requests request
     JOIN tenant_maintenance_portal_links portal
       ON portal.user_id=request.user_id
      AND portal.contract_id=request.contract_id
      AND portal.id=request.portal_link_id
     LEFT JOIN rooms room ON room.user_id=request.user_id AND room.id=request.room_id
     LEFT JOIN tenant_maintenance_request_assignments assignment
       ON assignment.user_id=request.user_id AND assignment.request_id=request.id
     LEFT JOIN users assigned_member ON assigned_member.id=assignment.member_user_id
     WHERE request.user_id=$1 AND request.contract_id=$2
     ORDER BY request.submitted_at DESC, request.id DESC
     LIMIT 100`,
    [req.userId, contractId]
  );
  const [requests, assignees] = await Promise.all([
    requestRowsJson(query, req.userId, result.rows),
    eligibleMaintenanceAssignees(query, req.userId, contract.rows[0].property_id)
  ]);
  res.set('Cache-Control', 'no-store');
  return res.json({ requests, assignees });
}

async function listMaintenanceWork(req, res, dependencies = {}) {
  const roomId = String(req.query?.roomId || '').trim();
  if (!roomId || roomId.length > 200) {
    return res.status(400).json({
      error: 'Phòng cần xem công việc không hợp lệ',
      code: 'INVALID_MAINTENANCE_ROOM'
    });
  }
  const query = dependencies.query || db.query;
  const roomResult = await query(
    'SELECT id, property_id FROM rooms WHERE user_id=$1 AND id=$2',
    [req.userId, roomId]
  );
  const room = roomResult.rows[0];
  if (!room) {
    return res.status(404).json({ error: 'Không tìm thấy phòng', code: 'ROOM_NOT_FOUND' });
  }
  const owner = req.workspace?.isOwner !== false;
  if (!owner && !workspacePropertyIds(req).includes(Number(room.property_id))) {
    return res.status(403).json({
      error: 'Bạn chưa được giao khu của phòng này',
      code: 'MAINTENANCE_PROPERTY_ACCESS_DENIED'
    });
  }
  const params = [req.userId, roomId];
  let staffClause = '';
  if (!owner) {
    params.push(actorUserId(req));
    staffClause = 'AND assignment.member_user_id=$3';
  }
  const result = await query(
    `SELECT request.*, room.property_id,
            assignment.member_user_id AS assigned_member_user_id,
            assignment.assigned_at,
            assignment.updated_at AS assignment_updated_at,
            assigned_member.email AS assigned_member_email
     FROM tenant_maintenance_requests request
     JOIN tenant_maintenance_portal_links portal
       ON portal.user_id=request.user_id
      AND portal.contract_id=request.contract_id
      AND portal.id=request.portal_link_id
     JOIN rooms room ON room.user_id=request.user_id AND room.id=request.room_id
     LEFT JOIN tenant_maintenance_request_assignments assignment
       ON assignment.user_id=request.user_id AND assignment.request_id=request.id
     LEFT JOIN users assigned_member ON assigned_member.id=assignment.member_user_id
     WHERE request.user_id=$1 AND request.room_id=$2
       ${staffClause}
     ORDER BY
       CASE request.status
         WHEN 'new' THEN 1 WHEN 'acknowledged' THEN 2 WHEN 'in_progress' THEN 3 ELSE 4
       END,
       request.submitted_at DESC,
       request.id DESC
     LIMIT 100`,
    params
  );
  const [requests, assignees] = await Promise.all([
    requestRowsJson(query, req.userId, result.rows),
    owner
      ? eligibleMaintenanceAssignees(query, req.userId, room.property_id)
      : Promise.resolve([])
  ]);
  res.set('Cache-Control', 'no-store');
  return res.json({
    requests,
    assignees,
    access: { isOwner: owner, actorUserId: actorUserId(req) }
  });
}

async function assignMaintenanceRequest(req, res, dependencies = {}) {
  let requestId;
  let memberUserId;
  try {
    requireOwnerWorkspace(req);
    requestId = positiveId(req.params?.id, 'Yêu cầu');
    memberUserId = optionalMemberId(req.body?.memberUserId);
  } catch (error) {
    if (sendMaintenanceRequestError(res, error)) return res;
    throw error;
  }
  const client = await (dependencies.getClient || db.getClient)();
  try {
    await client.query('BEGIN');
    await ensureWritable(client.query.bind(client), req.userId);
    const row = await maintenanceRequestRow(
      client.query.bind(client),
      req.userId,
      requestId,
      { forUpdate: true }
    );
    if (!row) {
      throw new TenantMaintenanceError(
        404,
        'MAINTENANCE_REQUEST_NOT_FOUND',
        'Không tìm thấy yêu cầu sửa chữa'
      );
    }
    const previousUserId = row.assigned_member_user_id
      ? Number(row.assigned_member_user_id)
      : null;
    if (previousUserId === memberUserId) {
      const events = await requestEventsByRequest(
        client.query.bind(client),
        req.userId,
        [requestId]
      );
      await client.query('COMMIT');
      res.set('Cache-Control', 'no-store');
      return res.json({
        request: requestJson({ ...row, events: events.get(requestId) || [] }),
        unchanged: true
      });
    }
    let nextMember = null;
    if (memberUserId !== null) {
      const eligible = await eligibleMaintenanceAssignees(
        client.query.bind(client),
        req.userId,
        row.property_id
      );
      nextMember = eligible.find(member => member.userId === memberUserId) || null;
      if (!nextMember) {
        throw new TenantMaintenanceError(
          409,
          'MAINTENANCE_ASSIGNEE_NOT_ELIGIBLE',
          'Nhân viên phải được giao đúng khu và nghiệp vụ phòng'
        );
      }
    }
    if (memberUserId === null) {
      await client.query(
        'DELETE FROM tenant_maintenance_request_assignments WHERE user_id=$1 AND request_id=$2',
        [req.userId, requestId]
      );
    } else {
      await client.query(
        `INSERT INTO tenant_maintenance_request_assignments
           (user_id, request_id, member_user_id, assigned_by_user_id)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (user_id, request_id) DO UPDATE
         SET member_user_id=EXCLUDED.member_user_id,
             assigned_by_user_id=EXCLUDED.assigned_by_user_id,
             updated_at=now()`,
        [req.userId, requestId, memberUserId, actorUserId(req)]
      );
    }
    await client.query(
      `INSERT INTO tenant_maintenance_request_events
         (user_id, request_id, event_type, actor_user_id, actor_email_snapshot,
          previous_assignee_user_id, previous_assignee_email_snapshot,
          new_assignee_user_id, new_assignee_email_snapshot)
       VALUES ($1,$2,'assignment_changed',$3,$4,$5,$6,$7,$8)`,
      [
        req.userId,
        requestId,
        actorUserId(req),
        String(req.userEmail || ''),
        previousUserId,
        String(row.assigned_member_email || ''),
        memberUserId,
        String(nextMember?.email || '')
      ]
    );
    await recordDataAudits(client.query.bind(client), [requestDataAuditEntry(
      req,
      'tenant_maintenance_request_assigned',
      'tenant_maintenance_request',
      String(requestId),
      { changedFields: ['assignedMemberUserId'], purpose: 'Phân công yêu cầu sửa chữa' }
    )]);
    const refreshed = await maintenanceRequestRow(client.query.bind(client), req.userId, requestId);
    const events = await requestEventsByRequest(client.query.bind(client), req.userId, [requestId]);
    await client.query('COMMIT');
    res.set('Cache-Control', 'no-store');
    return res.json({
      request: requestJson({ ...refreshed, events: events.get(requestId) || [] }),
      unchanged: false
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendMaintenanceRequestError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

async function transitionMaintenanceRequestStatus(req, res, dependencies = {}) {
  let requestId;
  let input;
  try {
    requestId = positiveId(req.params?.id, 'Yêu cầu');
    input = statusTransitionInput(req.body);
  } catch (error) {
    if (sendMaintenanceRequestError(res, error)) return res;
    throw error;
  }
  const client = await (dependencies.getClient || db.getClient)();
  try {
    await client.query('BEGIN');
    await ensureWritable(client.query.bind(client), req.userId);
    const row = await maintenanceRequestRow(
      client.query.bind(client),
      req.userId,
      requestId,
      { forUpdate: true }
    );
    if (!row) {
      throw new TenantMaintenanceError(
        404,
        'MAINTENANCE_REQUEST_NOT_FOUND',
        'Không tìm thấy yêu cầu sửa chữa'
      );
    }
    ensureStaffRequestAccess(req, row);
    const owner = req.workspace?.isOwner !== false;
    if (!owner && input.status === 'cancelled') {
      throw new TenantMaintenanceError(
        403,
        'MAINTENANCE_STATUS_OWNER_REQUIRED',
        'Chỉ chủ tài khoản được hủy yêu cầu sửa chữa'
      );
    }
    if (row.status === input.status) {
      const events = await requestEventsByRequest(client.query.bind(client), req.userId, [requestId]);
      await client.query('COMMIT');
      res.set('Cache-Control', 'no-store');
      return res.json({
        request: requestJson({ ...row, events: events.get(requestId) || [] }),
        unchanged: true
      });
    }
    if (!(STATUS_TRANSITIONS[row.status] || []).includes(input.status)) {
      throw new TenantMaintenanceError(
        409,
        'MAINTENANCE_STATUS_TRANSITION_INVALID',
        `Không thể chuyển từ ${row.status} sang ${input.status}`
      );
    }
    const updated = await client.query(
      `UPDATE tenant_maintenance_requests
       SET status=$3, updated_at=now()
       WHERE user_id=$1 AND id=$2 AND status=$4
       RETURNING *`,
      [req.userId, requestId, input.status, row.status]
    );
    if (!updated.rows[0]) {
      throw new TenantMaintenanceError(
        409,
        'MAINTENANCE_STATUS_CHANGED',
        'Trạng thái đã thay đổi, vui lòng tải lại'
      );
    }
    await client.query(
      `INSERT INTO tenant_maintenance_request_events
         (user_id, request_id, event_type, actor_user_id, actor_email_snapshot,
          previous_status, new_status, note)
       VALUES ($1,$2,'status_changed',$3,$4,$5,$6,$7)`,
      [
        req.userId,
        requestId,
        actorUserId(req),
        String(req.userEmail || ''),
        row.status,
        input.status,
        input.note
      ]
    );
    await recordDataAudits(client.query.bind(client), [requestDataAuditEntry(
      req,
      'tenant_maintenance_request_status_changed',
      'tenant_maintenance_request',
      String(requestId),
      { changedFields: ['status', 'note'], purpose: 'Cập nhật tiến độ yêu cầu sửa chữa' }
    )]);
    const refreshed = {
      ...row,
      ...updated.rows[0]
    };
    const events = await requestEventsByRequest(client.query.bind(client), req.userId, [requestId]);
    await client.query('COMMIT');
    res.set('Cache-Control', 'no-store');
    return res.json({
      request: requestJson({ ...refreshed, events: events.get(requestId) || [] }),
      unchanged: false
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendMaintenanceRequestError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

async function publicPortalRow(query, token, { forUpdate = false } = {}) {
  const result = await query(
    `SELECT link.*, contract.contract_code, contract.status AS contract_status,
            (contract.ends_on IS NOT NULL AND
             contract.ends_on < (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date)
              AS contract_date_expired
     FROM tenant_maintenance_portal_links link
     JOIN rental_contracts contract
       ON contract.user_id=link.user_id AND contract.id=link.contract_id
     WHERE link.token_hash=$1
     ${forUpdate ? 'FOR UPDATE OF link' : ''}`,
    [portalTokenHash(token)]
  );
  return validatePortalRow(result.rows[0]);
}

async function resolvePublicMaintenancePortal(req, res, dependencies = {}) {
  const token = String(req.body?.token || '').trim();
  if (!PORTAL_TOKEN_PATTERN.test(token)) {
    return res.status(404).json({
      error: 'Liên kết báo sửa không hợp lệ',
      code: 'MAINTENANCE_PORTAL_INVALID'
    });
  }
  const client = await (dependencies.getClient || db.getClient)();
  try {
    await client.query('BEGIN');
    const portal = await publicPortalRow(client.query.bind(client), token, { forUpdate: true });
    const requests = await client.query(
      `SELECT * FROM tenant_maintenance_requests
       WHERE user_id=$1 AND contract_id=$2
       ORDER BY submitted_at DESC, id DESC
       LIMIT 50`,
      [portal.user_id, portal.contract_id]
    );
    await client.query(
      `UPDATE tenant_maintenance_portal_links
       SET view_count=view_count + 1, last_viewed_at=now()
       WHERE id=$1`,
      [portal.id]
    );
    await client.query('COMMIT');
    res.set('Cache-Control', 'no-store');
    return res.json({
      portal: {
        contractCode: portal.contract_code,
        roomName: portal.room_name_snapshot,
        expiresAt: portal.expires_at
      },
      requests: requests.rows.map(publicRequestJson)
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendMaintenanceRequestError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

async function submitPublicMaintenanceRequest(req, res, dependencies = {}) {
  const token = String(req.body?.token || '').trim();
  if (!PORTAL_TOKEN_PATTERN.test(token)) {
    return res.status(404).json({
      error: 'Liên kết báo sửa không hợp lệ',
      code: 'MAINTENANCE_PORTAL_INVALID'
    });
  }
  let input;
  try {
    input = publicRequestInput(req.body);
  } catch (error) {
    if (sendMaintenanceRequestError(res, error)) return res;
    throw error;
  }
  const rateKey = portalTokenHash(token);
  const checkRate = dependencies.checkRate || checkAuthRateLimit;
  const recordRate = dependencies.recordRate || recordAuthAttempt;
  if (!(await checkRate(req, res, 'maintenanceRequest', rateKey))) return res;
  if (!(await recordRate(req, res, 'maintenanceRequest', rateKey))) return res;

  const client = await (dependencies.getClient || db.getClient)();
  try {
    await client.query('BEGIN');
    const portal = await publicPortalRow(client.query.bind(client), token, { forUpdate: true });
    const idResult = await client.query(
      `SELECT nextval('tenant_maintenance_requests_id_seq') AS id,
              EXTRACT(YEAR FROM CURRENT_DATE)::int AS code_year`
    );
    const id = Number(idResult.rows[0].id);
    const inserted = await client.query(
      `INSERT INTO tenant_maintenance_requests
         (id, user_id, contract_id, portal_link_id, request_code,
          room_id, room_name_snapshot, tenant_id, tenant_name_snapshot,
          category, urgency, description, contact_phone, available_time,
          idempotency_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::uuid)
       ON CONFLICT (portal_link_id, idempotency_key) DO NOTHING
       RETURNING *`,
      [
        id,
        portal.user_id,
        portal.contract_id,
        portal.id,
        requestCode(id, idResult.rows[0].code_year),
        portal.room_id,
        portal.room_name_snapshot,
        portal.tenant_id,
        portal.tenant_name_snapshot,
        input.category,
        input.urgency,
        input.description,
        input.contactPhone,
        input.availableTime,
        input.idempotencyKey
      ]
    );
    let row = inserted.rows[0];
    let duplicate = false;
    if (!row) {
      const existing = await client.query(
        `SELECT * FROM tenant_maintenance_requests
         WHERE portal_link_id=$1 AND idempotency_key=$2::uuid`,
        [portal.id, input.idempotencyKey]
      );
      row = existing.rows[0];
      duplicate = true;
    }
    if (!row) throw new Error('Không đọc lại được yêu cầu sửa chữa');
    if (!duplicate) {
      const context = requestAuditContext(req);
      await recordDataAudits(client.query.bind(client), [{
        actorUserId: null,
        actorEmail: '',
        subjectUserId: portal.user_id,
        action: 'tenant_maintenance_request_submitted',
        resourceType: 'tenant_maintenance_request',
        resourceId: String(row.id),
        changedFields: [
          'category', 'urgency', 'description', 'contactPhone', 'availableTime'
        ],
        purpose: 'Khách thuê gửi yêu cầu sửa chữa qua cổng công khai',
        ...context
      }]);
    }
    await client.query('COMMIT');
    res.set('Cache-Control', 'no-store');
    return res.status(duplicate ? 200 : 201).json({
      request: publicRequestJson(row),
      duplicate
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendMaintenanceRequestError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

async function loadTenantMaintenanceExport(userId, query = db.query) {
  const [portalResult, requestResult, assignmentResult, eventResult] = await Promise.all([
    query(
      `SELECT link.*, contract.contract_code
       FROM tenant_maintenance_portal_links link
       LEFT JOIN rental_contracts contract
         ON contract.user_id=link.user_id AND contract.id=link.contract_id
       WHERE link.user_id=$1
       ORDER BY link.created_at DESC, link.id DESC`,
      [userId]
    ),
    query(
      `SELECT request.*, room.property_id,
              assignment.member_user_id AS assigned_member_user_id,
              assignment.assigned_at,
              assignment.updated_at AS assignment_updated_at,
              assigned_member.email AS assigned_member_email
       FROM tenant_maintenance_requests request
       JOIN tenant_maintenance_portal_links portal
         ON portal.user_id=request.user_id
        AND portal.contract_id=request.contract_id
        AND portal.id=request.portal_link_id
       LEFT JOIN rooms room ON room.user_id=request.user_id AND room.id=request.room_id
       LEFT JOIN tenant_maintenance_request_assignments assignment
         ON assignment.user_id=request.user_id AND assignment.request_id=request.id
       LEFT JOIN users assigned_member ON assigned_member.id=assignment.member_user_id
       WHERE request.user_id=$1
       ORDER BY request.submitted_at DESC, request.id DESC`,
      [userId]
    ),
    query(
      `SELECT assignment.*, member.email AS member_email,
              assigned_by.email AS assigned_by_email
       FROM tenant_maintenance_request_assignments assignment
       JOIN users member ON member.id=assignment.member_user_id
       LEFT JOIN users assigned_by ON assigned_by.id=assignment.assigned_by_user_id
       WHERE assignment.user_id=$1
       ORDER BY assignment.updated_at DESC, assignment.request_id`,
      [userId]
    ),
    query(
      `SELECT * FROM tenant_maintenance_request_events
       WHERE user_id=$1
       ORDER BY created_at, id`,
      [userId]
    )
  ]);
  return {
    portals: portalResult.rows.map(portalJson),
    requests: requestResult.rows.map(requestJson),
    assignments: assignmentResult.rows.map(row => ({
      requestId: Number(row.request_id),
      memberUserId: Number(row.member_user_id),
      memberEmail: row.member_email,
      assignedByUserId: row.assigned_by_user_id ? Number(row.assigned_by_user_id) : null,
      assignedByEmail: row.assigned_by_email || '',
      assignedAt: row.assigned_at,
      updatedAt: row.updated_at
    })),
    events: eventResult.rows.map(eventJson)
  };
}

module.exports = {
  IDEMPOTENCY_PATTERN,
  MAX_PORTAL_DAYS,
  PORTAL_TOKEN_PATTERN,
  REQUEST_CATEGORIES,
  REQUEST_STATUSES,
  REQUEST_URGENCIES,
  TenantMaintenanceError,
  expiryDays,
  eventJson,
  generatePortalToken,
  assignMaintenanceRequest,
  eligibleMaintenanceAssignees,
  ensureStaffRequestAccess,
  issueMaintenancePortal,
  listMaintenancePortals,
  listMaintenanceRequests,
  listMaintenanceWork,
  loadTenantMaintenanceExport,
  portalJson,
  portalTokenHash,
  publicPortalRow,
  publicRequestJson,
  publicRequestInput,
  requireOwnerWorkspace,
  requestCode,
  requestJson,
  resolvePublicMaintenancePortal,
  revokeMaintenancePortal,
  sendMaintenanceRequestError,
  submitPublicMaintenanceRequest,
  statusTransitionInput,
  transitionMaintenanceRequestStatus,
  validatePortalRow
};
