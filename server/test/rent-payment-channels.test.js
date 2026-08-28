'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-payment-channel-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'https://tro-bill.example';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const {
  createSepayChannel,
  generateSecret,
  normalizeAccountNumber,
  safeSecretMatch,
  secretHash,
  sepayTransactionInput,
  sepayWebhook
} = require('../rent-payment-channels');

function responseRecorder() {
  const record = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; },
    set(name, value) { record.headers[name] = value; return res; }
  };
  return { record, res };
}

function request(body = {}, options = {}) {
  const headers = Object.fromEntries(
    Object.entries(options.headers || {}).map(([key, value]) => [key.toLowerCase(), value])
  );
  return {
    userId: 7,
    protocol: 'https',
    params: options.params || {},
    body,
    get(name) {
      if (String(name).toLowerCase() === 'host') return 'ignored.example';
      return headers[String(name).toLowerCase()] || '';
    }
  };
}

function sepayPayload(overrides = {}) {
  return {
    id: 92704,
    gateway: 'Vietcombank',
    transactionDate: '2026-08-24 20:15:30',
    accountNumber: '0123 456 789',
    code: 'HD00000015',
    content: 'Thanh toan HD00000015',
    transferType: 'in',
    transferAmount: 3000000,
    referenceCode: 'FT26236123456789',
    ...overrides
  };
}

test('API key webhook đủ entropy, chỉ so sánh bằng hash và timing-safe', () => {
  const secret = generateSecret();
  assert.match(secret, /^tbrwh_[A-Za-z0-9_-]{32}$/);
  const hash = secretHash(secret);
  assert.match(hash, /^[a-f0-9]{64}$/);
  assert.equal(safeSecretMatch(secret, hash), true);
  assert.equal(safeSecretMatch(`${secret}x`, hash), false);
  assert.equal(safeSecretMatch(secret, 'invalid'), false);
});

test('chuẩn hóa tài khoản và thời gian SePay theo múi giờ Việt Nam', () => {
  assert.equal(normalizeAccountNumber('0123 456-789'), '0123456789');
  const input = sepayTransactionInput(sepayPayload(), '0123456789');
  assert.equal(input.providerTransactionId, '92704');
  assert.equal(input.amountVnd, 3000000);
  assert.equal(input.occurredAt, '2026-08-24T13:15:30.000Z');
  assert.equal(input.content, 'Thanh toan HD00000015');
});

test('webhook từ chối tiền ra, sai tài khoản, số tiền lỗi và payload quá lớn', () => {
  assert.throws(
    () => sepayTransactionInput(sepayPayload({ transferType: 'out' }), '0123456789'),
    (error) => error.code === 'OUTGOING_TRANSACTION_IGNORED' && error.statusCode === 422
  );
  assert.throws(
    () => sepayTransactionInput(sepayPayload({ accountNumber: '99998888' }), '0123456789'),
    (error) => error.code === 'BANK_ACCOUNT_MISMATCH'
  );
  assert.throws(
    () => sepayTransactionInput(sepayPayload({ transferAmount: 1.5 }), '0123456789'),
    (error) => error.code === 'INVALID_SEPAY_AMOUNT'
  );
  assert.throws(
    () => sepayTransactionInput(sepayPayload({ transactionDate: '' }), '0123456789'),
    (error) => error.code === 'INVALID_TRANSACTION_DATE'
  );
  assert.throws(
    () => sepayTransactionInput(sepayPayload({ accountNumber: 'ABC-1234' }), '0123456789'),
    (error) => error.code === 'INVALID_BANK_ACCOUNT'
  );
  assert.throws(
    () => sepayTransactionInput(sepayPayload({ content: 'x'.repeat(70 * 1024) }), '0123456789'),
    (error) => error.code === 'SEPAY_PAYLOAD_TOO_LARGE'
  );
});

