'use strict';

const db = require('./db');
const DebtAge = require('../debt-age');
const InvoiceReference = require('../invoice-reference');

const PERIOD_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9:_-]{8,300}$/;
const PAYMENT_METHODS = new Set(['bank_transfer', 'cash', 'manual', 'other']);

class RentPaymentError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'RentPaymentError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function sendRentPaymentError(res, error) {
  if (!(error instanceof RentPaymentError)) return false;
  res.status(error.statusCode).json({ error: error.message, code: error.code });
  return true;
}

function integerVnd(value, field, { allowZero = false } = {}) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1) || parsed > 999999999999) {
    throw new RentPaymentError(400, 'INVALID_AMOUNT', `${field} không hợp lệ`);
  }
  return parsed;
}

function invoiceInput(body = {}) {
  const roomId = String(body.roomId || '').trim();
  const roomName = String(body.roomName || '').trim().slice(0, 200);
  const period = String(body.period || '').trim();
  const totalVnd = integerVnd(body.invoiceTotalVnd, 'Tổng hóa đơn');
  const note = String(body.note || '').trim();
  const idempotencyKey = String(body.idempotencyKey || '').trim();
  const occurredAt = body.occurredAt ? new Date(body.occurredAt) : new Date();
  if (!roomId || roomId.length > 200) {
    throw new RentPaymentError(400, 'INVALID_ROOM_ID', 'Phòng không hợp lệ');
  }
  if (!PERIOD_PATTERN.test(period)) {
    throw new RentPaymentError(400, 'INVALID_PERIOD', 'Tháng hóa đơn không hợp lệ');
  }
  if (note.length > 500) {
    throw new RentPaymentError(400, 'INVALID_NOTE', 'Ghi chú tối đa 500 ký tự');
  }
  if (!IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    throw new RentPaymentError(400, 'INVALID_IDEMPOTENCY_KEY', 'Mã chống ghi trùng không hợp lệ');
  }
  if (Number.isNaN(occurredAt.getTime())
      || occurredAt.getTime() < Date.UTC(2000, 0, 1)
      || occurredAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new RentPaymentError(400, 'INVALID_OCCURRED_AT', 'Thời điểm thu tiền không hợp lệ');
  }
  return {
    roomId,
    roomName,
    period,
    totalVnd,
    note,
    idempotencyKey,
    occurredAt: occurredAt.toISOString()
  };
}

function paymentInput(body = {}) {
  const invoice = invoiceInput(body);
  const rawAmount = body.amountVnd;
  const amountVnd = rawAmount === undefined || rawAmount === null || rawAmount === ''
    ? null
    : integerVnd(rawAmount, 'Số tiền thanh toán');
  const paymentMethod = String(body.paymentMethod || 'manual').trim().toLowerCase();
  if (!PAYMENT_METHODS.has(paymentMethod)) {
    throw new RentPaymentError(
      400,
      'INVALID_PAYMENT_METHOD',
      'Phương thức thanh toán không hợp lệ'
    );
  }
  return {
    ...invoice,
    amountVnd,
    paymentMethod,
    includePriorDebt: body.includePriorDebt === true
  };
}

function summaryJson(row, options = {}) {
  const total = Number(row.issued_total_vnd) || 0;
  const collected = Number(row.paid_amount_vnd) || 0;
  const remaining = Math.max(0, total - collected);
  const priorDebt = Math.max(0, Number(row.prior_debt_vnd) || 0);
  const totalDue = priorDebt + remaining;
  const oldestUnpaidPeriod = row.oldest_unpaid_period || null;
  const debtAgePeriod = oldestUnpaidPeriod || row.period;
  const debtAge = DebtAge.classify(debtAgePeriod, totalDue, options);
  let status = 'unpaid';
  if (collected > 0 && remaining > 0) status = 'partial';
  if (remaining === 0) status = collected > total ? 'overpaid' : 'paid';
  return {
    invoiceId: Number(row.id),
    transferContent: InvoiceReference.fromInvoiceId(row.id),
    roomId: row.room_id,
    roomName: row.room_name_snapshot || '',
    period: row.period,
    invoiceTotalVnd: total,
    paidAmountVnd: collected,
    remainingVnd: remaining,
    priorDebtVnd: priorDebt,
    totalDueVnd: totalDue,
    priorUnpaidInvoiceCount: Number(row.prior_unpaid_invoice_count) || 0,
    oldestUnpaidPeriod,
    debtAgePeriod,
    dueDate: debtAge.dueDate,
    overdueDays: debtAge.overdueDays,
    debtAgeBucket: debtAge.bucket,
    status,
    transactionCount: Number(row.transaction_count) || 0,
    lastPaymentAt: row.last_payment_at || null,
    issuedAt: row.issued_at,
    updatedAt: row.updated_at
  };
}

