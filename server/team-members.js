'use strict';

const db = require('./db');
const {
  EntitlementError,
  getUserEntitlements,
  sendEntitlementError
} = require('./subscription');

const STAFF_ROLES = Object.freeze(['manager', 'accountant', 'meter_reader']);
const ACCESS_OPERATIONS = Object.freeze([
  { value: 'overview', label: 'Tổng quan' },
  { value: 'rooms', label: 'Phòng và khách thuê' },
  { value: 'meters', label: 'Ghi điện nước' },
  { value: 'expenses', label: 'Chi phí' },
  { value: 'invoices', label: 'Hóa đơn và thanh toán' }
]);
const ROLE_ALLOWED_OPERATIONS = Object.freeze({
  manager: Object.freeze(ACCESS_OPERATIONS.map(operation => operation.value)),
  accountant: Object.freeze(['overview', 'expenses', 'invoices']),
  meter_reader: Object.freeze(['meters'])
});
const ROLE_LABELS = Object.freeze({
  owner: 'Chủ sở hữu',
  manager: 'Quản lý',
  accountant: 'Kế toán',
  meter_reader: 'Người ghi điện nước'
});

class TeamMemberError extends Error {
  constructor(statusCode, code, message, details = {}) {
    super(message);
    this.name = 'TeamMemberError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
  }
}

function normalizeEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  if (email.length < 3 || email.length > 320 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new TeamMemberError(400, 'INVALID_MEMBER_EMAIL', 'Email thành viên không hợp lệ');
  }
  return email;
}

function normalizeRole(value) {
  const role = String(value || '').trim().toLowerCase();
  if (!STAFF_ROLES.includes(role)) {
    throw new TeamMemberError(400, 'INVALID_MEMBER_ROLE', 'Vai trò thành viên không hợp lệ');
  }
  return role;
}

function memberUserId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new TeamMemberError(400, 'INVALID_MEMBER_ID', 'ID thành viên không hợp lệ');
  }
  return id;
}

function memberJson(row, access = {}) {
  return {
    userId: Number(row.member_user_id),
    email: row.member_email,
    role: row.role,
    roleLabel: ROLE_LABELS[row.role] || row.role,
    isOwner: row.role === 'owner',
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    access: {
      propertyIds: Array.isArray(access.propertyIds)
        ? access.propertyIds.map(Number).filter(Number.isSafeInteger)
        : [],
      operations: Array.isArray(access.operations)
        ? access.operations.filter(operation => ACCESS_OPERATIONS.some(item => item.value === operation))
        : []
    }
  };
}

function normalizeAccess(body = {}, role) {
  const rawPropertyIds = Array.isArray(body.propertyIds) ? body.propertyIds : [];
  const propertyIds = [...new Set(rawPropertyIds.map(Number))];
  if (propertyIds.length > 100 || propertyIds.some(id => !Number.isSafeInteger(id) || id <= 0)) {
    throw new TeamMemberError(400, 'INVALID_MEMBER_PROPERTIES', 'Danh sách khu được giao không hợp lệ');
  }
  const rawOperations = Array.isArray(body.operations) ? body.operations : [];
  const operations = [...new Set(rawOperations.map(value => String(value || '').trim().toLowerCase()))];
  const allowed = ROLE_ALLOWED_OPERATIONS[role] || [];
  if (operations.some(operation => !allowed.includes(operation))) {
    throw new TeamMemberError(
      400,
      'OPERATION_NOT_ALLOWED_FOR_ROLE',
      'Nghiệp vụ được giao không phù hợp với vai trò hiện tại'
    );
  }
  return { propertyIds, operations };
}

function sendTeamMemberError(res, error) {
  if (!(error instanceof TeamMemberError)) return false;
  res.status(error.statusCode).json({
    error: error.message,
    code: error.code,
    ...error.details
  });
  return true;
}

async function teamRows(accountUserId, query = db.query) {
  const result = await query(
    `SELECT membership.*, member.email AS member_email
     FROM account_memberships membership
     JOIN users member ON member.id=membership.member_user_id
     WHERE membership.account_user_id=$1
     ORDER BY (membership.role='owner') DESC, member.email, membership.member_user_id`,
    [accountUserId]
  );
  return result.rows;
}

