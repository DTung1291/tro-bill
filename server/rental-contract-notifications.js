'use strict';

const db = require('./db');
const { sendRentalContractExpiryEmail } = require('./email');
const { writeLog } = require('./observability');
const { authorizedCronRequest } = require('./subscription-notifications');

function contractReminderType(daysRemaining) {
  const days = Math.max(0, Number(daysRemaining) || 0);
  if (days <= 1) return 'expiry_1d';
  if (days <= 3) return 'expiry_3d';
  if (days <= 7) return 'expiry_7d';
  if (days <= 14) return 'expiry_14d';
  return 'expiry_30d';
}

function safeErrorCode(error) {
  const code = String(error?.code || 'EMAIL_SEND_FAILED').toUpperCase();
  return /^[A-Z0-9_]{3,64}$/.test(code) ? code : 'EMAIL_SEND_FAILED';
}

async function processContractCandidate(candidate, query, sendEmail) {
  const type = contractReminderType(candidate.days_remaining);
  const claim = await query(
    `INSERT INTO rental_contract_notifications
       (user_id, contract_id, notification_type, scheduled_for,
        recipient_email_snapshot, status, attempt_count)
     VALUES ($1,$2,$3,$4,$5,'sending',1)
     ON CONFLICT (contract_id, notification_type, scheduled_for)
     DO UPDATE SET
       status='sending',
       recipient_email_snapshot=EXCLUDED.recipient_email_snapshot,
       attempt_count=rental_contract_notifications.attempt_count + 1,
       last_error_code=NULL,
       updated_at=now()
     WHERE rental_contract_notifications.status='failed'
        OR (rental_contract_notifications.status='sending'
            AND rental_contract_notifications.updated_at < now() - interval '30 minutes')
     RETURNING id`,
    [
      candidate.user_id,
      candidate.contract_id,
      type,
      candidate.ends_on,
      candidate.email
    ]
  );
  const notification = claim.rows[0];
  if (!notification) return 'skipped';

  try {
    const delivery = await sendEmail({
      email: candidate.email,
      contractCode: candidate.contract_code,
      roomName: candidate.room_name,
      tenantName: candidate.tenant_name,
      daysRemaining: Number(candidate.days_remaining),
      endsOn: candidate.ends_on,
      notificationId: notification.id
    });
    await query(
      `UPDATE rental_contract_notifications
       SET status='sent', provider_message_id=$2, sent_at=now(), updated_at=now()
       WHERE id=$1`,
      [notification.id, delivery?.emailId || null]
    );
    return 'sent';
  } catch (error) {
    await query(
      `UPDATE rental_contract_notifications
       SET status='failed', last_error_code=$2, updated_at=now()
       WHERE id=$1`,
      [notification.id, safeErrorCode(error)]
    );
    return 'failed';
  }
}

async function processRentalContractExpiryNotifications({
  query = db.query,
  sendEmail = sendRentalContractExpiryEmail
} = {}) {
  const { rows } = await query(
    `WITH clock AS (
       SELECT timezone('Asia/Ho_Chi_Minh', now())::date AS today
     )
     SELECT u.id AS user_id, u.email, contract.id AS contract_id,
            contract.contract_code,
            contract.room_name_snapshot AS room_name,
            contract.tenant_name_snapshot AS tenant_name,
            contract.ends_on::text AS ends_on,
            (contract.ends_on - clock.today)::int AS days_remaining
     FROM rental_contracts contract
     JOIN users u ON u.id=contract.user_id
     CROSS JOIN clock
     WHERE u.email_verified_at IS NOT NULL
       AND contract.status='active'
       AND contract.ends_on IS NOT NULL
       AND contract.ends_on >= clock.today
       AND contract.ends_on <= clock.today + 30
     ORDER BY contract.ends_on, contract.id
     LIMIT 20`
  );

  const results = await Promise.all(
    rows.map((candidate) => processContractCandidate(candidate, query, sendEmail))
  );
  return {
    candidates: rows.length,
    sent: results.filter((value) => value === 'sent').length,
    failed: results.filter((value) => value === 'failed').length,
    skipped: results.filter((value) => value === 'skipped').length
  };
}

async function rentalContractExpiryReminderCron(req, res) {
  if (!process.env.CRON_SECRET) {
    return res.status(503).json({ error: 'Cron chưa được cấu hình', code: 'CRON_NOT_CONFIGURED' });
  }
  if (!authorizedCronRequest(req)) {
    return res.status(401).json({ error: 'Không được phép', code: 'CRON_UNAUTHORIZED' });
  }

  const result = await processRentalContractExpiryNotifications();
  writeLog(
    result.failed > 0 ? 'warn' : 'info',
    'rental_contract_expiry_reminders_completed',
    result
  );
  return res.json({ ok: true, ...result });
}

module.exports = {
  contractReminderType,
  processContractCandidate,
  processRentalContractExpiryNotifications,
  rentalContractExpiryReminderCron
};