const SUMMARY_SELECT = `
  SELECT i.id, i.room_id, i.room_name_snapshot, i.period, i.issued_total_vnd,
         i.issued_at, i.updated_at,
         COALESCE(SUM(t.amount_vnd), 0) AS paid_amount_vnd,
         COUNT(t.id)::int AS transaction_count,
         MAX(t.occurred_at) FILTER (WHERE t.amount_vnd > 0) AS last_payment_at,
         COALESCE((
           SELECT SUM(GREATEST(
             older.issued_total_vnd - COALESCE((
               SELECT SUM(older_tx.amount_vnd)
               FROM rent_payment_transactions older_tx
               WHERE older_tx.user_id=older.user_id AND older_tx.invoice_id=older.id
             ), 0),
             0
           ))
         FROM rent_invoices older
         WHERE older.user_id=i.user_id
           AND older.room_id=i.room_id
           AND older.period<i.period
           AND (
             NULLIF(left(current_room.rent_start_date, 7), '') IS NULL
             OR i.period < left(current_room.rent_start_date, 7)
             OR older.period >= left(current_room.rent_start_date, 7)
           )
         ), 0) AS prior_debt_vnd,
         (SELECT COUNT(*)::int
          FROM rent_invoices older
          WHERE older.user_id=i.user_id
            AND older.room_id=i.room_id
            AND older.period<i.period
            AND (
              NULLIF(left(current_room.rent_start_date, 7), '') IS NULL
              OR i.period < left(current_room.rent_start_date, 7)
              OR older.period >= left(current_room.rent_start_date, 7)
            )
            AND older.issued_total_vnd > COALESCE((
              SELECT SUM(older_tx.amount_vnd)
              FROM rent_payment_transactions older_tx
              WHERE older_tx.user_id=older.user_id AND older_tx.invoice_id=older.id
            ), 0)) AS prior_unpaid_invoice_count,
         (SELECT MIN(older.period)
          FROM rent_invoices older
          WHERE older.user_id=i.user_id
            AND older.room_id=i.room_id
            AND older.period<i.period
            AND (
              NULLIF(left(current_room.rent_start_date, 7), '') IS NULL
              OR i.period < left(current_room.rent_start_date, 7)
              OR older.period >= left(current_room.rent_start_date, 7)
            )
            AND older.issued_total_vnd > COALESCE((
              SELECT SUM(older_tx.amount_vnd)
              FROM rent_payment_transactions older_tx
              WHERE older_tx.user_id=older.user_id AND older_tx.invoice_id=older.id
            ), 0)) AS oldest_unpaid_period
  FROM rent_invoices i
  LEFT JOIN rent_payment_transactions t
    ON t.user_id=i.user_id AND t.invoice_id=i.id
  LEFT JOIN rooms current_room
    ON current_room.user_id=i.user_id AND current_room.id=i.room_id`;

async function invoiceSummary(query, userId, invoiceId) {
  const { rows } = await query(
    `${SUMMARY_SELECT}
     WHERE i.user_id=$1 AND i.id=$2
     GROUP BY i.id, current_room.id`,
    [userId, invoiceId]
  );
  return rows[0] ? summaryJson(rows[0]) : null;
}

async function listInvoiceSummaries(req, res) {
  const period = String(req.query?.period || '').trim();
  if (period && !PERIOD_PATTERN.test(period)) {
    return res.status(400).json({ error: 'Tháng hóa đơn không hợp lệ', code: 'INVALID_PERIOD' });
  }
  const params = [req.userId];
  let filter = 'WHERE i.user_id=$1';
  if (period) {
    params.push(period);
    filter += ' AND i.period=$2';
  }
  const { rows } = await db.query(
    `${SUMMARY_SELECT}
     ${filter}
     GROUP BY i.id, current_room.id
     ORDER BY i.period DESC, i.room_name_snapshot, i.id`,
    params
  );
  return res.json({ invoices: rows.map(summaryJson) });
}

async function authorizedInvoiceSource(query, userId, input) {
  const { rows } = await query(
    `SELECT source.room_name
     FROM (
       SELECT r.name AS room_name, 2 AS priority
       FROM billing_entries b
       JOIN rooms r ON r.user_id=b.user_id AND r.id=b.room_id
       WHERE b.user_id=$1 AND b.room_id=$2 AND b.period=$3
       UNION ALL
       SELECT COALESCE(hb.room_name, '') AS room_name, 1 AS priority
       FROM history_bills hb
       JOIN history_snapshots hs ON hs.id=hb.snapshot_id
       WHERE hs.user_id=$1 AND hs.period=$3 AND hb.room_id=$2
     ) source
     ORDER BY source.priority
     LIMIT 1`,
    [userId, input.roomId, input.period]
  );
  return rows[0] || null;
}

