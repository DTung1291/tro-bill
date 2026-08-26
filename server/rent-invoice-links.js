'use strict';

const crypto = require('crypto');
const db = require('./db');
const DebtAge = require('../debt-age');
const InvoiceReference = require('../invoice-reference');
const { invoiceDetailInput } = require('./rent-payments');
const { normalizeRentBankSettings } = require('./rent-bank-settings');

const TOKEN_PATTERN = /^tbril_[A-Za-z0-9_-]{43}$/;
const MAX_LINK_HOURS = 24 * 30;

class RentInvoiceLinkError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'RentInvoiceLinkError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function sendLinkError(res, error) {
  if (!(error instanceof RentInvoiceLinkError)) return false;
  res.status(error.statusCode).json({ error: error.message, code: error.code });
  return true;
}

function positiveId(value, field = 'Hóa đơn') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new RentInvoiceLinkError(400, 'INVALID_INVOICE_LINK_ID', `${field} không hợp lệ`);
  }
  return id;
}

function expiryHours(value) {
  const hours = Number(value ?? 72);
  if (!Number.isSafeInteger(hours) || hours < 1 || hours > MAX_LINK_HOURS) {
    throw new RentInvoiceLinkError(
      400,
      'INVALID_INVOICE_LINK_EXPIRY',
      'Thời hạn liên kết phải từ 1 giờ đến 30 ngày'
    );
  }
  return hours;
}

function generateToken() {
  return `tbril_${crypto.randomBytes(32).toString('base64url')}`;
}

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token), 'utf8').digest('hex');
}

function publicBaseUrl(req) {
  const host = String(req.get('host') || '').trim();
  const requestBase = /^[A-Za-z0-9.-]+(?::[0-9]{1,5})?$/.test(host)
    ? `${req.protocol || 'http'}://${host}`
    : '';
  const configured = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  return process.env.VERCEL_ENV === 'preview' && requestBase
    ? requestBase
    : (configured || requestBase);
}

function linkJson(row) {
  const now = Date.now();
  const expired = new Date(row.expires_at).getTime() <= now;
  return {
    id: Number(row.id),
    invoiceId: Number(row.invoice_id),
    tokenLast4: row.token_last4,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at || null,
    createdAt: row.created_at,
    viewCount: Number(row.view_count) || 0,
    lastViewedAt: row.last_viewed_at || null,
    status: row.revoked_at ? 'revoked' : (expired ? 'expired' : 'active')
  };
}

async function createInvoiceLink(req, res) {
  let invoiceId;
  let hours;
  try {
    invoiceId = positiveId(req.params.invoiceId);
    hours = expiryHours(req.body?.expiresInHours);
  } catch (error) {
    if (sendLinkError(res, error)) return res;
    throw error;
  }
  const token = generateToken();
  const hash = tokenHash(token);
  const { rows } = await db.query(
    `INSERT INTO rent_invoice_share_links
       (user_id, invoice_id, tenancy_start_period,
        token_hash, token_last4, expires_at)
     SELECT invoice.user_id, invoice.id,
            CASE
              WHEN room.rent_start_date ~ '^[0-9]{4}-(0[1-9]|1[0-2])-[0-9]{2}$'
                AND left(room.rent_start_date, 7) <= invoice.period
              THEN left(room.rent_start_date, 7)
              ELSE invoice.period
            END,
            $3, $4,
            now() + ($5::int * interval '1 hour')
     FROM rent_invoices invoice
     LEFT JOIN rooms room
       ON room.user_id=invoice.user_id AND room.id=invoice.room_id
     WHERE invoice.user_id=$1 AND invoice.id=$2
     RETURNING *`,
    [req.userId, invoiceId, hash, token.slice(-4), hours]
  );
  if (!rows[0]) {
    return res.status(404).json({ error: 'Không tìm thấy hóa đơn', code: 'INVOICE_NOT_FOUND' });
  }
  res.set('Cache-Control', 'no-store');
  return res.status(201).json({
    link: linkJson(rows[0]),
    publicUrl: `${publicBaseUrl(req)}/invoice.html#t=${encodeURIComponent(token)}`
  });
}

