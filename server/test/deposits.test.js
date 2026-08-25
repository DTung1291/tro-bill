'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-deposit-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const {
  createDepositTransaction,
  depositTransactionInput,
  transactionCode
} = require('../deposits');

function responseRecorder() {
  const record = { statusCode: 200, body: null };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; },
    set() { return res; }
  };
  return { record, res };
}

function request(overrides = {}) {
  return {
    userId: 7,
    params: {},
    body: {
      tenantId: 'tenant-1',
      entryType: 'collection',
      amountVnd: 2000000,
      paymentMethod: 'bank_transfer',
      note: 'Cọc phòng P101',
      idempotencyKey: 'deposit-test-00000001',
      occurredAt: '2026-08-25T01:00:00.000Z',
      ...overrides
    }
  };
}

test('input tiền cọc chặn số lẻ, loại sai và bắt buộc lý do khi trừ tiền', () => {
  assert.throws(
    () => depositTransactionInput(request({ amountVnd: 1.5 }).body),
    (error) => error.code === 'INVALID_DEPOSIT_AMOUNT'
  );
  assert.throws(
    () => depositTransactionInput(request({ entryType: 'delete' }).body),
    (error) => error.code === 'INVALID_DEPOSIT_ENTRY_TYPE'
  );
  assert.throws(
    () => depositTransactionInput(request({ entryType: 'refund', note: '' }).body),
    (error) => error.code === 'DEPOSIT_NOTE_REQUIRED'
  );
  assert.throws(
    () => depositTransactionInput(request({ idempotencyKey: 'short' }).body),
    (error) => error.code === 'INVALID_IDEMPOTENCY_KEY'
  );
  assert.equal(transactionCode(36, 'collection'), 'TC-00000010');
  assert.equal(transactionCode(36, 'refund'), 'HC-00000010');
});

