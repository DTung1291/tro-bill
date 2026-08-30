'use strict';

const db = require('./db');

const DEPOSIT_ENTRY_TYPES = new Set(['collection', 'deduction', 'refund']);
const DEPOSIT_PAYMENT_METHODS = new Set(['bank_transfer', 'cash', 'manual', 'other']);
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9:_-]{8,300}$/;

class DepositError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'DepositError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function sendDepositError(res, error) {
  if (!(error instanceof DepositError)) return false;
  res.status(error.statusCode).json({ error: error.message, code: error.code });
  return true;
}

function positiveIntegerVnd(value) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 999999999999) {
    throw new DepositError(400, 'INVALID_DEPOSIT_AMOUNT', 'Số tiền cọc không hợp lệ');
  }
  return parsed;
}

function validTenantId(value) {
  const tenantId = String(value || '').trim();
  if (!tenantId || tenantId.length > 200) {
    throw new DepositError(400, 'INVALID_TENANT_ID', 'Khách thuê không hợp lệ');
  }
  return tenantId;
}

function depositTransactionInput(body = {}) {
  const tenantId = validTenantId(body.tenantId);
  const entryType = String(body.entryType || '').trim().toLowerCase();
  if (!DEPOSIT_ENTRY_TYPES.has(entryType)) {
    throw new DepositError(400, 'INVALID_DEPOSIT_ENTRY_TYPE', 'Loại giao dịch tiền cọc không hợp lệ');
  }
  const amountVnd = positiveIntegerVnd(body.amountVnd);
  const paymentMethod = String(body.paymentMethod || 'manual').trim().toLowerCase();
  if (!DEPOSIT_PAYMENT_METHODS.has(paymentMethod)) {
    throw new DepositError(400, 'INVALID_DEPOSIT_PAYMENT_METHOD', 'Phương thức giao dịch không hợp lệ');
  }
  const note = String(body.note || '').trim();
  if (note.length > 500) {
    throw new DepositError(400, 'INVALID_DEPOSIT_NOTE', 'Ghi chú tối đa 500 ký tự');
  }
  if (entryType !== 'collection' && note.length < 3) {
    throw new DepositError(
      400,
      'DEPOSIT_NOTE_REQUIRED',
      'Khấu trừ hoặc hoàn cọc phải có ghi chú ít nhất 3 ký tự'
    );
  }
  const idempotencyKey = String(body.idempotencyKey || '').trim();
  if (!IDEMPOTENCY_PATTERN.test(idempotencyKey)) {
    throw new DepositError(400, 'INVALID_IDEMPOTENCY_KEY', 'Mã chống ghi trùng không hợp lệ');
  }
  const occurredAt = body.occurredAt ? new Date(body.occurredAt) : new Date();
  if (Number.isNaN(occurredAt.getTime())
      || occurredAt.getTime() < Date.UTC(2000, 0, 1)
      || occurredAt.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new DepositError(400, 'INVALID_OCCURRED_AT', 'Thời điểm giao dịch không hợp lệ');
  }
  return {
    tenantId,
    entryType,
    amountVnd,
    paymentMethod,
    note,
    idempotencyKey,
    occurredAt: occurredAt.toISOString()
  };
}

function accountJson(row) {
  if (!row) return null;
  return {
    accountId: row.id === null || row.id === undefined ? null : Number(row.id),
    tenantId: row.tenant_id,
    tenantName: row.tenant_name_snapshot || '',
    roomId: row.room_id,
    roomName: row.room_name_snapshot || '',
    balanceVnd: Math.max(0, Number(row.balance_vnd) || 0),
    transactionCount: Number(row.transaction_count) || 0,
    lastTransactionAt: row.last_transaction_at || null,
    createdAt: row.created_at || null
  };
}

function transactionJson(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    accountId: Number(row.account_id),
    code: row.transaction_code,
    entryType: row.entry_type,
    amountVnd: Number(row.amount_vnd) || 0,
    paymentMethod: row.payment_method,
    note: row.note || '',
    source: row.source,
    reversesTransactionId: row.reverses_transaction_id === null
      || row.reverses_transaction_id === undefined
      ? null
      : Number(row.reverses_transaction_id),
    isReversed: !!row.is_reversed,
    occurredAt: row.occurred_at,
    createdAt: row.created_at
  };
}

