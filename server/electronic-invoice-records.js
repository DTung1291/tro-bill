'use strict';

const db = require('./db');

const PROVIDERS = new Set([
  'misa_meinvoice', 'vnpt_invoice', 'viettel_sinvoice', 'other'
]);
const STATUSES = new Set([
  'draft', 'submitted', 'issued', 'rejected',
  'adjusted', 'replaced', 'cancelled'
]);
const HASH_PATTERN = /^[a-f0-9]{64}$/;

const STATUS_TRANSITIONS = Object.freeze({
  draft: new Set(['draft', 'submitted', 'issued', 'rejected', 'cancelled']),
  submitted: new Set(['submitted', 'issued', 'rejected', 'cancelled']),
  rejected: new Set(['rejected', 'submitted', 'cancelled']),
  issued: new Set(['issued', 'adjusted', 'replaced', 'cancelled']),
  adjusted: new Set(['adjusted', 'replaced', 'cancelled']),
  replaced: new Set(['replaced']),
  cancelled: new Set(['cancelled'])
});

class ElectronicInvoiceRecordError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'ElectronicInvoiceRecordError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function positiveId(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new ElectronicInvoiceRecordError(
      400,
      'INVALID_ELECTRONIC_INVOICE_RECORD_REFERENCE',
      `${label} không hợp lệ`
    );
  }
  return parsed;
}

function boundedText(value, label, maxLength, { required = false, minLength = 1 } = {}) {
  const normalized = String(value || '').trim();
  if ((required && normalized.length < minLength) || normalized.length > maxLength) {
    throw new ElectronicInvoiceRecordError(
      400,
      'INVALID_ELECTRONIC_INVOICE_PROVIDER_EVENT',
      `${label} không hợp lệ`
    );
  }
  return normalized;
}

function normalizeTimestamp(value, label, { required = true } = {}) {
  if (!value && !required) return null;
  if (!value) {
    throw new ElectronicInvoiceRecordError(
      400,
      'INVALID_ELECTRONIC_INVOICE_PROVIDER_EVENT_TIME',
      `${label} không hợp lệ`
    );
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())
      || parsed.getTime() < Date.UTC(2000, 0, 1)
      || parsed.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new ElectronicInvoiceRecordError(
      400,
      'INVALID_ELECTRONIC_INVOICE_PROVIDER_EVENT_TIME',
      `${label} không hợp lệ`
    );
  }
  return parsed.toISOString();
}

function providerEventInput(input = {}) {
  const provider = boundedText(input.provider, 'Nhà cung cấp', 40, { required: true });
  if (!PROVIDERS.has(provider)) {
    throw new ElectronicInvoiceRecordError(
      400,
      'INVALID_ELECTRONIC_INVOICE_PROVIDER',
      'Nhà cung cấp hóa đơn điện tử không hợp lệ'
    );
  }
  const normalizedStatus = boundedText(
    input.normalizedStatus,
    'Trạng thái chuẩn hóa',
    40,
    { required: true }
  );
  if (!STATUSES.has(normalizedStatus)) {
    throw new ElectronicInvoiceRecordError(
      400,
      'INVALID_ELECTRONIC_INVOICE_STATUS',
      'Trạng thái hóa đơn điện tử không hợp lệ'
    );
  }
  const sourceFingerprint = String(input.sourceFingerprint || '').trim().toLowerCase();
  const payloadSha256 = String(input.payloadSha256 || '').trim().toLowerCase();
  if (!HASH_PATTERN.test(sourceFingerprint) || !HASH_PATTERN.test(payloadSha256)) {
    throw new ElectronicInvoiceRecordError(
      400,
      'INVALID_ELECTRONIC_INVOICE_EVENT_HASH',
      'Dấu vân tay nguồn hoặc payload nhà cung cấp không hợp lệ'
    );
  }
  return {
    userId: positiveId(input.userId, 'Tài khoản'),
    sourceInvoiceId: positiveId(input.sourceInvoiceId, 'Hóa đơn nguồn'),
    provider,
    providerDocumentId: boundedText(
      input.providerDocumentId,
      'Mã tài liệu nhà cung cấp',
      300,
      { required: true }
    ),
    providerEventId: boundedText(
      input.providerEventId,
      'Mã sự kiện nhà cung cấp',
      300,
      { required: true, minLength: 8 }
    ),
    sourceFingerprint,
    payloadSha256,
    normalizedStatus,
    providerStatus: boundedText(input.providerStatus, 'Trạng thái nhà cung cấp', 200),
    lookupCode: boundedText(input.lookupCode, 'Mã tra cứu', 300),
    taxAuthorityCode: boundedText(input.taxAuthorityCode, 'Mã cơ quan thuế', 300),
    invoiceNumber: boundedText(input.invoiceNumber, 'Số hóa đơn', 100),
    occurredAt: normalizeTimestamp(input.occurredAt, 'Thời điểm sự kiện'),
    issuedAt: normalizeTimestamp(input.issuedAt, 'Thời điểm phát hành', { required: false })
  };
}

