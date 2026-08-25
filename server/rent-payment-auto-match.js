'use strict';

const InvoiceReference = require('../invoice-reference');
const { receiptCode } = require('./rent-payments');

const TRANSFER_REFERENCE_PATTERN = /\bHD[0-9A-Z]{8,13}\b/g;

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
  const invoiceResult = await client.query(
    `SELECT id, user_id, room_id, period
     FROM rent_invoices
     WHERE user_id=$1 AND id=$2
     FOR UPDATE`,
    [transaction.user_id, invoiceId]
  );
  const targetInvoice = invoiceResult.rows[0];
  if (!targetInvoice) {
    return keepPending(client, transaction.id, 'invoice_not_found');
  }

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
  if (expectedAmountVnd <= 0) {
    return keepPending(client, transaction.id, 'invoice_already_settled');
  }
  const receivedAmountVnd = Number(transaction.amount_vnd);
  if (!Number.isSafeInteger(receivedAmountVnd)
      || receivedAmountVnd !== expectedAmountVnd) {
    return keepPending(client, transaction.id, 'amount_mismatch');
  }

  const receiptIdResult = await client.query(
    `SELECT nextval('rent_payment_receipts_id_seq') AS id`
  );
  const receiptId = Number(receiptIdResult.rows[0].id);
  const idempotencyKey = `sepay:${transaction.channel_id}:${transaction.provider_transaction_id}`;
  const note = `SePay tự động đối soát ${transferReference}`;
  const newReceiptCode = receiptCode(receiptId, targetInvoice.period);
  await client.query(
    `INSERT INTO rent_payment_receipts
       (id, user_id, room_id, target_period, receipt_code, amount_vnd,
        payment_method, note, source, idempotency_key, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,'bank_transfer',$7,'sepay_auto',$8,$9)`,
    [
      receiptId,
      transaction.user_id,
      targetInvoice.room_id,
      targetInvoice.period,
      newReceiptCode,
      receivedAmountVnd,
      note,
      idempotencyKey,
      transaction.occurred_at
    ]
  );

  let unallocated = receivedAmountVnd;
  const allocations = [];
  for (const invoice of outstanding) {
    if (unallocated <= 0) break;
    const allocatedAmount = Math.min(unallocated, Number(invoice.remaining_vnd));
    const source = invoice.period < targetInvoice.period
      ? 'sepay_prior_debt'
      : 'sepay_auto';
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
     SET match_status='matched', match_reason='matched_exact',
         matched_invoice_id=$2, matched_receipt_id=$3,
         matched_at=now(), updated_at=now()
     WHERE id=$1 AND match_status='pending'`,
    [transaction.id, targetInvoice.id, receiptId]
  );
  return {
    matched: true,
    status: 'matched',
    reason: 'matched_exact',
    transferReference,
    invoiceId: Number(targetInvoice.id),
    receiptId,
    receiptCode: newReceiptCode,
    allocations
  };
}

module.exports = {
  TRANSFER_REFERENCE_PATTERN,
  autoMatchBankTransaction,
  invoiceReferences
};
