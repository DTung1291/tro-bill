'use strict';

const db = require('./db');

function receiptCode(id) {
  return `TB-RCPT-${String(Number(id)).padStart(8, '0')}`;
}

function paymentJson(row) {
  return {
    id: Number(row.id),
    receiptCode: row.status === 'paid' ? receiptCode(row.id) : null,
    orderReference: row.provider_reference || '',
    transferContent: row.transfer_content || '',
    planCode: row.plan_code,
    planName: row.plan_name,
    action: row.subscription_action,
    billingCycle: row.billing_cycle,
    amountVnd: Number(row.amount_vnd),
    currency: row.currency,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    paidAt: row.paid_at
  };
}

async function listSubscriptionPayments(req, res) {
  const rawLimit = Number(req.query?.limit || 30);
  const limit = Number.isInteger(rawLimit) ? Math.min(100, Math.max(1, rawLimit)) : 30;
  const { rows } = await db.query(
    `SELECT sp.id, sp.provider_reference, sp.transfer_content, sp.subscription_action,
            sp.billing_cycle, sp.amount_vnd, sp.currency, sp.status,
            sp.created_at, sp.expires_at, sp.paid_at,
            p.code AS plan_code, p.name AS plan_name
     FROM subscription_payments sp
     JOIN plans p ON p.id=sp.plan_id
     WHERE sp.user_id=$1
     ORDER BY sp.created_at DESC, sp.id DESC
     LIMIT $2`,
    [req.userId, limit]
  );
  return res.json({ payments: rows.map(paymentJson) });
}

async function getSubscriptionReceipt(req, res) {
  const paymentId = Number(req.params.id);
  if (!Number.isInteger(paymentId) || paymentId <= 0) {
    return res.status(400).json({ error: 'Mã payment không hợp lệ', code: 'INVALID_PAYMENT_ID' });
  }
  const { rows } = await db.query(
    `SELECT sp.id, sp.provider_reference, sp.transfer_content, sp.subscription_action,
            sp.billing_cycle, sp.amount_vnd, sp.currency, sp.status,
            sp.created_at, sp.paid_at, sp.settlement_provider, sp.settlement_reference,
            sp.bank_id_snapshot, sp.bank_account_snapshot, sp.bank_owner_snapshot,
            p.code AS plan_code, p.name AS plan_name,
            u.email AS customer_email
     FROM subscription_payments sp
     JOIN plans p ON p.id=sp.plan_id
     JOIN users u ON u.id=sp.user_id
     WHERE sp.id=$1 AND sp.user_id=$2
     LIMIT 1`,
    [paymentId, req.userId]
  );
  const payment = rows[0];
  if (!payment) {
    return res.status(404).json({ error: 'Không tìm thấy payment', code: 'PAYMENT_NOT_FOUND' });
  }
  if (payment.status !== 'paid') {
    return res.status(409).json({
      error: 'Biên nhận chỉ có sau khi thanh toán được xác nhận',
      code: 'PAYMENT_RECEIPT_NOT_READY'
    });
  }
  return res.json({
    receipt: {
      code: receiptCode(payment.id),
      issuedAt: payment.paid_at,
      customerEmail: payment.customer_email,
      orderReference: payment.provider_reference || '',
      transferContent: payment.transfer_content || '',
      plan: { code: payment.plan_code, name: payment.plan_name },
      action: payment.subscription_action,
      billingCycle: payment.billing_cycle,
      amountVnd: Number(payment.amount_vnd),
      currency: payment.currency,
      paidAt: payment.paid_at,
      settlement: {
        provider: payment.settlement_provider || '',
        reference: payment.settlement_reference || ''
      },
      receiver: {
        bankId: payment.bank_id_snapshot || '',
        account: payment.bank_account_snapshot || '',
        ownerName: payment.bank_owner_snapshot || ''
      }
    }
  });
}

module.exports = {
  getSubscriptionReceipt,
  listSubscriptionPayments,
  paymentJson,
  receiptCode
};
