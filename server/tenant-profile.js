'use strict';

const db = require('./db');
const { recordDataAudits, requestDataAuditEntry } = require('./data-audit');
const { TENANT_DATA_NOTICE_VERSION } = require('./privacy-constants');
const { enforceStateWrite, sendEntitlementError } = require('./subscription');
const { changedTenantFields, isMaskedCccd, maskCccd, validOptionalDate } = require('./state');

function profileError(res, status, code, message) {
  return res.status(status).json({ error: message, code });
}

function normalizeTenantProfile(body = {}) {
  const profile = {
    roomId: String(body.roomId || '').trim(),
    fullName: String(body.fullName || '').trim(),
    phone: String(body.phone || '').trim(),
    email: String(body.email || '').trim().toLowerCase(),
    cccd: String(body.cccd || '').trim(),
    issueDate: String(body.issueDate || '').trim(),
    dob: String(body.dob || '').trim(),
    gender: String(body.gender || '').trim(),
    address: String(body.address || '').trim(),
    temporaryResidenceRegisteredOn: body.temporaryResidenceRegisteredOn || '',
    temporaryResidenceExpiresOn: body.temporaryResidenceExpiresOn || '',
    dataNoticeAcknowledged: body.dataNoticeAcknowledged === true
  };
  if (!profile.roomId || profile.roomId.length > 200
      || !profile.fullName || !profile.cccd || !profile.issueDate
      || !profile.dob || !['Nam', 'Nữ', 'Khác'].includes(profile.gender)
      || !profile.address) {
    return { error: ['INVALID_TENANT_PROFILE', 'Hồ sơ khách thuê thiếu hoặc sai thông tin bắt buộc'] };
  }
  if (profile.email && (profile.email.length > 254
      || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(profile.email))) {
    return { error: ['INVALID_TENANT_EMAIL', 'Email nhận hóa đơn của khách thuê không hợp lệ'] };
  }
  if (!validOptionalDate(profile.issueDate) || !validOptionalDate(profile.dob)
      || !validOptionalDate(profile.temporaryResidenceRegisteredOn)
      || !validOptionalDate(profile.temporaryResidenceExpiresOn)
      || (profile.temporaryResidenceRegisteredOn && profile.temporaryResidenceExpiresOn
        && profile.temporaryResidenceExpiresOn < profile.temporaryResidenceRegisteredOn)) {
    return { error: ['INVALID_TENANT_DATES', 'Ngày trong hồ sơ khách thuê không hợp lệ'] };
  }
  return { profile };
}

async function updateTenantProfile(req, res, dependencies = {}) {
  if (req.workspace && !req.workspace.isOwner) {
    return profileError(res, 403, 'TENANT_PROFILE_OWNER_REQUIRED',
      'Chỉ chủ tài khoản mới có thể sửa hồ sơ khách thuê');
  }
  const tenantId = String(req.params?.tenantId || '').trim();
  if (!tenantId || tenantId.length > 200) {
    return profileError(res, 400, 'INVALID_TENANT_ID', 'Mã khách thuê không hợp lệ');
  }
  const normalized = normalizeTenantProfile(req.body);
  if (normalized.error) return profileError(res, 400, ...normalized.error);
  const profile = normalized.profile;
  const getClient = dependencies.getClient || db.getClient;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('state-write:' || $1::text, 0))`,
      [req.userId]
    );
    const roomCount = await client.query(
      'SELECT COUNT(*)::int AS room_count FROM rooms WHERE user_id=$1',
      [req.userId]
    );
    await enforceStateWrite(req.userId, Number(roomCount.rows[0].room_count),
      client.query.bind(client));
    const existingResult = await client.query(
      `SELECT tenant.id, tenant.full_name, tenant.phone, tenant.email, tenant.cccd,
              tenant.issue_date, tenant.dob, tenant.gender, tenant.address,
              tenant.temporary_residence_registered_on::text AS temporary_residence_registered_on_iso,
              tenant.temporary_residence_expires_on::text AS temporary_residence_expires_on_iso,
              tenant.data_notice_version, tenant.data_notice_acknowledged_at
       FROM tenants tenant
       JOIN rooms room ON room.id=tenant.room_id AND room.user_id=tenant.user_id
       WHERE tenant.id=$1 AND tenant.user_id=$2 AND tenant.room_id=$3
       FOR UPDATE OF tenant`,
      [tenantId, req.userId, profile.roomId]
    );
    const existing = existingResult.rows[0];
    if (!existing) {
      await client.query('ROLLBACK');
      return profileError(res, 404, 'TENANT_NOT_FOUND', 'Không tìm thấy khách thuê trong phòng này');
    }
    const resolvedCccd = isMaskedCccd(profile.cccd) ? existing.cccd : profile.cccd;
    const noticePreviouslyAcknowledged = !!(
      existing.data_notice_acknowledged_at
      && existing.data_notice_version === TENANT_DATA_NOTICE_VERSION
    );
    const changedFields = changedTenantFields(existing, profile, resolvedCccd);
    if (!noticePreviouslyAcknowledged && profile.dataNoticeAcknowledged) {
      changedFields.push('dataNoticeAcknowledged');
    }
    if (changedFields.length && !noticePreviouslyAcknowledged && !profile.dataNoticeAcknowledged) {
      await client.query('ROLLBACK');
      return profileError(res, 400, 'TENANT_DATA_NOTICE_REQUIRED',
        'Cần xác nhận đã thông báo mục đích thu thập dữ liệu cho khách thuê');
    }
    if (changedFields.length) {
      await client.query(
        `UPDATE tenants SET full_name=$3, phone=$4, email=$5, cccd=$6,
                issue_date=$7, dob=$8, gender=$9, address=$10,
                temporary_residence_registered_on=$11,
                temporary_residence_expires_on=$12,
                data_notice_version=$13, data_notice_acknowledged_at=$14
         WHERE id=$1 AND user_id=$2`,
        [tenantId, req.userId, profile.fullName, profile.phone, profile.email,
          resolvedCccd, profile.issueDate, profile.dob, profile.gender, profile.address,
          profile.temporaryResidenceRegisteredOn || null,
          profile.temporaryResidenceExpiresOn || null,
          TENANT_DATA_NOTICE_VERSION,
          noticePreviouslyAcknowledged ? existing.data_notice_acknowledged_at : new Date().toISOString()]
      );
      await recordDataAudits(client.query.bind(client), [requestDataAuditEntry(
        req, 'tenant_sensitive_update', 'tenant', tenantId, { changedFields }
      )]);
    }
    await client.query('COMMIT');
    return res.json({ ok: true, tenantId, cccd: maskCccd(resolvedCccd) });
  } catch (error) {
    await client.query('ROLLBACK');
    if (sendEntitlementError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { normalizeTenantProfile, updateTenantProfile };