test('tạo kênh chỉ ghi hash và trả API key rõ đúng trong response tạo', async (t) => {
  const originalQuery = db.query;
  let insertParams;
  db.query = async (sql, params) => {
    if (sql.includes('FROM settings')) {
      return { rows: [{
        bank_id: 'VCB',
        bank_account: '0123456789',
        bank_owner_name: 'NGUYEN VAN A'
      }] };
    }
    assert.match(sql, /INSERT INTO rent_payment_channels/);
    insertParams = params;
    return { rows: [{
      id: 3,
      provider: 'sepay',
      public_id: '9b78ad4a-cb73-4f1f-a24c-c5d843795715',
      secret_last4: params[4],
      expected_account_number: params[5],
      status: 'active',
      last_received_at: null,
      created_at: '2026-08-25T00:00:00.000Z',
      updated_at: '2026-08-25T00:00:00.000Z'
    }] };
  };
  t.after(() => { db.query = originalQuery; });

  const { record, res } = responseRecorder();
  await createSepayChannel(request({ expectedAccountNumber: '0123 456 789' }), res);

  assert.equal(record.statusCode, 201);
  assert.equal(record.body.channel.webhookUrl,
    'https://tro-bill.example/api/rent-payment-channels/sepay/9b78ad4a-cb73-4f1f-a24c-c5d843795715/webhook');
  assert.equal(record.body.channel.expectedAccountNumber, '0123456789');
  assert.match(record.body.secret, /^tbrwh_/);
  assert.equal(insertParams.includes(record.body.secret), false, 'database không nhận secret dạng rõ');
  assert.equal(insertParams[3], secretHash(record.body.secret));
  assert.equal(insertParams[4], record.body.secret.slice(-4));
  assert.equal(JSON.stringify(record.body.channel).includes(insertParams[3]), false, 'API không trả secret hash');
  assert.equal(record.body.channel.settlementMode, 'direct_to_landlord');
});

test('tạo kênh từ chối tài khoản khác với VietQR đã lưu của chủ trọ', async (t) => {
  const originalQuery = db.query;
  let inserted = false;
  db.query = async (sql) => {
    if (sql.includes('FROM settings')) {
      return { rows: [{
        bank_id: 'VCB',
        bank_account: '0123456789',
        bank_owner_name: 'NGUYEN VAN A'
      }] };
    }
    inserted = true;
    return { rows: [] };
  };
  t.after(() => { db.query = originalQuery; });

  const { record, res } = responseRecorder();
  await createSepayChannel(request({ expectedAccountNumber: '99998888' }), res);
  assert.equal(record.statusCode, 409);
  assert.equal(record.body.code, 'RENT_BANK_ACCOUNT_OUT_OF_SYNC');
  assert.equal(inserted, false);
});

test('webhook yêu cầu Apikey hợp lệ trước khi xử lý payload', async (t) => {
  const originalQuery = db.query;
  const originalGetClient = db.getClient;
  db.query = async () => ({ rows: [{
    id: 3,
    user_id: 7,
    secret_hash: secretHash('tbrwh_right_secret_that_is_long_enough'),
    expected_account_number: '0123456789',
    status: 'active'
  }] });
  db.getClient = async () => { throw new Error('không được mở transaction'); };
  t.after(() => {
    db.query = originalQuery;
    db.getClient = originalGetClient;
  });

  const { record, res } = responseRecorder();
  await sepayWebhook(request(sepayPayload(), {
    params: { publicId: '9b78ad4a-cb73-4f1f-a24c-c5d843795715' },
    headers: { Authorization: 'Apikey wrong_secret_that_is_long_enough' }
  }), res);
  assert.equal(record.statusCode, 401);
  assert.equal(record.body.code, 'INVALID_WEBHOOK_API_KEY');
});

