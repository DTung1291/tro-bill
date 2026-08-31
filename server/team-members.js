'use strict';

const db = require('./db');
const {
  EntitlementError,
  getUserEntitlements,
  sendEntitlementError
} = require('./subscription');

const STAFF_ROLES = Object.freeze(['manager', 'accountant', 'meter_reader']);
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

function memberJson(row) {
  return {
    userId: Number(row.member_user_id),
    email: row.member_email,
    role: row.role,
    roleLabel: ROLE_LABELS[row.role] || row.role,
    isOwner: row.role === 'owner',
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
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
  const [members, entitlement] = await Promise.all([
    teamRows(req.userId, query),
    getUserEntitlements(req.userId, query)
  ]);
  const staffLimit = Math.max(0, Number(entitlement.features.staffManagement.limit) || 0);
  const staffCount = members.filter(row => row.role !== 'owner').length;
  res.set('Cache-Control', 'no-store');
  return res.json({
    members: members.map(memberJson),
    staffUsage: {
      used: staffCount,
      limit: staffLimit,
      remaining: Math.max(0, staffLimit - staffCount),
      canManage: !!entitlement.features.staffManagement.enabled
    },
    roles: STAFF_ROLES.map(role => ({ value: role, label: ROLE_LABELS[role] }))
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
    await client.query('COMMIT');
    return res.json({ member: memberJson(updated.rows[0]) });
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
  STAFF_ROLES,
  TeamMemberError,
  createTeamMember,
  deleteTeamMember,
  listTeamMembers,
  memberJson,
  normalizeEmail,
  normalizeRole,
  teamRows,
  updateTeamMember
};
