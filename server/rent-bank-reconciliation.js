'use strict';

const db = require('./db');
const {
  recordDataAudit,
  requestAuditContext,
  requestDataAuditEntry
} = require('./data-audit');
const {
  ReconciliationError,
  manuallyMatchBankTransaction
} = require('./rent-payment-auto-match');

const STATUSES = new Set(['pending', 'matched', 'ignored']);

function positiveId(value, field = 'Giao dịch') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new ReconciliationError(400, 'INVALID_RECONCILIATION_ID', `${field} không hợp lệ`);
  }
  return id;
}

function transactionJson(row) {
  return {
    id: Number(row.id),
    provider: row.provider,
    providerTransactionId: row.provider_transaction_id,
    gateway: row.gateway || '',
    accountNumber: row.account_number,
    amountVnd: Number(row.amount_vnd) || 0,
    content: row.transaction_content || '',
    transactionCode: row.transaction_code || '',
    providerReference: row.provider_reference || '',
    occurredAt: row.occurred_at,
    receivedAt: row.received_at,
    matchStatus: row.match_status,
    matchReason: row.match_reason || '',
    matchedInvoiceId: row.matched_invoice_id == null ? null : Number(row.matched_invoice_id),
    matchedReceiptId: row.matched_receipt_id == null ? null : Number(row.matched_receipt_id),
    matchedReceiptCode: row.receipt_code || null,
    matchedRoomName: row.room_name_snapshot || null,
    matchedPeriod: row.period || null,
    reviewNote: row.review_note || '',
    reviewedAt: row.reviewed_at || null
  };
}

async function listBankTransactions(req, res) {
  const status = String(req.query?.status || 'pending').trim().toLowerCase();
  const requestedLimit = Number(req.query?.limit);
  const limit = Math.min(100, Math.max(
    1,
    Number.isFinite(requestedLimit) ? Math.floor(requestedLimit) : 50
  ));
  if (!STATUSES.has(status)) {
    return res.status(400).json({ error: 'Trạng thái đối soát không hợp lệ', code: 'INVALID_MATCH_STATUS' });
  }
  const { rows } = await db.query(
    `SELECT bank.*, invoice.room_name_snapshot, invoice.period, receipt.receipt_code
     FROM rent_bank_transactions bank
     LEFT JOIN rent_invoices invoice
       ON invoice.user_id=bank.user_id AND invoice.id=bank.matched_invoice_id
     LEFT JOIN rent_payment_receipts receipt
       ON receipt.user_id=bank.user_id AND receipt.id=bank.matched_receipt_id
     WHERE bank.user_id=$1 AND bank.match_status=$2
     ORDER BY bank.occurred_at DESC, bank.id DESC
     LIMIT $3`,
    [req.userId, status, limit]
  );
  res.set('Cache-Control', 'no-store');
  return res.json({ transactions: rows.map(transactionJson), status });
}

async function manuallyMatchTransaction(req, res) {
  let transactionId;
  let invoiceId;
  const note = String(req.body?.note || '').trim();
  try {
    transactionId = positiveId(req.params.id);
    invoiceId = positiveId(req.body?.invoiceId, 'Hóa đơn');
    if (note.length > 500) {
      throw new ReconciliationError(400, 'INVALID_REVIEW_NOTE', 'Ghi chú tối đa 500 ký tự');
    }
  } catch (error) {
    if (error instanceof ReconciliationError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    throw error;
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const transactionResult = await client.query(
      `SELECT * FROM rent_bank_transactions
       WHERE user_id=$1 AND id=$2
       FOR UPDATE`,
      [req.userId, transactionId]
    );
    if (!transactionResult.rows[0]) {
      throw new ReconciliationError(404, 'BANK_TRANSACTION_NOT_FOUND', 'Không tìm thấy giao dịch ngân hàng');
    }
    const match = await manuallyMatchBankTransaction(
      client,
      transactionResult.rows[0],
      invoiceId,
      req.actorUserId || req.userId,
      note,
      {
        actorEmail: req.userEmail || '',
        ...requestAuditContext(req)
      }
    );
    await client.query('COMMIT');
    return res.status(201).json({ match });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (error instanceof ReconciliationError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Giao dịch đã được xử lý trước đó', code: 'BANK_TRANSACTION_ALREADY_REVIEWED' });
    }
    throw error;
  } finally {
    client.release();
  }
}

async function ignoreBankTransaction(req, res) {
  let transactionId;
  const reason = String(req.body?.reason || '').trim();
  try {
    transactionId = positiveId(req.params.id);
    if (reason.length < 10 || reason.length > 500) {
      throw new ReconciliationError(
        400,
        'INVALID_IGNORE_REASON',
        'Lý do bỏ qua phải từ 10 đến 500 ký tự'
      );
    }
  } catch (error) {
    if (error instanceof ReconciliationError) {
      return res.status(error.statusCode).json({ error: error.message, code: error.code });
    }
    throw error;
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const updated = await client.query(
      `UPDATE rent_bank_transactions
       SET match_status='ignored', match_reason='manual_ignored',
           review_note=$3, reviewed_by_user_id=$1, reviewed_at=now(), updated_at=now()
       WHERE user_id=$1 AND id=$2 AND match_status='pending'
       RETURNING *`,
      [req.userId, transactionId, reason]
    );
    if (!updated.rows[0]) {
      const existing = await client.query(
        `SELECT match_status FROM rent_bank_transactions WHERE user_id=$1 AND id=$2`,
        [req.userId, transactionId]
      );
      if (!existing.rows[0]) {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Không tìm thấy giao dịch ngân hàng', code: 'BANK_TRANSACTION_NOT_FOUND' });
      }
      await client.query('ROLLBACK');
      return res.status(409).json({ error: 'Giao dịch đã được xử lý trước đó', code: 'BANK_TRANSACTION_ALREADY_REVIEWED' });
    }
    await recordDataAudit(
      client.query.bind(client),
      requestDataAuditEntry(
        req,
        'rent_bank_transaction_ignored',
        'rent_bank_transaction',
        transactionId,
        {
          changedFields: ['matchStatus'],
          purpose: reason
        }
      )
    );
    await client.query('COMMIT');
    res.set('Cache-Control', 'no-store');
    return res.json({ transaction: transactionJson(updated.rows[0]) });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  STATUSES,
  ignoreBankTransaction,
  listBankTransactions,
  manuallyMatchTransaction,
  positiveId,
  transactionJson
};
