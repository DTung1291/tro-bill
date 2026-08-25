'use strict';

const db = require('./db');

const WRITABLE_STATUSES = new Set(['trialing', 'active', 'grace_period']);
const DAY_MS = 24 * 60 * 60 * 1000;
const EXPIRING_SOON_DAYS = 7;
const GRACE_PERIOD_DAYS = 3;

class EntitlementError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'EntitlementError';
    this.code = code;
    this.statusCode = 403;
    this.details = details;
  }
}

class SubscriptionOperationError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'SubscriptionOperationError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function toIso(value) {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function daysBetween(later, earlier) {
  return Math.max(0, Math.ceil((later.getTime() - earlier.getTime()) / DAY_MS));
}

function resolveLifecycle(row, now = new Date()) {
  const sourceStatus = row.status;
  const parsedEnd = row.ends_at ? new Date(row.ends_at) : null;
  const endsAt = parsedEnd && !Number.isNaN(parsedEnd.getTime()) ? parsedEnd : null;
  const graceEndsAt = endsAt
    ? new Date(endsAt.getTime() + GRACE_PERIOD_DAYS * DAY_MS)
    : null;

  let status = sourceStatus;
  if (sourceStatus === 'expired' || sourceStatus === 'canceled') {
    status = sourceStatus;
  } else if (sourceStatus === 'trialing') {
    if (endsAt && endsAt <= now) status = 'expired';
    else if (endsAt && daysBetween(endsAt, now) <= EXPIRING_SOON_DAYS) status = 'expiring_soon';
  } else if (sourceStatus === 'active') {
    if (endsAt && endsAt <= now) {
      status = graceEndsAt && graceEndsAt > now ? 'grace_period' : 'expired';
    } else if (endsAt && daysBetween(endsAt, now) <= EXPIRING_SOON_DAYS) {
      status = 'expiring_soon';
    }
  } else if (sourceStatus === 'grace_period') {
    status = graceEndsAt && graceEndsAt > now ? 'grace_period' : 'expired';
  }

  return {
    status,
    sourceStatus,
    expiringSoon: status === 'expiring_soon',
    daysRemaining: endsAt && endsAt > now ? daysBetween(endsAt, now) : 0,
    graceDaysRemaining: status === 'grace_period' && graceEndsAt
      ? daysBetween(graceEndsAt, now)
      : 0,
    graceEndsAt: status === 'grace_period' ? toIso(graceEndsAt) : null
  };
}

function resolveEntitlements(row, now = new Date()) {
  if (!row) {
    throw new EntitlementError(
      'SUBSCRIPTION_REQUIRED',
      'Tài khoản chưa có gói dịch vụ. Vui lòng liên hệ hỗ trợ.'
    );
  }

  const lifecycle = resolveLifecycle(row, now);
  const writable = WRITABLE_STATUSES.has(lifecycle.status)
    || lifecycle.status === 'expiring_soon';
  const roomLimit = Math.max(0, Number(row.room_limit) || 0);
  const staffLimit = Math.max(0, Number(row.staff_limit) || 0);
  const roomCount = Math.max(0, Number(row.room_count) || 0);

  return {
    subscription: {
      id: Number(row.subscription_id),
      status: lifecycle.status,
      recordedStatus: lifecycle.sourceStatus,
      billingCycle: row.billing_cycle || null,
      startsAt: toIso(row.starts_at),
      endsAt: toIso(row.ends_at),
      expiringSoon: lifecycle.expiringSoon,
      daysRemaining: lifecycle.daysRemaining,
      graceDaysRemaining: lifecycle.graceDaysRemaining,
      graceEndsAt: lifecycle.graceEndsAt
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
      roomManagement: {
        enabled: writable,
        limit: roomLimit,
        used: roomCount,
        remaining: Math.max(0, roomLimit - roomCount)
      },
      staffManagement: { enabled: writable && staffLimit > 0, limit: staffLimit },
      dataExport: { enabled: true }
    }
  };
}

