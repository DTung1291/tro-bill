'use strict';

const bcrypt = require('bcryptjs');
const db = require('./db');
const { clearSessionCookie } = require('./auth');
const { recordDataAudit, requestAuditContext } = require('./data-audit');
const {
  AUDIT_RETENTION_DAYS,
  BACKUP_RETENTION_DAYS,
  PRIMARY_DATA_RETENTION,
  PRIVACY_POLICY_VERSION,
  TENANT_DATA_NOTICE_VERSION,
  TERMS_VERSION
} = require('./privacy-constants');
const { buildState } = require('./state');
const { loadRentPaymentExport } = require('./rent-payments');
const { loadDepositExport } = require('./deposits');
const { loadRentalHandoverExport } = require('./rental-handovers');
const { loadRentalLifecycleExport } = require('./rental-lifecycle');
const { loadRentalFinalSettlementExport } = require('./rental-final-settlements');
const { loadMaintenanceExport } = require('./room-maintenance');
const { loadRoomAssetsExport } = require('./room-assets');
const {
  checkAuthRateLimit,
  clearAccountRateLimit,
  recordAuthAttempt
} = require('./rate-limit');

function auditEntry(req, action, resourceType, resourceId = '', extra = {}) {
  return {
    actorUserId: req.userId,
    actorEmail: req.userEmail,
    subjectUserId: req.userId,
    action,
    resourceType,
    resourceId,
    ...requestAuditContext(req),
    ...extra
  };
}

async function verifyCurrentPassword(userId, password, query = db.query) {
  const { rows } = await query(
    'SELECT password_hash FROM users WHERE id=$1',
    [userId]
  );
  return !!rows[0] && bcrypt.compare(String(password || ''), rows[0].password_hash);
}

async function requireCurrentPassword(req, res) {
  if (!(await checkAuthRateLimit(req, res, 'sensitive', req.userEmail))) return false;
  if (!(await verifyCurrentPassword(req.userId, req.body.password))) {
    if (!(await recordAuthAttempt(req, res, 'sensitive', req.userEmail))) return false;
    res.status(403).json({ error: 'Mật khẩu hiện tại không đúng' });
    return false;
  }
  await clearAccountRateLimit('sensitive', req.userEmail);
  return true;
}

