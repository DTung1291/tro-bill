'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-rent-bank-account-tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  bankAccountInput,
  createRentBankAccount,
  assignPropertyRentBankAccount,
  syncDefaultBankAccountFromSettings
} = require('../rent-bank-accounts');

function responseRecorder() {
  const record = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; },
    set(name, value) { record.headers[name] = value; return res; }
  };
  return { record, res };
}

function accountRow(overrides = {}) {
  return {
    id: 12,
    user_id: 7,
    label: 'Tài khoản khu A',
    bank_id: 'VCB',
    account_number: '0123456789',
    owner_name: 'NGUYEN VAN A',
    is_default: true,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
    ...overrides
  };
}

test('chuẩn hóa tài khoản theo khu và từ chối dữ liệu ngân hàng không hợp lệ', () => {
  assert.deepEqual(bankAccountInput({
    label: '  Tài khoản   khu A ',
    bankId: 'vcb',
    accountNumber: '0123 456-789',
    ownerName: 'Nguyễn Văn A',
    makeDefault: true
  }), {
    label: 'Tài khoản khu A',
    bankId: 'VCB',
    accountNumber: '0123456789',
    ownerName: 'NGUYỄN VĂN A',
    makeDefault: true
  });
  assert.throws(
    () => bankAccountInput({ label: '', bankId: 'VCB', accountNumber: '1234', ownerName: 'A B' }),
    error => error.code === 'INVALID_RENT_BANK_ACCOUNT_LABEL'
  );
});

test('tài khoản đầu tiên tự thành mặc định và đồng bộ cấu hình VietQR cũ', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('COUNT(*)::int AS account_count')) {
        return { rows: [{ account_count: 0 }] };
      }
      if (sql.includes('INSERT INTO rent_bank_accounts')) {
        return { rows: [accountRow()] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const response = responseRecorder();
  await createRentBankAccount({
    userId: 7,
    actorUserId: 7,
    userEmail: 'owner@example.com',
    headers: {},
    body: {
      label: 'Tài khoản khu A',
      bankId: 'VCB',
      accountNumber: '0123456789',
      ownerName: 'NGUYEN VAN A'
    }
  }, response.res, { getClient: async () => client });

  assert.equal(response.record.statusCode, 201);
  assert.equal(response.record.body.bankAccount.isDefault, true);
  const inserted = calls.find(call => call.sql.includes('INSERT INTO rent_bank_accounts'));
  assert.deepEqual(inserted.params.slice(0, 6), [
    7, 'Tài khoản khu A', 'VCB', '0123456789', 'NGUYEN VAN A', true
  ]);
  const legacy = calls.find(call => call.sql.includes('INSERT INTO settings'));
  assert.deepEqual(legacy.params, [7, 'VCB', '0123456789', 'NGUYEN VAN A']);
  assert.equal(calls.some(call => call.sql === 'COMMIT'), true);
});

test('gán tài khoản cho khu kiểm tra cùng chủ và cho phép kế thừa mặc định', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('SELECT id FROM rent_bank_accounts')) return { rows: [{ id: 12 }] };
      if (sql.includes('UPDATE properties')) {
        return { rows: [{ id: 5, rent_bank_account_id: params[2] }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  let response = responseRecorder();
  await assignPropertyRentBankAccount({
    userId: 7,
    actorUserId: 7,
    userEmail: 'owner@example.com',
    params: { propertyId: '5' },
    headers: {},
    body: { bankAccountId: 12 }
  }, response.res, { getClient: async () => client });
  assert.deepEqual(response.record.body, { propertyId: 5, bankAccountId: 12 });
  const update = calls.find(call => call.sql.includes('UPDATE properties'));
  assert.deepEqual(update.params, [7, 5, 12]);

  response = responseRecorder();
  await assignPropertyRentBankAccount({
    userId: 7,
    actorUserId: 7,
    userEmail: 'owner@example.com',
    params: { propertyId: '5' },
    headers: {},
    body: { bankAccountId: null }
  }, response.res, { getClient: async () => client });
  assert.deepEqual(response.record.body, { propertyId: 5, bankAccountId: null });
});

test('lưu cấu hình mặc định cũ sẽ chuyển mặc định sang tài khoản trùng thay vì lỗi unique', async () => {
  const calls = [];
  const promoted = accountRow({ id: 13, label: 'Khu B', bank_id: 'MB', account_number: '99887766' });
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('bank_id=$2 AND account_number=$3')) return { rows: [promoted] };
    if (sql.includes('WHERE user_id=$1 AND is_default FOR UPDATE')) {
      return { rows: [accountRow()] };
    }
    if (sql.includes('SET owner_name=$3, is_default=true')) {
      return { rows: [{ ...promoted, owner_name: 'TRAN THI B', is_default: true }] };
    }
    return { rows: [] };
  };
  const row = await syncDefaultBankAccountFromSettings(query, 7, {
    bankId: 'MB',
    bankAccount: '99887766',
    bankOwnerName: 'Trần Thị B'
  });
  assert.equal(row.id, 13);
  assert.equal(row.is_default, true);
  assert.equal(calls.some(call => call.sql.includes('SET is_default=false')), true);
});

test('không để form cấu hình cũ xóa rỗng trong khi tài khoản mặc định vẫn tồn tại', async () => {
  const calls = [];
  const current = accountRow();
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('WHERE user_id=$1 AND is_default FOR UPDATE')) {
      return { rows: [current] };
    }
    return { rows: [] };
  };
  const row = await syncDefaultBankAccountFromSettings(query, 7, {
    bankId: '',
    bankAccount: '',
    bankOwnerName: ''
  });
  assert.equal(row.id, 12);
  const restored = calls.find(call => call.sql.includes('INSERT INTO settings'));
  assert.deepEqual(restored.params, [7, 'VCB', '0123456789', 'NGUYEN VAN A']);
});

test('schema, migration, API và UI khóa ownership và hỗ trợ SePay riêng từng tài khoản', () => {
  const root = path.join(__dirname, '..', '..');
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260901_property_bank_accounts.sql'),
    'utf8'
  );
  const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const source of [schema, migration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS rent_bank_accounts/);
    assert.match(source, /UNIQUE \(user_id, bank_id, account_number\)/);
    assert.match(source, /properties_rent_bank_account_owner_fk/);
    assert.match(source, /FOREIGN KEY \(user_id, bank_account_id\)/);
    assert.match(source, /idx_rent_payment_channels_account_provider/);
  }
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;[\s\S]*bank_account_ownership_ready/);
  assert.match(server, /\/api\/rent-bank-accounts/);
  assert.match(api, /assignPropertyRentBankAccount/);
  assert.match(app, /rentBankAccountForRoom/);
  assert.match(
    app,
    /rentBankAccountId:\s*Number\.isSafeInteger\(Number\(property\.rentBankAccountId\)\)[\s\S]*?Number\(property\.rentBankAccountId\)[\s\S]*?: null/
  );
  assert.match(app, /bank_account_mismatch/);
  assert.match(html, /id="property-bank-account-list"/);
  assert.match(html, /id="sepay-bank-account-select"/);
});