async function getUserEntitlements(userId, query = db.query, now = new Date()) {
  const { rows } = await query(
    `SELECT s.id AS subscription_id, s.status, s.billing_cycle, s.starts_at, s.ends_at,
            p.id AS plan_id, p.code AS plan_code, p.name AS plan_name,
            p.room_limit, p.staff_limit,
            (SELECT COUNT(*)::int FROM rooms r WHERE r.user_id=s.user_id) AS room_count
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

function trialRequest(req) {
  const targetUserId = Number(req.params.id);
  const planCode = String(req.body?.planCode || '').trim().toLowerCase();
  const reason = String(req.body?.reason || '').trim();
  const rawDays = req.body?.days;
  const days = rawDays === undefined || rawDays === null || rawDays === ''
    ? null
    : Number(rawDays);

  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    throw new SubscriptionOperationError(400, 'INVALID_USER_ID', 'ID tài khoản không hợp lệ');
  }
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(planCode)) {
    throw new SubscriptionOperationError(400, 'INVALID_PLAN_CODE', 'Mã gói không hợp lệ');
  }
  if (reason.length < 10 || reason.length > 500) {
    throw new SubscriptionOperationError(
      400,
      'INVALID_REASON',
      'Lý do cấp dùng thử phải từ 10 đến 500 ký tự'
    );
  }
  if (days !== null && (!Number.isInteger(days) || days < 14 || days > 30)) {
    throw new SubscriptionOperationError(
      400,
      'INVALID_TRIAL_DAYS',
      'Thời gian dùng thử phải từ 14 đến 30 ngày'
    );
  }
  return { targetUserId, planCode, reason, days };
}

function sendOperationError(res, error) {
  if (!(error instanceof SubscriptionOperationError)) return false;
  res.status(error.statusCode).json({ error: error.message, code: error.code });
  return true;
}

// POST /api/admin/users/:id/subscription/trial
// Cấp trial và audit trong cùng transaction để không thể đổi gói mà mất dấu.
async function startTrial(req, res) {
  let input;
  try {
    input = trialRequest(req);
  } catch (error) {
    if (sendOperationError(res, error)) return res;
    throw error;
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    const targetResult = await client.query(
      'SELECT id, email FROM users WHERE id=$1 FOR UPDATE',
      [input.targetUserId]
    );
    const target = targetResult.rows[0];
    if (!target) {
      throw new SubscriptionOperationError(404, 'USER_NOT_FOUND', 'Không tìm thấy tài khoản');
    }

    const planResult = await client.query(
      `SELECT id, code, name, trial_days
       FROM plans
       WHERE code=$1
       FOR SHARE`,
      [input.planCode]
    );
    const plan = planResult.rows[0];
    if (!plan) {
      throw new SubscriptionOperationError(404, 'PLAN_NOT_FOUND', 'Không tìm thấy gói dịch vụ');
    }
    const configuredDays = Number(plan.trial_days) || 0;
    if (plan.code === 'free' || configuredDays === 0) {
      throw new SubscriptionOperationError(
        409,
        'TRIAL_NOT_AVAILABLE',
        'Gói này không hỗ trợ dùng thử'
      );
    }
    const trialDays = input.days ?? configuredDays;
    if (!Number.isInteger(trialDays) || trialDays < 14 || trialDays > 30) {
      throw new SubscriptionOperationError(
        409,
        'TRIAL_CONFIGURATION_INVALID',
        'Cấu hình thời gian dùng thử của gói không hợp lệ'
      );
    }

    const currentResult = await client.query(
      `SELECT s.status, s.trial_used_at, p.code AS plan_code
       FROM subscriptions s
       JOIN plans p ON p.id=s.plan_id
       WHERE s.user_id=$1
       FOR UPDATE OF s`,
      [input.targetUserId]
    );
    const current = currentResult.rows[0] || null;
    if (current?.trial_used_at || current?.status === 'trialing') {
      throw new SubscriptionOperationError(
        409,
        'TRIAL_ALREADY_USED',
        'Tài khoản này đã sử dụng quyền dùng thử'
      );
    }

    const subscriptionResult = await client.query(
      `INSERT INTO subscriptions
         (user_id, plan_id, status, starts_at, ends_at, trial_used_at)
       VALUES ($1,$2,'trialing',now(),now() + ($3::integer * interval '1 day'),now())
       ON CONFLICT (user_id) DO UPDATE SET
         plan_id=EXCLUDED.plan_id,
         status='trialing',
         starts_at=EXCLUDED.starts_at,
         ends_at=EXCLUDED.ends_at,
         trial_used_at=EXCLUDED.trial_used_at,
         updated_at=now()
       RETURNING id, status, starts_at, ends_at`,
      [input.targetUserId, plan.id, trialDays]
    );
    const subscription = subscriptionResult.rows[0];

    await client.query(
      `INSERT INTO subscription_change_logs
         (actor_user_id, actor_email_snapshot, target_user_id, target_email_snapshot,
          action, previous_plan_code, new_plan_code, previous_status, new_status,
          reason, metadata)
       VALUES ($1,$2,$3,$4,'trial_started',$5,$6,$7,'trialing',$8,$9::jsonb)`,
      [
        req.userId,
        String(req.userEmail || ''),
        input.targetUserId,
        target.email,
        current?.plan_code || null,
        plan.code,
        current?.status || null,
        input.reason,
        JSON.stringify({ trialDays })
      ]
    );

    await client.query('COMMIT');
    return res.json({
      ok: true,
      audited: true,
      target: { id: Number(target.id), email: target.email },
      subscription: {
        id: Number(subscription.id),
        planCode: plan.code,
        planName: plan.name,
        status: subscription.status,
        startsAt: toIso(subscription.starts_at),
        endsAt: toIso(subscription.ends_at),
        trialDays
      }
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // Lỗi gốc vẫn quan trọng hơn lỗi rollback; middleware sẽ ghi incident.
    }
    if (sendOperationError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

function subscriptionChangeRequest(req) {
  const targetUserId = Number(req.params.id);
  const operation = String(req.body?.operation || '').trim().toLowerCase();
  const planCode = String(req.body?.planCode || '').trim().toLowerCase();
  const billingCycle = String(req.body?.billingCycle || '').trim().toLowerCase();
  const reason = String(req.body?.reason || '').trim();

  if (!Number.isInteger(targetUserId) || targetUserId <= 0) {
    throw new SubscriptionOperationError(400, 'INVALID_USER_ID', 'ID tài khoản không hợp lệ');
  }
  if (!['upgrade', 'renew'].includes(operation)) {
    throw new SubscriptionOperationError(
      400,
      'INVALID_SUBSCRIPTION_OPERATION',
      'Thao tác phải là nâng gói hoặc gia hạn'
    );
  }
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(planCode)) {
    throw new SubscriptionOperationError(400, 'INVALID_PLAN_CODE', 'Mã gói không hợp lệ');
  }
  if (!['monthly', 'yearly'].includes(billingCycle)) {
    throw new SubscriptionOperationError(
      400,
      'INVALID_BILLING_CYCLE',
      'Chu kỳ thanh toán phải là tháng hoặc năm'
    );
  }
  if (reason.length < 10 || reason.length > 500) {
    throw new SubscriptionOperationError(
      400,
      'INVALID_REASON',
      'Lý do thay đổi gói phải từ 10 đến 500 ký tự'
    );
  }
  return { targetUserId, operation, planCode, billingCycle, reason };
}

// POST /api/admin/users/:id/subscription/change
// Nâng gói có hiệu lực ngay nhưng chu kỳ mới luôn cộng sau thời gian còn lại.
async function changeSubscription(req, res) {
  let input;
  try {
    input = subscriptionChangeRequest(req);
  } catch (error) {
    if (sendOperationError(res, error)) return res;
    throw error;
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const targetResult = await client.query(
      'SELECT id, email FROM users WHERE id=$1 FOR UPDATE',
      [input.targetUserId]
    );
    const target = targetResult.rows[0];
    if (!target) {
      throw new SubscriptionOperationError(404, 'USER_NOT_FOUND', 'Không tìm thấy tài khoản');
    }

    const planResult = await client.query(
      `SELECT id, code, name, room_limit
       FROM plans
       WHERE code=$1
       FOR SHARE`,
      [input.planCode]
    );
    const plan = planResult.rows[0];
    if (!plan) {
      throw new SubscriptionOperationError(404, 'PLAN_NOT_FOUND', 'Không tìm thấy gói dịch vụ');
    }
    if (plan.code === 'free') {
      throw new SubscriptionOperationError(
        409,
        'PAID_PLAN_REQUIRED',
        'Nâng gói và gia hạn chỉ áp dụng cho gói trả phí'
      );
    }

    const currentResult = await client.query(
      `SELECT s.id, s.status, s.starts_at, s.ends_at, s.billing_cycle,
              p.id AS plan_id, p.code AS plan_code, p.name AS plan_name,
              p.room_limit
       FROM subscriptions s
       JOIN plans p ON p.id=s.plan_id
       WHERE s.user_id=$1
       FOR UPDATE OF s`,
      [input.targetUserId]
    );
    const current = currentResult.rows[0];
    if (!current) {
      throw new SubscriptionOperationError(
        409,
        'SUBSCRIPTION_REQUIRED',
        'Tài khoản chưa có gói dịch vụ hiện tại'
      );
    }

    if (input.operation === 'renew' && current.plan_code !== plan.code) {
      throw new SubscriptionOperationError(
        409,
        'RENEW_PLAN_MISMATCH',
        'Gia hạn phải dùng đúng gói hiện tại; hãy chọn nâng gói nếu muốn đổi gói'
      );
    }
    if (input.operation === 'upgrade') {
      if (current.plan_code === plan.code) {
        throw new SubscriptionOperationError(
          409,
          'UPGRADE_SAME_PLAN',
          'Tài khoản đã dùng gói này; hãy chọn gia hạn'
        );
      }
      if (Number(plan.room_limit) < Number(current.room_limit)) {
        throw new SubscriptionOperationError(
          409,
          'PLAN_NOT_UPGRADE',
          'Gói mới có giới hạn phòng thấp hơn gói hiện tại'
        );
      }
    }

    const updatedResult = await client.query(
      `UPDATE subscriptions
       SET plan_id=$2,
           status='active',
           billing_cycle=$4,
           starts_at=CASE
             WHEN $3='upgrade' OR ends_at IS NULL OR ends_at <= now() THEN now()
             ELSE starts_at
           END,
           ends_at=(CASE
             WHEN ends_at IS NOT NULL AND ends_at > now() THEN ends_at
             ELSE now()
           END) + CASE
             WHEN $4='monthly' THEN interval '1 month'
             ELSE interval '1 year'
           END,
           updated_at=now()
       WHERE user_id=$1
       RETURNING id, status, billing_cycle, starts_at, ends_at`,
      [input.targetUserId, plan.id, input.operation, input.billingCycle]
    );
    const subscription = updatedResult.rows[0];
    const action = input.operation === 'upgrade'
      ? 'subscription_upgraded'
      : 'subscription_renewed';

    await client.query(
      `INSERT INTO subscription_change_logs
         (actor_user_id, actor_email_snapshot, target_user_id, target_email_snapshot,
          action, previous_plan_code, new_plan_code, previous_status, new_status,
          reason, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10::jsonb)`,
      [
        req.userId,
        String(req.userEmail || ''),
        input.targetUserId,
        target.email,
        action,
        current.plan_code,
        plan.code,
        current.status,
        input.reason,
        JSON.stringify({ billingCycle: input.billingCycle })
      ]
    );

    await client.query('COMMIT');
    return res.json({
      ok: true,
      audited: true,
      operation: input.operation,
      target: { id: Number(target.id), email: target.email },
      subscription: {
        id: Number(subscription.id),
        planCode: plan.code,
        planName: plan.name,
        status: subscription.status,
        billingCycle: subscription.billing_cycle,
        startsAt: toIso(subscription.starts_at),
        endsAt: toIso(subscription.ends_at)
      }
    });
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (_) {
      // Giữ lỗi gốc để middleware ghi nhận đúng incident.
    }
    if (sendOperationError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

// GET /api/admin/subscription/manual-change-logs
// Chỉ trả những thao tác cấp/gia hạn thủ công do admin thực hiện. Metadata được
// thu hẹp về chu kỳ/số ngày trial để không vô tình mở rộng dữ liệu audit ra UI.
async function listAdminManualChangeLogs(req, res) {
  const requestedLimit = Number(req.query?.limit || 100);
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(200, Math.max(1, requestedLimit))
    : 100;
  const { rows } = await db.query(
    `SELECT id, actor_user_id, actor_email_snapshot, target_user_id,
            target_email_snapshot, action, previous_plan_code, new_plan_code,
            previous_status, new_status, reason, metadata, created_at
     FROM subscription_change_logs
     WHERE actor_user_id IS NOT NULL
       AND action IN ('trial_started', 'subscription_upgraded', 'subscription_renewed')
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  res.set('Cache-Control', 'no-store');
  return res.json({
    changeLogs: rows.map((row) => {
      const metadata = row.metadata && typeof row.metadata === 'object'
        ? row.metadata
        : {};
      return {
        id: Number(row.id),
        actorUserId: row.actor_user_id === null ? null : Number(row.actor_user_id),
        actorEmail: row.actor_email_snapshot,
        targetUserId: row.target_user_id === null ? null : Number(row.target_user_id),
        targetEmail: row.target_email_snapshot,
        action: row.action,
        previousPlanCode: row.previous_plan_code || null,
        newPlanCode: row.new_plan_code || null,
        previousStatus: row.previous_status || null,
        newStatus: row.new_status || null,
        reason: row.reason,
        billingCycle: ['monthly', 'yearly'].includes(metadata.billingCycle)
          ? metadata.billingCycle
          : null,
        trialDays: Number.isInteger(Number(metadata.trialDays))
          ? Number(metadata.trialDays)
          : null,
        createdAt: row.created_at
      };
    })
  });
}

module.exports = {
  EntitlementError,
  SubscriptionOperationError,
  changeSubscription,
  enforceStateWrite,
  getSubscription,
  getUserEntitlements,
  listAdminManualChangeLogs,
  resolveEntitlements,
  resolveLifecycle,
  sendEntitlementError,
  subscriptionChangeRequest,
  startTrial,
  trialRequest
};
