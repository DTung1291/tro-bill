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
    triggerSource: row.trigger_source || 'manual',
    reminderOffsetDays: row.reminder_offset_days === null || row.reminder_offset_days === undefined
      ? null
      : Number(row.reminder_offset_days),
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

async function enqueueAutomaticInvoiceReminders(dependencies = {}) {
  const query = dependencies.query || db.query;
  const scheduledFor = vietnamDate(dependencies.now || new Date());
  const { rows } = await query(
    `WITH disabled_or_changed AS (
       UPDATE rent_invoice_deliveries delivery
       SET status='skipped', last_error_code='REMINDER_CONFIG_DISABLED', updated_at=now()
       WHERE delivery.trigger_source='automatic'
         AND delivery.status IN ('scheduled','failed')
         AND NOT EXISTS (
           SELECT 1
           FROM settings active_settings
           WHERE active_settings.user_id=delivery.user_id
             AND active_settings.invoice_reminder_enabled=true
             AND (
               (
                 delivery.reminder_offset_days > 0
                 AND delivery.reminder_offset_days=ANY(active_settings.invoice_reminder_before_days)
               ) OR (
                 delivery.reminder_offset_days < 0
                 AND -delivery.reminder_offset_days=ANY(active_settings.invoice_reminder_after_days)
               )
             )
         )
       RETURNING delivery.id
     ), invoice_candidates AS (
       SELECT
         invoice.user_id,
         invoice.id AS invoice_id,
         invoice.room_id,
         invoice.period,
         settings.invoice_reminder_before_days,
         settings.invoice_reminder_after_days,
         (
           to_date(invoice.period || '-01', 'YYYY-MM-DD')
           + interval '1 month - 1 day'
         )::date AS due_date
       FROM rent_invoices invoice
       JOIN settings ON settings.user_id=invoice.user_id
         AND settings.invoice_reminder_enabled=true
       JOIN rooms room ON room.user_id=invoice.user_id AND room.id=invoice.room_id
       WHERE invoice.period <= to_char($1::date, 'YYYY-MM')
         AND (
           NULLIF(left(room.rent_start_date, 7), '') IS NULL
           OR invoice.period >= left(room.rent_start_date, 7)
         )
         AND invoice.issued_total_vnd > COALESCE((
           SELECT SUM(payment_tx.amount_vnd)
           FROM rent_payment_transactions payment_tx
           WHERE payment_tx.user_id=invoice.user_id
             AND payment_tx.invoice_id=invoice.id
         ), 0)
     ), due_candidates AS (
       SELECT
         candidate.*,
         tenant.id AS tenant_id,
         lower(tenant.email) AS recipient_email,
         CASE
           WHEN candidate.due_date > $1::date THEN candidate.due_date - $1::date
           ELSE -($1::date - candidate.due_date)
         END AS reminder_offset_days
       FROM invoice_candidates candidate
       JOIN LATERAL (
         SELECT current_tenant.id, current_tenant.email
         FROM tenants current_tenant
         WHERE current_tenant.user_id=candidate.user_id
           AND current_tenant.room_id=candidate.room_id
           AND NULLIF(trim(current_tenant.email), '') IS NOT NULL
         ORDER BY current_tenant.sort_order, current_tenant.id
         LIMIT 1
       ) tenant ON true
     ), inserted AS (
       INSERT INTO rent_invoice_deliveries
         (user_id, invoice_id, tenant_id, channel, template_type,
          scheduled_for, recipient_email_snapshot, status,
          trigger_source, reminder_offset_days)
       SELECT
         user_id, invoice_id, tenant_id, 'email', 'reminder',
         $1::date, recipient_email, 'scheduled', 'automatic', reminder_offset_days
       FROM due_candidates
       WHERE (
         reminder_offset_days > 0
         AND reminder_offset_days=ANY(invoice_reminder_before_days)
       ) OR (
         reminder_offset_days < 0
         AND -reminder_offset_days=ANY(invoice_reminder_after_days)
       )
       ON CONFLICT (user_id, invoice_id, tenant_id, channel, template_type, scheduled_for)
       DO NOTHING
       RETURNING id
     )
     SELECT
       (SELECT COUNT(*)::int FROM inserted) AS queued,
       (SELECT COUNT(*)::int FROM disabled_or_changed) AS skipped`,
    [scheduledFor]
  );
  return {
    queued: Number(rows[0]?.queued) || 0,
    skipped: Number(rows[0]?.skipped) || 0,
    scheduledFor
  };
}

async function deliverClaimedInvoiceSchedule(schedule, dependencies = {}) {
  const query = dependencies.query || db.query;
  const executeDelivery = dependencies.executeInvoiceEmailDelivery || executeInvoiceEmailDelivery;
  let delivery;
  try {
    delivery = await executeDelivery({
      userId: Number(schedule.user_id),
      invoiceId: Number(schedule.invoice_id),
      tenantId: schedule.tenant_id,
      templateType: schedule.template_type,
      expiresInHours: 72,
      idempotencyKey: `rent-invoice-schedule-${schedule.id}`,
      req: dependencies.req || cronRequestContext()
    }, { query });
  } catch (error) {
    const code = safeErrorCode(error);
    const outcome = SKIPPED_ERROR_CODES.has(code) ? 'skipped' : 'failed';
    const { rows } = await query(
      `UPDATE rent_invoice_deliveries
       SET status=$2, last_error_code=$3, updated_at=now()
       WHERE id=$1 AND status='sending'
       RETURNING *`,
      [schedule.id, outcome, code]
    );
    return {
      outcome,
      code,
      row: rows[0] || { ...schedule, status: outcome, last_error_code: code }
    };
  }
  const { rows } = await query(
    `UPDATE rent_invoice_deliveries
     SET status='sent', provider_message_id=$2, sent_at=now(), updated_at=now()
     WHERE id=$1 AND status='sending'
     RETURNING *`,
    [schedule.id, delivery.delivery?.emailId || null]
  );
  return {
    outcome: 'sent',
    code: null,
    delivery,
    row: rows[0] || {
      ...schedule,
      status: 'sent',
      provider_message_id: delivery.delivery?.emailId || null,
      sent_at: new Date().toISOString()
    }
  };
}