const ACCOUNT_SUMMARY_SELECT = `
  SELECT a.id, a.tenant_id, a.tenant_name_snapshot, a.room_id,
         a.room_name_snapshot, a.created_at,
         COALESCE(SUM(t.amount_vnd), 0) AS balance_vnd,
         COUNT(t.id)::int AS transaction_count,
         MAX(t.occurred_at) AS last_transaction_at
  FROM tenant_deposit_accounts a
  LEFT JOIN tenant_deposit_transactions t
    ON t.user_id=a.user_id AND t.account_id=a.id`;

async function accountSummary(query, userId, accountId) {
  const { rows } = await query(
    `${ACCOUNT_SUMMARY_SELECT}
     WHERE a.user_id=$1 AND a.id=$2
     GROUP BY a.id`,
    [userId, accountId]
  );
  return rows[0] ? accountJson(rows[0]) : null;
}

async function findAccountByTenant(query, userId, tenantId) {
  const { rows } = await query(
    `${ACCOUNT_SUMMARY_SELECT}
     WHERE a.user_id=$1 AND a.tenant_id=$2
     GROUP BY a.id`,
    [userId, tenantId]
  );
  return rows[0] || null;
}

async function getTenantDeposit(req, res) {
  let tenantId;
  try {
    tenantId = validTenantId(req.params.tenantId);
  } catch (error) {
    if (sendDepositError(res, error)) return res;
    throw error;
  }

  let accountRow = await findAccountByTenant(db.query, req.userId, tenantId);
  if (!accountRow) {
    const current = await db.query(
      `SELECT t.id AS tenant_id, t.full_name AS tenant_name_snapshot,
              r.id AS room_id, r.name AS room_name_snapshot
       FROM tenants t
       JOIN rooms r ON r.user_id=t.user_id AND r.id=t.room_id
       WHERE t.user_id=$1 AND t.id=$2`,
      [req.userId, tenantId]
    );
    if (!current.rows[0]) {
      return res.status(404).json({ error: 'Không tìm thấy khách thuê', code: 'TENANT_NOT_FOUND' });
    }
    accountRow = {
      id: null,
      ...current.rows[0],
      balance_vnd: 0,
      transaction_count: 0,
      last_transaction_at: null,
      created_at: null
    };
  }

  let transactions = [];
  if (accountRow.id !== null) {
    const result = await db.query(
      `SELECT t.*,
              EXISTS (
                SELECT 1 FROM tenant_deposit_transactions reversal
                WHERE reversal.user_id=t.user_id
                  AND reversal.reverses_transaction_id=t.id
              ) AS is_reversed
       FROM tenant_deposit_transactions t
       WHERE t.user_id=$1 AND t.account_id=$2
       ORDER BY t.occurred_at DESC, t.id DESC`,
      [req.userId, accountRow.id]
    );
    transactions = result.rows.map(transactionJson);
  }
  res.set('Cache-Control', 'no-store');
  return res.json({ account: accountJson(accountRow), transactions });
}

function transactionCode(transactionId, entryType) {
  const prefixes = {
    collection: 'TC',
    deduction: 'KC',
    refund: 'HC',
    reversal: 'DC'
  };
  return `${prefixes[entryType] || 'COC'}-${Number(transactionId).toString(36).toUpperCase().padStart(8, '0')}`;
}