async function teamAccess(accountUserId, query = db.query) {
  const [properties, propertyAccess, operationAccess] = await Promise.all([
    query(
      `SELECT id, name, is_default
       FROM properties
       WHERE user_id=$1
       ORDER BY is_default DESC, sort_order, name, id`,
      [accountUserId]
    ),
    query(
      `SELECT member_user_id, property_id
       FROM account_member_property_access
       WHERE account_user_id=$1
       ORDER BY member_user_id, property_id`,
      [accountUserId]
    ),
    query(
      `SELECT member_user_id, operation
       FROM account_member_operation_access
       WHERE account_user_id=$1
       ORDER BY member_user_id, operation`,
      [accountUserId]
    )
  ]);
  const byMember = new Map();
  const ensure = memberUserIdValue => {
    const id = Number(memberUserIdValue);
    if (!byMember.has(id)) byMember.set(id, { propertyIds: [], operations: [] });
    return byMember.get(id);
  };
  for (const row of propertyAccess.rows) ensure(row.member_user_id).propertyIds.push(Number(row.property_id));
  for (const row of operationAccess.rows) ensure(row.member_user_id).operations.push(row.operation);
  return {
    byMember,
    properties: properties.rows.map(row => ({
      id: Number(row.id),
      name: row.name,
      isDefault: !!row.is_default
    }))
  };
}

async function staffWriteEntitlement(accountUserId, query) {
  const entitlement = await getUserEntitlements(accountUserId, query);
  if (entitlement.accessMode !== 'full') {
    throw new EntitlementError(
      'SUBSCRIPTION_READ_ONLY',
      'Gói dịch vụ đã hết hiệu lực. Tài khoản hiện chỉ có thể xem và xuất dữ liệu.',
      { accessMode: entitlement.accessMode }
    );
  }
  const feature = entitlement.features.staffManagement;
  if (!feature.enabled || feature.limit <= 0) {
    throw new TeamMemberError(
      403,
      'STAFF_FEATURE_NOT_AVAILABLE',
      `Gói ${entitlement.plan.name} chưa hỗ trợ thêm nhân viên`,
      { planCode: entitlement.plan.code, limit: feature.limit }
    );
  }
  return entitlement;
}

async function listTeamMembers(req, res, dependencies = {}) {
  const query = dependencies.query || db.query;
  const [members, entitlement, access] = await Promise.all([
    teamRows(req.userId, query),
    getUserEntitlements(req.userId, query),
    teamAccess(req.userId, query)
  ]);
  const staffLimit = Math.max(0, Number(entitlement.features.staffManagement.limit) || 0);
  const staffCount = members.filter(row => row.role !== 'owner').length;
  res.set('Cache-Control', 'no-store');
  return res.json({
    members: members.map(row => memberJson(
      row,
      row.role === 'owner'
        ? {
            propertyIds: access.properties.map(property => property.id),
            operations: ACCESS_OPERATIONS.map(operation => operation.value)
          }
        : access.byMember.get(Number(row.member_user_id))
    )),
    staffUsage: {
      used: staffCount,
      limit: staffLimit,
      remaining: Math.max(0, staffLimit - staffCount),
      canManage: !!entitlement.features.staffManagement.enabled
    },
    roles: STAFF_ROLES.map(role => ({ value: role, label: ROLE_LABELS[role] })),
    properties: access.properties,
    operations: ACCESS_OPERATIONS.map(operation => ({
      ...operation,
      roles: STAFF_ROLES.filter(role => ROLE_ALLOWED_OPERATIONS[role].includes(operation.value))
    }))
  });
}

