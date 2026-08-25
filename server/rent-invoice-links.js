'use strict';

const crypto = require('crypto');
const db = require('./db');
const DebtAge = require('../debt-age');
const InvoiceReference = require('../invoice-reference');

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
       (user_id, invoice_id, token_hash, token_last4, expires_at)
     SELECT invoice.user_id, invoice.id, $3, $4,
            now() + ($5::int * interval '1 hour')
     FROM rent_invoices invoice
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
  return {
    invoice: {
      transferContent: InvoiceReference.fromInvoiceId(row.invoice_id),
      roomName: row.room_name_snapshot || '',
      period: row.period,
      invoiceTotalVnd: total,
      paidAmountVnd: paid,
      remainingVnd: remaining,
      dueDate: debtAge.dueDate,
      status: remaining === 0 ? 'paid' : (paid > 0 ? 'partial' : 'unpaid')
    },
    link: {
      expiresAt: row.expires_at
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
      `SELECT id, user_id, invoice_id, expires_at, revoked_at
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
      `SELECT invoice.id AS invoice_id, invoice.room_name_snapshot,
              invoice.period, invoice.issued_total_vnd,
              COALESCE(SUM(tx.amount_vnd), 0) AS paid_amount_vnd
       FROM rent_invoices invoice
       LEFT JOIN rent_payment_transactions tx
         ON tx.user_id=invoice.user_id AND tx.invoice_id=invoice.id
       WHERE invoice.user_id=$1 AND invoice.id=$2
       GROUP BY invoice.id`,
      [link.user_id, link.invoice_id]
    );
    const row = { ...invoiceResult.rows[0], expires_at: link.expires_at };
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
