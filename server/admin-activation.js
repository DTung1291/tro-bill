'use strict';

const db = require('./db');

function count(value) {
  return Math.max(0, Number(value) || 0);
}

function cohort(row, prefix) {
  return {
    accounts: count(row[`${prefix}_accounts`]),
    property: count(row[`${prefix}_property`]),
    room: count(row[`${prefix}_room`]),
    reading: count(row[`${prefix}_reading`]),
    bill: count(row[`${prefix}_bill`])
  };
}

function activationSummaryJson(row = {}) {
  return {
    allTime: cohort(row, 'all'),
    last30Days: cohort(row, 'recent'),
    generatedAt: row.generated_at || new Date().toISOString()
  };
}

async function getActivationSummary(req, res) {
  const { rows } = await db.query(
    `WITH eligible_accounts AS (
       SELECT u.id, u.created_at
       FROM users u
       WHERE u.email_verified_at IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM account_memberships membership
           WHERE membership.member_user_id=u.id AND membership.role <> 'owner'
         )
     ), raw_milestones AS (
       SELECT account.created_at,
         EXISTS (SELECT 1 FROM properties property WHERE property.user_id=account.id) AS has_property,
         EXISTS (SELECT 1 FROM rooms room WHERE room.user_id=account.id) AS has_room,
         EXISTS (
           SELECT 1 FROM billing_entries entry
           JOIN rooms room ON room.user_id=entry.user_id AND room.id=entry.room_id
           WHERE entry.user_id=account.id AND entry.electric_new IS NOT NULL
             AND (room.water_type='khối' AND entry.water_new IS NOT NULL
               OR room.water_type='người' AND (entry.water_units IS NOT NULL OR room.people_count > 0))
         ) AS has_reading,
         (
           EXISTS (SELECT 1 FROM rent_invoices invoice WHERE invoice.user_id=account.id)
           OR EXISTS (
             SELECT 1 FROM history_snapshots snapshot
             JOIN history_bills bill ON bill.snapshot_id=snapshot.id
             WHERE snapshot.user_id=account.id
           )
         ) AS has_bill
       FROM eligible_accounts account
     ), milestones AS (
       SELECT created_at,
         has_property OR has_bill AS reached_property,
         has_room OR has_bill AS reached_room,
         has_reading OR has_bill AS reached_reading,
         has_bill AS reached_bill
       FROM raw_milestones
     )
     SELECT
       COUNT(*)::int AS all_accounts,
       COUNT(*) FILTER (WHERE reached_property)::int AS all_property,
       COUNT(*) FILTER (WHERE reached_room)::int AS all_room,
       COUNT(*) FILTER (WHERE reached_reading)::int AS all_reading,
       COUNT(*) FILTER (WHERE reached_bill)::int AS all_bill,
       COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days')::int AS recent_accounts,
       COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days' AND reached_property)::int AS recent_property,
       COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days' AND reached_room)::int AS recent_room,
       COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days' AND reached_reading)::int AS recent_reading,
       COUNT(*) FILTER (WHERE created_at >= now() - interval '30 days' AND reached_bill)::int AS recent_bill,
       now() AS generated_at
     FROM milestones`
  );
  res.set('Cache-Control', 'no-store');
  return res.json({ summary: activationSummaryJson(rows[0]) });
}

module.exports = { getActivationSummary, activationSummaryJson };
