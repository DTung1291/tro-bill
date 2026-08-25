'use strict';

const crypto = require('crypto');
const db = require('./db');
const { autoMatchBankTransaction } = require('./rent-payment-auto-match');
const { RentBankSettingsError, normalizeRentBankSettings } = require('./rent-bank-settings');

const PROVIDER = 'sepay';
const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
const ACCOUNT_PATTERN = /^[0-9]{4,30}$/;

class RentPaymentChannelError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'RentPaymentChannelError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function sendChannelError(res, error) {
  if (!(error instanceof RentPaymentChannelError)) return false;
  res.status(error.statusCode).json({ error: error.message, code: error.code });
  return true;
}

function secretHash(secret) {
  return crypto.createHash('sha256').update(String(secret), 'utf8').digest('hex');
}

function generateSecret() {
  return `tbrwh_${crypto.randomBytes(24).toString('base64url')}`;
}

function safeSecretMatch(secret, expectedHash) {
  const supplied = Buffer.from(secretHash(secret), 'hex');
  const expected = /^[a-f0-9]{64}$/.test(String(expectedHash || ''))
    ? Buffer.from(expectedHash, 'hex')
    : Buffer.alloc(32);
  return supplied.length === expected.length && crypto.timingSafeEqual(supplied, expected);
}

function normalizeAccountNumber(value) {
  const raw = String(value || '').trim();
  if (!/^[0-9\s-]+$/.test(raw)) {
    throw new RentPaymentChannelError(
      400,
      'INVALID_BANK_ACCOUNT',
      'Số tài khoản nhận tiền chỉ được chứa chữ số'
    );
  }
  const normalized = raw.replace(/[\s-]/g, '');
  if (!ACCOUNT_PATTERN.test(normalized)) {
    throw new RentPaymentChannelError(
      400,
      'INVALID_BANK_ACCOUNT',
      'Số tài khoản nhận tiền phải có từ 4 đến 30 chữ số'
    );
  }
  return normalized;
}

function positiveId(value, code = 'INVALID_CHANNEL_ID') {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RentPaymentChannelError(400, code, 'Kênh thanh toán không hợp lệ');
  }
  return parsed;
}

function endpointBase(req) {
  const configured = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;
  return `${req.protocol || 'http'}://${req.get('host')}`;
}

function webhookUrl(req, publicId) {
  return `${endpointBase(req)}/api/rent-payment-channels/sepay/${publicId}/webhook`;
}