async function createDepositTransaction(req, res) {
  let input;
  try {
    input = depositTransactionInput(req.body);
  } catch (error) {
    if (sendDepositError(res, error)) return res;
    throw error;
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1::text || ':' || $2, 0))`,
      [req.userId, input.idempotencyKey]
    );
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('deposit-account:' || $1::text || ':' || $2, 0))`,
      [req.userId, input.tenantId]
    );
    const replayResult = await client.query(
      `SELECT t.*, a.tenant_id
       FROM tenant_deposit_transactions t
       JOIN tenant_deposit_accounts a
         ON a.user_id=t.user_id AND a.id=t.account_id
       WHERE t.user_id=$1 AND t.idempotency_key=$2`,
      [req.userId, input.idempotencyKey]
    );
    if (replayResult.rows[0]) {
      const replay = replayResult.rows[0];
      const expectedAmount = input.entryType === 'collection'
        ? input.amountVnd
        : -input.amountVnd;
      if (replay.tenant_id !== input.tenantId
          || replay.entry_type !== input.entryType
          || Number(replay.amount_vnd) !== expectedAmount
          || replay.payment_method !== input.paymentMethod) {
        throw new DepositError(
          409,
          'IDEMPOTENCY_KEY_REUSED',
          'Mã chống ghi trùng đã được dùng cho một giao dịch khác'
        );
      }
      const summary = await accountSummary(
        client.query.bind(client),
        req.userId,
        replay.account_id
      );
      await client.query('COMMIT');
      return res.json({ reused: true, account: summary, transaction: transactionJson(replay) });
    }

    let accountResult = await client.query(
      `SELECT * FROM tenant_deposit_accounts
       WHERE user_id=$1 AND tenant_id=$2`,
      [req.userId, input.tenantId]
    );
    let account = accountResult.rows[0];
    if (!account) {
      const tenantResult = await client.query(
        `SELECT t.id AS tenant_id, t.full_name, r.id AS room_id, r.name AS room_name
         FROM tenants t
         JOIN rooms r ON r.user_id=t.user_id AND r.id=t.room_id
         WHERE t.user_id=$1 AND t.id=$2`,
        [req.userId, input.tenantId]
      );
      const tenant = tenantResult.rows[0];
      if (!tenant) {
        throw new DepositError(404, 'TENANT_NOT_FOUND', 'Không tìm thấy khách thuê');
      }
      accountResult = await client.query(
        `INSERT INTO tenant_deposit_accounts
           (user_id, tenant_id, tenant_name_snapshot, room_id, room_name_snapshot)
         VALUES ($1,$2,$3,$4,$5)
         RETURNING *`,
        [req.userId, tenant.tenant_id, tenant.full_name, tenant.room_id, tenant.room_name]
      );
      account = accountResult.rows[0];
    }

    // Runtime chỉ có SELECT/INSERT trên ledger append-only nên không thể dùng
    // SELECT ... FOR UPDATE. Khóa advisory này trùng với trigger database và
    // giữ số dư ổn định cho đến khi bút toán mới được chèn/transaction kết thúc.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(
         'deposit-balance:' || $1::text || ':' || $2::text,
         0
       ))`,
      [req.userId, account.id]
    );
    const balanceResult = await client.query(
      `SELECT COALESCE(SUM(amount_vnd), 0) AS balance_vnd
       FROM tenant_deposit_transactions
       WHERE user_id=$1 AND account_id=$2`,
      [req.userId, account.id]
    );
    const balanceVnd = Number(balanceResult.rows[0]?.balance_vnd) || 0;
    const signedAmount = input.entryType === 'collection' ? input.amountVnd : -input.amountVnd;
    if (signedAmount < 0 && Math.abs(signedAmount) > balanceVnd) {
      throw new DepositError(
        409,
        'DEPOSIT_EXCEEDS_BALANCE',
        `Số tiền không được vượt quá số dư cọc ${balanceVnd} đồng`
      );
    }

    const idResult = await client.query(
      `SELECT nextval('tenant_deposit_transactions_id_seq') AS id`
    );
    const transactionId = Number(idResult.rows[0].id);
    const inserted = await client.query(
      `INSERT INTO tenant_deposit_transactions
         (id, user_id, account_id, transaction_code, entry_type, amount_vnd,
          payment_method, note, source, idempotency_key, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'manual',$9,$10)
       RETURNING *`,
      [
        transactionId,
        req.userId,
        account.id,
        transactionCode(transactionId, input.entryType),
        input.entryType,
        signedAmount,
        input.paymentMethod,
        input.note,
        input.idempotencyKey,
        input.occurredAt
      ]
    );
    const summary = await accountSummary(client.query.bind(client), req.userId, account.id);
    await client.query('COMMIT');
    return res.status(201).json({
      reused: false,
      account: summary,
      transaction: transactionJson(inserted.rows[0])
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendDepositError(res, error)) return res;
    if (error.code === '23514') {
      return res.status(409).json({
        error: 'Giao dịch sẽ làm số dư tiền cọc bị âm',
        code: 'DEPOSIT_EXCEEDS_BALANCE'
      });
    }
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Giao dịch tiền cọc đã tồn tại', code: 'DEPOSIT_DUPLICATE' });
    }
    throw error;
  } finally {
    client.release();
  }
}

async function reverseDepositTransaction(req, res) {
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
    // Một giao dịch gốc chỉ được hoàn tác một lần. Advisory lock thay cho row
    // lock vì bảng giao dịch cố ý không cấp quyền UPDATE cho runtime role.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(
         'deposit-reversal:' || $1::text || ':' || $2::text,
         0
       ))`,
      [req.userId, transactionId]
    );
    const originalResult = await client.query(
      `SELECT t.*
       FROM tenant_deposit_transactions t
       WHERE t.user_id=$1 AND t.id=$2`,
      [req.userId, transactionId]
    );
    const original = originalResult.rows[0];
    if (!original) {
      throw new DepositError(404, 'DEPOSIT_TRANSACTION_NOT_FOUND', 'Không tìm thấy giao dịch tiền cọc');
    }
    if (original.entry_type === 'reversal') {
      throw new DepositError(409, 'DEPOSIT_TRANSACTION_NOT_REVERSIBLE', 'Không thể hoàn tác một bút toán hoàn tác');
    }
    const reversalExists = await client.query(
      `SELECT id FROM tenant_deposit_transactions
       WHERE user_id=$1 AND reverses_transaction_id=$2`,
      [req.userId, transactionId]
    );
    if (reversalExists.rows[0]) {
      throw new DepositError(409, 'DEPOSIT_TRANSACTION_ALREADY_REVERSED', 'Giao dịch đã được hoàn tác');
    }
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(
         'deposit-balance:' || $1::text || ':' || $2::text,
         0
       ))`,
      [req.userId, original.account_id]
    );
    const balanceResult = await client.query(
      `SELECT COALESCE(SUM(amount_vnd), 0) AS balance_vnd
       FROM tenant_deposit_transactions
       WHERE user_id=$1 AND account_id=$2`,
      [req.userId, original.account_id]
    );
    const balanceVnd = Number(balanceResult.rows[0]?.balance_vnd) || 0;
    const reversalAmount = -Number(original.amount_vnd);
    if (reversalAmount < 0 && Math.abs(reversalAmount) > balanceVnd) {
      throw new DepositError(
        409,
        'DEPOSIT_REVERSAL_EXCEEDS_BALANCE',
        'Không thể hoàn tác khoản thu vì một phần tiền cọc đã được sử dụng'
      );
    }
    const idResult = await client.query(
      `SELECT nextval('tenant_deposit_transactions_id_seq') AS id`
    );
    const reversalId = Number(idResult.rows[0].id);
    const inserted = await client.query(
      `INSERT INTO tenant_deposit_transactions
         (id, user_id, account_id, transaction_code, entry_type, amount_vnd,
          payment_method, note, source, reverses_transaction_id, occurred_at)
       VALUES ($1,$2,$3,$4,'reversal',$5,$6,$7,'manual_reversal',$8,now())
       RETURNING *`,
      [
        reversalId,
        req.userId,
        original.account_id,
        transactionCode(reversalId, 'reversal'),
        reversalAmount,
        original.payment_method,
        reason,
        transactionId
      ]
    );
    const summary = await accountSummary(
      client.query.bind(client),
      req.userId,
      original.account_id
    );
    await client.query('COMMIT');
    return res.status(201).json({ account: summary, transaction: transactionJson(inserted.rows[0]) });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendDepositError(res, error)) return res;
    if (error.code === '23514') {
      return res.status(409).json({
        error: 'Hoàn tác sẽ làm số dư tiền cọc bị âm',
        code: 'DEPOSIT_REVERSAL_EXCEEDS_BALANCE'
      });
    }
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'Giao dịch đã được hoàn tác',
        code: 'DEPOSIT_TRANSACTION_ALREADY_REVERSED'
      });
    }
    throw error;
  } finally {
    client.release();
  }
}

async function loadDepositExport(userId) {
  const [accountResult, transactionResult] = await Promise.all([
    db.query(
      `SELECT a.id, a.tenant_id, a.tenant_name_snapshot, a.room_id,
              a.room_name_snapshot, a.created_at,
              COALESCE(SUM(t.amount_vnd), 0) AS balance_vnd,
              COUNT(t.id)::int AS transaction_count,
              MAX(t.occurred_at) AS last_transaction_at
       FROM tenant_deposit_accounts a
       LEFT JOIN tenant_deposit_transactions t
         ON t.user_id=a.user_id AND t.account_id=a.id
       WHERE a.user_id=$1
       GROUP BY a.id
       ORDER BY a.id`,
      [userId]
    ),
    db.query(
      `SELECT * FROM tenant_deposit_transactions
       WHERE user_id=$1 ORDER BY id`,
      [userId]
    )
  ]);
  return {
    accounts: accountResult.rows.map(accountJson),
    transactions: transactionResult.rows.map((row) => transactionJson({
      ...row,
      is_reversed: false
    }))
  };
}

module.exports = {
  DEPOSIT_ENTRY_TYPES,
  DEPOSIT_PAYMENT_METHODS,
  DepositError,
  accountJson,
  createDepositTransaction,
  depositTransactionInput,
  getTenantDeposit,
  loadDepositExport,
  positiveIntegerVnd,
  reverseDepositTransaction,
  transactionCode,
  transactionJson,
  validTenantId
};
