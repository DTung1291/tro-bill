'use strict';

const db = require('./db');

const SETTLEMENT_PROVIDER = 'bank_transfer';
const PAYMENT_STATUSES = new Set(['pending', 'paid', 'failed', 'refunded', 'canceled']);
const PAYMENT_ACTIONS = new Set(['upgrade', 'renew']);

class AdminPaymentError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'AdminPaymentError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function manualConfirmationInput(req, now = new Date()) {
  const paymentId = Number(req.params?.id);
  const transactionReference = String(req.body?.transactionReference || '').trim();
  const paidAtText = String(req.body?.paidAt || '').trim();
  const reason = String(req.body?.reason || '').trim();
  const paidAtDate = new Date(paidAtText);

  if (!Number.isInteger(paymentId) || paymentId <= 0) {
    throw new AdminPaymentError(400, 'INVALID_PAYMENT_ID', 'Mã payment không hợp lệ');
  }
  if (!/^[A-Za-z0-9._:/-]{3,100}$/.test(transactionReference)) {
    throw new AdminPaymentError(
      400,
      'INVALID_TRANSACTION_REFERENCE',
      'Mã giao dịch ngân hàng phải từ 3 đến 100 ký tự và không chứa khoảng trắng'
    );
  }
  if (!paidAtText || Number.isNaN(paidAtDate.getTime())
      || paidAtDate.getTime() > now.getTime() + 5 * 60 * 1000) {
    throw new AdminPaymentError(
      400,
      'INVALID_PAID_AT',
      'Thời điểm nhận tiền không hợp lệ hoặc nằm trong tương lai'
    );
  }
  if (reason.length < 10 || reason.length > 500) {
    throw new AdminPaymentError(
      400,
      'INVALID_REASON',
      'Lý do xác nhận phải từ 10 đến 500 ký tự'
    );
  }
  return {
    paymentId,
    transactionReference,
    paidAt: paidAtDate.toISOString(),
    reason
  };
}

function sendAdminPaymentError(res, error) {
  if (!(error instanceof AdminPaymentError)) return false;
  res.status(error.statusCode).json({ error: error.message, code: error.code });
  return true;
}

function maskedAccount(value) {
  const account = String(value || '').trim();
  if (!account) return '';
  if (account.length <= 4) return account;
  return `${'•'.repeat(Math.min(6, account.length - 4))}${account.slice(-4)}`;
}

function adminPaymentJson(row) {
  const confirmationActorId = row.confirmation_actor_user_id === null
    || row.confirmation_actor_user_id === undefined
    ? null
    : Number(row.confirmation_actor_user_id);
  return {
    id: Number(row.id),
    user: {
      id: Number(row.user_id),
      email: row.user_email
    },
    plan: {
      code: row.plan_code,
      name: row.plan_name
    },
    orderReference: row.provider_reference || '',
    transferContent: row.transfer_content || '',
    action: row.subscription_action,
    billingCycle: row.billing_cycle,
    amountVnd: Number(row.amount_vnd),
    currency: row.currency,
    status: row.status,
    receiver: {
      bankId: row.bank_id_snapshot || '',
      accountMasked: maskedAccount(row.bank_account_snapshot)
    },
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    paidAt: row.paid_at,
    settlement: row.settlement_reference ? {
      provider: row.settlement_provider || '',
      reference: row.settlement_reference
    } : null,
    confirmation: row.confirmation_created_at ? {
      method: confirmationActorId === null ? 'automatic' : 'manual_admin',
      actorUserId: confirmationActorId,
      actorEmail: confirmationActorId === null ? '' : row.confirmation_actor_email,
      reason: confirmationActorId === null ? '' : row.confirmation_reason,
      createdAt: row.confirmation_created_at
    } : null
  };
}

