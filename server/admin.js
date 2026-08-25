'use strict';

// ============================================================
//  API dành cho admin — tất cả route dùng requireAuth + requireAdmin
// ============================================================
const bcrypt = require('bcryptjs');
const db = require('./db');
const { buildState } = require('./state');
const { keyHash, requestIp } = require('./rate-limit');
const { recordDataAudit, requestAuditContext } = require('./data-audit');
const { resolveLifecycle } = require('./subscription');

// GET /api/admin/users — danh sách user + vài số liệu tóm tắt
async function listUsers(req, res) {
  const { rows } = await db.query(
    `SELECT u.id, u.email, u.is_admin, u.created_at,
            s.id AS subscription_id, s.status AS subscription_status,
            s.billing_cycle, s.starts_at AS subscription_starts_at,
            s.ends_at AS subscription_ends_at, s.trial_used_at,
            p.code AS plan_code, p.name AS plan_name, p.room_limit,
            p.trial_days,
            (SELECT COUNT(*)::int FROM rooms r WHERE r.user_id = u.id)              AS room_count,
            (SELECT COUNT(*)::int FROM history_snapshots h WHERE h.user_id = u.id)  AS history_count
     FROM users u
     LEFT JOIN subscriptions s ON s.user_id=u.id
     LEFT JOIN plans p ON p.id=s.plan_id
     ORDER BY u.id`
  );
  res.set('Cache-Control', 'no-store');
  res.json({
    users: rows.map((u) => {
      const lifecycle = u.subscription_id === null
        ? null
        : resolveLifecycle({
          status: u.subscription_status,
          ends_at: u.subscription_ends_at
        });
      return {
        id: Number(u.id),
        email: u.email,
        isAdmin: !!u.is_admin,
        createdAt: u.created_at,
        roomCount: Number(u.room_count) || 0,
        historyCount: Number(u.history_count) || 0,
        subscription: u.subscription_id === null ? null : {
          id: Number(u.subscription_id),
          planCode: u.plan_code,
          planName: u.plan_name,
          roomLimit: Number(u.room_limit) || 0,
          trialDays: Number(u.trial_days) || 0,
          status: lifecycle.status,
          recordedStatus: lifecycle.sourceStatus,
          billingCycle: u.billing_cycle || null,
          startsAt: u.subscription_starts_at,
          endsAt: u.subscription_ends_at,
          trialUsed: !!u.trial_used_at
        }
      };
    })
  });
}

// GET /api/admin/users/:id/state — CCCD luôn bị che trong màn hình hỗ trợ.
async function getUserState(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID không hợp lệ' });

  const found = await db.query('SELECT id, email FROM users WHERE id=$1', [id]);
  if (found.rowCount === 0) return res.status(404).json({ error: 'Không tìm thấy user' });

  const state = await buildState(id, { maskCccd: true });
  res.set('Cache-Control', 'no-store');
  res.json({ user: { id, email: found.rows[0].email }, state });
}

// POST /api/admin/users/:id/tenants/:tenantId/reveal-cccd
async function revealTenantCccd(req, res) {
  const targetUserId = Number(req.params.id);
  const tenantId = String(req.params.tenantId || '').trim();
  const reason = String(req.body.reason || '').trim();
  if (!Number.isInteger(targetUserId) || !tenantId) {
    return res.status(400).json({ error: 'Đối tượng hỗ trợ không hợp lệ' });
  }
  if (reason.length < 10 || reason.length > 500) {
    return res.status(400).json({ error: 'Lý do hỗ trợ phải từ 10 đến 500 ký tự' });
  }

  const { rows } = await db.query(
    `SELECT t.id, t.full_name, t.cccd, u.email AS target_email
     FROM tenants t
     JOIN users u ON u.id=t.user_id
     WHERE t.user_id=$1 AND t.id=$2`,
    [targetUserId, tenantId]
  );
  const tenant = rows[0];
  if (!tenant) return res.status(404).json({ error: 'Không tìm thấy khách thuê của tài khoản này' });

  const userAgent = String(req.get('user-agent') || '').slice(0, 500);
  const ipHash = keyHash('sensitive-access', 'ip', requestIp(req));
  await db.query(
    `INSERT INTO admin_sensitive_access_logs
       (admin_user_id, admin_email_snapshot, target_user_id, target_email_snapshot,
        tenant_id, tenant_name_snapshot, action, reason, request_ip_hash, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,'reveal_cccd',$7,$8,$9)`,
    [
      req.userId,
      req.userEmail,
      targetUserId,
      tenant.target_email,
      tenant.id,
      tenant.full_name || '',
      reason,
      ipHash,
      userAgent
    ]
  );
  await db.query(
    `DELETE FROM admin_sensitive_access_logs
     WHERE created_at < now() - interval '365 days'`
  );

  res.set('Cache-Control', 'no-store');
  return res.json({
    tenantId: tenant.id,
    fullName: tenant.full_name || '',
    cccd: tenant.cccd || '',
    audited: true
  });
}