async function listInvoiceLinks(req, res) {
  let invoiceId;
  try {
    invoiceId = positiveId(req.params.invoiceId);
  } catch (error) {
    if (sendLinkError(res, error)) return res;
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
    `SELECT * FROM rent_invoice_share_links
     WHERE user_id=$1 AND invoice_id=$2
     ORDER BY created_at DESC, id DESC
     LIMIT 50`,
    [req.userId, invoiceId]
  );
  res.set('Cache-Control', 'no-store');
  return res.json({ links: rows.map(linkJson) });
}

async function revokeInvoiceLink(req, res) {
  let linkId;
  try {
    linkId = positiveId(req.params.id, 'Liên kết');
  } catch (error) {
    if (sendLinkError(res, error)) return res;
    throw error;
  }
  const { rows } = await db.query(
    `UPDATE rent_invoice_share_links
     SET revoked_at=COALESCE(revoked_at, now())
     WHERE user_id=$1 AND id=$2
     RETURNING *`,
    [req.userId, linkId]
  );
  if (!rows[0]) {
    return res.status(404).json({ error: 'Không tìm thấy liên kết', code: 'INVOICE_LINK_NOT_FOUND' });
  }
  res.set('Cache-Control', 'no-store');
  return res.json({ link: linkJson(rows[0]) });
}

function publicInvoiceJson(row) {
  const total = Number(row.issued_total_vnd) || 0;
  const paid = Math.max(0, Number(row.paid_amount_vnd) || 0);
  const remaining = Math.max(0, total - paid);
  const debtAge = DebtAge.classify(row.period, remaining);
  const transferContent = InvoiceReference.fromInvoiceId(row.invoice_id);
  let details = {};
  try {
    details = invoiceDetailInput(row.detail_snapshot || {}, total);
  } catch (_) {
    // Hóa đơn legacy chưa có snapshot hợp lệ vẫn hiển thị được phần tổng quan.
  }
  const meterPhotos = {};
  for (const photo of Array.isArray(row.meter_photos) ? row.meter_photos : []) {
    const meterType = String(photo.meter_type || '');
    const mimeType = String(photo.mime_type || '');
    const imageBase64 = String(photo.image_base64 || '');
    if (['electricity', 'water'].includes(meterType)
        && mimeType === 'image/jpeg'
        && /^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)) {
      meterPhotos[meterType] = `data:${mimeType};base64,${imageBase64}`;
    }
  }
  let payment = null;
  try {
    const bank = normalizeRentBankSettings(row, { allowEmpty: false });
    if (remaining > 0 && transferContent) {
      const imageUrl = `https://img.vietqr.io/image/${encodeURIComponent(bank.bankId)}`
        + `-${encodeURIComponent(bank.accountNumber)}-compact2.png`
        + `?amount=${remaining}`
        + `&addInfo=${encodeURIComponent(transferContent)}`
        + `&accountName=${encodeURIComponent(bank.ownerName)}`;
      payment = {
        settlementMode: 'direct_to_landlord',
        amountVnd: remaining,
        transferContent,
        bankId: bank.bankId,
        accountNumber: bank.accountNumber,
        ownerName: bank.ownerName,
        imageUrl
      };
    }
  } catch (_) {
    // Chủ trọ chưa cấu hình đủ ngân hàng: vẫn hiển thị hóa đơn, không tạo QR sai.
  }
  return {
    invoice: {
      transferContent,
      roomName: row.room_name_snapshot || '',
      period: row.period,
      invoiceTotalVnd: total,
      paidAmountVnd: paid,
      remainingVnd: remaining,
      dueDate: debtAge.dueDate,
      status: remaining === 0 ? 'paid' : (paid > 0 ? 'partial' : 'unpaid')
    },
    details,
    meterPhotos,
    payment,
    receipts: (Array.isArray(row.receipts) ? row.receipts : []).map(receipt => ({
      code: receipt.receipt_code,
      receiptTotalVnd: Number(receipt.receipt_total_vnd) || 0,
      allocatedAmountVnd: Number(receipt.allocated_amount_vnd) || 0,
      paymentMethod: receipt.payment_method,
      occurredAt: receipt.occurred_at
    })),
    history: {
      scopeStartPeriod: row.tenancy_start_period || row.period,
      scopeEndPeriod: row.period,
      invoices: (Array.isArray(row.history_invoices) ? row.history_invoices : []).map(invoice => {
        const invoiceTotalVnd = Number(invoice.issued_total_vnd) || 0;
        const paidAmountVnd = Math.max(0, Number(invoice.paid_amount_vnd) || 0);
        const remainingVnd = Math.max(0, invoiceTotalVnd - paidAmountVnd);
        return {
          period: invoice.period,
          invoiceTotalVnd,
          paidAmountVnd,
          remainingVnd,
          status: remainingVnd === 0 ? 'paid' : (paidAmountVnd > 0 ? 'partial' : 'unpaid')
        };
      }),
      payments: (Array.isArray(row.history_payments) ? row.history_payments : []).map(paymentRow => ({
        period: paymentRow.period,
        entryType: paymentRow.entry_type,
        amountVnd: Number(paymentRow.amount_vnd) || 0,
        paymentMethod: paymentRow.payment_method,
        receiptCode: paymentRow.receipt_code || null,
        occurredAt: paymentRow.occurred_at
      }))
    },
    link: {
      expiresAt: row.expires_at,
      paymentProof: row.payment_proof || null
    }
  };
}

