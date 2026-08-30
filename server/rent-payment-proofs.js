'use strict';

const crypto = require('crypto');
const db = require('./db');
const { TOKEN_PATTERN, tokenHash } = require('./rent-invoice-links');

const MAX_PROOF_BYTES = 192 * 1024;
const DATA_URL_PATTERN = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/;

class RentPaymentProofError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'RentPaymentProofError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function sendProofError(res, error) {
  if (!(error instanceof RentPaymentProofError)) return false;
  res.status(error.statusCode).json({ error: error.message, code: error.code });
  return true;
}

function positiveId(value) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new RentPaymentProofError(400, 'INVALID_INVOICE_ID', 'Hóa đơn không hợp lệ');
  }
  return id;
}

function proofImageInput(value) {
  const dataUrl = String(value || '').trim();
  const match = DATA_URL_PATTERN.exec(dataUrl);
  if (!match || match[1].length % 4 !== 0) {
    throw new RentPaymentProofError(
      400,
      'INVALID_PAYMENT_PROOF',
      'Minh chứng phải là ảnh JPEG hợp lệ'
    );
  }
  const imageData = Buffer.from(match[1], 'base64');
  if (imageData.toString('base64') !== match[1]
      || imageData.length < 100
      || imageData.length > MAX_PROOF_BYTES
      || imageData[0] !== 0xff
      || imageData[1] !== 0xd8
      || imageData[2] !== 0xff
      || imageData[imageData.length - 2] !== 0xff
      || imageData[imageData.length - 1] !== 0xd9) {
    throw new RentPaymentProofError(
      400,
      'INVALID_PAYMENT_PROOF',
      'Ảnh minh chứng không hợp lệ hoặc vượt quá 192 KB'
    );
  }
  return {
    imageData,
    sha256: crypto.createHash('sha256').update(imageData).digest('hex')
  };
}

function publicProofJson(row) {
  if (!row) return null;
  return {
    status: row.status,
    submittedAt: row.submitted_at
  };
}

function ownerProofJson(row) {
  const imageBase64 = String(row.image_base64 || '');
  return {
    id: Number(row.id),
    invoiceId: Number(row.invoice_id),
    linkTokenLast4: row.token_last4,
    status: row.status,
    byteSize: Number(row.byte_size),
    sha256: row.sha256,
    submittedAt: row.submitted_at,
    imageDataUrl: /^[A-Za-z0-9+/]+={0,2}$/.test(imageBase64)
      ? `data:image/jpeg;base64,${imageBase64}`
      : null
  };
}

async function submitPublicPaymentProof(req, res) {
  const token = String(req.body?.token || '').trim();
  if (!TOKEN_PATTERN.test(token)) {
    return res.status(404).json({
      error: 'Liên kết hóa đơn không hợp lệ',
      code: 'INVOICE_LINK_INVALID'
    });
  }

  let proof;
  try {
    proof = proofImageInput(req.body?.dataUrl);
  } catch (error) {
    if (sendProofError(res, error)) return res;
    throw error;
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const linkResult = await client.query(
      `SELECT link.id, link.user_id, link.invoice_id, link.expires_at, link.revoked_at,
              COALESCE(invoice.final_total_vnd, invoice.issued_total_vnd)
                AS issued_total_vnd
       FROM rent_invoice_share_links link
       JOIN rent_invoices invoice
         ON invoice.user_id=link.user_id AND invoice.id=link.invoice_id
       WHERE link.token_hash=$1
       FOR UPDATE OF link`,
      [tokenHash(token)]
    );
    const link = linkResult.rows[0];
    if (!link) {
      throw new RentPaymentProofError(404, 'INVOICE_LINK_INVALID', 'Liên kết hóa đơn không hợp lệ');
    }
    if (link.revoked_at) {
      throw new RentPaymentProofError(410, 'INVOICE_LINK_REVOKED', 'Liên kết hóa đơn đã được thu hồi');
    }
    if (new Date(link.expires_at).getTime() <= Date.now()) {
      throw new RentPaymentProofError(410, 'INVOICE_LINK_EXPIRED', 'Liên kết hóa đơn đã hết hạn');
    }
    const paidResult = await client.query(
      `SELECT COALESCE(SUM(amount_vnd), 0) AS paid_amount_vnd
       FROM rent_payment_transactions
       WHERE user_id=$1 AND invoice_id=$2`,
      [link.user_id, link.invoice_id]
    );
    const remaining = Math.max(
      0,
      (Number(link.issued_total_vnd) || 0)
        - (Number(paidResult.rows[0]?.paid_amount_vnd) || 0)
    );
    if (remaining === 0) {
      throw new RentPaymentProofError(
        409,
        'INVOICE_ALREADY_PAID',
        'Hóa đơn đã được thanh toán đầy đủ'
      );
    }

    const insertResult = await client.query(
      `INSERT INTO rent_payment_proofs
         (user_id, invoice_id, share_link_id, mime_type, image_data, byte_size, sha256)
       VALUES ($1,$2,$3,'image/jpeg',$4,$5,$6)
       ON CONFLICT (share_link_id) DO NOTHING
       RETURNING status, submitted_at`,
      [
        link.user_id,
        link.invoice_id,
        link.id,
        proof.imageData,
        proof.imageData.length,
        proof.sha256
      ]
    );
    if (!insertResult.rows[0]) {
      throw new RentPaymentProofError(
        409,
        'PAYMENT_PROOF_ALREADY_SUBMITTED',
        'Liên kết này đã gửi minh chứng chuyển khoản'
      );
    }
    await client.query('COMMIT');
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({ proof: publicProofJson(insertResult.rows[0]) });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendProofError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

async function listInvoicePaymentProofs(req, res) {
  let invoiceId;
  try {
    invoiceId = positiveId(req.params.invoiceId);
  } catch (error) {
    if (sendProofError(res, error)) return res;
    throw error;
  }
  const { rows } = await db.query(
    `SELECT proof.id, proof.invoice_id, proof.status, proof.byte_size,
            proof.sha256, proof.submitted_at, link.token_last4,
            encode(proof.image_data, 'base64') AS image_base64
     FROM rent_payment_proofs proof
     JOIN rent_invoice_share_links link
       ON link.user_id=proof.user_id
      AND link.invoice_id=proof.invoice_id
      AND link.id=proof.share_link_id
     WHERE proof.user_id=$1 AND proof.invoice_id=$2
     ORDER BY proof.submitted_at DESC, proof.id DESC
     LIMIT 10`,
    [req.userId, invoiceId]
  );
  res.set('Cache-Control', 'no-store');
  return res.json({ proofs: rows.map(ownerProofJson) });
}

module.exports = {
  DATA_URL_PATTERN,
  MAX_PROOF_BYTES,
  RentPaymentProofError,
  listInvoicePaymentProofs,
  ownerProofJson,
  proofImageInput,
  publicProofJson,
  submitPublicPaymentProof
};