test('webhook ghi giao dịch đã chuẩn hóa và retry cùng id không tạo bản ghi thứ hai', async (t) => {
  const originalQuery = db.query;
  const originalGetClient = db.getClient;
  const secret = 'tbrwh_valid_secret_that_is_long_enough';
  db.query = async () => ({ rows: [{
    id: 3,
    user_id: 7,
    secret_hash: secretHash(secret),
    expected_account_number: '0123456789',
    status: 'active'
  }] });
  let duplicate = false;
  const calls = [];
  const storedTransaction = {
    id: 99,
    user_id: 7,
    channel_id: 3,
    provider_transaction_id: '92704',
    transaction_code: 'HD00000015',
    transaction_content: 'Thanh toan HD00000015',
    amount_vnd: '3000000',
    occurred_at: '2026-08-24T13:15:30.000Z',
    match_status: 'pending',
    match_reason: ''
  };
  db.getClient = async () => ({
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('INSERT INTO rent_bank_transactions')) {
        return { rows: duplicate ? [] : [storedTransaction] };
      }
      if (sql.includes('SELECT * FROM rent_bank_transactions')) {
        return { rows: [storedTransaction] };
      }
      return { rows: [] };
    },
    release() {}
  });
  t.after(() => {
    db.query = originalQuery;
    db.getClient = originalGetClient;
  });

  const req = request(sepayPayload(), {
    params: { publicId: '9b78ad4a-cb73-4f1f-a24c-c5d843795715' },
    headers: { Authorization: `Apikey ${secret}` }
  });
  let response = responseRecorder();
  await sepayWebhook(req, response.res);
  assert.deepEqual(response.record.body, {
    success: true,
    duplicate: false,
    matched: false,
    matchStatus: 'pending',
    matchReason: 'invoice_not_found',
    receiptCode: undefined
  });

  const insert = calls.find((call) => call.sql.includes('INSERT INTO rent_bank_transactions'));
  assert.deepEqual(insert.params.slice(0, 8), [
    7, 3, 'sepay', '92704', 'Vietcombank', '0123456789', 'in', 3000000
  ]);
  assert.match(insert.sql, /ON CONFLICT \(channel_id, provider_transaction_id\) DO NOTHING/);

  duplicate = true;
  response = responseRecorder();
  await sepayWebhook(req, response.res);
  assert.deepEqual(response.record.body, {
    success: true,
    duplicate: true,
    matched: false,
    matchStatus: 'pending',
    matchReason: 'invoice_not_found',
    receiptCode: undefined
  });
  assert.equal(calls.filter((call) => call.sql === 'COMMIT').length, 2);
});

test('schema và migration giữ queue append-only, secret hash và khóa chống replay', () => {
  const root = path.join(__dirname, '..', '..');
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260825_rent_payment_channels.sql'),
    'utf8'
  );
  for (const source of [schema, migration]) {
    const transactionTable = source.match(
      /CREATE TABLE IF NOT EXISTS rent_bank_transactions \([\s\S]*?\n\);/
    )?.[0] || '';
    assert.match(source, /secret_hash ~ '\^\[a-f0-9\]\{64\}\$'/);
    assert.match(source, /UNIQUE \(channel_id, provider_transaction_id\)/);
    assert.match(source, /REVOKE UPDATE, DELETE, TRUNCATE[\s\S]*ON rent_bank_transactions/);
    assert.match(source, /GRANT UPDATE \(match_status,[^)]*matched_invoice_id,[^)]*matched_at,[^)]*updated_at\)/);
    assert.doesNotMatch(transactionTable, /raw_payload|payload\s+JSONB/i);
  }
});

test('frontend khai báo API quản lý kênh nhưng không có API đọc secret cũ', () => {
  const root = path.join(__dirname, '..', '..');
  const source = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const styleSource = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  assert.match(source, /function getRentPaymentChannels/);
  assert.match(source, /function createSepayRentPaymentChannel/);
  assert.match(source, /function rotateRentPaymentChannelSecret/);
  assert.match(source, /function setRentPaymentChannelStatus/);
  assert.match(source, /function updateRentPaymentChannelAccount/);
  assert.doesNotMatch(source, /getRentPaymentChannelSecret/);
  assert.match(appSource, /function renderRentPaymentChannel/);
  assert.match(appSource, /ACTIVE_RENT_PAYMENT_CHANNEL_SECRET = null/);
  assert.match(htmlSource, /id="sepay-channel-card"/);
  assert.match(htmlSource, /API key mới — chỉ hiển thị lần này/);
  assert.match(htmlSource, /api\.js\?v=97[\s\S]*app\.js\?v=100/);
  assert.match(styleSource, /\.payment-channel-value-row[\s\S]*min-width: 0/);
});
