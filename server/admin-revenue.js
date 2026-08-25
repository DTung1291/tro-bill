'use strict';

const db = require('./db');

function number(value) {
  return Number(value) || 0;
}

function revenueSummaryJson(row = {}) {
  const trialEver = number(row.trial_ever_count);
  const trialConverted = number(row.trial_converted_count);
  return {
    accounts: {
      total: number(row.total_accounts),
      trialing: number(row.trialing_accounts),
      paying: number(row.paying_accounts),
      expired: number(row.expired_accounts),
      expiringSoon: number(row.expiring_soon_accounts)
    },
    revenue: {
      monthGrossVnd: number(row.month_gross_vnd),
      monthRefundedVnd: number(row.month_refunded_vnd),
      monthNetVnd: number(row.month_gross_vnd) - number(row.month_refunded_vnd),
      yearGrossVnd: number(row.year_gross_vnd),
      yearRefundedVnd: number(row.year_refunded_vnd),
      yearNetVnd: number(row.year_gross_vnd) - number(row.year_refunded_vnd),
      mrrVnd: Math.round(number(row.mrr_vnd)),
      arrVnd: Math.round(number(row.mrr_vnd) * 12)
    },
    trialConversion: {
      trialEver,
      converted: trialConverted,
      ratePercent: trialEver > 0
        ? Math.round((trialConverted / trialEver) * 1000) / 10
        : 0
    },
    generatedAt: row.generated_at || new Date().toISOString()
  };
}

async function getRevenueSummary(req, res) {
  const { rows } = await db.query(
    `WITH boundaries AS (
       SELECT
         date_trunc('month', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')
           AT TIME ZONE 'Asia/Ho_Chi_Minh' AS month_start,
         date_trunc('year', now() AT TIME ZONE 'Asia/Ho_Chi_Minh')
           AT TIME ZONE 'Asia/Ho_Chi_Minh' AS year_start
     ),
     account_metrics AS (
       SELECT
         COUNT(*)::int AS total_accounts,
         COUNT(*) FILTER (
           WHERE s.status='trialing' AND s.ends_at > now()
         )::int AS trialing_accounts,
         COUNT(*) FILTER (
           WHERE p.code <> 'free'
             AND s.status NOT IN ('expired','canceled','trialing')
             AND (s.ends_at IS NULL OR s.ends_at + interval '3 days' > now())
         )::int AS paying_accounts,
         COUNT(*) FILTER (
           WHERE s.status IN ('expired','canceled')
              OR (s.ends_at IS NOT NULL
                  AND s.ends_at + CASE WHEN s.status='trialing'
                    THEN interval '0 days' ELSE interval '3 days' END <= now())
         )::int AS expired_accounts,
         COUNT(*) FILTER (
           WHERE p.code <> 'free' AND s.status='active'
             AND s.ends_at > now() AND s.ends_at <= now() + interval '7 days'
         )::int AS expiring_soon_accounts,
         COUNT(*) FILTER (WHERE s.trial_used_at IS NOT NULL)::int AS trial_ever_count,
         COUNT(*) FILTER (
           WHERE s.trial_used_at IS NOT NULL
             AND EXISTS (
               SELECT 1 FROM subscription_payments paid
               WHERE paid.user_id=s.user_id AND paid.status='paid'
                 AND NOT EXISTS (
                   SELECT 1 FROM subscription_refund_requests completed_refund
                   WHERE completed_refund.user_id=paid.user_id
                     AND completed_refund.payment_id=paid.id
                     AND completed_refund.status='refunded'
                     AND completed_refund.requested_amount_vnd >= paid.amount_vnd
                 )
             )
         )::int AS trial_converted_count,
         COALESCE(SUM(
           CASE WHEN p.code <> 'free'
             AND s.status NOT IN ('expired','canceled','trialing')
             AND (s.ends_at IS NULL OR s.ends_at + interval '3 days' > now())
           THEN CASE s.billing_cycle
             WHEN 'monthly' THEN p.monthly_price_vnd
             WHEN 'yearly' THEN p.yearly_price_vnd / 12.0
             ELSE 0
           END ELSE 0 END
         ), 0) AS mrr_vnd
       FROM users u
       LEFT JOIN subscriptions s ON s.user_id=u.id
       LEFT JOIN plans p ON p.id=s.plan_id
     ),
     payment_metrics AS (
       SELECT
         COALESCE(SUM(sp.amount_vnd) FILTER (
           WHERE sp.status='paid' AND sp.paid_at >= b.month_start
         ), 0) AS month_gross_vnd,
         COALESCE(SUM(sp.amount_vnd) FILTER (
           WHERE sp.status='paid' AND sp.paid_at >= b.year_start
         ), 0) AS year_gross_vnd
       FROM boundaries b
       LEFT JOIN subscription_payments sp ON true
       GROUP BY b.month_start, b.year_start
     ),
     refund_metrics AS (
       SELECT
         COALESCE(SUM(rr.requested_amount_vnd) FILTER (
           WHERE rr.status='refunded' AND rr.refunded_at >= b.month_start
         ), 0) AS month_refunded_vnd,
         COALESCE(SUM(rr.requested_amount_vnd) FILTER (
           WHERE rr.status='refunded' AND rr.refunded_at >= b.year_start
         ), 0) AS year_refunded_vnd
       FROM boundaries b
       LEFT JOIN subscription_refund_requests rr ON true
       GROUP BY b.month_start, b.year_start
     )
     SELECT account_metrics.*, payment_metrics.*, refund_metrics.*, now() AS generated_at
     FROM account_metrics, payment_metrics, refund_metrics`
  );
  res.set('Cache-Control', 'no-store');
  return res.json({ summary: revenueSummaryJson(rows[0]) });
}

module.exports = { getRevenueSummary, revenueSummaryJson };