async function listAdminSubscriptionPayments(req, res) {
  const status = String(req.query?.status || 'pending').trim().toLowerCase();
  if (status !== 'all' && !PAYMENT_STATUSES.has(status)) {
    return res.status(400).json({
      error: 'Trạng thái payment không hợp lệ',
      code: 'INVALID_PAYMENT_STATUS'
    });
  }
  const requestedLimit = Number(req.query?.limit || 100);
  const limit = Number.isInteger(requestedLimit)
    ? Math.min(200, Math.max(1, requestedLimit))
    : 100;
  const { rows } = await db.query(
    `SELECT sp.id, sp.user_id, sp.amount_vnd, sp.currency, sp.billing_cycle,
            sp.status, sp.provider_reference, sp.subscription_action,
            sp.transfer_content, sp.bank_id_snapshot, sp.bank_account_snapshot,
            sp.settlement_provider, sp.settlement_reference, sp.expires_at,
            sp.paid_at, sp.created_at, u.email AS user_email,
            p.code AS plan_code, p.name AS plan_name,
            confirmation.actor_user_id AS confirmation_actor_user_id,
            confirmation.actor_email_snapshot AS confirmation_actor_email,
            confirmation.reason AS confirmation_reason,
            confirmation.created_at AS confirmation_created_at
     FROM subscription_payments sp
     JOIN users u ON u.id=sp.user_id
     JOIN plans p ON p.id=sp.plan_id
     LEFT JOIN LATERAL (
       SELECT log.actor_user_id, log.actor_email_snapshot, log.reason, log.created_at
       FROM subscription_change_logs log
       WHERE log.target_user_id=sp.user_id
         AND log.action IN ('subscription_upgraded_by_payment', 'subscription_renewed_by_payment')
         AND log.metadata->>'paymentId'=sp.id::text
       ORDER BY log.created_at DESC, log.id DESC
       LIMIT 1
     ) confirmation ON true
     WHERE ($1::text='all' OR sp.status=$1)
     ORDER BY CASE WHEN sp.status='pending' THEN 0 ELSE 1 END,
              sp.created_at DESC, sp.id DESC
     LIMIT $2`,
    [status, limit]
  );
  res.set('Cache-Control', 'no-store');
  return res.json({ payments: rows.map(adminPaymentJson) });
}

function subscriptionChanged(payment) {
  if (!PAYMENT_ACTIONS.has(payment.subscription_action)) return true;
  if (payment.subscription_action === 'renew') {
    return Number(payment.current_plan_id) !== Number(payment.plan_id);
  }
  return Number(payment.current_plan_id) === Number(payment.plan_id)
    || Number(payment.plan_room_limit) < Number(payment.current_room_limit);
}

function confirmationResponse(payment, subscription, input, duplicate = false) {
  return {
    ok: true,
    duplicate,
    payment: {
      id: Number(payment.payment_id),
      status: 'paid',
      paidAt: duplicate && payment.paid_at ? payment.paid_at : input.paidAt,
      settlementProvider: SETTLEMENT_PROVIDER,
      settlementReference: input.transactionReference
    },
    subscription: subscription ? {
      id: Number(subscription.id),
      planCode: payment.plan_code,
      status: subscription.status,
      billingCycle: subscription.billing_cycle,
      startsAt: subscription.starts_at,
      endsAt: subscription.ends_at
    } : null
  };
}

