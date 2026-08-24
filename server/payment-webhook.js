'use strict';

const crypto = require('crypto');
const db = require('./db');

const WEBHOOK_PROVIDER = 'bank_transfer';
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;
const TRANSFER_CODE_PATTERN = /\bTB[A-F0-9]{12}\b/;

class PaymentWebhookError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'PaymentWebhookError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function header(req, name) {
  return String(req.get?.(name) || '').trim();
}

function verifyPaymentWebhook(req, secret, nowMs = Date.now()) {
  if (String(secret || '').length < 32) {
    throw new PaymentWebhookError(
      503,
      'PAYMENT_WEBHOOK_NOT_CONFIGURED',
      'Webhook thanh toán chưa được cấu hình'
    );
  }
  if (!Buffer.isBuffer(req.rawBody) || req.rawBody.length === 0) {
    throw new PaymentWebhookError(400, 'WEBHOOK_BODY_REQUIRED', 'Thiếu nội dung webhook');
  }
  if (req.rawBody.length > 64 * 1024) {
    throw new PaymentWebhookError(413, 'WEBHOOK_BODY_TOO_LARGE', 'Nội dung webhook quá lớn');
  }

  const eventId = header(req, 'x-payment-event-id');
  const timestampText = header(req, 'x-payment-timestamp');
  const signatureText = header(req, 'x-payment-signature');
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(eventId)) {
    throw new PaymentWebhookError(400, 'INVALID_WEBHOOK_EVENT_ID', 'Event ID không hợp lệ');
  }
  if (!/^\d{10}$/.test(timestampText)) {
    throw new PaymentWebhookError(401, 'INVALID_WEBHOOK_TIMESTAMP', 'Timestamp webhook không hợp lệ');
  }
  const timestamp = Number(timestampText);
  const nowSeconds = Math.floor(nowMs / 1000);
  if (Math.abs(nowSeconds - timestamp) > SIGNATURE_TOLERANCE_SECONDS) {
    throw new PaymentWebhookError(401, 'WEBHOOK_TIMESTAMP_EXPIRED', 'Webhook đã quá thời hạn xác minh');
  }
  const signatureMatch = /^v1=([a-f0-9]{64})$/.exec(signatureText);
  if (!signatureMatch) {
    throw new PaymentWebhookError(401, 'INVALID_WEBHOOK_SIGNATURE', 'Chữ ký webhook không hợp lệ');
  }

  const signedPayload = Buffer.concat([
    Buffer.from(`${timestampText}.`, 'utf8'),
    req.rawBody
  ]);
  const expected = crypto.createHmac('sha256', secret).update(signedPayload).digest();
  const supplied = Buffer.from(signatureMatch[1], 'hex');
  if (expected.length !== supplied.length || !crypto.timingSafeEqual(expected, supplied)) {
    throw new PaymentWebhookError(401, 'INVALID_WEBHOOK_SIGNATURE', 'Chữ ký webhook không hợp lệ');
  }
  return { eventId, timestamp };
}

function webhookInput(req, verified, nowMs = Date.now()) {
  const body = req.body || {};
  const eventType = String(body.type || '').trim();
  const transactionId = String(body.transactionId || '').trim();
  const bankAccount = String(body.bankAccount || '').trim().toUpperCase();
  const paidAtValue = typeof body.paidAt === 'string' ? body.paidAt.trim() : '';
  const description = String(body.transferContent || '').trim().toUpperCase();
  if (description.length > 500) {
    throw new PaymentWebhookError(400, 'INVALID_TRANSFER_CONTENT', 'Nội dung chuyển khoản quá dài');
  }
  const transferCode = description.match(TRANSFER_CODE_PATTERN)?.[0] || '';
  const amountVnd = Number(body.amountVnd);
  const paidAtDate = new Date(paidAtValue);

  if (eventType !== 'payment.completed') {
    throw new PaymentWebhookError(400, 'UNSUPPORTED_WEBHOOK_EVENT', 'Loại webhook không được hỗ trợ');
  }
  if (!/^[A-Za-z0-9._:/-]{1,255}$/.test(transactionId)) {
    throw new PaymentWebhookError(400, 'INVALID_TRANSACTION_ID', 'Mã giao dịch không hợp lệ');
  }
  if (!TRANSFER_CODE_PATTERN.test(transferCode)) {
    throw new PaymentWebhookError(400, 'TRANSFER_CODE_NOT_FOUND', 'Không tìm thấy mã đơn thanh toán');
  }
  if (!Number.isSafeInteger(amountVnd) || amountVnd <= 0 || amountVnd > 999999999999) {
    throw new PaymentWebhookError(400, 'INVALID_PAYMENT_AMOUNT', 'Số tiền giao dịch không hợp lệ');
  }
  if (!/^[A-Z0-9]{4,30}$/.test(bankAccount)) {
    throw new PaymentWebhookError(400, 'INVALID_BANK_ACCOUNT', 'Tài khoản nhận không hợp lệ');
  }
  if (!paidAtValue || Number.isNaN(paidAtDate.getTime())
      || paidAtDate.getTime() > nowMs + 5 * 60 * 1000) {
    throw new PaymentWebhookError(400, 'INVALID_PAID_AT', 'Thời điểm thanh toán không hợp lệ');
  }

  const paidAt = paidAtDate.toISOString();
  return {
    eventId: verified.eventId,
    eventType,
    transactionId,
    transferCode,
    bankAccount,
    amountVnd,
    paidAt,
    payloadHash: crypto.createHash('sha256').update(req.rawBody).digest('hex'),
    safePayload: {
      type: eventType,
      transactionId,
      transferCode,
      amountVnd,
      paidAt
    }
  };
}