// GET /api/admin/sensitive-access-logs — danh sách để chủ sản phẩm rà soát.
async function listSensitiveAccessLogs(req, res) {
  const requestedLimit = Number(req.query.limit || 100);
  const limit = Number.isInteger(requestedLimit) ? Math.min(200, Math.max(1, requestedLimit)) : 100;
  const { rows } = await db.query(
    `SELECT id, admin_user_id, admin_email_snapshot, target_user_id,
            target_email_snapshot, tenant_id, tenant_name_snapshot, action,
            reason, request_ip_hash, created_at
     FROM admin_sensitive_access_logs
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  res.set('Cache-Control', 'no-store');
  return res.json({
    logs: rows.map((row) => ({
      id: Number(row.id),
      adminUserId: row.admin_user_id === null ? null : Number(row.admin_user_id),
      adminEmail: row.admin_email_snapshot,
      targetUserId: row.target_user_id === null ? null : Number(row.target_user_id),
      targetEmail: row.target_email_snapshot,
      tenantId: row.tenant_id,
      tenantName: row.tenant_name_snapshot,
      action: row.action,
      reason: row.reason,
      ipFingerprint: String(row.request_ip_hash || '').slice(0, 12),
      createdAt: row.created_at
    }))
  });
}

// DELETE /api/admin/users/:id — xoá user (cascade dọn toàn bộ dữ liệu con)
async function deleteUser(req, res) {
  const id = Number(req.params.id);
  const reason = String(req.body.reason || '').trim();
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID không hợp lệ' });
  if (id === Number(req.userId)) return res.status(400).json({ error: 'Không thể tự xoá chính mình' });
  if (reason.length < 10 || reason.length > 500) {
    return res.status(400).json({ error: 'Lý do xóa tài khoản phải từ 10 đến 500 ký tự' });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const target = await client.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [id]);
    if (target.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Không tìm thấy user' });
    }
    await recordDataAudit(client.query.bind(client), {
      actorUserId: req.userId,
      actorEmail: req.userEmail,
      subjectUserId: id,
      action: 'admin_account_delete',
      resourceType: 'account',
      resourceId: String(id),
      purpose: reason,
      ...requestAuditContext(req)
    });
    await client.query('DELETE FROM users WHERE id=$1', [id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  res.json({ ok: true });
}

// POST /api/admin/users/:id/password — đặt lại mật khẩu cho user
async function resetPassword(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID không hợp lệ' });
  const password = String(req.body.password || '');
  if (password.length < 6) return res.status(400).json({ error: 'Mật khẩu tối thiểu 6 ký tự' });

  const hash = await bcrypt.hash(password, 10);
  const r = await db.query(
    'UPDATE users SET password_hash=$1, token_version=token_version + 1 WHERE id=$2',
    [hash, id]
  );
  if (r.rowCount === 0) return res.status(404).json({ error: 'Không tìm thấy user' });
  res.json({ ok: true });
}

// POST /api/admin/users/:id/admin — bật/tắt quyền admin
async function setAdmin(req, res) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID không hợp lệ' });
  const makeAdmin = !!req.body.isAdmin;
  if (id === Number(req.userId) && !makeAdmin) {
    return res.status(400).json({ error: 'Không thể tự gỡ quyền admin của chính mình' });
  }
  const r = await db.query('UPDATE users SET is_admin=$1 WHERE id=$2', [makeAdmin, id]);
  if (r.rowCount === 0) return res.status(404).json({ error: 'Không tìm thấy user' });
  res.json({ ok: true, isAdmin: makeAdmin });
}

module.exports = {
  listUsers,
  getUserState,
  revealTenantCccd,
  listSensitiveAccessLogs,
  deleteUser,
  resetPassword,
  setAdmin
};