async function confirmSubscriptionPaymentManually(req, res) {
  let input;
  try {
    input = manualConfirmationInput(req);
  } catch (error) {
    if (sendAdminPaymentError(res, error)) return res;
    throw error;
  }
  res.set('Cache-Control', 'no-store');

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const paymentResult = await client.query(
      `SELECT sp.id AS payment_id, sp.user_id, sp.subscription_id, sp.plan_id,
              sp.amount_vnd, sp.billing_cycle, sp.status AS payment_status,
              sp.subscription_action, sp.created_at AS payment_created_at,
              sp.expires_at, sp.paid_at, sp.settlement_provider, sp.settlement_reference,
              p.code AS plan_code, p.name AS plan_name, p.room_limit AS plan_room_limit,
              s.status AS subscription_status, s.plan_id AS current_plan_id,
              s.billing_cycle AS current_billing_cycle, s.starts_at AS current_starts_at,
              s.ends_at AS current_ends_at,
              cp.code AS current_plan_code, cp.room_limit AS current_room_limit,
              u.email AS user_email
       FROM subscription_payments sp
       JOIN plans p ON p.id=sp.plan_id
       JOIN subscriptions s ON s.id=sp.subscription_id AND s.user_id=sp.user_id
       JOIN plans cp ON cp.id=s.plan_id
       JOIN users u ON u.id=sp.user_id
       WHERE sp.id=$1
       LIMIT 1
       FOR UPDATE OF sp, s`,
      [input.paymentId]
    );
    const payment = paymentResult.rows[0];
    if (!payment) {
      throw new AdminPaymentError(404, 'PAYMENT_NOT_FOUND', 'Không tìm thấy payment');
    }

    if (payment.payment_status === 'paid'
        && payment.settlement_provider === SETTLEMENT_PROVIDER
        && payment.settlement_reference === input.transactionReference) {
      await client.query('COMMIT');
      return res.json(confirmationResponse(payment, {
        id: payment.subscription_id,
        status: payment.subscription_status,
        billing_cycle: payment.current_billing_cycle,
        starts_at: payment.current_starts_at,
        ends_at: payment.current_ends_at
      }, input, true));
    }
    if (payment.payment_status !== 'pending') {
      throw new AdminPaymentError(
        409,
        'PAYMENT_NOT_PENDING',
        'Chỉ đơn đang chờ thanh toán mới được xác nhận thủ công'
      );
    }

    const transactionResult = await client.query(
      `SELECT id
       FROM subscription_payments
       WHERE settlement_provider=$1 AND settlement_reference=$2
       LIMIT 1
       FOR UPDATE`,
      [SETTLEMENT_PROVIDER, input.transactionReference]
    );
    if (transactionResult.rows[0]) {
      throw new AdminPaymentError(
        409,
        'TRANSACTION_ALREADY_USED',
        'Mã giao dịch ngân hàng đã được dùng cho payment khác'
      );
    }

    const paidAtMs = new Date(input.paidAt).getTime();
    if (payment.payment_created_at
        && paidAtMs < new Date(payment.payment_created_at).getTime() - 5 * 60 * 1000) {
      throw new AdminPaymentError(
        409,
        'PAYMENT_BEFORE_ORDER',
        'Giao dịch xảy ra trước khi đơn được tạo'
      );
    }
    if (payment.expires_at && paidAtMs >= new Date(payment.expires_at).getTime()) {
      throw new AdminPaymentError(
        409,
        'PAYMENT_ORDER_EXPIRED',
        'Giao dịch xảy ra sau khi đơn hết hạn; cần xử lý đối soát hoặc hoàn tiền'
      );
    }
    if (subscriptionChanged(payment)) {
      throw new AdminPaymentError(
        409,
        'SUBSCRIPTION_CHANGED',
        'Gói hiện tại đã thay đổi sau khi tạo đơn; không thể tự động áp dụng đơn cũ'
      );
    }

    const paidResult = await client.query(
      `UPDATE subscription_payments
       SET status='paid', paid_at=$2, settlement_provider=$3,
           settlement_reference=$4, updated_at=now()
       WHERE id=$1 AND status='pending'
       RETURNING id`,
      [
        payment.payment_id,
        input.paidAt,
        SETTLEMENT_PROVIDER,
        input.transactionReference
      ]
    );
    if (!paidResult.rows[0]) {
      throw new AdminPaymentError(
        409,
        'PAYMENT_NOT_PENDING',
        'Payment đã được xử lý bởi một yêu cầu khác'
      );
    }

    const updatedSubscription = await client.query(
      `UPDATE subscriptions
       SET plan_id=$2, status='active', billing_cycle=$3,
           starts_at=CASE
             WHEN $4='upgrade' OR ends_at IS NULL OR ends_at <= $5::timestamptz THEN $5::timestamptz
             ELSE starts_at
           END,
           ends_at=(CASE
             WHEN ends_at IS NOT NULL AND ends_at > $5::timestamptz THEN ends_at
             ELSE $5::timestamptz
           END) + CASE
             WHEN $3='monthly' THEN interval '1 month'
             ELSE interval '1 year'
           END,
           updated_at=now()
       WHERE id=$1 AND user_id=$6
       RETURNING id, status, billing_cycle, starts_at, ends_at`,
      [
        payment.subscription_id,
        payment.plan_id,
        payment.billing_cycle,
        payment.subscription_action,
        input.paidAt,
        payment.user_id
      ]
    );
    const subscription = updatedSubscription.rows[0];
    if (!subscription) {
      throw new Error('Subscription payment ownership changed during manual confirmation');
    }

    const action = payment.subscription_action === 'upgrade'
      ? 'subscription_upgraded_by_payment'
      : 'subscription_renewed_by_payment';
    await client.query(
      `INSERT INTO subscription_change_logs
         (actor_user_id, actor_email_snapshot, target_user_id, target_email_snapshot,
          action, previous_plan_code, new_plan_code, previous_status, new_status,
          reason, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'active',$9,$10::jsonb)`,
      [
        req.userId,
        String(req.userEmail || ''),
        payment.user_id,
        payment.user_email,
        action,
        payment.current_plan_code,
        payment.plan_code,
        payment.subscription_status,
        input.reason,
        JSON.stringify({
          paymentId: Number(payment.payment_id),
          transactionId: input.transactionReference,
          amountVnd: Number(payment.amount_vnd),
          billingCycle: payment.billing_cycle,
          confirmationMethod: 'manual_admin'
        })
      ]
    );

    await client.query('COMMIT');
    return res.json(confirmationResponse(payment, subscription, input));
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (error?.code === '23505'
        && error?.constraint === 'idx_subscription_payments_settlement_reference') {
      return res.status(409).json({
        error: 'Mã giao dịch ngân hàng đã được dùng cho payment khác',
        code: 'TRANSACTION_ALREADY_USED'
      });
    }
    if (sendAdminPaymentError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  AdminPaymentError,
  SETTLEMENT_PROVIDER,
  adminPaymentJson,
  confirmSubscriptionPaymentManually,
  listAdminSubscriptionPayments,
  manualConfirmationInput,
  maskedAccount,
  subscriptionChanged
};
