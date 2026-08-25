'use strict';

const InvoiceReference = require('../invoice-reference');
const { receiptCode } = require('./rent-payments');

const TRANSFER_REFERENCE_PATTERN = /\bHD[0-9A-Z]{8,13}\b/g;

class ReconciliationError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'ReconciliationError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function invoiceReferences(...values) {
  const matches = new Set();
  for (const value of values) {
    const text = String(value || '').toUpperCase();
    for (const candidate of text.match(TRANSFER_REFERENCE_PATTERN) || []) {
      if (InvoiceReference.isValid(candidate)) matches.add(candidate);
    }
  }
  return [...matches];
}

async function keepPending(client, transactionId, reason) {
  await client.query(
    `UPDATE rent_bank_transactions
     SET match_status='pending', match_reason=$2, updated_at=now()
     WHERE id=$1 AND match_status='pending'`,
    [transactionId, reason]
  );
  return { matched: false, status: 'pending', reason };
}

async function targetWithOutstanding(client, transaction, invoiceId) {
  const invoiceResult = await client.query(
    `SELECT id, user_id, room_id, period
     FROM rent_invoices
     WHERE user_id=$1 AND id=$2
     FOR UPDATE`,
    [transaction.user_id, invoiceId]
  );
  const targetInvoice = invoiceResult.rows[0];
  if (!targetInvoice) return null;

  await client.query(
    `SELECT id FROM rent_invoices
     WHERE user_id=$1 AND room_id=$2 AND period<=$3
     ORDER BY period, id
     FOR UPDATE`,
    [transaction.user_id, targetInvoice.room_id, targetInvoice.period]
  );
  const balanceResult = await client.query(
    `SELECT i.id, i.period,
            GREATEST(i.issued_total_vnd - COALESCE(SUM(t.amount_vnd), 0), 0)
              AS remaining_vnd
     FROM rent_invoices i
     LEFT JOIN rent_payment_transactions t
       ON t.user_id=i.user_id AND t.invoice_id=i.id
     WHERE i.user_id=$1 AND i.room_id=$2 AND i.period<=$3
     GROUP BY i.id
     HAVING i.issued_total_vnd - COALESCE(SUM(t.amount_vnd), 0) > 0
     ORDER BY i.period, i.id`,
    [transaction.user_id, targetInvoice.room_id, targetInvoice.period]
  );
  const tenancyResult = await client.query(
    `SELECT NULLIF(left(rent_start_date, 7), '') AS tenancy_start_period
     FROM rooms
     WHERE user_id=$1 AND id=$2
     LIMIT 1`,
    [transaction.user_id, targetInvoice.room_id]
  );
  const tenancyStart = tenancyResult.rows[0]?.tenancy_start_period || '';
  const outstanding = tenancyStart && targetInvoice.period >= tenancyStart
    ? balanceResult.rows.filter((row) => row.period >= tenancyStart)
    : balanceResult.rows;
  const expectedAmountVnd = outstanding.reduce(
    (total, row) => total + Number(row.remaining_vnd),
    0
  );
  return { targetInvoice, outstanding, expectedAmountVnd };
}