function assertStatusTransition(previousStatus, nextStatus) {
  if (!previousStatus) return;
  if (!STATUSES.has(previousStatus)
      || !STATUS_TRANSITIONS[previousStatus]?.has(nextStatus)) {
    throw new ElectronicInvoiceRecordError(
      409,
      'ELECTRONIC_INVOICE_STATUS_TRANSITION_INVALID',
      'Không thể chuyển trạng thái hóa đơn điện tử theo thứ tự này'
    );
  }
}

function assertStableField(currentValue, nextValue, label) {
  if (currentValue && nextValue && currentValue !== nextValue) {
    throw new ElectronicInvoiceRecordError(
      409,
      'ELECTRONIC_INVOICE_REFERENCE_MISMATCH',
      `${label} không khớp bản đã lưu`
    );
  }
}

function recordJson(row) {
  return {
    id: Number(row.id),
    sourceInvoiceId: Number(row.source_invoice_id),
    provider: row.provider,
    providerDocumentId: row.provider_document_id,
    lookupCode: row.lookup_code || '',
    taxAuthorityCode: row.tax_authority_code || '',
    invoiceNumber: row.invoice_number || '',
    status: row.normalized_status,
    providerStatus: row.provider_status || '',
    issuedAt: row.issued_at || null,
    lastEventAt: row.last_event_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    events: []
  };
}

function eventJson(row) {
  return {
    id: Number(row.id),
    recordId: Number(row.record_id),
    previousStatus: row.previous_status || null,
    status: row.new_status,
    providerStatus: row.provider_status || '',
    occurredAt: row.occurred_at,
    createdAt: row.created_at
  };
}

function ensureOwner(req) {
  if (!req.workspace || req.workspace.isOwner !== true) {
    throw new ElectronicInvoiceRecordError(
      403,
      'ELECTRONIC_INVOICE_RECORD_OWNER_REQUIRED',
      'Chỉ chủ tài khoản được xem hồ sơ hóa đơn điện tử'
    );
  }
}

function sendError(res, error) {
  if (!(error instanceof ElectronicInvoiceRecordError)) return false;
  res.status(error.statusCode).json({ error: error.message, code: error.code });
  return true;
}

async function getElectronicInvoiceRecords(req, res, dependencies = {}) {
  let invoiceId;
  try {
    ensureOwner(req);
    invoiceId = positiveId(req.params?.invoiceId, 'Hóa đơn nguồn');
  } catch (error) {
    if (sendError(res, error)) return res;
    throw error;
  }
  const query = dependencies.query || db.query;
  const invoiceResult = await query(
    'SELECT 1 FROM rent_invoices WHERE user_id=$1 AND id=$2',
    [req.userId, invoiceId]
  );
  if (!invoiceResult.rows[0]) {
    return res.status(404).json({
      error: 'Không tìm thấy hóa đơn',
      code: 'ELECTRONIC_INVOICE_SOURCE_NOT_FOUND'
    });
  }
  const [recordResult, eventResult] = await Promise.all([
    query(
      `SELECT * FROM electronic_invoice_records
       WHERE user_id=$1 AND source_invoice_id=$2
       ORDER BY created_at DESC, id DESC`,
      [req.userId, invoiceId]
    ),
    query(
      `SELECT event.*
       FROM electronic_invoice_status_events event
       JOIN electronic_invoice_records record
         ON record.user_id=event.user_id AND record.id=event.record_id
       WHERE record.user_id=$1 AND record.source_invoice_id=$2
       ORDER BY event.occurred_at, event.id`,
      [req.userId, invoiceId]
    )
  ]);
  const records = recordResult.rows.map(recordJson);
  const byId = new Map(records.map(record => [record.id, record]));
  for (const row of eventResult.rows) {
    byId.get(Number(row.record_id))?.events.push(eventJson(row));
  }
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');
  return res.json({ records });
}