async function createTeamMember(req, res, dependencies = {}) {
  let email;
  let role;
  try {
    email = normalizeEmail(req.body?.email);
    role = normalizeRole(req.body?.role);
  } catch (error) {
    if (sendTeamMemberError(res, error)) return res;
    throw error;
  }

  const getClient = dependencies.getClient || db.getClient;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(
         'team-write:' || $1::text, 0
       ))`,
      [req.userId]
    );
    const entitlement = await staffWriteEntitlement(req.userId, client.query.bind(client));
    const targetResult = await client.query(
      `SELECT id, email
       FROM users
       WHERE email=$1 AND email_verified_at IS NOT NULL
       LIMIT 1`,
      [email]
    );
    const target = targetResult.rows[0];
    if (!target) {
      throw new TeamMemberError(
        404,
        'MEMBER_ACCOUNT_NOT_FOUND',
        'Email này chưa có tài khoản TrọBill đã xác minh'
      );
    }
    if (Number(target.id) === Number(req.userId)) {
      throw new TeamMemberError(
        409,
        'OWNER_ROLE_IMMUTABLE',
        'Chủ tài khoản luôn giữ vai trò Chủ sở hữu'
      );
    }
    const countResult = await client.query(
      `SELECT COUNT(*)::int AS staff_count
       FROM account_memberships
       WHERE account_user_id=$1 AND role<>'owner'`,
      [req.userId]
    );
    const staffCount = Math.max(0, Number(countResult.rows[0]?.staff_count) || 0);
    const limit = entitlement.features.staffManagement.limit;
    if (staffCount >= limit) {
      throw new TeamMemberError(
        409,
        'STAFF_LIMIT_EXCEEDED',
        `Gói ${entitlement.plan.name} chỉ hỗ trợ tối đa ${limit} nhân viên`,
        { current: staffCount, limit, planCode: entitlement.plan.code }
      );
    }
    const inserted = await client.query(
      `INSERT INTO account_memberships
         (account_user_id, member_user_id, role, created_by_user_id)
       VALUES ($1,$2,$3,$1)
       RETURNING *`,
      [req.userId, target.id, role]
    );
    await client.query('COMMIT');
    return res.status(201).json({
      member: memberJson({ ...inserted.rows[0], member_email: target.email })
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendEntitlementError(res, error) || sendTeamMemberError(res, error)) return res;
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'Tài khoản này đã là thành viên',
        code: 'MEMBER_ALREADY_EXISTS'
      });
    }
    throw error;
  } finally {
    client.release();
  }
}

async function updateTeamMember(req, res, dependencies = {}) {
  let id;
  let role;
  try {
    id = memberUserId(req.params.id);
    role = normalizeRole(req.body?.role);
  } catch (error) {
    if (sendTeamMemberError(res, error)) return res;
    throw error;
  }
  if (id === Number(req.userId)) {
    return res.status(409).json({
      error: 'Không thể thay đổi vai trò Chủ sở hữu',
      code: 'OWNER_ROLE_IMMUTABLE'
    });
  }

  const getClient = dependencies.getClient || db.getClient;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(
         'team-write:' || $1::text, 0
       ))`,
      [req.userId]
    );
    await staffWriteEntitlement(req.userId, client.query.bind(client));
    const currentResult = await client.query(
      `SELECT membership.*, member.email AS member_email
       FROM account_memberships membership
       JOIN users member ON member.id=membership.member_user_id
       WHERE membership.account_user_id=$1
         AND membership.member_user_id=$2
         AND membership.role<>'owner'
       FOR UPDATE OF membership`,
      [req.userId, id]
    );
    const current = currentResult.rows[0];
    if (!current) {
      throw new TeamMemberError(404, 'TEAM_MEMBER_NOT_FOUND', 'Không tìm thấy thành viên');
    }
    if (current.role === role) {
      const accessResult = await client.query(
        `SELECT
           ARRAY(
             SELECT property_id
             FROM account_member_property_access
             WHERE account_user_id=$1 AND member_user_id=$2
             ORDER BY property_id
           ) AS property_ids,
           ARRAY(
             SELECT operation
             FROM account_member_operation_access
             WHERE account_user_id=$1 AND member_user_id=$2
             ORDER BY operation
           ) AS operations`,
        [req.userId, id]
      );
      const access = accessResult.rows[0] || {};
      await client.query('COMMIT');
      return res.json({
        member: memberJson(current, {
          propertyIds: access.property_ids,
          operations: access.operations
        }),
        accessReset: false,
        unchanged: true
      });
    }
    const updated = await client.query(
      `UPDATE account_memberships membership
       SET role=$3, updated_at=now()
       FROM users member
       WHERE membership.account_user_id=$1
         AND membership.member_user_id=$2
         AND membership.role<>'owner'
         AND member.id=membership.member_user_id
       RETURNING membership.*, member.email AS member_email`,
      [req.userId, id, role]
    );
    if (!updated.rows[0]) {
      throw new TeamMemberError(404, 'TEAM_MEMBER_NOT_FOUND', 'Không tìm thấy thành viên');
    }
    // Vai trò mới có ma trận nghiệp vụ khác. Thu hồi toàn bộ assignment cũ để
    // chủ sở hữu gán lại có chủ đích, tránh giữ quyền thừa sau khi đổi vai trò.
    await client.query(
      'DELETE FROM account_member_property_access WHERE account_user_id=$1 AND member_user_id=$2',
      [req.userId, id]
    );
    await client.query(
      'DELETE FROM account_member_operation_access WHERE account_user_id=$1 AND member_user_id=$2',
      [req.userId, id]
    );
    await client.query('COMMIT');
    return res.json({ member: memberJson(updated.rows[0]), accessReset: true });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendEntitlementError(res, error) || sendTeamMemberError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

