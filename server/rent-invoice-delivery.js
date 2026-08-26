'use strict';

const crypto = require('crypto');
const db = require('./db');
const BillMessageTemplates = require('../bill-message-templates');
const { assertEmailConfigured, sendRentInvoiceEmail } = require('./email');
const { RentInvoiceLinkError, issueInvoiceLink } = require('./rent-invoice-links');
const { invoiceSummary } = require('./rent-payments');
const { checkAuthRateLimit, recordAuthAttempt } = require('./rate-limit');

const TENANT_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const DELIVERY_KEY_PATTERN = /^[A-Za-z0-9_-]{16,100}$/;
const TEMPLATE_TYPES = new Set(['invoice', 'reminder']);

class RentInvoiceDeliveryError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'RentInvoiceDeliveryError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function deliveryInput(req) {
  const invoiceId = Number(req.params?.invoiceId);
  const tenantId = String(req.body?.tenantId || '').trim();
  const templateType = String(req.body?.templateType || '').trim().toLowerCase();
  const deliveryKey = String(req.body?.deliveryKey || '').trim();
  const expiresInHours = Number(req.body?.expiresInHours ?? 72);
  if (!Number.isSafeInteger(invoiceId) || invoiceId < 1) {
    throw new RentInvoiceDeliveryError(400, 'INVALID_INVOICE_ID', 'Hóa đơn không hợp lệ');
  }
  if (!tenantId || tenantId.length > 200) {
    throw new RentInvoiceDeliveryError(400, 'INVALID_TENANT_ID', 'Khách nhận hóa đơn không hợp lệ');
  }
  if (!TEMPLATE_TYPES.has(templateType)) {
    throw new RentInvoiceDeliveryError(400, 'INVALID_MESSAGE_TEMPLATE', 'Loại tin nhắn không hợp lệ');
  }
  if (!DELIVERY_KEY_PATTERN.test(deliveryKey)) {
    throw new RentInvoiceDeliveryError(400, 'INVALID_DELIVERY_KEY', 'Mã chống gửi trùng không hợp lệ');
  }
  return { invoiceId, tenantId, templateType, deliveryKey, expiresInHours };
}

function periodLabel(period) {
  const match = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
  return match ? `Tháng ${Number(match[2])}/${match[1]}` : String(period || '');
}

function bankRecipient(row) {
  const owner = String(row.bank_owner_name || '').trim().toUpperCase();
  const bank = String(row.bank_id || '').trim().toUpperCase();
  const account = String(row.bank_account || '').replace(/\D/g, '');
  if (!bank || !account) return '';
  return [owner, bank, account].filter(Boolean).join(' · ');
}

function maskEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  const [local, domain] = email.split('@');
  if (!local || !domain) return '';
  return `${local.slice(0, 1)}${'*'.repeat(Math.min(5, Math.max(2, local.length - 1)))}@${domain}`;
}

function sendDeliveryError(res, error) {
  if (error instanceof RentInvoiceDeliveryError || error instanceof RentInvoiceLinkError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return true;
  }
  if (error?.code === 'EMAIL_NOT_CONFIGURED') {
    res.status(503).json({ error: error.message, code: error.code });
    return true;
  }
  if (error?.code === 'EMAIL_SEND_FAILED') {
    res.status(502).json({ error: 'Không gửi được email hóa đơn. Vui lòng thử lại.', code: error.code });
    return true;
  }
  return false;
}

async function deliverInvoiceEmail(req, res, dependencies = {}) {
  const checkDeliveryRateLimit = dependencies.checkDeliveryRateLimit || checkAuthRateLimit;
  const recordDeliveryAttempt = dependencies.recordDeliveryAttempt || recordAuthAttempt;
  let input;
  try {
    input = deliveryInput(req);
    if (!(await checkDeliveryRateLimit(req, res, 'invoiceEmail', req.userEmail))) return res;
    if (!(await recordDeliveryAttempt(req, res, 'invoiceEmail', req.userEmail))) return res;
    const result = await executeInvoiceEmailDelivery({
      userId: req.userId,
      invoiceId: input.invoiceId,
      tenantId: input.tenantId,
      templateType: input.templateType,
      expiresInHours: input.expiresInHours,
      idempotencyKey: deliveryIdempotencyKey(
        req.userId,
        input.invoiceId,
        input.tenantId,
        input.deliveryKey
      ),
      req
    }, dependencies);
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({
      delivered: result.delivery.delivered === true,
      development: result.delivery.development === true,
      emailId: result.delivery.emailId || null,
      recipient: maskEmail(result.email),
      message: result.message,
      link: result.issuedLink.link,
      publicUrl: result.issuedLink.publicUrl
    });
  } catch (error) {
    if (sendDeliveryError(res, error)) return res;
    throw error;
  }
}