async function resolvePublicInvoiceLink(req, res) {
  const token = String(req.body?.token || '').trim();
  if (!TOKEN_PATTERN.test(token)) {
    return res.status(404).json({ error: 'Liên kết hóa đơn không hợp lệ', code: 'INVOICE_LINK_INVALID' });
  }
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const linkResult = await client.query(
      `SELECT id, user_id, invoice_id, tenancy_start_period, expires_at, revoked_at
       FROM rent_invoice_share_links
       WHERE token_hash=$1
       FOR UPDATE`,
      [tokenHash(token)]
    );
    const link = linkResult.rows[0];
    if (!link) {
      throw new RentInvoiceLinkError(404, 'INVOICE_LINK_INVALID', 'Liên kết hóa đơn không hợp lệ');
    }
    if (link.revoked_at) {
      throw new RentInvoiceLinkError(410, 'INVOICE_LINK_REVOKED', 'Liên kết hóa đơn đã được thu hồi');
    }
    if (new Date(link.expires_at).getTime() <= Date.now()) {
      throw new RentInvoiceLinkError(410, 'INVOICE_LINK_EXPIRED', 'Liên kết hóa đơn đã hết hạn');
    }
    const invoiceResult = await client.query(
      `SELECT invoice.id AS invoice_id, invoice.room_id, invoice.room_name_snapshot,
              invoice.period, invoice.issued_total_vnd, invoice.detail_snapshot,
              settings.bank_id, settings.bank_account, settings.bank_owner_name,
              COALESCE(SUM(tx.amount_vnd), 0) AS paid_amount_vnd
       FROM rent_invoices invoice
       LEFT JOIN settings ON settings.user_id=invoice.user_id
       LEFT JOIN rent_payment_transactions tx
         ON tx.user_id=invoice.user_id AND tx.invoice_id=invoice.id
       WHERE invoice.user_id=$1 AND invoice.id=$2
       GROUP BY invoice.id, settings.bank_id, settings.bank_account, settings.bank_owner_name`,
      [link.user_id, link.invoice_id]
    );
    const invoice = invoiceResult.rows[0];
    if (!invoice) {
      throw new RentInvoiceLinkError(404, 'INVOICE_NOT_FOUND', 'Không tìm thấy hóa đơn');
    }
    const tenancyStartPeriod = String(link.tenancy_start_period || invoice.period);
    const meterPhotoResult = await client.query(
      `SELECT meter_type, mime_type, encode(image_data, 'base64') AS image_base64
       FROM rent_meter_photos
       WHERE user_id=$1 AND room_id=$2 AND period=$3
       ORDER BY meter_type`,
      [link.user_id, invoice.room_id, invoice.period]
    );
    const proofResult = await client.query(
      `SELECT status, submitted_at
       FROM rent_payment_proofs
       WHERE user_id=$1 AND invoice_id=$2 AND share_link_id=$3`,
      [link.user_id, link.invoice_id, link.id]
    );
    const receiptResult = await client.query(
      `SELECT receipt.receipt_code, receipt.amount_vnd AS receipt_total_vnd,
              receipt.payment_method, receipt.occurred_at,
              SUM(tx.amount_vnd) AS allocated_amount_vnd
       FROM rent_payment_transactions tx
       JOIN rent_payment_receipts receipt
         ON receipt.user_id=tx.user_id AND receipt.id=tx.receipt_id
       WHERE tx.user_id=$1 AND tx.invoice_id=$2
         AND tx.entry_type='payment' AND tx.amount_vnd > 0
         AND NOT EXISTS (
           SELECT 1 FROM rent_payment_transactions reversal
           WHERE reversal.user_id=tx.user_id
             AND reversal.reverses_transaction_id=tx.id
         )
       GROUP BY receipt.id
       HAVING SUM(tx.amount_vnd) > 0
       ORDER BY receipt.occurred_at DESC, receipt.id DESC
       LIMIT 20`,
      [link.user_id, link.invoice_id]
    );
    const historyInvoiceResult = await client.query(
      `SELECT history.id, history.period, history.issued_total_vnd,
              COALESCE(SUM(tx.amount_vnd), 0) AS paid_amount_vnd
       FROM rent_invoices history
       LEFT JOIN rent_payment_transactions tx
         ON tx.user_id=history.user_id AND tx.invoice_id=history.id
       WHERE history.user_id=$1 AND history.room_id=$2
         AND history.period BETWEEN $3 AND $4
       GROUP BY history.id
       ORDER BY history.period DESC, history.id DESC
       LIMIT 24`,
      [link.user_id, invoice.room_id, tenancyStartPeriod, invoice.period]
    );
    const historyPaymentResult = await client.query(
      `SELECT history.period, tx.entry_type, tx.amount_vnd,
              tx.payment_method, tx.occurred_at, receipt.receipt_code
       FROM rent_payment_transactions tx
       JOIN rent_invoices history
         ON history.user_id=tx.user_id AND history.id=tx.invoice_id
       LEFT JOIN rent_payment_receipts receipt
         ON receipt.user_id=tx.user_id AND receipt.id=tx.receipt_id
       WHERE history.user_id=$1 AND history.room_id=$2
         AND history.period BETWEEN $3 AND $4
       ORDER BY tx.occurred_at DESC, tx.id DESC
       LIMIT 100`,
      [link.user_id, invoice.room_id, tenancyStartPeriod, invoice.period]
    );
    const row = {
      ...invoice,
      expires_at: link.expires_at,
      meter_photos: meterPhotoResult.rows,
      receipts: receiptResult.rows,
      tenancy_start_period: tenancyStartPeriod,
      history_invoices: historyInvoiceResult.rows,
      history_payments: historyPaymentResult.rows,
      payment_proof: proofResult.rows[0]
        ? {
            status: proofResult.rows[0].status,
            submittedAt: proofResult.rows[0].submitted_at
          }
        : null
    };
    await client.query(
      `UPDATE rent_invoice_share_links
       SET view_count=view_count + 1, last_viewed_at=now()
       WHERE id=$1`,
      [link.id]
    );
    await client.query('COMMIT');
    res.set('Cache-Control', 'no-store');
    return res.json(publicInvoiceJson(row));
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendLinkError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  MAX_LINK_HOURS,
  RentInvoiceLinkError,
  TOKEN_PATTERN,
  createInvoiceLink,
  expiryHours,
  generateToken,
  linkJson,
  listInvoiceLinks,
  publicBaseUrl,
  publicInvoiceJson,
  resolvePublicInvoiceLink,
  revokeInvoiceLink,
  tokenHash
};