function receiptCode(receiptId, period) {
  return `PT-${String(period).replace('-', '')}-${Number(receiptId).toString(36).toUpperCase().padStart(6, '0')}`;
}

function receiptJson(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    code: row.receipt_code,
    roomId: row.room_id,
    targetPeriod: row.target_period,
    amountVnd: Number(row.amount_vnd) || 0,
    paymentMethod: row.payment_method,
    note: row.note || '',
    source: row.source,
    occurredAt: row.occurred_at,
    createdAt: row.created_at
  };
}

async function settleInvoice(req, res) {
  let input;
  try {
    input = paymentInput(req.body);
  } catch (error) {
    if (sendRentPaymentError(res, error)) return res;
    throw error;
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2, 0))`,
      [req.userId, input.idempotencyKey]
    );
    const receiptReplay = await client.query(
      `SELECT * FROM rent_payment_receipts
       WHERE user_id=$1 AND idempotency_key=$2
       FOR UPDATE`,
      [req.userId, input.idempotencyKey]
    );
    if (receiptReplay.rows[0]) {
      const receipt = receiptReplay.rows[0];
      const amountConflict = input.amountVnd !== null
        && Number(receipt.amount_vnd) !== input.amountVnd;
      if (receipt.room_id !== input.roomId
          || receipt.target_period !== input.period
          || receipt.payment_method !== input.paymentMethod
          || amountConflict) {
        throw new RentPaymentError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Mã chống ghi trùng đã được dùng cho một nội dung giao dịch khác'
        );
      }
      const targetResult = await client.query(
        `SELECT id, issued_total_vnd FROM rent_invoices
         WHERE user_id=$1 AND room_id=$2 AND period=$3`,
        [req.userId, input.roomId, input.period]
      );
      const target = targetResult.rows[0];
      if (!target || Number(target.issued_total_vnd) !== input.totalVnd) {
        throw new RentPaymentError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Mã chống ghi trùng không khớp hóa đơn hiện tại'
        );
      }
      const allocationResult = await client.query(
        `SELECT t.id AS transaction_id, t.invoice_id, t.amount_vnd, i.period
         FROM rent_payment_transactions t
         JOIN rent_invoices i ON i.user_id=t.user_id AND i.id=t.invoice_id
         WHERE t.user_id=$1 AND t.receipt_id=$2
         ORDER BY i.period, i.id`,
        [req.userId, receipt.id]
      );
      const summary = await invoiceSummary(
        client.query.bind(client),
        req.userId,
        target.id
      );
      await client.query('COMMIT');
      return res.json({
        reused: true,
        receipt: receiptJson(receipt),
        allocations: allocationResult.rows.map((row) => ({
          transactionId: Number(row.transaction_id),
          invoiceId: Number(row.invoice_id),
          period: row.period,
          amountVnd: Number(row.amount_vnd) || 0
        })),
        transactionId: allocationResult.rows[0]
          ? Number(allocationResult.rows[0].transaction_id)
          : null,
        invoice: summary
      });
    }

    // Tương thích với các request đã ghi trước khi có bảng phiếu thu.
    const replay = await client.query(
      `SELECT t.id, t.invoice_id, t.amount_vnd, t.payment_method,
              i.room_id, i.period, i.issued_total_vnd
       FROM rent_payment_transactions t
       JOIN rent_invoices i ON i.user_id=t.user_id AND i.id=t.invoice_id
       WHERE t.user_id=$1 AND t.idempotency_key=$2
       FOR UPDATE OF t`,
      [req.userId, input.idempotencyKey]
    );
    if (replay.rows[0]) {
      const row = replay.rows[0];
      const amountConflict = input.amountVnd !== null
        && Number(row.amount_vnd) !== input.amountVnd;
      if (row.room_id !== input.roomId
          || row.period !== input.period
          || Number(row.issued_total_vnd) !== input.totalVnd
          || row.payment_method !== input.paymentMethod
          || input.includePriorDebt
          || amountConflict) {
        throw new RentPaymentError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Mã chống ghi trùng đã được dùng cho một nội dung giao dịch khác'
        );
      }
      const summary = await invoiceSummary(client.query.bind(client), req.userId, row.invoice_id);
      await client.query('COMMIT');
      return res.json({ reused: true, transactionId: Number(row.id), invoice: summary });
    }

    const source = await authorizedInvoiceSource(client.query.bind(client), req.userId, input);
    if (!source) {
      throw new RentPaymentError(404, 'INVOICE_SOURCE_NOT_FOUND', 'Không tìm thấy hóa đơn thuộc tài khoản');
    }
    const roomName = input.roomName || source.room_name || '';
    const invoiceResult = await client.query(
      `INSERT INTO rent_invoices
         (user_id, room_id, room_name_snapshot, period, issued_total_vnd)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id, room_id, period) DO UPDATE SET
         room_name_snapshot=EXCLUDED.room_name_snapshot,
         updated_at=now()
       RETURNING id, issued_total_vnd`,
      [req.userId, input.roomId, roomName, input.period, input.totalVnd]
    );
    const invoiceId = invoiceResult.rows[0].id;
    let invoiceTotalVnd = Number(invoiceResult.rows[0].issued_total_vnd);
    const collectedResult = await client.query(
      `SELECT COALESCE(SUM(amount_vnd), 0) AS paid_amount_vnd,
              COUNT(*)::int AS transaction_count
       FROM rent_payment_transactions
       WHERE user_id=$1 AND invoice_id=$2`,
      [req.userId, invoiceId]
    );
    const transactionCount = Number(collectedResult.rows[0].transaction_count) || 0;
    if (invoiceTotalVnd !== input.totalVnd) {
      if (transactionCount > 0) {
        throw new RentPaymentError(
          409,
          'INVOICE_TOTAL_MISMATCH',
          'Tổng hóa đơn đã thay đổi sau khi phát sinh giao dịch. Hãy lập bút toán điều chỉnh.'
        );
      }
      await client.query(
        `UPDATE rent_invoices
         SET issued_total_vnd=$3, updated_at=now()
         WHERE user_id=$1 AND id=$2`,
        [req.userId, invoiceId, input.totalVnd]
      );
      invoiceTotalVnd = input.totalVnd;
    }
    await client.query(
      `SELECT id FROM rent_invoices
       WHERE user_id=$1 AND room_id=$2 AND period<=$3
       ORDER BY period, id
       FOR UPDATE`,
      [req.userId, input.roomId, input.period]
    );
    const balanceResult = await client.query(
      `SELECT i.id, i.period, i.issued_total_vnd,
              COALESCE(SUM(t.amount_vnd), 0) AS paid_amount_vnd,
              GREATEST(i.issued_total_vnd - COALESCE(SUM(t.amount_vnd), 0), 0)
                AS remaining_vnd,
              (SELECT NULLIF(left(r.rent_start_date, 7), '')
               FROM rooms r
               WHERE r.user_id=$1 AND r.id=$2
               LIMIT 1) AS current_tenancy_start_period
       FROM rent_invoices i
       LEFT JOIN rent_payment_transactions t
         ON t.user_id=i.user_id AND t.invoice_id=i.id
       WHERE i.user_id=$1 AND i.room_id=$2 AND i.period<=$3
       GROUP BY i.id
       HAVING i.issued_total_vnd - COALESCE(SUM(t.amount_vnd), 0) > 0
       ORDER BY i.period, i.id`,
      [req.userId, input.roomId, input.period]
    );
    const currentTenancyStart = balanceResult.rows.find(
      (row) => row.current_tenancy_start_period
    )?.current_tenancy_start_period || '';
    const carryForwardInvoices = currentTenancyStart && input.period >= currentTenancyStart
      ? balanceResult.rows.filter((row) => row.period >= currentTenancyStart)
      : balanceResult.rows;
    const outstandingInvoices = input.includePriorDebt
      ? carryForwardInvoices
      : balanceResult.rows.filter((row) => Number(row.id) === Number(invoiceId));
    const totalOutstanding = outstandingInvoices.reduce(
      (sum, row) => sum + Number(row.remaining_vnd),
      0
    );
    if (totalOutstanding === 0) {
      throw new RentPaymentError(
        409,
        'INVOICE_ALREADY_SETTLED',
        input.includePriorDebt ? 'Hóa đơn và nợ cũ đã được thu đủ' : 'Hóa đơn hiện tại đã được thu đủ'
      );
    }
    const paymentAmount = input.amountVnd === null ? totalOutstanding : input.amountVnd;
    if (paymentAmount > totalOutstanding) {
      throw new RentPaymentError(
        409,
        'PAYMENT_EXCEEDS_REMAINING',
        `Số tiền thu không được vượt quá công nợ còn lại ${totalOutstanding} đồng`
      );
    }
    const hasPriorDebt = outstandingInvoices.some((row) => row.period < input.period);
    const receiptSource = input.includePriorDebt && hasPriorDebt
      ? 'manual_carry_forward'
      : 'manual_current';
    const receiptIdResult = await client.query(
      `SELECT nextval('rent_payment_receipts_id_seq') AS id`
    );
    const receiptId = Number(receiptIdResult.rows[0].id);
    const newReceiptCode = receiptCode(receiptId, input.period);
    const receiptResult = await client.query(
      `INSERT INTO rent_payment_receipts
         (id, user_id, room_id, target_period, receipt_code, amount_vnd,
          payment_method, note, source, idempotency_key, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
       RETURNING *`,
      [
        receiptId,
        req.userId,
        input.roomId,
        input.period,
        newReceiptCode,
        paymentAmount,
        input.paymentMethod,
        input.note,
        receiptSource,
        input.idempotencyKey,
        input.occurredAt
      ]
    );
    let unallocated = paymentAmount;
    const allocations = [];
    for (const invoice of outstandingInvoices) {
      if (unallocated <= 0) break;
      const invoiceRemaining = Number(invoice.remaining_vnd);
      const allocatedAmount = Math.min(unallocated, invoiceRemaining);
      const isPriorDebt = invoice.period < input.period;
      const paymentSource = isPriorDebt
        ? 'manual_prior_debt'
        : (allocatedAmount === invoiceRemaining ? 'manual_full' : 'manual_partial');
      const transactionResult = await client.query(
        `INSERT INTO rent_payment_transactions
           (user_id, invoice_id, receipt_id, entry_type, amount_vnd, payment_method,
            note, source, occurred_at)
         VALUES ($1,$2,$3,'payment',$4,$5,$6,$7,$8)
         RETURNING id, occurred_at`,
        [
          req.userId,
          invoice.id,
          receiptId,
          allocatedAmount,
          input.paymentMethod,
          input.note || (isPriorDebt
            ? `Phân bổ nợ cũ kỳ ${invoice.period}`
            : (allocatedAmount === invoiceRemaining
              ? 'Chủ trọ xác nhận đã thu đủ'
              : 'Chủ trọ ghi nhận thanh toán một phần')),
          paymentSource,
          input.occurredAt
        ]
      );
      allocations.push({
        transactionId: Number(transactionResult.rows[0].id),
        invoiceId: Number(invoice.id),
        period: invoice.period,
        amountVnd: allocatedAmount,
        source: paymentSource,
        occurredAt: transactionResult.rows[0].occurred_at
      });
      unallocated -= allocatedAmount;
    }
    const summary = await invoiceSummary(client.query.bind(client), req.userId, invoiceId);
    await client.query('COMMIT');
    return res.status(201).json({
      reused: false,
      receipt: receiptJson(receiptResult.rows[0]),
      allocations,
      transaction: {
        id: allocations[0]?.transactionId || null,
        amountVnd: paymentAmount,
        paymentMethod: input.paymentMethod,
        source: allocations[0]?.source || receiptSource,
        occurredAt: receiptResult.rows[0].occurred_at
      },
      invoice: summary
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendRentPaymentError(res, error)) return res;
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Giao dịch đã được ghi nhận', code: 'PAYMENT_DUPLICATE' });
    }
    throw error;
  } finally {
    client.release();
  }
}

function transactionJson(row) {
  return {
    id: Number(row.id),
    invoiceId: Number(row.invoice_id),
    receiptId: row.receipt_id === null || row.receipt_id === undefined
      ? null
      : Number(row.receipt_id),
    receiptCode: row.receipt_code || null,
    entryType: row.entry_type,
    amountVnd: Number(row.amount_vnd) || 0,
    paymentMethod: row.payment_method,
    externalReference: row.external_reference || null,
    note: row.note || '',
    source: row.source,
    reversesTransactionId: row.reverses_transaction_id === null
      ? null
      : Number(row.reverses_transaction_id),
    isReversed: !!row.is_reversed,
    occurredAt: row.occurred_at,
    createdAt: row.created_at
  };
}

async function listInvoiceTransactions(req, res) {
  const invoiceId = Number(req.params.invoiceId);
  if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
    return res.status(400).json({ error: 'Hóa đơn không hợp lệ', code: 'INVALID_INVOICE_ID' });
  }
  const summary = await invoiceSummary(db.query, req.userId, invoiceId);
  if (!summary) {
    return res.status(404).json({ error: 'Không tìm thấy hóa đơn', code: 'INVOICE_NOT_FOUND' });
  }
  const { rows } = await db.query(
    `SELECT t.*, receipt.receipt_code,
            EXISTS (
              SELECT 1 FROM rent_payment_transactions reversal
              WHERE reversal.user_id=t.user_id
                AND reversal.reverses_transaction_id=t.id
            ) AS is_reversed
     FROM rent_payment_transactions t
     LEFT JOIN rent_payment_receipts receipt
       ON receipt.user_id=t.user_id AND receipt.id=t.receipt_id
     WHERE t.user_id=$1 AND t.invoice_id=$2
     ORDER BY t.occurred_at DESC, t.id DESC`,
    [req.userId, invoiceId]
  );
  return res.json({ invoice: summary, transactions: rows.map(transactionJson) });
}

async function reverseTransaction(req, res) {
  const transactionId = Number(req.params.id);
  const reason = String(req.body?.reason || '').trim();
  if (!Number.isInteger(transactionId) || transactionId <= 0) {
    return res.status(400).json({ error: 'Giao dịch không hợp lệ', code: 'INVALID_TRANSACTION_ID' });
  }
  if (reason.length < 10 || reason.length > 500) {
    return res.status(400).json({
      error: 'Lý do hoàn tác phải từ 10 đến 500 ký tự',
      code: 'INVALID_REVERSAL_REASON'
    });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const originalResult = await client.query(
      `SELECT t.id, t.invoice_id, t.amount_vnd, t.payment_method, t.entry_type
       FROM rent_payment_transactions t
       WHERE t.user_id=$1 AND t.id=$2
       FOR UPDATE OF t`,
      [req.userId, transactionId]
    );
    const original = originalResult.rows[0];
    if (!original) {
      throw new RentPaymentError(404, 'TRANSACTION_NOT_FOUND', 'Không tìm thấy giao dịch');
    }
    if (original.entry_type !== 'payment' || Number(original.amount_vnd) <= 0) {
      throw new RentPaymentError(409, 'TRANSACTION_NOT_REVERSIBLE', 'Chỉ hoàn tác được giao dịch thu tiền gốc');
    }
    const reversed = await client.query(
      `SELECT id FROM rent_payment_transactions
       WHERE user_id=$1 AND reverses_transaction_id=$2`,
      [req.userId, transactionId]
    );
    if (reversed.rows[0]) {
      throw new RentPaymentError(409, 'TRANSACTION_ALREADY_REVERSED', 'Giao dịch đã được hoàn tác trước đó');
    }
    const reversalResult = await client.query(
      `INSERT INTO rent_payment_transactions
         (user_id, invoice_id, entry_type, amount_vnd, payment_method, note,
          source, reverses_transaction_id, occurred_at)
       VALUES ($1,$2,'reversal',$3,$4,$5,'manual_reversal',$6,now())
       RETURNING *`,
      [
        req.userId,
        original.invoice_id,
        -Number(original.amount_vnd),
        original.payment_method,
        reason,
        transactionId
      ]
    );
    const summary = await invoiceSummary(
      client.query.bind(client),
      req.userId,
      original.invoice_id
    );
    await client.query('COMMIT');
    return res.status(201).json({
      transaction: transactionJson({ ...reversalResult.rows[0], is_reversed: false }),
      invoice: summary
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendRentPaymentError(res, error)) return res;
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'Giao dịch đã được hoàn tác trước đó',
        code: 'TRANSACTION_ALREADY_REVERSED'
      });
    }
    throw error;
  } finally {
    client.release();
  }
}

function legacyEntries(body = {}) {
  const entries = Array.isArray(body.entries) ? body.entries : [];
  if (entries.length > 500) {
    throw new RentPaymentError(400, 'LEGACY_BATCH_TOO_LARGE', 'Mỗi lần chỉ chuyển tối đa 500 hóa đơn cũ');
  }
  return entries.map((entry) => {
    const roomId = String(entry?.roomId || '').trim();
    const roomName = String(entry?.roomName || '').trim().slice(0, 200);
    const period = String(entry?.period || '').trim();
    const totalVnd = integerVnd(entry?.invoiceTotalVnd, 'Tổng hóa đơn cũ');
    if (!roomId || roomId.length > 200 || !PERIOD_PATTERN.test(period)) {
      throw new RentPaymentError(400, 'INVALID_LEGACY_INVOICE', 'Hóa đơn cũ không hợp lệ');
    }
    return { roomId, roomName, period, totalVnd };
  });
}

function invoiceSyncEntries(body = {}) {
  const entries = Array.isArray(body.entries) ? body.entries : [];
  if (entries.length > 1000) {
    throw new RentPaymentError(400, 'INVOICE_SYNC_BATCH_TOO_LARGE', 'Mỗi lần chỉ đồng bộ tối đa 1.000 hóa đơn');
  }
  return entries.map((entry) => {
    const roomId = String(entry?.roomId || '').trim();
    const roomName = String(entry?.roomName || '').trim().slice(0, 200);
    const period = String(entry?.period || '').trim();
    const totalVnd = integerVnd(entry?.invoiceTotalVnd, 'Tổng hóa đơn');
    if (!roomId || roomId.length > 200 || !PERIOD_PATTERN.test(period)) {
      throw new RentPaymentError(400, 'INVALID_INVOICE_SYNC', 'Hóa đơn đồng bộ không hợp lệ');
    }
    return { roomId, roomName, period, totalVnd };
  });
}

async function syncInvoices(req, res) {
  let entries;
  try {
    entries = invoiceSyncEntries(req.body);
  } catch (error) {
    if (sendRentPaymentError(res, error)) return res;
    throw error;
  }
  if (entries.length === 0) {
    return res.json({ created: 0, updated: 0, migratedPaid: 0, unchanged: 0, skipped: 0 });
  }

  const client = await db.getClient();
  const stats = { created: 0, updated: 0, migratedPaid: 0, unchanged: 0, skipped: 0 };
  try {
    await client.query('BEGIN');
    for (const entry of entries) {
      const sourceResult = await client.query(
        `SELECT source.room_name, source.server_total, source.server_paid
         FROM (
           SELECT COALESCE(hb.room_name, '') AS room_name,
                  hb.total AS server_total, hb.paid AS server_paid, 1 AS priority
           FROM history_bills hb
           JOIN history_snapshots hs ON hs.id=hb.snapshot_id
           WHERE hs.user_id=$1 AND hs.period=$2 AND hb.room_id=$3
           UNION ALL
           SELECT r.name AS room_name, NULL::numeric AS server_total,
                  b.paid AS server_paid, 2 AS priority
           FROM billing_entries b
           JOIN rooms r ON r.user_id=b.user_id AND r.id=b.room_id
           WHERE b.user_id=$1 AND b.period=$2 AND b.room_id=$3
         ) source
         ORDER BY source.priority
         LIMIT 1`,
        [req.userId, entry.period, entry.roomId]
      );
      const source = sourceResult.rows[0];
      if (!source) {
        stats.skipped += 1;
        continue;
      }
      const serverTotal = source.server_total === null ? null : Number(source.server_total);
      const totalVnd = Number.isSafeInteger(serverTotal) && serverTotal > 0
        ? serverTotal
        : entry.totalVnd;
      const inserted = await client.query(
        `INSERT INTO rent_invoices
           (user_id, room_id, room_name_snapshot, period, issued_total_vnd)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id, room_id, period) DO NOTHING
         RETURNING id, issued_total_vnd`,
        [
          req.userId,
          entry.roomId,
          entry.roomName || source.room_name || '',
          entry.period,
          totalVnd
        ]
      );
      let invoice = inserted.rows[0];
      let transactionCount = 0;
      if (invoice) {
        stats.created += 1;
      } else {
        const existing = await client.query(
          `SELECT i.id, i.issued_total_vnd,
                  (SELECT COUNT(*)::int FROM rent_payment_transactions t
                   WHERE t.user_id=i.user_id AND t.invoice_id=i.id) AS transaction_count
           FROM rent_invoices i
           WHERE i.user_id=$1 AND i.room_id=$2 AND i.period=$3
           FOR UPDATE`,
          [req.userId, entry.roomId, entry.period]
        );
        invoice = existing.rows[0];
        transactionCount = Number(invoice?.transaction_count) || 0;
        if (invoice && transactionCount === 0 && Number(invoice.issued_total_vnd) !== totalVnd) {
          await client.query(
            `UPDATE rent_invoices
             SET room_name_snapshot=$4, issued_total_vnd=$5, updated_at=now()
             WHERE user_id=$1 AND room_id=$2 AND period=$3`,
            [req.userId, entry.roomId, entry.period, entry.roomName || source.room_name || '', totalVnd]
          );
          stats.updated += 1;
        } else {
          stats.unchanged += 1;
        }
      }
      if (source.server_paid && transactionCount === 0 && invoice) {
        const legacyKey = `legacy:${entry.period}:${entry.roomId}`;
        const migrated = await client.query(
          `INSERT INTO rent_payment_transactions
             (user_id, invoice_id, entry_type, amount_vnd, payment_method, note,
              source, idempotency_key, occurred_at)
           VALUES ($1,$2,'payment',$3,'manual',
                   'Chuyển từ trạng thái đã thu của dữ liệu cũ','legacy_paid',$4,now())
           ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
           RETURNING id`,
          [req.userId, invoice.id, totalVnd, legacyKey]
        );
        if (migrated.rows[0]) stats.migratedPaid += 1;
      }
    }
    await client.query('COMMIT');
    return res.json(stats);
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function migrateLegacyPaid(req, res) {
  let entries;
  try {
    entries = legacyEntries(req.body);
  } catch (error) {
    if (sendRentPaymentError(res, error)) return res;
    throw error;
  }
  if (entries.length === 0) return res.json({ migrated: 0, skipped: 0 });

  const client = await db.getClient();
  let migrated = 0;
  let skipped = 0;
  try {
    await client.query('BEGIN');
    for (const entry of entries) {
      const sourceResult = await client.query(
        `SELECT source.room_name, source.server_total
         FROM (
           SELECT COALESCE(hb.room_name, '') AS room_name, hb.total AS server_total, 1 AS priority
           FROM history_bills hb
           JOIN history_snapshots hs ON hs.id=hb.snapshot_id
           WHERE hs.user_id=$1 AND hs.period=$2 AND hb.room_id=$3 AND hb.paid=true
           UNION ALL
           SELECT r.name AS room_name, NULL::numeric AS server_total, 2 AS priority
           FROM billing_entries b
           JOIN rooms r ON r.user_id=b.user_id AND r.id=b.room_id
           WHERE b.user_id=$1 AND b.period=$2 AND b.room_id=$3 AND b.paid=true
         ) source
         ORDER BY source.priority
         LIMIT 1`,
        [req.userId, entry.period, entry.roomId]
      );
      const source = sourceResult.rows[0];
      if (!source) {
        skipped += 1;
        continue;
      }
      const serverTotal = source.server_total === null ? null : Number(source.server_total);
      const totalVnd = Number.isSafeInteger(serverTotal) && serverTotal > 0
        ? serverTotal
        : entry.totalVnd;
      const invoiceInsert = await client.query(
        `INSERT INTO rent_invoices
           (user_id, room_id, room_name_snapshot, period, issued_total_vnd)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (user_id, room_id, period) DO NOTHING
         RETURNING id`,
        [
          req.userId,
          entry.roomId,
          entry.roomName || source.room_name || '',
          entry.period,
          totalVnd
        ]
      );
      let invoiceId = invoiceInsert.rows[0]?.id;
      if (!invoiceId) {
        const existing = await client.query(
          `SELECT id FROM rent_invoices
           WHERE user_id=$1 AND room_id=$2 AND period=$3
           FOR UPDATE`,
          [req.userId, entry.roomId, entry.period]
        );
        invoiceId = existing.rows[0]?.id;
      }
      const idempotencyKey = `legacy:${entry.period}:${entry.roomId}`;
      const transaction = await client.query(
        `INSERT INTO rent_payment_transactions
           (user_id, invoice_id, entry_type, amount_vnd, payment_method, note,
            source, idempotency_key, occurred_at)
         SELECT $1,$2,'payment',$3,'manual',
                'Chuyển từ trạng thái đã thu của dữ liệu cũ','legacy_paid',$4,now()
         WHERE NOT EXISTS (
           SELECT 1 FROM rent_payment_transactions
           WHERE user_id=$1 AND invoice_id=$2
         )
         ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
         RETURNING id`,
        [req.userId, invoiceId, totalVnd, idempotencyKey]
      );
      if (transaction.rows[0]) migrated += 1;
      else skipped += 1;
    }
    await client.query('COMMIT');
    return res.json({ migrated, skipped });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

async function loadRentPaymentExport(userId) {
  const [invoiceResult, receiptResult, transactionResult] = await Promise.all([
    db.query(
      `SELECT id, room_id, room_name_snapshot, period, issued_total_vnd,
              issued_at, updated_at
       FROM rent_invoices WHERE user_id=$1 ORDER BY period, id`,
      [userId]
    ),
    db.query(
      `SELECT id, room_id, target_period, receipt_code, amount_vnd,
              payment_method, note, source, occurred_at, created_at
       FROM rent_payment_receipts WHERE user_id=$1 ORDER BY id`,
      [userId]
    ),
    db.query(
      `SELECT t.id, t.invoice_id, t.receipt_id, receipt.receipt_code,
              t.entry_type, t.amount_vnd, t.payment_method,
              t.external_reference, t.note, t.source, t.idempotency_key,
              t.reverses_transaction_id, t.occurred_at, t.created_at
       FROM rent_payment_transactions t
       LEFT JOIN rent_payment_receipts receipt
         ON receipt.user_id=t.user_id AND receipt.id=t.receipt_id
       WHERE t.user_id=$1 ORDER BY t.id`,
      [userId]
    )
  ]);
  return {
    invoices: invoiceResult.rows.map((row) => ({
      id: Number(row.id),
      transferContent: InvoiceReference.fromInvoiceId(row.id),
      roomId: row.room_id,
      roomName: row.room_name_snapshot,
      period: row.period,
      invoiceTotalVnd: Number(row.issued_total_vnd) || 0,
      issuedAt: row.issued_at,
      updatedAt: row.updated_at
    })),
    receipts: receiptResult.rows.map(receiptJson),
    transactions: transactionResult.rows.map((row) => transactionJson({
      ...row,
      is_reversed: false
    }))
  };
}

module.exports = {
  IDEMPOTENCY_PATTERN,
  PAYMENT_METHODS,
  PERIOD_PATTERN,
  RentPaymentError,
  invoiceInput,
  invoiceSyncEntries,
  integerVnd,
  legacyEntries,
  listInvoiceSummaries,
  listInvoiceTransactions,
  loadRentPaymentExport,
  migrateLegacyPaid,
  paymentInput,
  receiptCode,
  receiptJson,
  reverseTransaction,
  settleInvoice,
  syncInvoices,
  summaryJson,
  transactionJson
};
