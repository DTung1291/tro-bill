'use strict';

const { AUDIT_RETENTION_DAYS } = require('./privacy-constants');

const ALLOWED_FIELDS = new Set([
  'fullName',
  'phone',
  'email',
  'cccd',
  'issueDate',
  'dob',
  'gender',
  'address',
  'dataNoticeAcknowledged',
  // Giá phòng / dịch vụ
  'effectiveFrom',
  'rentPrice',
  'electricRate',
  'waterRate',
  'trashFee',
  'wifiFee',
  'manageFee',
  // Nguồn hóa đơn và hóa đơn đã phát hành
  'electricNew',
  'electricOldOverride',
  'waterUnits',
  'waterNew',
  'waterOldOverride',
  'utilityOnly',
  'discountAmount',
  'surchargeAmount',
  'lateFeeAmount',
  'paid',
  'note',
  'issuedTotalVnd',
  'finalTotalVnd',
  'detailSnapshot',
  // Ledger giao dịch
  'amountVnd',
  'paymentMethod',
  'entryType',
  'transactionStatus',
  'matchStatus',
  'reversesTransactionId',
  // Hợp đồng
  'status',
  'roomId',
  'tenantId',
  'startsOn',
  'endsOn',
  'billingCycleMonths',
  'paymentDueDay',
  'monthlyRentVnd',
  'depositVnd',
  'terms'
]);

function requestAuditContext(req = {}) {
  // Tránh bắt các module đọc thuần phải có rate-limit secret ngay khi import.
  // Production vẫn bắt buộc secret tại thời điểm tạo context audit từ request.
  const { keyHash, requestIp } = require('./rate-limit');
  const rawIp = requestIp(req);
  return {
    requestIpHash: keyHash('data-audit', 'ip', rawIp),
    userAgent: String(typeof req.get === 'function' ? req.get('user-agent') || '' : '').slice(0, 500)
  };
}

async function recordDataAudit(query, entry) {
  return recordDataAudits(query, [entry]);
}

function requestDataAuditEntry(req = {}, action, resourceType, resourceId = '', extra = {}) {
  return {
    actorUserId: req.actorUserId || req.userId,
    actorEmail: req.userEmail || '',
    subjectUserId: req.accountUserId || req.userId,
    action,
    resourceType,
    resourceId: String(resourceId || ''),
    ...requestAuditContext(req),
    ...extra
  };
}

async function recordDataAudits(query, entries = []) {
  const normalizedEntries = Array.isArray(entries) ? entries.filter(Boolean) : [];
  if (normalizedEntries.length === 0) return;
  for (const entry of normalizedEntries) {
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
  }
  await query(
    `DELETE FROM data_audit_logs
     WHERE created_at < now() - ($1 * interval '1 day')`,
    [AUDIT_RETENTION_DAYS]
  );
}

module.exports = {
  ALLOWED_FIELDS,
  recordDataAudit,
  recordDataAudits,
  requestAuditContext,
  requestDataAuditEntry
};
