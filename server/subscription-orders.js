'use strict';

const crypto = require('crypto');
const db = require('./db');

class OrderError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'OrderError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function orderRequest(req) {
  const planCode = String(req.body?.planCode || '').trim().toLowerCase();
  const billingCycle = String(req.body?.billingCycle || '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{1,31}$/.test(planCode) || planCode === 'free') {
    throw new OrderError(400, 'INVALID_PLAN_CODE', 'Gói thanh toán không hợp lệ');
  }
  if (!['monthly', 'yearly'].includes(billingCycle)) {
    throw new OrderError(400, 'INVALID_BILLING_CYCLE', 'Chu kỳ phải là tháng hoặc năm');
  }
  return { planCode, billingCycle };
}

function vietQrUrl(payment) {
  return `https://img.vietqr.io/image/${encodeURIComponent(payment.bank_id_snapshot)}`
    + `-${encodeURIComponent(payment.bank_account_snapshot)}-compact2.png`
    + `?amount=${encodeURIComponent(payment.amount_vnd)}`
    + `&addInfo=${encodeURIComponent(payment.transfer_content)}`
    + `&accountName=${encodeURIComponent(payment.bank_owner_snapshot)}`;
}

function orderJson(payment, plan, reused = false) {
  return {
    reused,
    order: {
      id: Number(payment.id),
      reference: payment.provider_reference,
      planCode: plan.code,
      planName: plan.name,
      action: payment.subscription_action,
      billingCycle: payment.billing_cycle,
      amountVnd: Number(payment.amount_vnd),
      status: payment.status,
      expiresAt: payment.expires_at
    },
    vietQr: {
      bankId: payment.bank_id_snapshot,
      account: payment.bank_account_snapshot,
      ownerName: payment.bank_owner_snapshot,
      transferContent: payment.transfer_content,
      imageUrl: vietQrUrl(payment)
    }
  };
}

function sendOrderError(res, error) {
  if (!(error instanceof OrderError)) return false;
  res.status(error.statusCode).json({ error: error.message, code: error.code });
  return true;
}

async function createSubscriptionOrder(req, res) {
  let input;
  try {
    input = orderRequest(req);
  } catch (error) {
    if (sendOrderError(res, error)) return res;
    throw error;
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const currentResult = await client.query(
      `SELECT s.id AS subscription_id, p.code AS plan_code, p.room_limit
       FROM subscriptions s
       JOIN plans p ON p.id=s.plan_id
       WHERE s.user_id=$1
       FOR UPDATE OF s`,
      [req.userId]
    );
    const current = currentResult.rows[0];
    if (!current) throw new OrderError(409, 'SUBSCRIPTION_REQUIRED', 'Tài khoản chưa có gói hiện tại');

    const planResult = await client.query(
      `SELECT id, code, name, room_limit, monthly_price_vnd, yearly_price_vnd
       FROM plans
       WHERE code=$1 AND is_active=true AND is_public=true
       FOR SHARE`,
      [input.planCode]
    );
    const plan = planResult.rows[0];
    if (!plan) throw new OrderError(404, 'PLAN_NOT_FOR_SALE', 'Gói này chưa được mở bán');

    const action = current.plan_code === plan.code ? 'renew' : 'upgrade';
    if (action === 'upgrade' && Number(plan.room_limit) < Number(current.room_limit)) {
      throw new OrderError(409, 'PLAN_NOT_UPGRADE', 'Gói mới có giới hạn phòng thấp hơn gói hiện tại');
    }
    const amount = Number(input.billingCycle === 'monthly'
      ? plan.monthly_price_vnd
      : plan.yearly_price_vnd);
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new OrderError(409, 'PLAN_PRICE_MISSING', 'Gói chưa có giá cho chu kỳ này');
    }

    const configResult = await client.query(
      `SELECT subscription_bank_id, subscription_account, subscription_owner_name
       FROM app_config WHERE id=1`
    );
    const config = configResult.rows[0] || {};
    if (!config.subscription_bank_id || !config.subscription_account
        || !config.subscription_owner_name) {
      throw new OrderError(
        503,
        'SUBSCRIPTION_PAYMENT_NOT_CONFIGURED',
        'Kênh thanh toán gói chưa được cấu hình'
      );
    }

    await client.query(
      `UPDATE subscription_payments
       SET status='canceled', updated_at=now()
       WHERE user_id=$1 AND status='pending' AND expires_at <= now()`,
      [req.userId]
    );
    const existingResult = await client.query(
      `SELECT * FROM subscription_payments
       WHERE user_id=$1 AND plan_id=$2 AND billing_cycle=$3
         AND subscription_action=$4 AND status='pending' AND expires_at > now()
       ORDER BY created_at DESC LIMIT 1
       FOR UPDATE`,
      [req.userId, plan.id, input.billingCycle, action]
    );
    if (existingResult.rows[0]) {
      await client.query('COMMIT');
      return res.json(orderJson(existingResult.rows[0], plan, true));
    }

    const transferContent = `TB${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    const insertedResult = await client.query(
      `INSERT INTO subscription_payments
         (user_id, subscription_id, plan_id, amount_vnd, billing_cycle, status,
          provider, provider_reference, subscription_action, transfer_content,
          bank_id_snapshot, bank_account_snapshot, bank_owner_snapshot, expires_at)
       VALUES ($1,$2,$3,$4,$5,'pending','vietqr',$6,$7,$6,$8,$9,$10,
               now() + interval '24 hours')
       RETURNING *`,
      [
        req.userId,
        current.subscription_id,
        plan.id,
        amount,
        input.billingCycle,
        transferContent,
        action,
        config.subscription_bank_id,
        config.subscription_account,
        config.subscription_owner_name
      ]
    );
    await client.query('COMMIT');
    return res.status(201).json(orderJson(insertedResult.rows[0], plan, false));
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendOrderError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

module.exports = { createSubscriptionOrder, orderJson, orderRequest, vietQrUrl };
