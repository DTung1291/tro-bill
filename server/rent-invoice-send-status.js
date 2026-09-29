'use strict';

const crypto = require('node:crypto');
const db = require('./db');

class RentInvoiceSendStatusError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'RentInvoiceSendStatusError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function positiveInvoiceId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new RentInvoiceSendStatusError(400, 'INVALID_INVOICE_ID', 'Hóa đơn không hợp lệ');
  }
  return id;
}

function deliveryTemplate(value) {
  if (value !== 'invoice' && value !== 'reminder') {
    throw new RentInvoiceSendStatusError(400, 'INVALID_MESSAGE_TEMPLATE', 'Loại tin nhắn không hợp lệ');
  }
  return value;
}

function tenantIdInput(value) {
  const tenantId = String(value || '').trim();
  if (!tenantId || tenantId.length > 200) {
    throw new RentInvoiceSendStatusError(400, 'INVALID_TENANT_ID', 'Khách nhận hóa đơn không hợp lệ');
  }
  return tenantId;
}

function eventKey(parts) {
  return `rent-invoice-send-${crypto.createHash('sha256').update(parts.join(':')).digest('hex')}`;
}

async function confirmManualZalo(req, res, dependencies = {}) {
  try {
    const invoiceId = positiveInvoiceId(req.params?.invoiceId);
    const tenantId = tenantIdInput(req.body?.tenantId);
    const templateType = deliveryTemplate(req.body?.templateType);
    if (req.body?.confirmed !== true) {
      throw new RentInvoiceSendStatusError(
        400, 'SEND_CONFIRMATION_REQUIRED', 'Chỉ xác nhận sau khi bạn đã gửi tin trong Zalo'
      );
    }
    const query = dependencies.query || db.query;
    const { rows: recipientRows } = await query(
      `SELECT invoice.id
       FROM rent_invoices invoice
       JOIN tenants tenant
         ON tenant.user_id=invoice.user_id AND tenant.room_id=invoice.room_id
       WHERE invoice.user_id=$1 AND invoice.id=$2 AND tenant.id=$3`,
      [req.userId, invoiceId, tenantId]
    );
    if (!recipientRows[0]) {
      throw new RentInvoiceSendStatusError(
        404, 'INVOICE_RECIPIENT_NOT_FOUND', 'Không tìm thấy khách thuộc phòng của hóa đơn'
      );
    }
    const key = eventKey([req.userId, invoiceId, tenantId, 'zalo', templateType]);
    const { rows } = await query(
      `INSERT INTO rent_invoice_send_events
         (user_id, invoice_id, tenant_id, channel, evidence, template_type, idempotency_key)
       VALUES ($1,$2,$3,'zalo','owner_confirmed',$4,$5)
       ON CONFLICT (user_id, idempotency_key) DO NOTHING
       RETURNING id, created_at`,
      [req.userId, invoiceId, tenantId, templateType, key]
    );
    res.set('Cache-Control', 'no-store');
    return res.status(rows[0] ? 201 : 200).json({
      confirmed: true,
      created: !!rows[0],
      invoiceId,
      channel: 'zalo',
      templateType,
      sentAt: rows[0]?.created_at || null
    });
  } catch (error) {
    if (error instanceof RentInvoiceSendStatusError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    throw error;
  }
}

async function recordDirectEmailSuccess({ userId, invoiceId, tenantId, templateType, emailId, idempotencyKey }, query = db.query) {
  return query(
    `INSERT INTO rent_invoice_send_events
       (user_id, invoice_id, tenant_id, channel, evidence, template_type,
        provider_message_id, idempotency_key)
     VALUES ($1,$2,$3,'email','provider_accepted',$4,$5,$6)
     ON CONFLICT (user_id, idempotency_key) DO NOTHING`,
    [userId, invoiceId, tenantId, templateType, emailId || null, idempotencyKey]
  );
}

module.exports = {
  RentInvoiceSendStatusError,
  confirmManualZalo,
  deliveryTemplate,
  eventKey,
  positiveInvoiceId,
  recordDirectEmailSuccess,
  tenantIdInput
};
