'use strict';

const db = require('./db');
const { recordDataAudits, requestDataAuditEntry } = require('./data-audit');
const { normalizeRentBankSettings, RentBankSettingsError } = require('./rent-bank-settings');

const MAX_RENT_BANK_ACCOUNTS = 20;

class RentBankAccountError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'RentBankAccountError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function positiveId(value, field = 'Tài khoản ngân hàng') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new RentBankAccountError(400, 'INVALID_RENT_BANK_ACCOUNT_ID', `${field} không hợp lệ`);
  }
  return id;
}

function bankAccountInput(body = {}) {
  const label = String(body.label || '').trim().replace(/\s+/g, ' ');
  if (label.length < 1 || label.length > 100) {
    throw new RentBankAccountError(
      400,
      'INVALID_RENT_BANK_ACCOUNT_LABEL',
      'Tên gợi nhớ tài khoản phải từ 1 đến 100 ký tự'
    );
  }
  let normalized;
  try {
    normalized = normalizeRentBankSettings({
      bankId: body.bankId,
      bankAccount: body.accountNumber ?? body.bankAccount,
      bankOwnerName: body.ownerName ?? body.bankOwnerName
    }, { allowEmpty: false });
  } catch (error) {
    if (error instanceof RentBankSettingsError) {
      throw new RentBankAccountError(400, error.code, error.message);
    }
    throw error;
  }
  return {
    label,
    bankId: normalized.bankId,
    accountNumber: normalized.accountNumber,
    ownerName: normalized.ownerName,
    makeDefault: body.makeDefault === true
  };
}