async function getPrivacyStatus(req, res) {
  const { rows } = await db.query(
    `SELECT privacy_policy_version, privacy_accepted_at,
            terms_version, terms_accepted_at
     FROM users WHERE id=$1`,
    [req.userId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
  return res.json({
    policyVersion: PRIVACY_POLICY_VERSION,
    termsVersion: TERMS_VERSION,
    tenantDataNoticeVersion: TENANT_DATA_NOTICE_VERSION,
    accepted: rows[0].privacy_policy_version === PRIVACY_POLICY_VERSION &&
      rows[0].terms_version === TERMS_VERSION,
    privacyAcceptedAt: rows[0].privacy_accepted_at,
    termsAcceptedAt: rows[0].terms_accepted_at,
    retention: {
      primaryData: PRIMARY_DATA_RETENTION,
      backupDays: BACKUP_RETENTION_DAYS,
      auditDays: AUDIT_RETENTION_DAYS
    }
  });
}

async function acceptPolicies(req, res) {
  if (req.body.acceptPrivacy !== true || req.body.acceptTerms !== true) {
    return res.status(400).json({ error: 'Bạn phải đồng ý Chính sách bảo mật và Điều khoản sử dụng' });
  }
  await db.query(
    `UPDATE users
     SET privacy_policy_version=$2, privacy_accepted_at=now(),
         terms_version=$3, terms_accepted_at=now()
     WHERE id=$1`,
    [req.userId, PRIVACY_POLICY_VERSION, TERMS_VERSION]
  );
  await recordDataAudit(db.query, auditEntry(req, 'policy_accept', 'account'));
  return res.json({ ok: true, policyVersion: PRIVACY_POLICY_VERSION, termsVersion: TERMS_VERSION });
}

async function revealTenantCccd(req, res) {
  const tenantId = String(req.params.tenantId || '').trim();
  const purpose = String(req.body.purpose || '').trim().toLowerCase();
  if (!tenantId || !['view', 'edit'].includes(purpose)) {
    return res.status(400).json({ error: 'Mục đích xem CCCD không hợp lệ' });
  }
  const { rows } = await db.query(
    'SELECT id, cccd FROM tenants WHERE user_id=$1 AND id=$2',
    [req.userId, tenantId]
  );
  if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy khách thuê' });
  await recordDataAudit(
    db.query,
    auditEntry(req, 'tenant_sensitive_view', 'tenant', tenantId, { purpose })
  );
  res.set('Cache-Control', 'no-store');
  return res.json({ tenantId, cccd: rows[0].cccd || '', audited: true });
}

async function loadAccountAuditLogs(userId, limit) {
  const params = [userId];
  let limitClause = '';
  if (Number.isInteger(limit)) {
    params.push(limit);
    limitClause = 'LIMIT $2';
  }
  const { rows } = await db.query(
    `SELECT id::text AS id, actor_user_id, actor_email_snapshot,
            action, resource_type, resource_id, changed_fields, purpose, created_at
     FROM (
       SELECT id, actor_user_id, actor_email_snapshot, action, resource_type,
              resource_id, changed_fields, purpose, created_at
       FROM data_audit_logs
       WHERE subject_user_id=$1
       UNION ALL
       SELECT id, admin_user_id AS actor_user_id,
              admin_email_snapshot AS actor_email_snapshot,
              'admin_tenant_sensitive_view' AS action,
              'tenant' AS resource_type, tenant_id AS resource_id,
              ARRAY[]::TEXT[] AS changed_fields, reason AS purpose, created_at
       FROM admin_sensitive_access_logs
       WHERE target_user_id=$1
     ) account_audit
     ORDER BY created_at DESC
     ${limitClause}`,
    params
  );
  return rows.map(row => ({
    id: String(row.id),
    actorUserId: row.actor_user_id === null || row.actor_user_id === undefined
      ? null
      : Number(row.actor_user_id),
    actorEmail: row.actor_email_snapshot || '',
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    changedFields: row.changed_fields || [],
    purpose: row.purpose || '',
    createdAt: row.created_at
  }));
}

async function listAuditLogs(req, res) {
  const requestedLimit = Number(req.query.limit || 50);
  const limit = Number.isInteger(requestedLimit) ? Math.min(100, Math.max(1, requestedLimit)) : 50;
  res.set('Cache-Control', 'no-store');
  return res.json({ logs: await loadAccountAuditLogs(req.userId, limit) });
}

async function exportAccountData(req, res) {
  if (!(await requireCurrentPassword(req, res))) return;
  const [
    { rows },
    state,
    dataAuditLogs,
    rentPaymentLedger,
    tenantDepositLedger,
    rentalHandovers,
    rentalLifecycle,
    rentalFinalSettlements,
    roomMaintenance,
    roomAssets
  ] = await Promise.all([
    db.query(
      `SELECT email, created_at, privacy_policy_version, privacy_accepted_at,
              terms_version, terms_accepted_at
       FROM users WHERE id=$1`,
      [req.userId]
    ),
    buildState(req.userId, { maskCccd: false }),
    loadAccountAuditLogs(req.userId),
    loadRentPaymentExport(req.userId),
    loadDepositExport(req.userId),
    loadRentalHandoverExport(req.userId),
    loadRentalLifecycleExport(req.userId),
    loadRentalFinalSettlementExport(req.userId),
    loadMaintenanceExport(req.userId),
    loadRoomAssetsExport(req.userId)
  ]);
  if (!rows[0]) return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
  await recordDataAudit(db.query, auditEntry(req, 'account_data_export', 'account'));
  res.set('Cache-Control', 'no-store');
  res.set('Content-Disposition', `attachment; filename="trobill-data-${new Date().toISOString().slice(0, 10)}.json"`);
  return res.json({
    ...state,
    dataAuditLogs,
    rentPaymentLedger,
    tenantDepositLedger,
    rentalHandovers,
    rentalLifecycle,
    rentalFinalSettlements,
    roomMaintenance,
    roomAssets,
    exportMetadata: {
      exportedAt: new Date().toISOString(),
      account: {
        email: rows[0].email,
        createdAt: rows[0].created_at,
        privacyPolicyVersion: rows[0].privacy_policy_version,
        privacyAcceptedAt: rows[0].privacy_accepted_at,
        termsVersion: rows[0].terms_version,
        termsAcceptedAt: rows[0].terms_accepted_at
      }
    }
  });
}

async function deleteAccount(req, res) {
  if (String(req.body.confirmation || '').trim() !== 'XOA TAI KHOAN') {
    return res.status(400).json({ error: 'Vui lòng nhập đúng XOA TAI KHOAN để xác nhận' });
  }
  if (!(await requireCurrentPassword(req, res))) return;

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await recordDataAudit(
      client.query.bind(client),
      auditEntry(req, 'account_delete', 'account', '', { purpose: 'self_service_request' })
    );
    const deleted = await client.query('DELETE FROM users WHERE id=$1 RETURNING id', [req.userId]);
    if (deleted.rowCount === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Không tìm thấy tài khoản' });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  clearSessionCookie(res);
  return res.json({ ok: true, deleted: true });
}

module.exports = {
  acceptPolicies,
  deleteAccount,
  exportAccountData,
  getPrivacyStatus,
  loadAccountAuditLogs,
  listAuditLogs,
  revealTenantCccd,
  requireCurrentPassword,
  verifyCurrentPassword
};
