'use strict';

const db = require('./db');
const { assertEmailConfigured } = require('./email');
const {
  RentInvoiceDeliveryError,
  TEMPLATE_TYPES,
  TENANT_EMAIL_PATTERN,
  executeInvoiceEmailDelivery,
  maskEmail
} = require('./rent-invoice-delivery');
const { invoiceSummary } = require('./rent-payments');
const { authorizedCronRequest } = require('./subscription-notifications');
const { writeLog } = require('./observability');

const DATE_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const MAX_SCHEDULE_DAYS = 90;
const RETRY_LIMIT = 5;
const SKIPPED_ERROR_CODES = new Set([
  'INVOICE_ALREADY_PAID',
  'INVOICE_NOT_FOUND',
  'INVOICE_RECIPIENT_NOT_FOUND',
  'TENANT_EMAIL_MISSING',
  'TENANT_EMAIL_INVALID'
]);

class RentInvoiceScheduleError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'RentInvoiceScheduleError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function vietnamDate(now = new Date()) {
  return new Date(now.getTime() + (7 * 60 * 60 * 1000)).toISOString().slice(0, 10);
}

function addUtcDays(dateText, days) {
  const date = new Date(`${dateText}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function validCalendarDate(value) {
  if (!DATE_PATTERN.test(value)) return false;
  return new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) === value;
}

function positiveId(value, field) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new RentInvoiceScheduleError(400, 'INVALID_SCHEDULE_ID', `${field} không hợp lệ`);
  }
  return id;
}

function scheduleInput(req, now = new Date()) {
  const invoiceId = positiveId(req.params?.invoiceId, 'Hóa đơn');
  const tenantId = String(req.body?.tenantId || '').trim();
  const templateType = String(req.body?.templateType || '').trim().toLowerCase();
  const scheduledFor = String(req.body?.scheduledFor || '').trim();
  if (!tenantId || tenantId.length > 200) {
    throw new RentInvoiceScheduleError(400, 'INVALID_TENANT_ID', 'Khách nhận hóa đơn không hợp lệ');
  }
  if (!TEMPLATE_TYPES.has(templateType)) {
    throw new RentInvoiceScheduleError(400, 'INVALID_MESSAGE_TEMPLATE', 'Loại tin nhắn không hợp lệ');
  }
  if (!validCalendarDate(scheduledFor)) {
    throw new RentInvoiceScheduleError(400, 'INVALID_SCHEDULE_DATE', 'Ngày gửi không hợp lệ');
  }
  const today = vietnamDate(now);
  if (scheduledFor <= today) {
    throw new RentInvoiceScheduleError(
      400,
      'SCHEDULE_DATE_NOT_FUTURE',
      'Ngày hẹn gửi phải từ ngày mai trở đi'
    );
  }
  if (scheduledFor > addUtcDays(today, MAX_SCHEDULE_DAYS)) {
    throw new RentInvoiceScheduleError(
      400,
      'SCHEDULE_DATE_TOO_FAR',
      `Chỉ có thể hẹn gửi trong ${MAX_SCHEDULE_DAYS} ngày tới`
    );
  }
  return { invoiceId, tenantId, templateType, scheduledFor };
}

function scheduleJson(row) {
  return {
    id: Number(row.id),
    invoiceId: Number(row.invoice_id),
    tenantId: row.tenant_id,
    channel: row.channel,
    templateType: row.template_type,
    scheduledFor: String(row.scheduled_for).slice(0, 10),
    recipient: maskEmail(row.recipient_email_snapshot),
    status: row.status,
    attemptCount: Number(row.attempt_count) || 0,
    lastErrorCode: row.last_error_code || null,
    sentAt: row.sent_at || null,
    cancelledAt: row.cancelled_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function sendScheduleError(res, error) {
  if (error instanceof RentInvoiceScheduleError || error instanceof RentInvoiceDeliveryError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return true;
  }
  if (error?.code === 'EMAIL_NOT_CONFIGURED') {
    res.status(503).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
}

async function loadScheduleRecipient(query, userId, input, loadInvoiceSummary = invoiceSummary) {
  const summary = await loadInvoiceSummary(query, userId, input.invoiceId);
  if (!summary) {
    throw new RentInvoiceScheduleError(404, 'INVOICE_NOT_FOUND', 'Không tìm thấy hóa đơn');
  }
  const { rows } = await query(
    `SELECT id, email
     FROM tenants
     WHERE user_id=$1 AND room_id=$2 AND id=$3`,
    [userId, summary.roomId, input.tenantId]
  );
  const tenant = rows[0];
  if (!tenant) {
    throw new RentInvoiceScheduleError(
      404,
      'INVOICE_RECIPIENT_NOT_FOUND',
      'Khách thuê không thuộc phòng của hóa đơn này'
    );
  }
  const email = String(tenant.email || '').trim().toLowerCase();
  if (!email) {
    throw new RentInvoiceScheduleError(409, 'TENANT_EMAIL_MISSING', 'Khách thuê chưa có email nhận hóa đơn');
  }
  if (email.length > 254 || !TENANT_EMAIL_PATTERN.test(email)) {
    throw new RentInvoiceScheduleError(409, 'TENANT_EMAIL_INVALID', 'Email khách thuê không hợp lệ');
  }
  return { email, summary };
}

async function createInvoiceSchedule(req, res, dependencies = {}) {
  const query = dependencies.query || db.query;
  const ensureEmailConfigured = dependencies.assertEmailConfigured || assertEmailConfigured;
  const loadInvoiceSummary = dependencies.invoiceSummary || invoiceSummary;
  try {
    const input = scheduleInput(req, dependencies.now || new Date());
    const { email } = await loadScheduleRecipient(query, req.userId, input, loadInvoiceSummary);
    ensureEmailConfigured();
    const { rows } = await query(
      `INSERT INTO rent_invoice_deliveries
         (user_id, invoice_id, tenant_id, channel, template_type,
          scheduled_for, recipient_email_snapshot, status)
       VALUES ($1,$2,$3,'email',$4,$5,$6,'scheduled')
       ON CONFLICT (user_id, invoice_id, tenant_id, channel, template_type, scheduled_for)
       DO UPDATE SET
         recipient_email_snapshot=EXCLUDED.recipient_email_snapshot,
         status='scheduled', attempt_count=0, provider_message_id=NULL,
         last_error_code=NULL, sent_at=NULL, cancelled_at=NULL, updated_at=now()
       WHERE rent_invoice_deliveries.status IN ('cancelled','failed','skipped')
       RETURNING *`,
      [req.userId, input.invoiceId, input.tenantId, input.templateType, input.scheduledFor, email]
    );
    let row = rows[0];
    let created = true;
    if (!row) {
      const existing = await query(
        `SELECT * FROM rent_invoice_deliveries
         WHERE user_id=$1 AND invoice_id=$2 AND tenant_id=$3
           AND channel='email' AND template_type=$4 AND scheduled_for=$5`,
        [req.userId, input.invoiceId, input.tenantId, input.templateType, input.scheduledFor]
      );
      row = existing.rows[0];
      created = false;
    }
    res.set('Cache-Control', 'no-store');
    return res.status(created ? 201 : 200).json({ schedule: scheduleJson(row), created });
  } catch (error) {
    if (sendScheduleError(res, error)) return res;
    throw error;
  }
}

async function listInvoiceSchedules(req, res) {
  let invoiceId;
  try {
    invoiceId = positiveId(req.params?.invoiceId, 'Hóa đơn');
  } catch (error) {
    if (sendScheduleError(res, error)) return res;
    throw error;
  }
  const invoice = await db.query(
    'SELECT id FROM rent_invoices WHERE user_id=$1 AND id=$2',
    [req.userId, invoiceId]
  );
  if (!invoice.rows[0]) {
    return res.status(404).json({ error: 'Không tìm thấy hóa đơn', code: 'INVOICE_NOT_FOUND' });
  }
  const { rows } = await db.query(
    `SELECT * FROM rent_invoice_deliveries
     WHERE user_id=$1 AND invoice_id=$2
     ORDER BY scheduled_for DESC, id DESC
     LIMIT 50`,
    [req.userId, invoiceId]
  );
  res.set('Cache-Control', 'no-store');
  return res.json({ schedules: rows.map(scheduleJson) });
}

async function cancelInvoiceSchedule(req, res) {
  let scheduleId;
  try {
    scheduleId = positiveId(req.params?.id, 'Lịch gửi');
  } catch (error) {
    if (sendScheduleError(res, error)) return res;
    throw error;
  }
  const { rows } = await db.query(
    `UPDATE rent_invoice_deliveries
     SET status='cancelled', cancelled_at=now(), updated_at=now()
     WHERE user_id=$1 AND id=$2 AND status IN ('scheduled','failed')
     RETURNING *`,
    [req.userId, scheduleId]
  );
  if (!rows[0]) {
    const existing = await db.query(
      'SELECT status FROM rent_invoice_deliveries WHERE user_id=$1 AND id=$2',
      [req.userId, scheduleId]
    );
    if (!existing.rows[0]) {
      return res.status(404).json({ error: 'Không tìm thấy lịch gửi', code: 'SCHEDULE_NOT_FOUND' });
    }
    return res.status(409).json({
      error: 'Lịch gửi đang xử lý hoặc đã kết thúc nên không thể hủy',
      code: 'SCHEDULE_NOT_CANCELLABLE'
    });
  }
  res.set('Cache-Control', 'no-store');
  return res.json({ schedule: scheduleJson(rows[0]) });
}

function cronRequestContext() {
  let host = '';
  try { host = new URL(String(process.env.APP_URL || '')).host; } catch (_) {}
  return {
    protocol: 'https',
    get(name) { return String(name).toLowerCase() === 'host' ? host : ''; }
  };
}

function safeErrorCode(error) {
  const code = String(error?.code || 'EMAIL_SEND_FAILED').toUpperCase();
  return /^[A-Z0-9_]{3,64}$/.test(code) ? code : 'EMAIL_SEND_FAILED';
}

async function processDueInvoiceSchedules(dependencies = {}) {
  const query = dependencies.query || db.query;
  const executeDelivery = dependencies.executeInvoiceEmailDelivery || executeInvoiceEmailDelivery;
  const { rows } = await query(
    `WITH due AS (
       SELECT id
       FROM rent_invoice_deliveries
       WHERE scheduled_for <= (now() AT TIME ZONE 'Asia/Ho_Chi_Minh')::date
         AND attempt_count < $1
         AND (
           status IN ('scheduled','failed')
           OR (status='sending' AND updated_at < now() - interval '30 minutes')
         )
       ORDER BY scheduled_for, id
       FOR UPDATE SKIP LOCKED
       LIMIT 20
     )
     UPDATE rent_invoice_deliveries delivery
     SET status='sending', attempt_count=delivery.attempt_count + 1,
         last_error_code=NULL, updated_at=now()
     FROM due
     WHERE delivery.id=due.id
     RETURNING delivery.*`,
    [RETRY_LIMIT]
  );
  const result = { candidates: rows.length, sent: 0, failed: 0, skipped: 0 };
  for (const schedule of rows) {
    try {
      const delivery = await executeDelivery({
        userId: Number(schedule.user_id),
        invoiceId: Number(schedule.invoice_id),
        tenantId: schedule.tenant_id,
        templateType: schedule.template_type,
        expiresInHours: 72,
        idempotencyKey: `rent-invoice-schedule-${schedule.id}`,
        req: cronRequestContext()
      }, { query });
      await query(
        `UPDATE rent_invoice_deliveries
         SET status='sent', provider_message_id=$2, sent_at=now(), updated_at=now()
         WHERE id=$1 AND status='sending'`,
        [schedule.id, delivery.delivery?.emailId || null]
      );
      result.sent += 1;
    } catch (error) {
      const code = safeErrorCode(error);
      const skipped = SKIPPED_ERROR_CODES.has(code);
      await query(
        `UPDATE rent_invoice_deliveries
         SET status=$2, last_error_code=$3, updated_at=now()
         WHERE id=$1 AND status='sending'`,
        [schedule.id, skipped ? 'skipped' : 'failed', code]
      );
      result[skipped ? 'skipped' : 'failed'] += 1;
    }
  }
  return result;
}

async function invoiceScheduleCron(req, res) {
  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ error: 'Cron chưa được cấu hình', code: 'CRON_NOT_CONFIGURED' });
  }
  if (!authorizedCronRequest(req)) {
    return res.status(401).json({ error: 'Không được phép', code: 'CRON_UNAUTHORIZED' });
  }
  const result = await processDueInvoiceSchedules();
  writeLog(result.failed > 0 ? 'warn' : 'info', 'rent_invoice_schedules_completed', result);
  return res.json({ ok: true, ...result });
}

module.exports = {
  MAX_SCHEDULE_DAYS,
  RETRY_LIMIT,
  RentInvoiceScheduleError,
  addUtcDays,
  cancelInvoiceSchedule,
  createInvoiceSchedule,
  invoiceScheduleCron,
  listInvoiceSchedules,
  processDueInvoiceSchedules,
  scheduleInput,
  scheduleJson,
  vietnamDate
};