function bankAccountJson(row) {
  return {
    id: Number(row.id),
    label: row.label,
    bankId: row.bank_id,
    accountNumber: row.account_number,
    ownerName: row.owner_name,
    isDefault: !!row.is_default,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

function sendRentBankAccountError(res, error) {
  if (!(error instanceof RentBankAccountError)) return false;
  res.status(error.statusCode).json({ error: error.message, code: error.code });
  return true;
}

async function bankAccountRows(userId, propertyIds = null, query = db.query) {
  const scoped = Array.isArray(propertyIds);
  const result = await query(
    `SELECT account.*
     FROM rent_bank_accounts account
     WHERE account.user_id=$1
       AND (
         $2::boolean=false
         OR account.id IN (
           SELECT COALESCE(property.rent_bank_account_id, default_account.id)
           FROM properties property
           LEFT JOIN rent_bank_accounts default_account
             ON default_account.user_id=property.user_id AND default_account.is_default
           WHERE property.user_id=$1 AND property.id=ANY($3::bigint[])
         )
       )
     ORDER BY account.is_default DESC, account.label, account.id`,
    [userId, scoped, scoped ? propertyIds : []]
  );
  return result.rows;
}

async function listRentBankAccounts(req, res, dependencies = {}) {
  const query = dependencies.query || db.query;
  const propertyIds = req.workspace && !req.workspace.isOwner
    ? (Array.isArray(req.workspace.propertyIds) ? req.workspace.propertyIds : [])
    : null;
  const rows = await bankAccountRows(req.userId, propertyIds, query);
  res.set('Cache-Control', 'no-store');
  return res.json({ bankAccounts: rows.map(bankAccountJson) });
}

async function lockAccountWrite(client, userId) {
  await client.query(
    `SELECT pg_advisory_xact_lock(hashtextextended(
       'rent-bank-accounts:' || $1::text, 0
     ))`,
    [userId]
  );
}

async function syncLegacyDefaultSettings(query, userId, row) {
  await query(
    `INSERT INTO settings (user_id, bank_id, bank_account, bank_owner_name)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id) DO UPDATE SET
       bank_id=EXCLUDED.bank_id,
       bank_account=EXCLUDED.bank_account,
       bank_owner_name=EXCLUDED.bank_owner_name`,
    [userId, row.bank_id, row.account_number, row.owner_name]
  );
}

async function createRentBankAccount(req, res, dependencies = {}) {
  let input;
  try {
    input = bankAccountInput(req.body);
  } catch (error) {
    if (sendRentBankAccountError(res, error)) return res;
    throw error;
  }
  const client = await (dependencies.getClient || db.getClient)();
  try {
    await client.query('BEGIN');
    await lockAccountWrite(client, req.userId);
    const countResult = await client.query(
      'SELECT COUNT(*)::int AS account_count FROM rent_bank_accounts WHERE user_id=$1',
      [req.userId]
    );
    const count = Number(countResult.rows[0]?.account_count) || 0;
    if (count >= MAX_RENT_BANK_ACCOUNTS) {
      throw new RentBankAccountError(
        409,
        'RENT_BANK_ACCOUNT_LIMIT_EXCEEDED',
        `Mỗi tài khoản được tạo tối đa ${MAX_RENT_BANK_ACCOUNTS} tài khoản ngân hàng`
      );
    }
    const makeDefault = count === 0 || input.makeDefault;
    if (makeDefault) {
      await client.query(
        'UPDATE rent_bank_accounts SET is_default=false, updated_at=now() WHERE user_id=$1 AND is_default',
        [req.userId]
      );
    }
    const inserted = await client.query(
      `INSERT INTO rent_bank_accounts
         (user_id, label, bank_id, account_number, owner_name, is_default)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [
        req.userId,
        input.label,
        input.bankId,
        input.accountNumber,
        input.ownerName,
        makeDefault
      ]
    );
    const row = inserted.rows[0];
    if (makeDefault) await syncLegacyDefaultSettings(client.query.bind(client), req.userId, row);
    await recordDataAudits(client.query.bind(client), [requestDataAuditEntry(
      req,
      'rent_bank_account_created',
      'rent_bank_account',
      String(row.id),
      {
        changedFields: ['label', 'bankId', 'accountNumber', 'ownerName', 'isDefault'],
        purpose: makeDefault ? 'Tạo tài khoản nhận tiền mặc định' : 'Tạo tài khoản nhận tiền'
      }
    )]);
    await client.query('COMMIT');
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({ bankAccount: bankAccountJson(row) });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendRentBankAccountError(res, error)) return res;
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'Tài khoản ngân hàng này đã tồn tại',
        code: 'RENT_BANK_ACCOUNT_EXISTS'
      });
    }
    throw error;
  } finally {
    client.release();
  }
}

async function updateRentBankAccount(req, res, dependencies = {}) {
  let id;
  let input;
  try {
    id = positiveId(req.params.id);
    input = bankAccountInput(req.body);
  } catch (error) {
    if (sendRentBankAccountError(res, error)) return res;
    throw error;
  }
  const client = await (dependencies.getClient || db.getClient)();
  try {
    await client.query('BEGIN');
    await lockAccountWrite(client, req.userId);
    const found = await client.query(
      'SELECT * FROM rent_bank_accounts WHERE user_id=$1 AND id=$2 FOR UPDATE',
      [req.userId, id]
    );
    const current = found.rows[0];
    if (!current) {
      throw new RentBankAccountError(404, 'RENT_BANK_ACCOUNT_NOT_FOUND', 'Không tìm thấy tài khoản ngân hàng');
    }
    if (input.makeDefault && !current.is_default) {
      await client.query(
        'UPDATE rent_bank_accounts SET is_default=false, updated_at=now() WHERE user_id=$1 AND is_default',
        [req.userId]
      );
    }
    const updated = await client.query(
      `UPDATE rent_bank_accounts
       SET label=$3, bank_id=$4, account_number=$5, owner_name=$6,
           is_default=CASE WHEN $7 THEN true ELSE is_default END,
           updated_at=now()
       WHERE user_id=$1 AND id=$2
       RETURNING *`,
      [
        req.userId,
        id,
        input.label,
        input.bankId,
        input.accountNumber,
        input.ownerName,
        input.makeDefault
      ]
    );
    const row = updated.rows[0];
    if (row.is_default) await syncLegacyDefaultSettings(client.query.bind(client), req.userId, row);
    const changedFields = [
      ['label', 'label'],
      ['bank_id', 'bankId'],
      ['account_number', 'accountNumber'],
      ['owner_name', 'ownerName'],
      ['is_default', 'isDefault']
    ].filter(([databaseField]) => String(current[databaseField]) !== String(row[databaseField]))
      .map(([, clientField]) => clientField);
    if (changedFields.length > 0) {
      await recordDataAudits(client.query.bind(client), [requestDataAuditEntry(
        req,
        'rent_bank_account_updated',
        'rent_bank_account',
        String(row.id),
        { changedFields, purpose: row.is_default ? 'Cập nhật tài khoản mặc định' : 'Cập nhật tài khoản nhận tiền' }
      )]);
    }
    await client.query('COMMIT');
    res.set('Cache-Control', 'no-store');
    return res.json({ bankAccount: bankAccountJson(row) });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendRentBankAccountError(res, error)) return res;
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'Tài khoản ngân hàng này đã tồn tại',
        code: 'RENT_BANK_ACCOUNT_EXISTS'
      });
    }
    throw error;
  } finally {
    client.release();
  }
}

async function assignPropertyRentBankAccount(req, res, dependencies = {}) {
  let propertyId;
  let bankAccountId = null;
  try {
    propertyId = positiveId(req.params.propertyId, 'Khu');
    if (req.body?.bankAccountId !== null && req.body?.bankAccountId !== ''
        && req.body?.bankAccountId !== undefined) {
      bankAccountId = positiveId(req.body.bankAccountId);
    }
  } catch (error) {
    if (sendRentBankAccountError(res, error)) return res;
    throw error;
  }
  const client = await (dependencies.getClient || db.getClient)();
  try {
    await client.query('BEGIN');
    await lockAccountWrite(client, req.userId);
    if (bankAccountId !== null) {
      const account = await client.query(
        'SELECT id FROM rent_bank_accounts WHERE user_id=$1 AND id=$2',
        [req.userId, bankAccountId]
      );
      if (!account.rows[0]) {
        throw new RentBankAccountError(404, 'RENT_BANK_ACCOUNT_NOT_FOUND', 'Không tìm thấy tài khoản ngân hàng');
      }
    }
    const updated = await client.query(
      `UPDATE properties
       SET rent_bank_account_id=$3, updated_at=now()
       WHERE user_id=$1 AND id=$2
       RETURNING id, rent_bank_account_id`,
      [req.userId, propertyId, bankAccountId]
    );
    if (!updated.rows[0]) {
      throw new RentBankAccountError(404, 'PROPERTY_NOT_FOUND', 'Không tìm thấy khu');
    }
    await recordDataAudits(client.query.bind(client), [requestDataAuditEntry(
      req,
      'property_bank_account_assigned',
      'property',
      String(propertyId),
      {
        changedFields: ['rentBankAccountId'],
        purpose: bankAccountId === null ? 'Khu dùng tài khoản mặc định' : 'Gán tài khoản nhận tiền cho khu'
      }
    )]);
    await client.query('COMMIT');
    return res.json({
      propertyId,
      bankAccountId: updated.rows[0].rent_bank_account_id === null
        ? null
        : Number(updated.rows[0].rent_bank_account_id)
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendRentBankAccountError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

async function deleteRentBankAccount(req, res, dependencies = {}) {
  let id;
  try {
    id = positiveId(req.params.id);
  } catch (error) {
    if (sendRentBankAccountError(res, error)) return res;
    throw error;
  }
  const client = await (dependencies.getClient || db.getClient)();
  try {
    await client.query('BEGIN');
    await lockAccountWrite(client, req.userId);
    const found = await client.query(
      'SELECT * FROM rent_bank_accounts WHERE user_id=$1 AND id=$2 FOR UPDATE',
      [req.userId, id]
    );
    const row = found.rows[0];
    if (!row) {
      throw new RentBankAccountError(404, 'RENT_BANK_ACCOUNT_NOT_FOUND', 'Không tìm thấy tài khoản ngân hàng');
    }
    if (row.is_default) {
      throw new RentBankAccountError(
        409,
        'DEFAULT_RENT_BANK_ACCOUNT_REQUIRED',
        'Hãy đặt một tài khoản khác làm mặc định trước khi xóa'
      );
    }
    const usage = await client.query(
      `SELECT
         EXISTS (
           SELECT 1 FROM properties WHERE user_id=$1 AND rent_bank_account_id=$2
         ) AS used_by_property,
         EXISTS (
           SELECT 1 FROM rent_payment_channels WHERE user_id=$1 AND bank_account_id=$2
         ) AS used_by_channel,
         EXISTS (
           SELECT 1 FROM rent_bank_transactions WHERE user_id=$1 AND bank_account_id=$2
         ) AS used_by_transaction`,
      [req.userId, id]
    );
    const flags = usage.rows[0] || {};
    if (flags.used_by_property) {
      throw new RentBankAccountError(
        409,
        'RENT_BANK_ACCOUNT_ASSIGNED',
        'Hãy chuyển các khu đang dùng tài khoản này trước khi xóa'
      );
    }
    if (flags.used_by_channel || flags.used_by_transaction) {
      throw new RentBankAccountError(
        409,
        'RENT_BANK_ACCOUNT_HAS_HISTORY',
        'Không thể xóa tài khoản đã có kênh hoặc lịch sử đối soát'
      );
    }
    await client.query('DELETE FROM rent_bank_accounts WHERE user_id=$1 AND id=$2', [req.userId, id]);
    await recordDataAudits(client.query.bind(client), [requestDataAuditEntry(
      req,
      'rent_bank_account_deleted',
      'rent_bank_account',
      String(id),
      { changedFields: [], purpose: 'Xóa tài khoản nhận tiền chưa sử dụng' }
    )]);
    await client.query('COMMIT');
    return res.json({ ok: true });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendRentBankAccountError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

async function syncDefaultBankAccountFromSettings(query, userId, settings = {}) {
  let normalized;
  try {
    normalized = normalizeRentBankSettings(settings);
  } catch (error) {
    throw error;
  }
  await query(
    `SELECT pg_advisory_xact_lock(hashtextextended(
       'rent-bank-accounts:' || $1::text, 0
     ))`,
    [userId]
  );
  const existing = await query(
    'SELECT * FROM rent_bank_accounts WHERE user_id=$1 AND is_default FOR UPDATE',
    [userId]
  );
  if (!normalized.bankId || !normalized.accountNumber || !normalized.ownerName) {
    if (existing.rows[0]) {
      await syncLegacyDefaultSettings(query, userId, existing.rows[0]);
    }
    return existing.rows[0] || null;
  }
  const identity = await query(
    `SELECT * FROM rent_bank_accounts
     WHERE user_id=$1 AND bank_id=$2 AND account_number=$3
     FOR UPDATE`,
    [userId, normalized.bankId, normalized.accountNumber]
  );
  if (identity.rows[0] && Number(identity.rows[0].id) !== Number(existing.rows[0]?.id)) {
    await query(
      'UPDATE rent_bank_accounts SET is_default=false, updated_at=now() WHERE user_id=$1 AND is_default',
      [userId]
    );
    const promoted = await query(
      `UPDATE rent_bank_accounts
       SET owner_name=$3, is_default=true, updated_at=now()
       WHERE user_id=$1 AND id=$2
       RETURNING *`,
      [userId, identity.rows[0].id, normalized.ownerName]
    );
    return promoted.rows[0] || null;
  }
  if (existing.rows[0]) {
    const result = await query(
      `UPDATE rent_bank_accounts
       SET bank_id=$2, account_number=$3, owner_name=$4, updated_at=now()
       WHERE user_id=$1 AND id=$5
       RETURNING *`,
      [
        userId,
        normalized.bankId,
        normalized.accountNumber,
        normalized.ownerName,
        existing.rows[0].id
      ]
    );
    return result.rows[0] || null;
  }
  const inserted = await query(
    `INSERT INTO rent_bank_accounts
       (user_id, label, bank_id, account_number, owner_name, is_default)
     VALUES ($1,'Tài khoản mặc định',$2,$3,$4,true)
     RETURNING *`,
    [userId, normalized.bankId, normalized.accountNumber, normalized.ownerName]
  );
  return inserted.rows[0] || null;
}

module.exports = {
  MAX_RENT_BANK_ACCOUNTS,
  RentBankAccountError,
  assignPropertyRentBankAccount,
  bankAccountInput,
  bankAccountJson,
  bankAccountRows,
  createRentBankAccount,
  deleteRentBankAccount,
  listRentBankAccounts,
  positiveId,
  sendRentBankAccountError,
  syncDefaultBankAccountFromSettings,
  syncLegacyDefaultSettings,
  updateRentBankAccount
};
