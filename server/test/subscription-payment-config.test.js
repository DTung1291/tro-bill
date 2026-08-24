'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const {
  getConfig,
  getAdminConfig,
  setSubscriptionPaymentConfig
} = require('../config');

function responseRecorder() {
  const record = { statusCode: 200, body: null };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; }
  };
  return { record, res };
}

const configRow = {
  donate_bank_id: 'MB',
  donate_account: '987654321',
  donate_owner_name: 'DONATE OWNER',
  donate_message: 'Ung ho',
  subscription_bank_id: 'VCB',
  subscription_account: '123456789',
  subscription_owner_name: 'SUBSCRIPTION OWNER'
};

test('API cấu hình thường không lộ tài khoản thu subscription', async (t) => {
  const originalQuery = db.query;
  db.query = async () => ({ rows: [configRow] });
  t.after(() => { db.query = originalQuery; });
  const response = responseRecorder();

  await getConfig({}, response.res);

  assert.equal(response.record.body.donateAccount, '987654321');
  assert.equal('subscriptionAccount' in response.record.body, false);
});

test('admin đọc được cấu hình tài khoản thu subscription', async (t) => {
  const originalQuery = db.query;
  db.query = async () => ({ rows: [configRow] });
  t.after(() => { db.query = originalQuery; });
  const response = responseRecorder();

  await getAdminConfig({}, response.res);

  assert.equal(response.record.body.subscriptionBankId, 'VCB');
  assert.equal(response.record.body.subscriptionAccount, '123456789');
});

test('không cho lưu cấu hình tài khoản thu phí thiếu trường', async () => {
  const response = responseRecorder();
  await setSubscriptionPaymentConfig(
    { body: { bankId: 'VCB', account: '', ownerName: 'NGUYEN VAN A' } },
    response.res
  );
  assert.equal(response.record.statusCode, 400);
  assert.equal(response.record.body.code, 'SUBSCRIPTION_BANK_CONFIG_INCOMPLETE');
});

test('lưu cấu hình thu phí chỉ cập nhật ba trường riêng', async (t) => {
  const originalQuery = db.query;
  const calls = [];
  db.query = async (sql, params = []) => {
    calls.push({ sql, params });
    return sql.startsWith('SELECT') ? { rows: [configRow] } : { rows: [] };
  };
  t.after(() => { db.query = originalQuery; });
  const response = responseRecorder();

  await setSubscriptionPaymentConfig(
    { body: { bankId: 'vcb', account: '123456789', ownerName: 'Nguyen Van A' } },
    response.res
  );

  const write = calls.find((call) => call.sql.includes('INSERT INTO app_config'));
  assert.deepEqual(write.params, ['VCB', '123456789', 'NGUYEN VAN A']);
  assert.doesNotMatch(write.sql, /donate_/);
  assert.equal(response.record.statusCode, 200);
});
