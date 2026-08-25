'use strict';

const db = require('./db');

const PERIOD_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9:_-]{8,300}$/;

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

function summaryJson(row) {
  const total = Number(row.issued_total_vnd) || 0;
  const collected = Number(row.paid_amount_vnd) || 0;
  const remaining = Math.max(0, total - collected);
  let status = 'unpaid';
  if (collected > 0 && remaining > 0) status = 'partial';
  if (remaining === 0) status = collected > total ? 'overpaid' : 'paid';
  return {
    invoiceId: Number(row.id),
    roomId: row.room_id,
    roomName: row.room_name_snapshot || '',
    period: row.period,
    invoiceTotalVnd: total,
    paidAmountVnd: collected,
    remainingVnd: remaining,
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
         MAX(t.occurred_at) FILTER (WHERE t.amount_vnd > 0) AS last_payment_at
  FROM rent_invoices i
  LEFT JOIN rent_payment_transactions t
    ON t.user_id=i.user_id AND t.invoice_id=i.id`;

async function invoiceSummary(query, userId, invoiceId) {
  const { rows } = await query(
    `${SUMMARY_SELECT}
     WHERE i.user_id=$1 AND i.id=$2
     GROUP BY i.id`,
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
     GROUP BY i.id
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

async function settleInvoice(req, res) {
  let input;
  try {
    input = invoiceInput(req.body);
  } catch (error) {
    if (sendRentPaymentError(res, error)) return res;
    throw error;
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const replay = await client.query(
      `SELECT t.id, t.invoice_id, i.room_id, i.period
       FROM rent_payment_transactions t
       JOIN rent_invoices i ON i.user_id=t.user_id AND i.id=t.invoice_id
       WHERE t.user_id=$1 AND t.idempotency_key=$2
       FOR UPDATE OF t`,
      [req.userId, input.idempotencyKey]
    );
    if (replay.rows[0]) {
      const row = replay.rows[0];
      if (row.room_id !== input.roomId || row.period !== input.period) {
        throw new RentPaymentError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Mã chống ghi trùng đã được dùng cho hóa đơn khác'
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
         issued_total_vnd=EXCLUDED.issued_total_vnd,
         updated_at=now()
       RETURNING id`,
      [req.userId, input.roomId, roomName, input.period, input.totalVnd]
    );
    const invoiceId = invoiceResult.rows[0].id;
    const collectedResult = await client.query(
      `SELECT COALESCE(SUM(amount_vnd), 0) AS paid_amount_vnd
       FROM rent_payment_transactions
       WHERE user_id=$1 AND invoice_id=$2`,
      [req.userId, invoiceId]
    );
    const collected = Number(collectedResult.rows[0].paid_amount_vnd) || 0;
    const remaining = Math.max(0, input.totalVnd - collected);
    if (remaining === 0) {
      throw new RentPaymentError(409, 'INVOICE_ALREADY_SETTLED', 'Hóa đơn đã được thu đủ');
    }

    const transactionResult = await client.query(
      `INSERT INTO rent_payment_transactions
         (user_id, invoice_id, entry_type, amount_vnd, payment_method, note,
          source, idempotency_key, occurred_at)
       VALUES ($1,$2,'payment',$3,'manual',$4,'manual_full',$5,$6)
       RETURNING id, occurred_at`,
      [
        req.userId,
        invoiceId,
        remaining,
        input.note || 'Chủ trọ xác nhận đã thu đủ',
        input.idempotencyKey,
        input.occurredAt
      ]
    );
    const summary = await invoiceSummary(client.query.bind(client), req.userId, invoiceId);
    await client.query('COMMIT');
    return res.status(201).json({
      reused: false,
      transaction: {
        id: Number(transactionResult.rows[0].id),
        amountVnd: remaining,
        occurredAt: transactionResult.rows[0].occurred_at
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
    `SELECT t.*,
            EXISTS (
              SELECT 1 FROM rent_payment_transactions reversal
              WHERE reversal.user_id=t.user_id
                AND reversal.reverses_transaction_id=t.id
            ) AS is_reversed
     FROM rent_payment_transactions t
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
  const [invoiceResult, transactionResult] = await Promise.all([
    db.query(
      `SELECT id, room_id, room_name_snapshot, period, issued_total_vnd,
              issued_at, updated_at
       FROM rent_invoices WHERE user_id=$1 ORDER BY period, id`,
      [userId]
    ),
    db.query(
      `SELECT id, invoice_id, entry_type, amount_vnd, payment_method,
              external_reference, note, source, idempotency_key,
              reverses_transaction_id, occurred_at, created_at
       FROM rent_payment_transactions WHERE user_id=$1 ORDER BY id`,
      [userId]
    )
  ]);
  return {
    invoices: invoiceResult.rows.map((row) => ({
      id: Number(row.id),
      roomId: row.room_id,
      roomName: row.room_name_snapshot,
      period: row.period,
      invoiceTotalVnd: Number(row.issued_total_vnd) || 0,
      issuedAt: row.issued_at,
      updatedAt: row.updated_at
    })),
    transactions: transactionResult.rows.map((row) => transactionJson({
      ...row,
      is_reversed: false
    }))
  };
}

module.exports = {
  IDEMPOTENCY_PATTERN,
  PERIOD_PATTERN,
  RentPaymentError,
  invoiceInput,
  integerVnd,
  legacyEntries,
  listInvoiceSummaries,
  listInvoiceTransactions,
  loadRentPaymentExport,
  migrateLegacyPaid,
  reverseTransaction,
  settleInvoice,
  summaryJson,
  transactionJson
};
