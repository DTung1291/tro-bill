'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  RentBankSettingsError,
  normalizeRentBankSettings
} = require('../rent-bank-settings');

test('chuẩn hóa tài khoản nhận tiền trực tiếp của chủ trọ', () => {
  assert.deepEqual(normalizeRentBankSettings({
    bankId: ' vcb ',
    bankAccount: '0123 456-789',
    bankOwnerName: '  nguyen   van a '
  }), {
    bankId: 'VCB',
    accountNumber: '0123456789',
    ownerName: 'NGUYEN VAN A'
  });
  assert.deepEqual(normalizeRentBankSettings({}), {
    bankId: '', accountNumber: '', ownerName: ''
  });
});

test('không nhận cấu hình VietQR thiếu hoặc sai tài khoản', () => {
  assert.throws(
    () => normalizeRentBankSettings({ bankId: 'VCB', bankAccount: '123456' }),
    (error) => error instanceof RentBankSettingsError
      && error.code === 'INVALID_RENT_BANK_OWNER'
  );
  assert.throws(
    () => normalizeRentBankSettings({
      bankId: 'VCB', bankAccount: 'ABC123', bankOwnerName: 'NGUYEN VAN A'
    }),
    (error) => error.code === 'INVALID_RENT_BANK_ACCOUNT'
  );
});

test('server ràng buộc webhook với settings và UI công khai cơ chế không giữ hộ tiền', () => {
  const root = path.join(__dirname, '..', '..');
  const stateSource = fs.readFileSync(path.join(root, 'server', 'state.js'), 'utf8');
  const channelSource = fs.readFileSync(path.join(root, 'server', 'rent-payment-channels.js'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const styleSource = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(stateSource, /normalizeRentBankSettings\(settings\)/);
  assert.match(channelSource, /SELECT bank_id, bank_account, bank_owner_name[\s\S]*FROM settings/);
  assert.match(channelSource, /settlementMode: 'direct_to_landlord'/);
  assert.match(channelSource, /supplied !== settings\.accountNumber/);
  assert.match(htmlSource, /Tiền thuê chuyển thẳng vào tài khoản của bạn/);
  assert.match(htmlSource, /TrọBill chỉ nhận thông báo giao dịch để đối soát/);
  assert.match(htmlSource, /style\.css\?v=89[\s\S]*api\.js\?v=89[\s\S]*app\.js\?v=89/);
  assert.match(appSource, /function rentBankRecipientText/);
  assert.match(appSource, /Tiền vào thẳng tài khoản chủ trọ; TrọBill không giữ hộ tiền thuê/);
  assert.match(styleSource, /\.bill-preview-direct-settlement/);
});