async function updateTeamMemberAccess(req, res, dependencies = {}) {
  let id;
  try {
    id = memberUserId(req.params.id);
  } catch (error) {
    if (sendTeamMemberError(res, error)) return res;
    throw error;
  }
  if (id === Number(req.userId)) {
    return res.status(409).json({
      error: 'Chủ sở hữu luôn có toàn quyền',
      code: 'OWNER_ACCESS_IMMUTABLE'
    });
  }

  const getClient = dependencies.getClient || db.getClient;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(
         'team-write:' || $1::text, 0
       ))`,
      [req.userId]
    );
    await staffWriteEntitlement(req.userId, client.query.bind(client));
    const membershipResult = await client.query(
      `SELECT membership.*, member.email AS member_email
       FROM account_memberships membership
       JOIN users member ON member.id=membership.member_user_id
       WHERE membership.account_user_id=$1
         AND membership.member_user_id=$2
         AND membership.role<>'owner'
       FOR UPDATE OF membership`,
      [req.userId, id]
    );
    const membership = membershipResult.rows[0];
    if (!membership) {
      throw new TeamMemberError(404, 'TEAM_MEMBER_NOT_FOUND', 'Không tìm thấy thành viên');
    }
    const access = normalizeAccess(req.body, membership.role);
    if (access.propertyIds.length > 0) {
      const properties = await client.query(
        `SELECT id FROM properties
         WHERE user_id=$1 AND id=ANY($2::bigint[])`,
        [req.userId, access.propertyIds]
      );
      if (properties.rows.length !== access.propertyIds.length) {
        throw new TeamMemberError(
          400,
          'MEMBER_PROPERTY_NOT_FOUND',
          'Một hoặc nhiều khu không thuộc tài khoản này'
        );
      }
    }
    await client.query(
      'DELETE FROM account_member_property_access WHERE account_user_id=$1 AND member_user_id=$2',
      [req.userId, id]
    );
    await client.query(
      'DELETE FROM account_member_operation_access WHERE account_user_id=$1 AND member_user_id=$2',
      [req.userId, id]
    );
    if (access.propertyIds.length > 0) {
      await client.query(
        `INSERT INTO account_member_property_access
           (account_user_id, member_user_id, property_id, created_by_user_id)
         SELECT $1, $2, property_id, $1
         FROM unnest($3::bigint[]) AS property_id`,
        [req.userId, id, access.propertyIds]
      );
    }
    if (access.operations.length > 0) {
      await client.query(
        `INSERT INTO account_member_operation_access
           (account_user_id, member_user_id, operation, created_by_user_id)
         SELECT $1, $2, operation, $1
         FROM unnest($3::text[]) AS operation`,
        [req.userId, id, access.operations]
      );
    }
    await client.query('COMMIT');
    return res.json({ member: memberJson(membership, access) });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendEntitlementError(res, error) || sendTeamMemberError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

async function deleteTeamMember(req, res, dependencies = {}) {
  let id;
  try {
    id = memberUserId(req.params.id);
  } catch (error) {
    if (sendTeamMemberError(res, error)) return res;
    throw error;
  }
  if (id === Number(req.userId)) {
    return res.status(409).json({
      error: 'Không thể xóa Chủ sở hữu khỏi tài khoản',
      code: 'OWNER_ROLE_IMMUTABLE'
    });
  }

  const getClient = dependencies.getClient || db.getClient;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(
         'team-write:' || $1::text, 0
       ))`,
      [req.userId]
    );
    // Thu hồi thành viên là thao tác bảo mật, luôn cho phép kể cả khi gói đã
    // hết hạn hoặc bị hạ xuống gói không còn tính năng quản lý nhân viên.
    const removed = await client.query(
      `DELETE FROM account_memberships
       WHERE account_user_id=$1 AND member_user_id=$2 AND role<>'owner'
       RETURNING member_user_id`,
      [req.userId, id]
    );
    if (!removed.rows[0]) {
      throw new TeamMemberError(404, 'TEAM_MEMBER_NOT_FOUND', 'Không tìm thấy thành viên');
    }
    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendEntitlementError(res, error) || sendTeamMemberError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  ROLE_LABELS,
  ACCESS_OPERATIONS,
  ROLE_ALLOWED_OPERATIONS,
  STAFF_ROLES,
  TeamMemberError,
  createTeamMember,
  deleteTeamMember,
  listTeamMembers,
  memberJson,
  normalizeAccess,
  normalizeEmail,
  normalizeRole,
  teamRows,
  teamAccess,
  updateTeamMemberAccess,
  updateTeamMember
};