async function recordMatch(client, transaction, target, options = {}) {
  const receivedAmountVnd = Number(transaction.amount_vnd);
  const manual = options.mode === 'manual';
  const transferReference = options.transferReference || '';
  const receiptSource = manual ? 'sepay_manual' : 'sepay_auto';
  const note = manual
    ? (String(options.reviewNote || '').trim() || 'Chủ trọ ghép giao dịch SePay thủ công')
    : `SePay tự động đối soát ${transferReference}`;
  const receiptIdResult = await client.query(
    `SELECT nextval('rent_payment_receipts_id_seq') AS id`
  );
  const receiptId = Number(receiptIdResult.rows[0].id);
  const idempotencyKey = `sepay:${transaction.channel_id}:${transaction.provider_transaction_id}`;
  const newReceiptCode = receiptCode(receiptId, target.targetInvoice.period);
  await client.query(
    `INSERT INTO rent_payment_receipts
       (id, user_id, room_id, target_period, receipt_code, amount_vnd,
        payment_method, note, source, idempotency_key, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,'bank_transfer',$7,$8,$9,$10)`,
    [
      receiptId,
      transaction.user_id,
      target.targetInvoice.room_id,
      target.targetInvoice.period,
      newReceiptCode,
      receivedAmountVnd,
      note,
      receiptSource,
      idempotencyKey,
      transaction.occurred_at
    ]
  );

  let unallocated = receivedAmountVnd;
  const allocations = [];
  for (const invoice of target.outstanding) {
    if (unallocated <= 0) break;
    const allocatedAmount = Math.min(unallocated, Number(invoice.remaining_vnd));
    const isPriorDebt = invoice.period < target.targetInvoice.period;
    const source = manual
      ? (isPriorDebt ? 'sepay_manual_prior_debt' : 'sepay_manual')
      : (isPriorDebt ? 'sepay_prior_debt' : 'sepay_auto');
    const inserted = await client.query(
      `INSERT INTO rent_payment_transactions
         (user_id, invoice_id, receipt_id, entry_type, amount_vnd,
          payment_method, external_reference, note, source, occurred_at)
       VALUES ($1,$2,$3,'payment',$4,'bank_transfer',$5,$6,$7,$8)
       RETURNING id`,
      [
        transaction.user_id,
        invoice.id,
        receiptId,
        allocatedAmount,
        `sepay:${transaction.provider_transaction_id}`,
        note,
        source,
        transaction.occurred_at
      ]
    );
    allocations.push({
      transactionId: Number(inserted.rows[0].id),
      invoiceId: Number(invoice.id),
      period: invoice.period,
      amountVnd: allocatedAmount
    });
    unallocated -= allocatedAmount;
  }

  await client.query(
    `UPDATE rent_bank_transactions
     SET match_status='matched', match_reason=$4,
         matched_invoice_id=$2, matched_receipt_id=$3,
         review_note=$5, reviewed_by_user_id=$6,
         reviewed_at=CASE WHEN $6::bigint IS NULL THEN reviewed_at ELSE now() END,
         matched_at=now(), updated_at=now()
     WHERE id=$1 AND match_status='pending'`,
    [
      transaction.id,
      target.targetInvoice.id,
      receiptId,
      manual ? 'matched_manual' : 'matched_exact',
      manual ? note : '',
      manual ? options.actorUserId : null
    ]
  );
  return {
    matched: true,
    status: 'matched',
    reason: manual ? 'matched_manual' : 'matched_exact',
    transferReference,
    invoiceId: Number(target.targetInvoice.id),
    receiptId,
    receiptCode: newReceiptCode,
    allocations
  };
}

async function autoMatchBankTransaction(client, transaction) {
  if (!transaction || transaction.match_status === 'matched') {
    return {
      matched: transaction?.match_status === 'matched',
      status: transaction?.match_status || 'pending',
      reason: transaction?.match_reason || ''
    };
  }

  const references = invoiceReferences(
    transaction.transaction_code,
    transaction.transaction_content
  );
  if (references.length === 0) {
    return keepPending(client, transaction.id, 'transfer_reference_missing');
  }
  if (references.length > 1) {
    return keepPending(client, transaction.id, 'multiple_transfer_references');
  }
  const transferReference = references[0];
  const invoiceId = InvoiceReference.toInvoiceId(transferReference);
  const target = await targetWithOutstanding(client, transaction, invoiceId);
  if (!target) return keepPending(client, transaction.id, 'invoice_not_found');
  if (target.expectedAmountVnd <= 0) {
    return keepPending(client, transaction.id, 'invoice_already_settled');
  }
  const receivedAmountVnd = Number(transaction.amount_vnd);
  if (!Number.isSafeInteger(receivedAmountVnd)
      || receivedAmountVnd !== target.expectedAmountVnd) {
    return keepPending(client, transaction.id, 'amount_mismatch');
  }
  return recordMatch(client, transaction, target, { transferReference, mode: 'auto' });
}

async function manuallyMatchBankTransaction(client, transaction, invoiceId, actorUserId, reviewNote) {
  if (!transaction || transaction.match_status !== 'pending') {
    throw new ReconciliationError(
      409,
      'BANK_TRANSACTION_ALREADY_REVIEWED',
      'Giao dịch ngân hàng đã được xử lý trước đó'
    );
  }
  const target = await targetWithOutstanding(client, transaction, invoiceId);
  if (!target) {
    throw new ReconciliationError(404, 'INVOICE_NOT_FOUND', 'Không tìm thấy hóa đơn thuộc tài khoản');
  }
  if (target.expectedAmountVnd <= 0) {
    throw new ReconciliationError(409, 'INVOICE_ALREADY_SETTLED', 'Hóa đơn đã được thu đủ');
  }
  const amount = Number(transaction.amount_vnd);
  if (!Number.isSafeInteger(amount) || amount < 1 || amount > target.expectedAmountVnd) {
    throw new ReconciliationError(
      409,
      'BANK_AMOUNT_EXCEEDS_OUTSTANDING',
      'Số tiền giao dịch lớn hơn công nợ của hóa đơn đã chọn'
    );
  }
  return recordMatch(client, transaction, target, {
    mode: 'manual',
    actorUserId,
    reviewNote
  });
}

module.exports = {
  ReconciliationError,
  TRANSFER_REFERENCE_PATTERN,
  autoMatchBankTransaction,
  invoiceReferences,
  manuallyMatchBankTransaction,
  targetWithOutstanding
};
