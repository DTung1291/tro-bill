'use strict';

// ============================================================
//  Cấu hình toàn cục của app (bảng app_config, 1 dòng id=1).
//  Thông tin ủng hộ nhà phát triển do admin thiết lập, dùng chung.
// ============================================================
const db = require('./db');

async function readConfig() {
  const { rows } = await db.query('SELECT * FROM app_config WHERE id=1');
  const c = rows[0] || {};
  return {
    donateBankId: c.donate_bank_id || '',
    donateAccount: c.donate_account || '',
    donateOwnerName: c.donate_owner_name || '',
    donateMessage: c.donate_message || 'Ung ho'
  };
}

// GET /api/config — công khai cho mọi user đã đăng nhập (chỉ đọc)
async function getConfig(req, res) {
  res.json(await readConfig());
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

module.exports = { getConfig, setConfig, readConfig };
