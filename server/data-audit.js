'use strict';

const { AUDIT_RETENTION_DAYS } = require('./privacy-constants');
const { keyHash, requestIp } = require('./rate-limit');

const ALLOWED_FIELDS = new Set([
  'fullName',
  'phone',
  'cccd',
  'issueDate',
  'dob',
  'gender',
  'address',
  'dataNoticeAcknowledged'
]);

function requestAuditContext(req = {}) {
  const rawIp = requestIp(req);
  return {
    requestIpHash: keyHash('data-audit', 'ip', rawIp),
    userAgent: String(typeof req.get === 'function' ? req.get('user-agent') || '' : '').slice(0, 500)
  };
}

async function recordDataAudit(query, entry) {
  const fields = [...new Set(Array.isArray(entry.changedFields) ? entry.changedFields : [])]
    .filter(field => ALLOWED_FIELDS.has(field));
  await query(
    `INSERT INTO data_audit_logs
       (actor_user_id, actor_email_snapshot, subject_user_id, action,
        resource_type, resource_id, changed_fields, purpose,
        request_ip_hash, user_agent)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [
      entry.actorUserId,
      String(entry.actorEmail || ''),
      entry.subjectUserId,
      String(entry.action || ''),
      String(entry.resourceType || ''),
      String(entry.resourceId || ''),
      fields,
      String(entry.purpose || '').slice(0, 500),
      String(entry.requestIpHash || ''),
      String(entry.userAgent || '').slice(0, 500)
    ]
  );
  await query(
    `DELETE FROM data_audit_logs
     WHERE created_at < now() - ($1 * interval '1 day')`,
    [AUDIT_RETENTION_DAYS]
  );
}

module.exports = { ALLOWED_FIELDS, recordDataAudit, requestAuditContext };