function channelJson(row, req) {
  return {
    id: Number(row.id),
    provider: row.provider,
    status: row.status,
    expectedAccountNumber: row.expected_account_number,
    settlementMode: 'direct_to_landlord',
    secretLast4: row.secret_last4,
    webhookUrl: webhookUrl(req, row.public_id),
    lastReceivedAt: row.last_received_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

async function configuredRentAccount(userId, suppliedAccountNumber) {
  const { rows } = await db.query(
    `SELECT bank_id, bank_account, bank_owner_name
     FROM settings
     WHERE user_id=$1`,
    [userId]
  );
  let settings;
  try {
    settings = normalizeRentBankSettings(rows[0] || {}, { allowEmpty: false });
  } catch (error) {
    if (error instanceof RentBankSettingsError) {
      throw new RentPaymentChannelError(
        409,
        'RENT_BANK_SETTINGS_REQUIRED',
        'Hãy lưu đủ ngân hàng, số tài khoản và tên chủ tài khoản VietQR trước'
      );
    }
    throw error;
  }
  let supplied;
  try {
    supplied = normalizeAccountNumber(suppliedAccountNumber);
  } catch (_) {
    throw new RentPaymentChannelError(
      409,
      'RENT_BANK_ACCOUNT_OUT_OF_SYNC',
      'Số tài khoản yêu cầu không khớp cấu hình VietQR đã lưu'
    );
  }
  if (supplied !== settings.accountNumber) {
    throw new RentPaymentChannelError(
      409,
      'RENT_BANK_ACCOUNT_OUT_OF_SYNC',
      'Số tài khoản yêu cầu không khớp cấu hình VietQR đã lưu'
    );
  }
  return settings.accountNumber;
}

function authorizationSecret(req) {
  const value = String(req.get('authorization') || '').trim();
  const match = /^apikey\s+([A-Za-z0-9_-]{24,160})$/i.exec(value);
  return match ? match[1] : '';
}

function localVietnamDate(value) {
  const text = String(value || '').trim();
  if (!text) {
    throw new RentPaymentChannelError(
      400,
      'INVALID_TRANSACTION_DATE',
      'Thời điểm giao dịch SePay không hợp lệ'
    );
  }
  const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text)
    ? `${text.replace(' ', 'T')}+07:00`
    : text;
  const date = new Date(normalized);
  if (Number.isNaN(date.getTime())
      || date.getTime() < Date.UTC(2000, 0, 1)
      || date.getTime() > Date.now() + 5 * 60 * 1000) {
    throw new RentPaymentChannelError(
      400,
      'INVALID_TRANSACTION_DATE',
      'Thời điểm giao dịch SePay không hợp lệ'
    );
  }
  return date.toISOString();
}

function boundedText(value, maxLength, field, { required = false } = {}) {
  const text = String(value ?? '').trim();
  if ((required && !text) || text.length > maxLength) {
    throw new RentPaymentChannelError(
      400,
      'INVALID_SEPAY_PAYLOAD',
      `${field} trong webhook SePay không hợp lệ`
    );
  }
  return text;
}

function sepayTransactionInput(body, expectedAccountNumber) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RentPaymentChannelError(400, 'INVALID_SEPAY_PAYLOAD', 'Webhook SePay không hợp lệ');
  }
  let encodedSize = MAX_WEBHOOK_BODY_BYTES + 1;
  try {
    encodedSize = Buffer.byteLength(JSON.stringify(body), 'utf8');
  } catch (_) {
    // Express chỉ đưa object JSON vào đây; vẫn giữ nhánh phòng vệ khi test trực tiếp.
  }
  if (encodedSize > MAX_WEBHOOK_BODY_BYTES) {
    throw new RentPaymentChannelError(413, 'SEPAY_PAYLOAD_TOO_LARGE', 'Webhook SePay quá lớn');
  }

  const providerTransactionId = boundedText(body.id, 128, 'Mã giao dịch', { required: true });
  if (!/^[A-Za-z0-9._:/-]+$/.test(providerTransactionId)) {
    throw new RentPaymentChannelError(400, 'INVALID_SEPAY_PAYLOAD', 'Mã giao dịch SePay không hợp lệ');
  }
  const transferType = boundedText(body.transferType, 16, 'Loại giao dịch', { required: true })
    .toLowerCase();
  if (transferType !== 'in') {
    throw new RentPaymentChannelError(
      422,
      'OUTGOING_TRANSACTION_IGNORED',
      'TrọBill chỉ nhận giao dịch tiền vào'
    );
  }
  const accountNumber = normalizeAccountNumber(body.accountNumber);
  if (accountNumber !== expectedAccountNumber) {
    throw new RentPaymentChannelError(
      422,
      'BANK_ACCOUNT_MISMATCH',
      'Giao dịch không thuộc tài khoản đã kết nối'
    );
  }
  const amountVnd = Number(body.transferAmount);
  if (!Number.isSafeInteger(amountVnd) || amountVnd < 1 || amountVnd > 999999999999) {
    throw new RentPaymentChannelError(400, 'INVALID_SEPAY_AMOUNT', 'Số tiền SePay không hợp lệ');
  }

  return {
    providerTransactionId,
    gateway: boundedText(body.gateway, 100, 'Ngân hàng'),
    accountNumber,
    transferType,
    amountVnd,
    content: boundedText(body.content, 500, 'Nội dung chuyển khoản'),
    transactionCode: boundedText(body.code, 200, 'Mã thanh toán'),
    referenceCode: boundedText(body.referenceCode, 255, 'Mã tham chiếu'),
    occurredAt: localVietnamDate(body.transactionDate)
  };
}