async function processDueInvoiceSchedules(dependencies = {}) {
  const query = dependencies.query || db.query;
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
    const delivered = await deliverClaimedInvoiceSchedule(schedule, { ...dependencies, query });
    result[delivered.outcome] += 1;
  }
  return result;
}

function retryFailureMessage(code) {
  return ({
    EMAIL_NOT_CONFIGURED: 'Dịch vụ email chưa được cấu hình.',
    EMAIL_SEND_FAILED: 'Không gửi được email hóa đơn. Lỗi đã được lưu để bạn thử lại.',
    INVOICE_ALREADY_PAID: 'Hóa đơn đã thanh toán đủ nên không gửi lại.',
    INVOICE_NOT_FOUND: 'Hóa đơn không còn tồn tại.',
    INVOICE_RECIPIENT_NOT_FOUND: 'Khách thuê không còn thuộc phòng của hóa đơn.',
    TENANT_EMAIL_MISSING: 'Khách thuê chưa có email nhận hóa đơn.',
    TENANT_EMAIL_INVALID: 'Email khách thuê không hợp lệ.'
  })[code] || 'Không gửi lại được email hóa đơn.';
}

async function retryInvoiceSchedule(req, res, dependencies = {}) {
  const query = dependencies.query || db.query;
  let scheduleId;
  try {
    scheduleId = positiveId(req.params?.id, 'Lịch gửi');
  } catch (error) {
    if (sendScheduleError(res, error)) return res;
    throw error;
  }
  const claimed = await query(
    `UPDATE rent_invoice_deliveries
     SET status='sending', attempt_count=attempt_count + 1,
         last_error_code=NULL, updated_at=now()
     WHERE user_id=$1 AND id=$2 AND status='failed' AND attempt_count < $3
     RETURNING *`,
    [req.userId, scheduleId, RETRY_LIMIT]
  );
  if (!claimed.rows[0]) {
    const existing = await query(
      'SELECT status, attempt_count FROM rent_invoice_deliveries WHERE user_id=$1 AND id=$2',
      [req.userId, scheduleId]
    );
    if (!existing.rows[0]) {
      return res.status(404).json({ error: 'Không tìm thấy lịch gửi', code: 'SCHEDULE_NOT_FOUND' });
    }
    if (existing.rows[0].status === 'failed'
        && Number(existing.rows[0].attempt_count) >= RETRY_LIMIT) {
      return res.status(409).json({
        error: `Lịch gửi đã đủ ${RETRY_LIMIT} lần thử`,
        code: 'SCHEDULE_RETRY_LIMIT_REACHED'
      });
    }
    return res.status(409).json({
      error: 'Chỉ có thể gửi lại lịch đang ở trạng thái lỗi',
      code: 'SCHEDULE_NOT_RETRYABLE'
    });
  }
  const result = await deliverClaimedInvoiceSchedule(claimed.rows[0], {
    ...dependencies,
    query,
    req
  });
  res.set('Cache-Control', 'no-store');
  const body = {
    delivered: result.outcome === 'sent',
    schedule: scheduleJson(result.row)
  };
  if (result.outcome === 'sent') return res.json(body);
  const statusCode = result.code === 'EMAIL_NOT_CONFIGURED'
    ? 503
    : (result.outcome === 'skipped' ? 409 : 502);
  return res.status(statusCode).json({
    ...body,
    error: retryFailureMessage(result.code),
    code: result.code
  });
}

async function invoiceScheduleCron(req, res, dependencies = {}) {
  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ error: 'Cron chưa được cấu hình', code: 'CRON_NOT_CONFIGURED' });
  }
  if (!authorizedCronRequest(req)) {
    return res.status(401).json({ error: 'Không được phép', code: 'CRON_UNAUTHORIZED' });
  }
  const enqueueReminders = dependencies.enqueueAutomaticInvoiceReminders
    || enqueueAutomaticInvoiceReminders;
  const processSchedules = dependencies.processDueInvoiceSchedules
    || processDueInvoiceSchedules;
  const queued = await enqueueReminders(dependencies);
  const result = await processSchedules(dependencies);
  result.queued = Number(queued?.queued) || 0;
  result.configurationSkipped = Number(queued?.skipped) || 0;
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
  deliverClaimedInvoiceSchedule,
  enqueueAutomaticInvoiceReminders,
  invoiceScheduleCron,
  listInvoiceSchedules,
  processDueInvoiceSchedules,
  retryInvoiceSchedule,
  scheduleInput,
  scheduleJson,
  vietnamDate
};