async function recordProviderStatus(input, dependencies = {}) {
  const normalized = providerEventInput(input);
  const getClient = dependencies.getClient || db.getClient;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(
         hashtextextended('electronic-invoice-event:' || $1::text || ':' || $2 || ':' || $3, 0)
       )`,
      [normalized.userId, normalized.provider, normalized.providerEventId]
    );
    const replayResult = await client.query(
      `SELECT event.*, record.provider_document_id, record.source_invoice_id,
              record.source_fingerprint
       FROM electronic_invoice_status_events event
       JOIN electronic_invoice_records record
         ON record.user_id=event.user_id AND record.id=event.record_id
       WHERE event.user_id=$1 AND event.provider=$2 AND event.provider_event_id=$3`,
      [normalized.userId, normalized.provider, normalized.providerEventId]
    );
    if (replayResult.rows[0]) {
      const replay = replayResult.rows[0];
      if (replay.payload_sha256 !== normalized.payloadSha256
          || replay.provider_document_id !== normalized.providerDocumentId
          || Number(replay.source_invoice_id) !== normalized.sourceInvoiceId
          || replay.source_fingerprint !== normalized.sourceFingerprint
          || replay.new_status !== normalized.normalizedStatus) {
        throw new ElectronicInvoiceRecordError(
          409,
          'ELECTRONIC_INVOICE_PROVIDER_EVENT_MISMATCH',
          'Mã sự kiện nhà cung cấp đã tồn tại với nội dung khác'
        );
      }
      await client.query('COMMIT');
      return { replay: true, recordId: Number(replay.record_id), event: eventJson(replay) };
    }

    const sourceResult = await client.query(
      'SELECT 1 FROM rent_invoices WHERE user_id=$1 AND id=$2 FOR SHARE',
      [normalized.userId, normalized.sourceInvoiceId]
    );
    if (!sourceResult.rows[0]) {
      throw new ElectronicInvoiceRecordError(
        404,
        'ELECTRONIC_INVOICE_SOURCE_NOT_FOUND',
        'Không tìm thấy hóa đơn nguồn'
      );
    }

    const currentResult = await client.query(
      `SELECT * FROM electronic_invoice_records
       WHERE user_id=$1 AND provider=$2 AND provider_document_id=$3
       FOR UPDATE`,
      [normalized.userId, normalized.provider, normalized.providerDocumentId]
    );
    const current = currentResult.rows[0] || null;
    let record;
    let previousStatus = null;
    if (!current) {
      const inserted = await client.query(
        `INSERT INTO electronic_invoice_records (
           user_id, source_invoice_id, provider, provider_document_id,
           source_fingerprint, lookup_code, tax_authority_code, invoice_number,
           normalized_status, provider_status, issued_at, last_event_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          normalized.userId, normalized.sourceInvoiceId, normalized.provider,
          normalized.providerDocumentId, normalized.sourceFingerprint,
          normalized.lookupCode, normalized.taxAuthorityCode, normalized.invoiceNumber,
          normalized.normalizedStatus, normalized.providerStatus,
          normalized.issuedAt || (normalized.normalizedStatus === 'issued' ? normalized.occurredAt : null),
          normalized.occurredAt
        ]
      );
      record = inserted.rows[0];
    } else {
      previousStatus = current.normalized_status;
      if (Number(current.source_invoice_id) !== normalized.sourceInvoiceId
          || current.source_fingerprint !== normalized.sourceFingerprint) {
        throw new ElectronicInvoiceRecordError(
          409,
          'ELECTRONIC_INVOICE_SOURCE_MISMATCH',
          'Tài liệu nhà cung cấp không khớp hóa đơn nguồn đã lưu'
        );
      }
      if (new Date(normalized.occurredAt).getTime() < new Date(current.last_event_at).getTime()) {
        throw new ElectronicInvoiceRecordError(
          409,
          'ELECTRONIC_INVOICE_EVENT_OUT_OF_ORDER',
          'Sự kiện nhà cung cấp cũ hơn trạng thái mới nhất đã lưu'
        );
      }
      assertStatusTransition(previousStatus, normalized.normalizedStatus);
      assertStableField(current.lookup_code, normalized.lookupCode, 'Mã tra cứu');
      assertStableField(current.tax_authority_code, normalized.taxAuthorityCode, 'Mã cơ quan thuế');
      assertStableField(current.invoice_number, normalized.invoiceNumber, 'Số hóa đơn');
      const updated = await client.query(
        `UPDATE electronic_invoice_records
         SET lookup_code=CASE WHEN lookup_code='' THEN $4 ELSE lookup_code END,
             tax_authority_code=CASE WHEN tax_authority_code='' THEN $5 ELSE tax_authority_code END,
             invoice_number=CASE WHEN invoice_number='' THEN $6 ELSE invoice_number END,
             normalized_status=$7,
             provider_status=$8,
             issued_at=COALESCE(issued_at, $9),
             last_event_at=GREATEST(last_event_at, $10::timestamptz),
             updated_at=now()
         WHERE user_id=$1 AND provider=$2 AND provider_document_id=$3
         RETURNING *`,
        [
          normalized.userId, normalized.provider, normalized.providerDocumentId,
          normalized.lookupCode, normalized.taxAuthorityCode, normalized.invoiceNumber,
          normalized.normalizedStatus, normalized.providerStatus,
          normalized.issuedAt || (normalized.normalizedStatus === 'issued' ? normalized.occurredAt : null),
          normalized.occurredAt
        ]
      );
      record = updated.rows[0];
    }

    const eventResult = await client.query(
      `INSERT INTO electronic_invoice_status_events (
         user_id, record_id, provider, provider_event_id,
         previous_status, new_status, provider_status, payload_sha256, occurred_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
       RETURNING *`,
      [
        normalized.userId, record.id, normalized.provider, normalized.providerEventId,
        previousStatus, normalized.normalizedStatus, normalized.providerStatus,
        normalized.payloadSha256, normalized.occurredAt
      ]
    );
    await client.query('COMMIT');
    return {
      replay: false,
      record: recordJson(record),
      event: eventJson(eventResult.rows[0])
    };
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  ElectronicInvoiceRecordError,
  assertStatusTransition,
  getElectronicInvoiceRecords,
  providerEventInput,
  recordProviderStatus
};