async function listChannels(req, res) {
  const { rows } = await db.query(
    `SELECT id, provider, public_id, secret_last4, expected_account_number,
            status, last_received_at, created_at, updated_at
     FROM rent_payment_channels
     WHERE user_id=$1
     ORDER BY id`,
    [req.userId]
  );
  res.set('Cache-Control', 'no-store');
  return res.json({ channels: rows.map((row) => channelJson(row, req)) });
}

async function createSepayChannel(req, res) {
  let expectedAccountNumber;
  try {
    expectedAccountNumber = await configuredRentAccount(
      req.userId,
      req.body?.expectedAccountNumber
    );
  } catch (error) {
    if (sendChannelError(res, error)) return res;
    throw error;
  }
  const secret = generateSecret();
  const publicId = crypto.randomUUID();
  try {
    const { rows } = await db.query(
      `INSERT INTO rent_payment_channels
         (user_id, provider, public_id, secret_hash, secret_last4, expected_account_number)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id, provider, public_id, secret_last4, expected_account_number,
                 status, last_received_at, created_at, updated_at`,
      [
        req.userId,
        PROVIDER,
        publicId,
        secretHash(secret),
        secret.slice(-4),
        expectedAccountNumber
      ]
    );
    res.set('Cache-Control', 'no-store');
    return res.status(201).json({ channel: channelJson(rows[0], req), secret });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'Tài khoản đã có kênh SePay. Hãy xoay API key nếu cần cấu hình lại.',
        code: 'SEPAY_CHANNEL_ALREADY_EXISTS'
      });
    }
    throw error;
  }
}

async function rotateChannelSecret(req, res) {
  let channelId;
  try {
    channelId = positiveId(req.params.id);
  } catch (error) {
    if (sendChannelError(res, error)) return res;
    throw error;
  }
  const secret = generateSecret();
  const { rows } = await db.query(
    `UPDATE rent_payment_channels
     SET secret_hash=$3, secret_last4=$4, status='active', updated_at=now()
     WHERE user_id=$1 AND id=$2
     RETURNING id, provider, public_id, secret_last4, expected_account_number,
               status, last_received_at, created_at, updated_at`,
    [req.userId, channelId, secretHash(secret), secret.slice(-4)]
  );
  if (!rows[0]) {
    return res.status(404).json({ error: 'Không tìm thấy kênh thanh toán', code: 'CHANNEL_NOT_FOUND' });
  }
  res.set('Cache-Control', 'no-store');
  return res.json({ channel: channelJson(rows[0], req), secret });
}

async function setChannelStatus(req, res) {
  let channelId;
  try {
    channelId = positiveId(req.params.id);
    if (typeof req.body?.active !== 'boolean') {
      throw new RentPaymentChannelError(400, 'INVALID_CHANNEL_STATUS', 'Trạng thái kênh không hợp lệ');
    }
  } catch (error) {
    if (sendChannelError(res, error)) return res;
    throw error;
  }
  const status = req.body.active ? 'active' : 'disabled';
  const { rows } = await db.query(
    `UPDATE rent_payment_channels
     SET status=$3, updated_at=now()
     WHERE user_id=$1 AND id=$2
     RETURNING id, provider, public_id, secret_last4, expected_account_number,
               status, last_received_at, created_at, updated_at`,
    [req.userId, channelId, status]
  );
  if (!rows[0]) {
    return res.status(404).json({ error: 'Không tìm thấy kênh thanh toán', code: 'CHANNEL_NOT_FOUND' });
  }
  res.set('Cache-Control', 'no-store');
  return res.json({ channel: channelJson(rows[0], req) });
}