function sendWebhookError(res, error) {
  if (!(error instanceof PaymentWebhookError)) return false;
  res.status(error.statusCode).json({ error: error.message, code: error.code });
  return true;
}

async function finishEvent(client, eventDbId, status, fields = {}) {
  await client.query(
    `UPDATE payment_events
     SET user_id=$2, payment_id=$3, status=$4, error_code=$5,
         processed_at=CASE WHEN $4 IN ('processed','ignored') THEN now() ELSE processed_at END,
         updated_at=now()
     WHERE id=$1`,
    [
      eventDbId,
      fields.userId || null,
      fields.paymentId || null,
      status,
      fields.errorCode || null
    ]
  );
}

async function acceptedForReview(client, res, eventDbId, code, payment = null, status = 'failed') {
  await finishEvent(client, eventDbId, status, {
    userId: payment?.user_id,
    paymentId: payment?.payment_id,
    errorCode: code
  });
  await client.query('COMMIT');
  return res.status(202).json({
    accepted: true,
    processed: false,
    requiresReview: true,
    code
  });
}

async function paymentWebhook(req, res) {
  let verified;
  let input;
  try {
    verified = verifyPaymentWebhook(req, process.env.PAYMENT_WEBHOOK_SECRET);
    input = webhookInput(req, verified);
  } catch (error) {
    if (sendWebhookError(res, error)) return res;
    throw error;
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');
    const insertedEvent = await client.query(
      `INSERT INTO payment_events
         (provider, event_id, event_type, payload, payload_sha256, signature_valid,
          status, attempt_count, processing_started_at)
       VALUES ($1,$2,$3,$4::jsonb,$5,true,'processing',1,now())
       ON CONFLICT (provider, event_id) DO NOTHING
       RETURNING id`,
      [
        WEBHOOK_PROVIDER,
        input.eventId,
        input.eventType,
        JSON.stringify(input.safePayload),
        input.payloadHash
      ]
    );

    if (!insertedEvent.rows[0]) {
      const duplicateResult = await client.query(
        `UPDATE payment_events
         SET attempt_count=attempt_count+1, updated_at=now()
         WHERE provider=$1 AND event_id=$2
         RETURNING status, error_code`,
        [WEBHOOK_PROVIDER, input.eventId]
      );
      await client.query('COMMIT');
      const duplicate = duplicateResult.rows[0] || {};
      return res.status(duplicate.status === 'processed' ? 200 : 202).json({
        accepted: true,
        duplicate: true,
        processed: duplicate.status === 'processed',
        status: duplicate.status || 'unknown',
        code: duplicate.error_code || undefined
      });
    }
    const eventDbId = insertedEvent.rows[0].id;

    const paymentResult = await client.query(
      `SELECT sp.id AS payment_id, sp.user_id, sp.subscription_id, sp.plan_id,
              sp.amount_vnd, sp.billing_cycle, sp.status AS payment_status,
              sp.subscription_action, sp.bank_account_snapshot, sp.expires_at,
              sp.created_at AS payment_created_at,
              sp.settlement_provider, sp.settlement_reference,
              p.code AS plan_code, p.name AS plan_name, p.room_limit AS plan_room_limit,
              s.status AS subscription_status, s.plan_id AS current_plan_id,
              cp.code AS current_plan_code, cp.room_limit AS current_room_limit,
              u.email AS user_email
       FROM subscription_payments sp
       JOIN plans p ON p.id=sp.plan_id
       JOIN subscriptions s ON s.id=sp.subscription_id AND s.user_id=sp.user_id
       JOIN plans cp ON cp.id=s.plan_id
       JOIN users u ON u.id=sp.user_id
       WHERE sp.transfer_content=$1
       LIMIT 1
       FOR UPDATE OF sp, s`,
      [input.transferCode]
    );
    const payment = paymentResult.rows[0];
    if (!payment) {
      return await acceptedForReview(
        client,
        res,
        eventDbId,
        'PAYMENT_NOT_MATCHED',
        null,
        'ignored'
      );
    }

    const transactionResult = await client.query(
      `SELECT id FROM subscription_payments
       WHERE settlement_provider=$1 AND settlement_reference=$2
       LIMIT 1 FOR UPDATE`,
      [WEBHOOK_PROVIDER, input.transactionId]
    );
    const settledPaymentId = Number(transactionResult.rows[0]?.id || 0);
    if (settledPaymentId && settledPaymentId !== Number(payment.payment_id)) {
      return await acceptedForReview(
        client,
        res,
        eventDbId,
        'TRANSACTION_ALREADY_USED',
        payment
      );
    }

    if (payment.payment_status === 'paid'
        && payment.settlement_provider === WEBHOOK_PROVIDER
        && payment.settlement_reference === input.transactionId) {
      await finishEvent(client, eventDbId, 'processed', {
        userId: payment.user_id,
        paymentId: payment.payment_id
      });
      await client.query('COMMIT');
      return res.json({ accepted: true, processed: true, duplicateTransaction: true });
    }
    if (payment.payment_status !== 'pending') {
      return await acceptedForReview(client, res, eventDbId, 'PAYMENT_NOT_PENDING', payment);
    }
    if (Number(payment.amount_vnd) !== input.amountVnd) {
      return await acceptedForReview(client, res, eventDbId, 'PAYMENT_AMOUNT_MISMATCH', payment);
    }
    if (String(payment.bank_account_snapshot).toUpperCase() !== input.bankAccount) {
      return await acceptedForReview(client, res, eventDbId, 'PAYMENT_ACCOUNT_MISMATCH', payment);
    }
    if (payment.payment_created_at
        && new Date(input.paidAt).getTime()
          < new Date(payment.payment_created_at).getTime() - 5 * 60 * 1000) {
      return await acceptedForReview(client, res, eventDbId, 'PAYMENT_BEFORE_ORDER', payment);
    }
    if (payment.expires_at && new Date(input.paidAt) >= new Date(payment.expires_at)) {
      return await acceptedForReview(client, res, eventDbId, 'PAYMENT_ORDER_EXPIRED', payment);
    }
    if (payment.subscription_action === 'renew'
        && Number(payment.current_plan_id) !== Number(payment.plan_id)) {
      return await acceptedForReview(client, res, eventDbId, 'SUBSCRIPTION_CHANGED', payment);
    }
    if (payment.subscription_action === 'upgrade'
        && (Number(payment.current_plan_id) === Number(payment.plan_id)
          || Number(payment.plan_room_limit) < Number(payment.current_room_limit))) {
      return await acceptedForReview(client, res, eventDbId, 'SUBSCRIPTION_CHANGED', payment);
    }

    await client.query(
      `UPDATE subscription_payments
       SET status='paid', paid_at=$2, settlement_provider=$3,
           settlement_reference=$4, updated_at=now()
       WHERE id=$1`,
      [payment.payment_id, input.paidAt, WEBHOOK_PROVIDER, input.transactionId]
    );
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
    if (!subscription) throw new Error('Subscription payment ownership changed during processing');

    const action = payment.subscription_action === 'upgrade'
      ? 'subscription_upgraded_by_payment'
      : 'subscription_renewed_by_payment';
    await client.query(
      `INSERT INTO subscription_change_logs
         (actor_email_snapshot, target_user_id, target_email_snapshot, action,
          previous_plan_code, new_plan_code, previous_status, new_status,
          reason, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,'active',$8,$9::jsonb)`,
      [
        `webhook:${WEBHOOK_PROVIDER}`,
        payment.user_id,
        payment.user_email,
        action,
        payment.current_plan_code,
        payment.plan_code,
        payment.subscription_status,
        'Thanh toán subscription đã được webhook xác minh',
        JSON.stringify({
          paymentId: Number(payment.payment_id),
          eventId: input.eventId,
          transactionId: input.transactionId,
          amountVnd: input.amountVnd,
          billingCycle: payment.billing_cycle
        })
      ]
    );
    await finishEvent(client, eventDbId, 'processed', {
      userId: payment.user_id,
      paymentId: payment.payment_id
    });
    await client.query('COMMIT');
    return res.json({
      accepted: true,
      processed: true,
      paymentId: Number(payment.payment_id),
      subscription: {
        id: Number(subscription.id),
        planCode: payment.plan_code,
        status: subscription.status,
        billingCycle: subscription.billing_cycle,
        startsAt: subscription.starts_at,
        endsAt: subscription.ends_at
      }
    });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  PaymentWebhookError,
  SIGNATURE_TOLERANCE_SECONDS,
  WEBHOOK_PROVIDER,
  paymentWebhook,
  verifyPaymentWebhook,
  webhookInput
};
