'use strict';

// ============================================================
//  Cấu hình toàn cục của app (bảng app_config, 1 dòng id=1).
//  Thông tin ủng hộ nhà phát triển do admin thiết lập, dùng chung.
// ============================================================
const db = require('./db');

async function readConfig(options = {}) {
  const { rows } = await db.query('SELECT * FROM app_config WHERE id=1');
  const c = rows[0] || {};
  const config = {
    donateBankId: c.donate_bank_id || '',
    donateAccount: c.donate_account || '',
    donateOwnerName: c.donate_owner_name || '',
    donateMessage: c.donate_message || 'Ung ho'
  };
  if (options.includeSubscriptionPayment) {
    config.subscriptionBankId = c.subscription_bank_id || '';
    config.subscriptionAccount = c.subscription_account || '';
    config.subscriptionOwnerName = c.subscription_owner_name || '';
  }
  return config;
}

// GET /api/config — công khai cho mọi user đã đăng nhập (chỉ đọc)
async function getConfig(req, res) {
  res.json(await readConfig());
}

async function getAdminConfig(req, res) {
  res.json(await readConfig({ includeSubscriptionPayment: true }));
}

// PUT /api/admin/config — chỉ admin
async function setConfig(req, res) {
  const b = req.body || {};
  await db.query(
    `INSERT INTO app_config (id, donate_bank_id, donate_account, donate_owner_name, donate_message)
     VALUES (1,$1,$2,$3,$4)
     ON CONFLICT (id) DO UPDATE SET
       donate_bank_id=$1, donate_account=$2, donate_owner_name=$3, donate_message=$4`,
    [
      String(b.donateBankId || '').trim().toUpperCase(),
      String(b.donateAccount || '').trim(),
      String(b.donateOwnerName || '').trim(),
      String(b.donateMessage || 'Ung ho').trim() || 'Ung ho'
    ]
  );
  res.json(await readConfig());
}

async function setSubscriptionPaymentConfig(req, res) {
  const bankId = String(req.body?.bankId || '').trim().toUpperCase();
  const account = String(req.body?.account || '').trim().toUpperCase();
  const ownerName = String(req.body?.ownerName || '').trim().toUpperCase();
  const configured = !!(bankId || account || ownerName);

  if (configured && (!bankId || !account || !ownerName)) {
    return res.status(400).json({
      error: 'Phải nhập đủ ngân hàng, số tài khoản và tên chủ tài khoản',
      code: 'SUBSCRIPTION_BANK_CONFIG_INCOMPLETE'
    });
  }
  if (bankId && !/^[A-Z0-9]{2,20}$/.test(bankId)) {
    return res.status(400).json({ error: 'Mã ngân hàng không hợp lệ', code: 'INVALID_BANK_ID' });
  }
  if (account && !/^[A-Z0-9]{4,30}$/.test(account)) {
    return res.status(400).json({ error: 'Số tài khoản không hợp lệ', code: 'INVALID_BANK_ACCOUNT' });
  }
  if (ownerName.length > 100) {
    return res.status(400).json({ error: 'Tên chủ tài khoản quá dài', code: 'INVALID_BANK_OWNER' });
  }

  await db.query(
    `INSERT INTO app_config
       (id, subscription_bank_id, subscription_account, subscription_owner_name)
     VALUES (1,$1,$2,$3)
     ON CONFLICT (id) DO UPDATE SET
       subscription_bank_id=$1, subscription_account=$2, subscription_owner_name=$3`,
    [bankId, account, ownerName]
  );
  return res.json(await readConfig({ includeSubscriptionPayment: true }));
}

module.exports = {
  getAdminConfig,
  getConfig,
  setConfig,
  setSubscriptionPaymentConfig,
  readConfig
};