async function updateChannelAccount(req, res) {
  let channelId;
  let expectedAccountNumber;
  try {
    channelId = positiveId(req.params.id);
    expectedAccountNumber = await configuredRentAccount(
      req.userId,
      req.body?.expectedAccountNumber
    );
  } catch (error) {
    if (sendChannelError(res, error)) return res;
    throw error;
  }
  const { rows } = await db.query(
    `UPDATE rent_payment_channels
     SET expected_account_number=$3, updated_at=now()
     WHERE user_id=$1 AND id=$2
     RETURNING id, provider, public_id, secret_last4, expected_account_number,
               status, last_received_at, created_at, updated_at`,
    [req.userId, channelId, expectedAccountNumber]
  );
  if (!rows[0]) {
    return res.status(404).json({ error: 'Không tìm thấy kênh thanh toán', code: 'CHANNEL_NOT_FOUND' });
  }
  res.set('Cache-Control', 'no-store');
  return res.json({ channel: channelJson(rows[0], req) });
}

async function sepayWebhook(req, res) {
  const publicId = String(req.params.publicId || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(publicId)) {
    return res.status(404).json({ error: 'Webhook không tồn tại', code: 'WEBHOOK_NOT_FOUND' });
  }
  const channelResult = await db.query(
    `SELECT id, user_id, secret_hash, expected_account_number, status
     FROM rent_payment_channels
     WHERE provider=$1 AND public_id=$2`,
    [PROVIDER, publicId]
  );
  const channel = channelResult.rows[0];
  const suppliedSecret = authorizationSecret(req);
  if (!channel || !suppliedSecret || !safeSecretMatch(suppliedSecret, channel.secret_hash)) {
    return res.status(401).json({ error: 'API key webhook không hợp lệ', code: 'INVALID_WEBHOOK_API_KEY' });
  }
  if (channel.status !== 'active') {
    return res.status(410).json({ error: 'Kênh thanh toán đã tắt', code: 'PAYMENT_CHANNEL_DISABLED' });
  }

  let input;
  try {
    input = sepayTransactionInput(req.body, channel.expected_account_number);
  } catch (error) {
    if (sendChannelError(res, error)) return res;
    throw error;
  }
  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const inserted = await client.query(
      `INSERT INTO rent_bank_transactions
         (user_id, channel_id, provider, provider_transaction_id, gateway,
          account_number, transfer_type, amount_vnd, transaction_content,
          transaction_code, provider_reference, occurred_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (channel_id, provider_transaction_id) DO NOTHING
       RETURNING *`,
      [
        channel.user_id,
        channel.id,
        PROVIDER,
        input.providerTransactionId,
        input.gateway,
        input.accountNumber,
        input.transferType,
        input.amountVnd,
        input.content,
        input.transactionCode,
        input.referenceCode,
        input.occurredAt
      ]
    );
    let bankTransaction = inserted.rows[0];
    if (!bankTransaction) {
      const existing = await client.query(
        `SELECT * FROM rent_bank_transactions
         WHERE channel_id=$1 AND provider_transaction_id=$2
         FOR UPDATE`,
        [channel.id, input.providerTransactionId]
      );
      bankTransaction = existing.rows[0];
    }
    const match = bankTransaction
      ? await autoMatchBankTransaction(client, bankTransaction)
      : { matched: false, status: 'pending', reason: 'transaction_not_found' };
    await client.query(
      `UPDATE rent_payment_channels
       SET last_received_at=now(), updated_at=now()
       WHERE id=$1 AND user_id=$2`,
      [channel.id, channel.user_id]
    );
    await client.query('COMMIT');
    return res.json({
      success: true,
      duplicate: !inserted.rows[0],
      matched: match.matched,
      matchStatus: match.status,
      matchReason: match.reason,
      receiptCode: match.receiptCode || undefined
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  RentPaymentChannelError,
  authorizationSecret,
  channelJson,
  configuredRentAccount,
  createSepayChannel,
  generateSecret,
  listChannels,
  normalizeAccountNumber,
  rotateChannelSecret,
  safeSecretMatch,
  secretHash,
  sepayTransactionInput,
  sepayWebhook,
  setChannelStatus,
  updateChannelAccount,
  webhookUrl
};
