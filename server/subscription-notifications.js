'use strict';

const crypto = require('crypto');
const db = require('./db');
const { sendSubscriptionExpiryEmail } = require('./email');
const { writeLog } = require('./observability');

function authorizedCronRequest(req, secret = process.env.CRON_SECRET) {
  const expected = `Bearer ${String(secret || '')}`;
  const received = String(req.get('authorization') || '');
  if (!secret || received.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(received), Buffer.from(expected));
}

function reminderType(daysRemaining) {
  if (daysRemaining <= 1) return 'expiry_1d';
  if (daysRemaining <= 3) return 'expiry_3d';
  return 'expiry_7d';
}

function safeErrorCode(error) {
  const code = String(error?.code || 'EMAIL_SEND_FAILED').toUpperCase();
  return /^[A-Z0-9_]{3,64}$/.test(code) ? code : 'EMAIL_SEND_FAILED';
}

async function processCandidate(candidate, query, sendEmail) {
  const type = reminderType(Number(candidate.days_remaining));
  const claim = await query(
    `INSERT INTO subscription_notifications
       (user_id, subscription_id, notification_type, scheduled_for,
        recipient_email_snapshot, status, attempt_count)
     VALUES ($1,$2,$3,$4,$5,'sending',1)
     ON CONFLICT (subscription_id, notification_type, scheduled_for)
     DO UPDATE SET
       status='sending',
       recipient_email_snapshot=EXCLUDED.recipient_email_snapshot,
       attempt_count=subscription_notifications.attempt_count + 1,
       last_error_code=NULL,
       updated_at=now()
     WHERE subscription_notifications.status='failed'
        OR (subscription_notifications.status='sending'
            AND subscription_notifications.updated_at < now() - interval '30 minutes')
     RETURNING id`,
    [candidate.user_id, candidate.subscription_id, type, candidate.ends_on, candidate.email]
  );
  const notification = claim.rows[0];
  if (!notification) return 'skipped';

  try {
    const delivery = await sendEmail({
      email: candidate.email,
      planName: candidate.plan_name,
      daysRemaining: Number(candidate.days_remaining),
      endsOn: candidate.ends_on,
      notificationId: notification.id
    });
    await query(
      `UPDATE subscription_notifications
       SET status='sent', provider_message_id=$2, sent_at=now(), updated_at=now()
       WHERE id=$1`,
      [notification.id, delivery?.emailId || null]
    );
    return 'sent';
  } catch (error) {
    await query(
      `UPDATE subscription_notifications
       SET status='failed', last_error_code=$2, updated_at=now()
       WHERE id=$1`,
      [notification.id, safeErrorCode(error)]
    );
    return 'failed';
  }
}

async function processExpiryNotifications({
  query = db.query,
  sendEmail = sendSubscriptionExpiryEmail
} = {}) {
  const { rows } = await query(
    `SELECT u.id AS user_id, u.email, s.id AS subscription_id,
            p.name AS plan_name, s.ends_at::date::text AS ends_on,
            GREATEST(1, CEIL(EXTRACT(EPOCH FROM (s.ends_at - now())) / 86400))::int
              AS days_remaining
     FROM subscriptions s
     JOIN users u ON u.id=s.user_id
     JOIN plans p ON p.id=s.plan_id
     WHERE u.email_verified_at IS NOT NULL
       AND s.status IN ('active', 'trialing')
       AND s.ends_at > now()
       AND s.ends_at <= now() + interval '7 days'
     ORDER BY s.ends_at, s.id
     LIMIT 20`
  );

  const results = await Promise.all(
    rows.map((candidate) => processCandidate(candidate, query, sendEmail))
  );
  return {
    candidates: rows.length,
    sent: results.filter((value) => value === 'sent').length,
    failed: results.filter((value) => value === 'failed').length,
    skipped: results.filter((value) => value === 'skipped').length
  };
}

async function expiryReminderCron(req, res) {
  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ error: 'Cron chưa được cấu hình', code: 'CRON_NOT_CONFIGURED' });
  }
  if (!authorizedCronRequest(req)) {
    return res.status(401).json({ error: 'Không được phép', code: 'CRON_UNAUTHORIZED' });
  }

  const result = await processExpiryNotifications();
  writeLog(result.failed > 0 ? 'warn' : 'info', 'subscription_expiry_reminders_completed', result);
  return res.json({ ok: true, ...result });
}

module.exports = {
  authorizedCronRequest,
  expiryReminderCron,
  processExpiryNotifications,
  reminderType
};
