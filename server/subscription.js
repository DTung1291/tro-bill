'use strict';

const db = require('./db');

const WRITABLE_STATUSES = new Set(['trialing', 'active', 'grace_period']);

class EntitlementError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'EntitlementError';
    this.code = code;
    this.statusCode = 403;
    this.details = details;
  }
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function resolveEntitlements(row, now = new Date()) {
  if (!row) {
    throw new EntitlementError(
      'SUBSCRIPTION_REQUIRED',
      'Tài khoản chưa có gói dịch vụ. Vui lòng liên hệ hỗ trợ.'
    );
  }

  const endsAt = row.ends_at ? new Date(row.ends_at) : null;
  const endedByDate = !!endsAt && !Number.isNaN(endsAt.getTime()) && endsAt <= now;
  const writable = WRITABLE_STATUSES.has(row.status) && !endedByDate;
  const roomLimit = Math.max(0, Number(row.room_limit) || 0);
  const staffLimit = Math.max(0, Number(row.staff_limit) || 0);

  return {
    subscription: {
      id: Number(row.subscription_id),
      status: row.status,
      startsAt: toIso(row.starts_at),
      endsAt: toIso(row.ends_at)
    },
    plan: {
      id: Number(row.plan_id),
      code: row.plan_code,
      name: row.plan_name,
      roomLimit,
      staffLimit
    },
    accessMode: writable ? 'full' : 'read_only',
    features: {
      roomManagement: { enabled: writable, limit: roomLimit },
      staffManagement: { enabled: writable && staffLimit > 0, limit: staffLimit },
      dataExport: { enabled: true }
    }
  };
}

async function getUserEntitlements(userId, query = db.query, now = new Date()) {
  const { rows } = await query(
    `SELECT s.id AS subscription_id, s.status, s.starts_at, s.ends_at,
            p.id AS plan_id, p.code AS plan_code, p.name AS plan_name,
            p.room_limit, p.staff_limit
     FROM subscriptions s
     JOIN plans p ON p.id = s.plan_id
     WHERE s.user_id = $1
     LIMIT 1`,
    [userId]
  );
  return resolveEntitlements(rows[0], now);
}

async function enforceStateWrite(userId, roomCount, query = db.query, now = new Date()) {
  const entitlement = await getUserEntitlements(userId, query, now);
  if (entitlement.accessMode !== 'full') {
    throw new EntitlementError(
      'SUBSCRIPTION_READ_ONLY',
      'Gói dịch vụ đã hết hiệu lực. Tài khoản hiện chỉ có thể xem và xuất dữ liệu.',
      { accessMode: entitlement.accessMode }
    );
  }

  const limit = entitlement.features.roomManagement.limit;
  if (roomCount > limit) {
    throw new EntitlementError(
      'ROOM_LIMIT_EXCEEDED',
      `Gói ${entitlement.plan.name} chỉ hỗ trợ tối đa ${limit} phòng.`,
      { current: roomCount, limit, planCode: entitlement.plan.code }
    );
  }
  return entitlement;
}

function sendEntitlementError(res, error) {
  if (!(error instanceof EntitlementError)) return false;
  res.status(error.statusCode).json({
    error: error.message,
    code: error.code,
    ...error.details
  });
  return true;
}

async function getSubscription(req, res) {
  try {
    return res.json(await getUserEntitlements(req.userId));
  } catch (error) {
    if (sendEntitlementError(res, error)) return res;
    throw error;
  }
}

module.exports = {
  EntitlementError,
  enforceStateWrite,
  getSubscription,
  getUserEntitlements,
  resolveEntitlements,
  sendEntitlementError
};
