'use strict';

class RentBankSettingsError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RentBankSettingsError';
    this.code = code;
  }
}

function normalizedText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeRentBankSettings(settings = {}, options = {}) {
  const bankId = normalizedText(settings.bankId ?? settings.bank_id).toUpperCase();
  const rawAccount = normalizedText(settings.bankAccount ?? settings.bank_account);
  const ownerName = normalizedText(settings.bankOwnerName ?? settings.bank_owner_name).toUpperCase();
  const accountNumber = rawAccount.replace(/[\s-]/g, '');
  const hasAnyValue = Boolean(bankId || rawAccount || ownerName);

  if (!hasAnyValue && options.allowEmpty !== false) {
    return { bankId: '', accountNumber: '', ownerName: '' };
  }
  if (!/^[A-Z0-9]{2,20}$/.test(bankId)) {
    throw new RentBankSettingsError(
      'INVALID_RENT_BANK_ID',
      'Mã ngân hàng nhận tiền phải có từ 2 đến 20 chữ hoặc số'
    );
  }
  if (!/^[0-9\s-]+$/.test(rawAccount) || !/^[0-9]{4,30}$/.test(accountNumber)) {
    throw new RentBankSettingsError(
      'INVALID_RENT_BANK_ACCOUNT',
      'Số tài khoản nhận tiền phải có từ 4 đến 30 chữ số'
    );
  }
  if (ownerName.length < 2 || ownerName.length > 100 || /[\u0000-\u001f\u007f]/.test(ownerName)) {
    throw new RentBankSettingsError(
      'INVALID_RENT_BANK_OWNER',
      'Tên chủ tài khoản nhận tiền phải có từ 2 đến 100 ký tự'
    );
  }
  return { bankId, accountNumber, ownerName };
}

module.exports = {
  RentBankSettingsError,
  normalizeRentBankSettings
};
