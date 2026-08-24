'use strict';

const db = require('./db');

function planJson(row) {
  return {
    code: row.code,
    name: row.name,
    description: row.description || '',
    monthlyPriceVnd: row.monthly_price_vnd === null ? null : Number(row.monthly_price_vnd),
    yearlyPriceVnd: row.yearly_price_vnd === null ? null : Number(row.yearly_price_vnd),
    roomLimit: Number(row.room_limit),
    staffLimit: Number(row.staff_limit),
    trialDays: Number(row.trial_days) || 0,
    isActive: !!row.is_active,
    isPublic: !!row.is_public
  };
}

const PLAN_COLUMNS = `code, name, description, monthly_price_vnd, yearly_price_vnd,
  room_limit, staff_limit, trial_days, is_active, is_public, sort_order`;

async function listPublicPlans(req, res) {
  const { rows } = await db.query(
    `SELECT ${PLAN_COLUMNS}
     FROM plans
     WHERE is_active=true AND is_public=true
     ORDER BY sort_order, id`
  );
  return res.json({ plans: rows.map(planJson) });
}

async function listAdminPlans(req, res) {
  const { rows } = await db.query(
    `SELECT ${PLAN_COLUMNS} FROM plans ORDER BY sort_order, id`
  );
  return res.json({ plans: rows.map(planJson) });
}

function price(value, fieldName) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > 999999999999) {
    const error = new Error(`${fieldName} không hợp lệ`);
    error.code = 'INVALID_PLAN_PRICE';
    throw error;
  }
  return parsed;
}

async function updatePlan(req, res) {
  const code = String(req.params.code || '').trim().toLowerCase();
  const reason = String(req.body?.reason || '').trim();
  let monthlyPrice;
  let yearlyPrice;
  try {
    monthlyPrice = price(req.body?.monthlyPriceVnd, 'Giá tháng');
    yearlyPrice = price(req.body?.yearlyPriceVnd, 'Giá năm');
  } catch (error) {
    return res.status(400).json({ error: error.message, code: error.code });
  }
  const isActive = req.body?.isActive === true;
  const isPublic = req.body?.isPublic === true;
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(code)) {
    return res.status(400).json({ error: 'Mã gói không hợp lệ', code: 'INVALID_PLAN_CODE' });
  }
  if (code === 'free') {
    return res.status(409).json({
      error: 'Gói Free là gói nền tảng và không thể mở bán hoặc thay đổi giá',
      code: 'FREE_PLAN_LOCKED'
    });
  }
  if (reason.length < 10 || reason.length > 500) {
    return res.status(400).json({
      error: 'Lý do thay đổi gói phải từ 10 đến 500 ký tự',
      code: 'INVALID_REASON'
    });
  }
  if ((isActive || isPublic)
      && (!(monthlyPrice > 0) || !(yearlyPrice > 0))) {
    return res.status(400).json({
      error: 'Gói mở bán phải có giá tháng và giá năm lớn hơn 0',
      code: 'PLAN_PRICE_REQUIRED'
    });
  }
  if (isPublic && !isActive) {
    return res.status(400).json({
      error: 'Gói công khai phải được kích hoạt trước',
      code: 'PUBLIC_PLAN_MUST_BE_ACTIVE'
    });
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const currentResult = await client.query(
      `SELECT ${PLAN_COLUMNS} FROM plans WHERE code=$1 FOR UPDATE`,
      [code]
    );
    const current = currentResult.rows[0];
    if (!current) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Không tìm thấy gói', code: 'PLAN_NOT_FOUND' });
    }
    const updatedResult = await client.query(
      `UPDATE plans
       SET monthly_price_vnd=$2, yearly_price_vnd=$3,
           is_active=$4, is_public=$5, updated_at=now()
       WHERE code=$1
       RETURNING ${PLAN_COLUMNS}`,
      [code, monthlyPrice, yearlyPrice, isActive, isPublic]
    );
    await client.query(
      `INSERT INTO subscription_change_logs
         (actor_user_id, actor_email_snapshot, action, previous_plan_code,
          new_plan_code, reason, metadata)
       VALUES ($1,$2,'plan_updated',$3,$3,$4,$5::jsonb)`,
      [
        req.userId,
        String(req.userEmail || ''),
        code,
        reason,
        JSON.stringify({
          previous: planJson(current),
          next: planJson(updatedResult.rows[0])
        })
      ]
    );
    await client.query('COMMIT');
    return res.json({ plan: planJson(updatedResult.rows[0]), audited: true });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { listAdminPlans, listPublicPlans, planJson, updatePlan };