test('thu cọc tạo bút toán dương và không cập nhật/xóa sổ giao dịch', async (t) => {
  const originalGetClient = db.getClient;
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('WHERE t.user_id=$1 AND t.idempotency_key=$2')) return { rows: [] };
      if (sql.includes('FROM tenant_deposit_accounts') && sql.includes('FOR UPDATE')) {
        return { rows: [{
          id: 4,
          user_id: 7,
          tenant_id: 'tenant-1',
          tenant_name_snapshot: 'Nguyễn Văn A',
          room_id: 'room-1',
          room_name_snapshot: 'P101'
        }] };
      }
      if (sql.includes('SELECT COALESCE(SUM(amount_vnd), 0) AS balance_vnd')) {
        return { rows: [{ balance_vnd: '0' }] };
      }
      if (sql.includes("nextval('tenant_deposit_transactions_id_seq')")) {
        return { rows: [{ id: 36 }] };
      }
      if (sql.includes('INSERT INTO tenant_deposit_transactions')) {
        return { rows: [{
          id: 36,
          account_id: 4,
          transaction_code: 'TC-00000010',
          entry_type: 'collection',
          amount_vnd: '2000000',
          payment_method: 'bank_transfer',
          note: 'Cọc phòng P101',
          source: 'manual',
          reverses_transaction_id: null,
          occurred_at: '2026-08-25T01:00:00.000Z',
          created_at: '2026-08-25T01:00:00.000Z'
        }] };
      }
      if (sql.includes('COALESCE(SUM(t.amount_vnd), 0) AS balance_vnd')) {
        return { rows: [{
          id: 4,
          tenant_id: 'tenant-1',
          tenant_name_snapshot: 'Nguyễn Văn A',
          room_id: 'room-1',
          room_name_snapshot: 'P101',
          balance_vnd: '2000000',
          transaction_count: 1,
          last_transaction_at: '2026-08-25T01:00:00.000Z'
        }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await createDepositTransaction(request(), response.res);

  assert.equal(response.record.statusCode, 201);
  assert.equal(response.record.body.account.balanceVnd, 2000000);
  assert.equal(response.record.body.transaction.amountVnd, 2000000);
  const insert = calls.find((call) => call.sql.includes('INSERT INTO tenant_deposit_transactions'));
  assert.equal(insert.params[5], 2000000);
  assert.equal(insert.params[3], 'TC-00000010');
  assert.equal(calls.some((call) => /UPDATE tenant_deposit_transactions|DELETE FROM tenant_deposit_transactions/.test(call.sql)), false);
  assert.equal(calls.some((call) => call.sql === 'COMMIT'), true);
});

test('khấu trừ hoặc hoàn cọc không được làm số dư âm', async (t) => {
  const originalGetClient = db.getClient;
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('WHERE t.user_id=$1 AND t.idempotency_key=$2')) return { rows: [] };
      if (sql.includes('FROM tenant_deposit_accounts') && sql.includes('FOR UPDATE')) {
        return { rows: [{ id: 4, tenant_id: 'tenant-1' }] };
      }
      if (sql.includes('SELECT COALESCE(SUM(amount_vnd), 0) AS balance_vnd')) {
        return { rows: [{ balance_vnd: '500000' }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  db.getClient = async () => client;
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await createDepositTransaction(request({
    entryType: 'deduction',
    amountVnd: 600000,
    note: 'Khấu trừ hư hỏng thiết bị',
    idempotencyKey: 'deposit-test-00000002'
  }), response.res);

  assert.equal(response.record.statusCode, 409);
  assert.equal(response.record.body.code, 'DEPOSIT_EXCEEDS_BALANCE');
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO tenant_deposit_transactions')), false);
  assert.equal(calls.some((call) => call.sql === 'ROLLBACK'), true);
});

const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
const migration = fs.readFileSync(
  path.join(__dirname, '..', 'migrations', '20260825_tenant_deposit_ledger.sql'),
  'utf8'
);

test('schema tiền cọc khóa ownership, số có dấu và append-only', () => {
  assert.match(schema, /CREATE TABLE IF NOT EXISTS tenant_deposit_accounts/);
  assert.match(schema, /UNIQUE \(user_id, tenant_id\)/);
  assert.match(schema, /CREATE TABLE IF NOT EXISTS tenant_deposit_transactions/);
  assert.match(
    schema,
    /FOREIGN KEY \(user_id, account_id\)[\s\S]*REFERENCES tenant_deposit_accounts\(user_id, id\)/
  );
  assert.match(schema, /entry_type IN \('collection', 'deduction', 'refund', 'reversal'\)/);
  assert.match(schema, /entry_type IN \('deduction', 'refund'\) AND amount_vnd < 0/);
  assert.match(schema, /idx_tenant_deposit_transactions_idempotency/);
  assert.match(schema, /idx_tenant_deposit_transactions_reversal_once/);
  assert.match(schema, /CREATE OR REPLACE FUNCTION enforce_tenant_deposit_nonnegative/);
  assert.match(schema, /CREATE TRIGGER tenant_deposit_nonnegative_before_insert/);
  assert.match(
    schema,
    /REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON tenant_deposit_transactions FROM tro_bill_runtime/
  );
  assert.match(schema, /GRANT SELECT, INSERT ON tenant_deposit_transactions TO tro_bill_runtime/);
});

test('migration tiền cọc chạy transaction, idempotent và tự kiểm tra', () => {
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS tenant_deposit_accounts/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS tenant_deposit_transactions/);
  assert.match(migration, /COMMIT;[\s\S]*accounts_ready/);
  assert.match(migration, /nonnegative_trigger_ready/);
  assert.match(migration, /ledger_append_only/);
  assert.doesNotMatch(migration, /DROP\s+(TABLE|SCHEMA|DATABASE)/i);
  assert.doesNotMatch(migration, /^\s*TRUNCATE\s+/im);
});

test('giao diện và API hỗ trợ thu, khấu trừ, hoàn cọc và chặn xóa khi còn dư', () => {
  const root = path.join(__dirname, '..', '..');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const apiSource = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const stateSource = fs.readFileSync(path.join(root, 'server', 'state.js'), 'utf8');

  assert.match(htmlSource, /id="deposit-modal"/);
  assert.match(htmlSource, /value="collection">Thu tiền cọc/);
  assert.match(htmlSource, /value="deduction">Khấu trừ cọc/);
  assert.match(htmlSource, /value="refund">Hoàn cọc cho khách/);
  assert.match(appSource, /data-deposit-tenant/);
  assert.match(appSource, /API\.createDepositTransaction/);
  assert.match(appSource, /API\.reverseDepositTransaction/);
  assert.match(apiSource, /\/api\/deposits\/transactions/);
  assert.match(stateSource, /TENANT_DEPOSIT_BALANCE_REMAINS/);
});