function deliveryIdempotencyKey(userId, invoiceId, tenantId, deliveryKey) {
  const fingerprint = crypto
    .createHash('sha256')
    .update(`${userId}:${invoiceId}:${tenantId}:${deliveryKey}`)
    .digest('hex');
  return `rent-invoice-${fingerprint}`;
}

async function executeInvoiceEmailDelivery(input, dependencies = {}) {
  const query = dependencies.query || db.query;
  const loadInvoiceSummary = dependencies.invoiceSummary || invoiceSummary;
  const createLink = dependencies.issueInvoiceLink || issueInvoiceLink;
  const sendEmail = dependencies.sendRentInvoiceEmail || sendRentInvoiceEmail;
  const ensureEmailConfigured = dependencies.assertEmailConfigured || assertEmailConfigured;
  const summary = await loadInvoiceSummary(query, input.userId, input.invoiceId);
  if (!summary) {
    throw new RentInvoiceDeliveryError(404, 'INVOICE_NOT_FOUND', 'Không tìm thấy hóa đơn');
  }
  const { rows } = await query(
    `SELECT tenant.id, tenant.full_name, tenant.email,
            settings.bank_id, settings.bank_account, settings.bank_owner_name
     FROM tenants tenant
     LEFT JOIN settings ON settings.user_id=tenant.user_id
     WHERE tenant.user_id=$1 AND tenant.room_id=$2 AND tenant.id=$3`,
    [input.userId, summary.roomId, input.tenantId]
  );
  const tenant = rows[0];
  if (!tenant) {
    throw new RentInvoiceDeliveryError(
      404,
      'INVOICE_RECIPIENT_NOT_FOUND',
      'Khách thuê không thuộc phòng của hóa đơn này'
    );
  }
  const email = String(tenant.email || '').trim().toLowerCase();
  if (!email) {
    throw new RentInvoiceDeliveryError(
      409,
      'TENANT_EMAIL_MISSING',
      'Khách thuê chưa có email nhận hóa đơn'
    );
  }
  if (email.length > 254 || !TENANT_EMAIL_PATTERN.test(email)) {
    throw new RentInvoiceDeliveryError(409, 'TENANT_EMAIL_INVALID', 'Email khách thuê không hợp lệ');
  }
  if (input.templateType === 'reminder' && summary.totalDueVnd <= 0) {
    throw new RentInvoiceDeliveryError(
      409,
      'INVOICE_ALREADY_PAID',
      'Hóa đơn đã thanh toán đủ nên không gửi nhắc nợ'
    );
  }

  ensureEmailConfigured();
  const issuedLink = await createLink({
    userId: input.userId,
    invoiceId: input.invoiceId,
    expiresInHours: input.expiresInHours,
    req: input.req,
    query
  });
  const context = {
    roomName: summary.roomName,
    periodLabel: periodLabel(summary.period),
    invoiceTotalVnd: summary.invoiceTotalVnd,
    paidAmountVnd: summary.paidAmountVnd,
    priorDebtVnd: summary.priorDebtVnd,
    totalDueVnd: summary.totalDueVnd,
    dueDate: summary.dueDate,
    overdueDays: summary.overdueDays,
    transferContent: summary.transferContent,
    bankRecipient: bankRecipient(tenant),
    invoiceUrl: issuedLink.publicUrl
  };
  const message = input.templateType === 'reminder'
    ? BillMessageTemplates.reminder(context)
    : BillMessageTemplates.invoice(context);
  try {
    const delivery = await sendEmail({
      email,
      tenantName: tenant.full_name || '',
      roomName: summary.roomName,
      period: periodLabel(summary.period),
      templateType: input.templateType,
      message,
      invoiceUrl: issuedLink.publicUrl,
      idempotencyKey: input.idempotencyKey
    });
    return { delivery, email, issuedLink, message, summary, tenant };
  } catch (error) {
    if (issuedLink?.link?.id) {
      await query(
        `UPDATE rent_invoice_share_links
         SET revoked_at=COALESCE(revoked_at, now())
         WHERE user_id=$1 AND id=$2`,
        [input.userId, issuedLink.link.id]
      ).catch(() => {});
    }
    throw error;
  }
}

module.exports = {
  DELIVERY_KEY_PATTERN,
  RentInvoiceDeliveryError,
  TENANT_EMAIL_PATTERN,
  TEMPLATE_TYPES,
  bankRecipient,
  deliveryIdempotencyKey,
  deliverInvoiceEmail,
  deliveryInput,
  executeInvoiceEmailDelivery,
  maskEmail,
  periodLabel,
  sendDeliveryError
};
