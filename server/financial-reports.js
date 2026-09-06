'use strict';

const db = require('./db');

const PERIOD_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const QUARTER_PATTERN = /^([0-9]{4})-Q([1-4])$/;
const YEAR_PATTERN = /^[2-9][0-9]{3}$/;
const REPORT_TIME_ZONE = 'Asia/Ho_Chi_Minh';
const PERIOD_TYPES = new Set(['month', 'quarter', 'year']);

class FinancialReportError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'FinancialReportError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function reportPeriod(value) {
  const period = String(value || '').trim();
  if (!PERIOD_PATTERN.test(period)) {
    throw new FinancialReportError(400, 'INVALID_REPORT_PERIOD', 'Tháng báo cáo không hợp lệ');
  }
  return period;
}

function reportRange(query = {}) {
  const type = String(query.periodType || 'month').trim().toLowerCase();
  const key = String(query.period || '').trim().toUpperCase();
  if (!PERIOD_TYPES.has(type)) {
    throw new FinancialReportError(400, 'INVALID_REPORT_PERIOD_TYPE', 'Loại kỳ báo cáo không hợp lệ');
  }
  if (type === 'month') {
    const period = reportPeriod(key);
    return { type, key: period, fromPeriod: period, toPeriod: period };
  }
  if (type === 'quarter') {
    const match = key.match(QUARTER_PATTERN);
    if (!match) {
      throw new FinancialReportError(400, 'INVALID_REPORT_PERIOD', 'Quý báo cáo không hợp lệ');
    }
    const startMonth = (Number(match[2]) - 1) * 3 + 1;
    return {
      type,
      key,
      fromPeriod: `${match[1]}-${String(startMonth).padStart(2, '0')}`,
      toPeriod: `${match[1]}-${String(startMonth + 2).padStart(2, '0')}`
    };
  }
  if (!YEAR_PATTERN.test(key)) {
    throw new FinancialReportError(400, 'INVALID_REPORT_PERIOD', 'Năm báo cáo không hợp lệ');
  }
  return { type, key, fromPeriod: `${key}-01`, toPeriod: `${key}-12` };
}

function optionalPropertyId(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw new FinancialReportError(400, 'INVALID_REPORT_PROPERTY', 'Khu lọc báo cáo không hợp lệ');
  }
  return id;
}

function optionalRoomId(value) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const id = String(value).trim();
  if (!id || id.length > 200) {
    throw new FinancialReportError(400, 'INVALID_REPORT_ROOM', 'Phòng lọc báo cáo không hợp lệ');
  }
  return id;
}

function reportFilters(query = {}) {
  return {
    propertyId: optionalPropertyId(query.propertyId),
    roomId: optionalRoomId(query.roomId)
  };
}

function amount(value) {
  return Math.round(Number(value) || 0);
}

function percentage(numerator, denominator) {
  if (!Number.isFinite(Number(denominator)) || Number(denominator) <= 0) return 0;
  return Math.round((Number(numerator) / Number(denominator)) * 10000) / 100;
}

function occupancyRoomJson(row) {
  const totalRoomDays = Math.max(0, Number(row.total_room_days) || 0);
  const occupiedRoomDays = Math.max(0, Number(row.occupied_room_days) || 0);
  const vacantRoomDays = Math.max(0, Number(row.vacant_room_days) || 0);
  const reservedRoomDays = Math.max(0, Number(row.reserved_room_days) || 0);
  const maintenanceRoomDays = Math.max(0, Number(row.maintenance_room_days) || 0);
  const rentableRoomDays = Math.max(0, totalRoomDays - maintenanceRoomDays);
  const endingStatus = ['occupied', 'reserved', 'maintenance', 'vacant'].includes(row.ending_status)
    ? row.ending_status
    : 'vacant';
  return {
    roomId: String(row.room_id || ''),
    roomName: String(row.room_name || ''),
    propertyId: Number(row.property_id) || null,
    propertyName: String(row.property_name || ''),
    totalRoomDays,
    rentableRoomDays,
    occupiedRoomDays,
    vacantRoomDays,
    reservedRoomDays,
    maintenanceRoomDays,
    occupancyRatePercent: percentage(occupiedRoomDays, rentableRoomDays),
    longestVacantDays: Math.max(0, Number(row.longest_vacant_days) || 0),
    endingVacantDays: endingStatus === 'vacant'
      ? Math.max(0, Number(row.ending_vacant_days) || 0)
      : 0,
    endingStatus,
    inferredOccupancyStart: row.inferred_occupancy_start === true
      || row.inferred_occupancy_start === 'true'
  };
}

function occupancyReportJson(rows = [], range) {
  const rooms = rows.map(occupancyRoomJson);
  const totals = rooms.reduce((result, room) => {
    result.totalRoomDays += room.totalRoomDays;
    result.rentableRoomDays += room.rentableRoomDays;
    result.occupiedRoomDays += room.occupiedRoomDays;
    result.vacantRoomDays += room.vacantRoomDays;
    result.reservedRoomDays += room.reservedRoomDays;
    result.maintenanceRoomDays += room.maintenanceRoomDays;
    result.longestVacantDays = Math.max(result.longestVacantDays, room.longestVacantDays);
    if (room.endingStatus === 'vacant') result.endingVacantRoomCount += 1;
    if (room.inferredOccupancyStart) result.inferredStartRoomCount += 1;
    return result;
  }, {
    totalRoomDays: 0,
    rentableRoomDays: 0,
    occupiedRoomDays: 0,
    vacantRoomDays: 0,
    reservedRoomDays: 0,
    maintenanceRoomDays: 0,
    longestVacantDays: 0,
    endingVacantRoomCount: 0,
    inferredStartRoomCount: 0
  });
  return {
    calendarDays: rooms.reduce((days, room) => Math.max(days, room.totalRoomDays), 0),
    roomCount: rooms.length,
    ...totals,
    occupancyRatePercent: percentage(totals.occupiedRoomDays, totals.rentableRoomDays),
    inventoryMode: 'current_rooms',
    rooms
  };
}

function financialReportJson(row, rangeOrPeriod, filters = {}) {
  const range = typeof rangeOrPeriod === 'string'
    ? reportRange({ periodType: 'month', period: rangeOrPeriod })
    : rangeOrPeriod;
  const revenueVnd = amount(row.revenue_vnd);
  const collectedVnd = amount(row.collected_vnd);
  const outstandingVnd = Math.max(0, amount(row.outstanding_vnd));
  const expensesVnd = amount(row.expenses_vnd);
  const depositCollectedVnd = amount(row.deposit_collected_vnd);
  const depositRefundedVnd = amount(row.deposit_refunded_vnd);
  return {
    period: range.key,
    range,
    filters: {
      propertyId: filters.propertyId ?? null,
      roomId: filters.roomId ?? null,
      expenseMode: filters.roomId ? 'linked_room_only' : filters.propertyId ? 'property_only' : 'all'
    },
    timeZone: REPORT_TIME_ZONE,
    revenueVnd,
    collectedVnd,
    outstandingVnd,
    expensesVnd,
    profitVnd: collectedVnd - expensesVnd,
    breakdown: {
      invoice: {
        rentVnd: amount(row.rent_vnd),
        electricityVnd: amount(row.electricity_vnd),
        waterVnd: amount(row.water_vnd),
        servicesVnd: amount(row.services_vnd),
        discountVnd: amount(row.discount_vnd),
        surchargeVnd: amount(row.surcharge_vnd),
        lateFeeVnd: amount(row.late_fee_vnd),
        adjustmentNetVnd: amount(row.adjustment_net_vnd),
        uncategorizedVnd: amount(row.uncategorized_vnd)
      },
      deposit: {
        collectedVnd: depositCollectedVnd,
        refundedVnd: depositRefundedVnd,
        deductedVnd: amount(row.deposit_deducted_vnd),
        netCashflowVnd: depositCollectedVnd - depositRefundedVnd
      }
    },
    invoiceCount: Math.max(0, Number(row.invoice_count) || 0),
    unpaidInvoiceCount: Math.max(0, Number(row.unpaid_invoice_count) || 0),
    generatedAt: row.generated_at instanceof Date
      ? row.generated_at.toISOString()
      : String(row.generated_at || '')
  };
}

function reportSql() {
  return `
    WITH bounds AS (
      SELECT to_date($2 || '-01', 'YYYY-MM-DD') AS start_date,
             to_date($3 || '-01', 'YYYY-MM-DD') + INTERVAL '1 month' AS end_date
    ),
    invoice_balances AS (
      SELECT invoice.id,
             invoice.period,
             COALESCE(invoice.final_total_vnd, invoice.issued_total_vnd) AS invoice_total_vnd,
             COALESCE(invoice.final_detail_snapshot, invoice.detail_snapshot, '{}'::jsonb)
               AS detail_snapshot,
             COALESCE(SUM(transaction.amount_vnd) FILTER (
               WHERE transaction.occurred_at AT TIME ZONE '${REPORT_TIME_ZONE}' < bounds.end_date
             ), 0) AS paid_by_period_end_vnd
      FROM rent_invoices invoice
      CROSS JOIN bounds
      LEFT JOIN rent_payment_transactions transaction
        ON transaction.user_id=invoice.user_id AND transaction.invoice_id=invoice.id
      WHERE invoice.user_id=$1
        AND invoice.period<=$3
        AND ($5::text IS NULL OR invoice.room_id=$5)
        AND ($4::bigint IS NULL OR EXISTS (
          SELECT 1 FROM rooms filter_room
          WHERE filter_room.user_id=invoice.user_id
            AND filter_room.id=invoice.room_id
            AND filter_room.property_id=$4
        ))
        AND ($6::bigint[] IS NULL OR EXISTS (
          SELECT 1 FROM rooms scoped_room
          WHERE scoped_room.user_id=invoice.user_id
            AND scoped_room.id=invoice.room_id
            AND scoped_room.property_id=ANY($6::bigint[])
        ))
      GROUP BY invoice.id, bounds.end_date
    ),
    invoice_components AS (
      SELECT invoice_balances.*,
             CASE WHEN jsonb_typeof(detail_snapshot #> '{rent,amountVnd}')='number'
               THEN (detail_snapshot #>> '{rent,amountVnd}')::numeric ELSE 0 END AS rent_vnd,
             CASE WHEN jsonb_typeof(detail_snapshot #> '{electricity,amountVnd}')='number'
               THEN (detail_snapshot #>> '{electricity,amountVnd}')::numeric ELSE 0 END AS electricity_vnd,
             CASE WHEN jsonb_typeof(detail_snapshot #> '{water,amountVnd}')='number'
               THEN (detail_snapshot #>> '{water,amountVnd}')::numeric ELSE 0 END AS water_vnd,
             CASE WHEN jsonb_typeof(detail_snapshot #> '{services,trashVnd}')='number'
               THEN (detail_snapshot #>> '{services,trashVnd}')::numeric ELSE 0 END AS trash_vnd,
             CASE WHEN jsonb_typeof(detail_snapshot #> '{services,wifiVnd}')='number'
               THEN (detail_snapshot #>> '{services,wifiVnd}')::numeric ELSE 0 END AS wifi_vnd,
             CASE WHEN jsonb_typeof(detail_snapshot #> '{services,managementVnd}')='number'
               THEN (detail_snapshot #>> '{services,managementVnd}')::numeric ELSE 0 END AS management_vnd,
             CASE WHEN jsonb_typeof(detail_snapshot #> '{adjustments,discountVnd}')='number'
               THEN (detail_snapshot #>> '{adjustments,discountVnd}')::numeric ELSE 0 END AS discount_vnd,
             CASE WHEN jsonb_typeof(detail_snapshot #> '{adjustments,surchargeVnd}')='number'
               THEN (detail_snapshot #>> '{adjustments,surchargeVnd}')::numeric ELSE 0 END AS surcharge_vnd,
             CASE WHEN jsonb_typeof(detail_snapshot #> '{adjustments,lateFeeVnd}')='number'
               THEN (detail_snapshot #>> '{adjustments,lateFeeVnd}')::numeric ELSE 0 END AS late_fee_vnd
      FROM invoice_balances
    ),
    invoice_metrics AS (
      SELECT COALESCE(SUM(invoice_total_vnd) FILTER (WHERE period BETWEEN $2 AND $3), 0)
               AS revenue_vnd,
             COUNT(*) FILTER (WHERE period BETWEEN $2 AND $3)::int AS invoice_count,
             COALESCE(SUM(GREATEST(invoice_total_vnd - paid_by_period_end_vnd, 0)), 0)
               AS outstanding_vnd,
             COUNT(*) FILTER (
               WHERE invoice_total_vnd - paid_by_period_end_vnd > 0
             )::int AS unpaid_invoice_count,
             COALESCE(SUM(rent_vnd) FILTER (WHERE period BETWEEN $2 AND $3), 0) AS rent_vnd,
             COALESCE(SUM(electricity_vnd) FILTER (WHERE period BETWEEN $2 AND $3), 0)
               AS electricity_vnd,
             COALESCE(SUM(water_vnd) FILTER (WHERE period BETWEEN $2 AND $3), 0) AS water_vnd,
             COALESCE(SUM(trash_vnd + wifi_vnd + management_vnd)
               FILTER (WHERE period BETWEEN $2 AND $3), 0) AS services_vnd,
             COALESCE(SUM(discount_vnd) FILTER (WHERE period BETWEEN $2 AND $3), 0)
               AS discount_vnd,
             COALESCE(SUM(surcharge_vnd) FILTER (WHERE period BETWEEN $2 AND $3), 0)
               AS surcharge_vnd,
             COALESCE(SUM(late_fee_vnd) FILTER (WHERE period BETWEEN $2 AND $3), 0)
               AS late_fee_vnd,
             COALESCE(SUM(surcharge_vnd + late_fee_vnd - discount_vnd)
               FILTER (WHERE period BETWEEN $2 AND $3), 0) AS adjustment_net_vnd,
             COALESCE(SUM(
               invoice_total_vnd - rent_vnd - electricity_vnd - water_vnd
               - trash_vnd - wifi_vnd - management_vnd
               + discount_vnd - surcharge_vnd - late_fee_vnd
             ) FILTER (WHERE period BETWEEN $2 AND $3), 0) AS uncategorized_vnd
      FROM invoice_components
    ),
    collection_metrics AS (
      SELECT COALESCE(SUM(transaction.amount_vnd), 0) AS collected_vnd
      FROM rent_payment_transactions transaction
      JOIN rent_invoices transaction_invoice
        ON transaction_invoice.user_id=transaction.user_id
       AND transaction_invoice.id=transaction.invoice_id
      CROSS JOIN bounds
      WHERE transaction.user_id=$1
        AND transaction.entry_type IN ('payment', 'reversal')
        AND transaction.payment_method<>'deposit'
        AND transaction.occurred_at AT TIME ZONE '${REPORT_TIME_ZONE}' >= bounds.start_date
        AND transaction.occurred_at AT TIME ZONE '${REPORT_TIME_ZONE}' < bounds.end_date
        AND ($5::text IS NULL OR transaction_invoice.room_id=$5)
        AND ($4::bigint IS NULL OR EXISTS (
          SELECT 1 FROM rooms filter_room
          WHERE filter_room.user_id=transaction_invoice.user_id
            AND filter_room.id=transaction_invoice.room_id
            AND filter_room.property_id=$4
        ))
        AND ($6::bigint[] IS NULL OR EXISTS (
          SELECT 1 FROM rooms scoped_room
          WHERE scoped_room.user_id=transaction_invoice.user_id
            AND scoped_room.id=transaction_invoice.room_id
            AND scoped_room.property_id=ANY($6::bigint[])
        ))
    ),
    deposit_metrics AS (
      SELECT COALESCE(SUM(deposit.amount_vnd) FILTER (
               WHERE COALESCE(original_deposit.entry_type, deposit.entry_type)='collection'
             ), 0) AS deposit_collected_vnd,
             COALESCE(-SUM(deposit.amount_vnd) FILTER (
               WHERE COALESCE(original_deposit.entry_type, deposit.entry_type)='refund'
             ), 0) AS deposit_refunded_vnd,
             COALESCE(-SUM(deposit.amount_vnd) FILTER (
               WHERE COALESCE(original_deposit.entry_type, deposit.entry_type)='deduction'
             ), 0) AS deposit_deducted_vnd
      FROM tenant_deposit_transactions deposit
      JOIN tenant_deposit_accounts deposit_account
        ON deposit_account.user_id=deposit.user_id AND deposit_account.id=deposit.account_id
      LEFT JOIN tenant_deposit_transactions original_deposit
        ON original_deposit.user_id=deposit.user_id
       AND original_deposit.id=deposit.reverses_transaction_id
      CROSS JOIN bounds
      WHERE deposit.user_id=$1
        AND deposit.occurred_at AT TIME ZONE '${REPORT_TIME_ZONE}' >= bounds.start_date
        AND deposit.occurred_at AT TIME ZONE '${REPORT_TIME_ZONE}' < bounds.end_date
        AND ($5::text IS NULL OR deposit_account.room_id=$5)
        AND ($4::bigint IS NULL OR EXISTS (
          SELECT 1 FROM rooms deposit_room
          WHERE deposit_room.user_id=deposit_account.user_id
            AND deposit_room.id=deposit_account.room_id
            AND deposit_room.property_id=$4
        ))
        AND ($6::bigint[] IS NULL OR EXISTS (
          SELECT 1 FROM rooms scoped_deposit_room
          WHERE scoped_deposit_room.user_id=deposit_account.user_id
            AND scoped_deposit_room.id=deposit_account.room_id
            AND scoped_deposit_room.property_id=ANY($6::bigint[])
        ))
    ),
    expense_metrics AS (
      SELECT COALESCE(SUM(expense.amount), 0) AS expenses_vnd
      FROM expense_entries expense
      WHERE expense.user_id=$1
        AND expense.period BETWEEN $2 AND $3
        AND ($5::text IS NULL OR (
          expense.maintenance_request_id IS NOT NULL
          AND expense.maintenance_room_id_snapshot=$5
        ))
        AND ($5::text IS NOT NULL OR $4::bigint IS NULL OR expense.property_id=$4)
        AND ($6::bigint[] IS NULL OR (
          expense.property_id=ANY($6::bigint[])
          OR (
            expense.property_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM properties unassigned_property
              WHERE unassigned_property.user_id=$1
                AND NOT (unassigned_property.id=ANY($6::bigint[]))
            )
          )
        ))
    )
    SELECT invoice_metrics.*, collection_metrics.collected_vnd,
           deposit_metrics.*, expense_metrics.expenses_vnd, now() AS generated_at
    FROM invoice_metrics, collection_metrics, deposit_metrics, expense_metrics`;
}

function occupancyReportSql() {
  return `
    WITH requested_bounds AS (
      SELECT to_date($2 || '-01', 'YYYY-MM-DD') AS start_date,
             to_date($3 || '-01', 'YYYY-MM-DD') + INTERVAL '1 month' AS requested_end_date
    ),
    bounds AS (
      SELECT start_date,
             LEAST(requested_end_date, CURRENT_DATE + INTERVAL '1 day') AS end_date
      FROM requested_bounds
    ),
    filtered_rooms AS (
      SELECT room.id AS room_id,
             room.name AS room_name,
             room.property_id,
             property.name AS property_name,
             EXISTS (
               SELECT 1 FROM tenants tenant
               WHERE tenant.user_id=room.user_id AND tenant.room_id=room.id
             ) AS has_current_tenant,
             CASE
               WHEN room.rent_start_date ~ '^[0-9]{4}-(0[1-9]|1[0-2])-([0-2][0-9]|3[01])$'
                AND to_char(to_date(room.rent_start_date, 'YYYY-MM-DD'), 'YYYY-MM-DD')
                    = room.rent_start_date
               THEN to_date(room.rent_start_date, 'YYYY-MM-DD')
               ELSE NULL
             END AS legacy_starts_on
      FROM rooms room
      JOIN properties property
        ON property.user_id=room.user_id AND property.id=room.property_id
      WHERE room.user_id=$1
        AND ($5::text IS NULL OR room.id=$5)
        AND ($4::bigint IS NULL OR room.property_id=$4)
        AND ($6::bigint[] IS NULL OR room.property_id=ANY($6::bigint[]))
    ),
    contract_spans AS (
      SELECT contract.room_id,
             GREATEST(contract.starts_on, bounds.start_date)::date AS starts_on,
             LEAST(
               CASE
                 WHEN contract.status='active' THEN (bounds.end_date - INTERVAL '1 day')::date
                 ELSE COALESCE(
                   lifecycle_end.occurred_on,
                   (COALESCE(contract.ended_at, contract.cancelled_at)
                     AT TIME ZONE '${REPORT_TIME_ZONE}')::date,
                   contract.ends_on,
                   (bounds.end_date - INTERVAL '1 day')::date
                 )
               END,
               (bounds.end_date - INTERVAL '1 day')::date
             ) AS ends_on
      FROM rental_contracts contract
      JOIN filtered_rooms room ON room.room_id=contract.room_id
      CROSS JOIN bounds
      LEFT JOIN LATERAL (
        SELECT MIN(event.occurred_on) AS occurred_on
        FROM rental_lifecycle_events event
        WHERE event.user_id=contract.user_id
          AND event.contract_id=contract.id
          AND event.event_type IN ('checked_out','room_transferred')
      ) lifecycle_end ON TRUE
      WHERE contract.user_id=$1
        AND (
          contract.status IN ('active','ended')
          OR (contract.status='cancelled' AND contract.activated_at IS NOT NULL)
        )
        AND contract.starts_on < bounds.end_date
        AND (
          contract.status='active'
          OR COALESCE(
            lifecycle_end.occurred_on,
            (COALESCE(contract.ended_at, contract.cancelled_at)
              AT TIME ZONE '${REPORT_TIME_ZONE}')::date,
            contract.ends_on,
            (bounds.end_date - INTERVAL '1 day')::date
          ) >= bounds.start_date
        )
    ),
    legacy_occupancy_spans AS (
      SELECT room.room_id,
             GREATEST(COALESCE(room.legacy_starts_on, bounds.start_date), bounds.start_date)::date
               AS starts_on,
             (bounds.end_date - INTERVAL '1 day')::date AS ends_on
      FROM filtered_rooms room
      CROSS JOIN bounds
      WHERE room.has_current_tenant
    ),
    occupied_days AS (
      SELECT DISTINCT span.room_id, day::date AS day
      FROM (
        SELECT * FROM contract_spans WHERE ends_on >= starts_on
        UNION ALL
        SELECT * FROM legacy_occupancy_spans WHERE ends_on >= starts_on
      ) span
      CROSS JOIN LATERAL generate_series(span.starts_on, span.ends_on, INTERVAL '1 day') day
    ),
    reservation_spans AS (
      SELECT reservation.room_id,
             GREATEST(reservation.reserved_on, bounds.start_date)::date AS starts_on,
             LEAST(
               CASE reservation.status
                 WHEN 'converted' THEN COALESCE(lifecycle_end.occurred_on,
                   (reservation.converted_at AT TIME ZONE '${REPORT_TIME_ZONE}')::date)
                 WHEN 'cancelled' THEN COALESCE(lifecycle_end.occurred_on,
                   (reservation.cancelled_at AT TIME ZONE '${REPORT_TIME_ZONE}')::date)
                 WHEN 'expired' THEN reservation.expires_on
                 ELSE reservation.expires_on
               END,
               (bounds.end_date - INTERVAL '1 day')::date
             ) AS ends_on
      FROM rental_reservations reservation
      JOIN filtered_rooms room ON room.room_id=reservation.room_id
      CROSS JOIN bounds
      LEFT JOIN LATERAL (
        SELECT MIN(event.occurred_on) AS occurred_on
        FROM rental_lifecycle_events event
        WHERE event.user_id=reservation.user_id
          AND event.reservation_id=reservation.id
          AND event.event_type IN ('reservation_cancelled','reservation_converted')
      ) lifecycle_end ON TRUE
      WHERE reservation.user_id=$1
        AND reservation.reserved_on < bounds.end_date
        AND reservation.expires_on >= bounds.start_date
    ),
    reserved_days AS (
      SELECT DISTINCT span.room_id, day::date AS day
      FROM reservation_spans span
      CROSS JOIN LATERAL generate_series(span.starts_on, span.ends_on, INTERVAL '1 day') day
      WHERE span.ends_on >= span.starts_on
    ),
    maintenance_spans AS (
      SELECT maintenance.room_id,
             GREATEST(maintenance.starts_on, bounds.start_date)::date AS starts_on,
             LEAST(
               CASE WHEN maintenance.status='active'
                 THEN (bounds.end_date - INTERVAL '1 day')::date
                 ELSE maintenance.ended_on
               END,
               (bounds.end_date - INTERVAL '1 day')::date
             ) AS ends_on
      FROM room_maintenance_periods maintenance
      JOIN filtered_rooms room ON room.room_id=maintenance.room_id
      CROSS JOIN bounds
      WHERE maintenance.user_id=$1
        AND maintenance.starts_on < bounds.end_date
        AND (maintenance.status='active' OR maintenance.ended_on >= bounds.start_date)
    ),
    maintenance_days AS (
      SELECT DISTINCT span.room_id, day::date AS day
      FROM maintenance_spans span
      CROSS JOIN LATERAL generate_series(span.starts_on, span.ends_on, INTERVAL '1 day') day
      WHERE span.ends_on >= span.starts_on
    ),
    room_days AS (
      SELECT room.*, day::date AS day
      FROM filtered_rooms room
      CROSS JOIN bounds
      CROSS JOIN LATERAL generate_series(
        bounds.start_date,
        bounds.end_date - INTERVAL '1 day',
        INTERVAL '1 day'
      ) day
    ),
    classified_days AS (
      SELECT room_day.*,
             CASE
               WHEN occupied.room_id IS NOT NULL THEN 'occupied'
               WHEN reserved.room_id IS NOT NULL THEN 'reserved'
               WHEN maintenance.room_id IS NOT NULL THEN 'maintenance'
               ELSE 'vacant'
             END AS operational_status
      FROM room_days room_day
      LEFT JOIN occupied_days occupied
        ON occupied.room_id=room_day.room_id AND occupied.day=room_day.day
      LEFT JOIN reserved_days reserved
        ON reserved.room_id=room_day.room_id AND reserved.day=room_day.day
      LEFT JOIN maintenance_days maintenance
        ON maintenance.room_id=room_day.room_id AND maintenance.day=room_day.day
    ),
    vacant_numbered AS (
      SELECT room_id, day,
             day - (ROW_NUMBER() OVER (PARTITION BY room_id ORDER BY day))::int AS streak_group
      FROM classified_days
      WHERE operational_status='vacant'
    ),
    vacant_streaks AS (
      SELECT room_id, COUNT(*)::int AS vacant_days, MAX(day) AS last_vacant_on
      FROM vacant_numbered
      GROUP BY room_id, streak_group
    ),
    vacant_metrics AS (
      SELECT streak.room_id,
             MAX(streak.vacant_days)::int AS longest_vacant_days,
             COALESCE(MAX(streak.vacant_days) FILTER (
               WHERE streak.last_vacant_on=(bounds.end_date - INTERVAL '1 day')::date
             ), 0)::int AS ending_vacant_days
      FROM vacant_streaks streak
      CROSS JOIN bounds
      GROUP BY streak.room_id
    )
    SELECT room_day.room_id,
           room_day.room_name,
           room_day.property_id,
           room_day.property_name,
           COUNT(*)::int AS total_room_days,
           COUNT(*) FILTER (WHERE operational_status='occupied')::int AS occupied_room_days,
           COUNT(*) FILTER (WHERE operational_status='vacant')::int AS vacant_room_days,
           COUNT(*) FILTER (WHERE operational_status='reserved')::int AS reserved_room_days,
           COUNT(*) FILTER (WHERE operational_status='maintenance')::int AS maintenance_room_days,
           COALESCE(vacancy.longest_vacant_days, 0)::int AS longest_vacant_days,
           COALESCE(vacancy.ending_vacant_days, 0)::int AS ending_vacant_days,
           MAX(operational_status) FILTER (
             WHERE day=(bounds.end_date - INTERVAL '1 day')::date
           ) AS ending_status,
           BOOL_OR(room_day.has_current_tenant AND room_day.legacy_starts_on IS NULL)
             AS inferred_occupancy_start
    FROM classified_days room_day
    CROSS JOIN bounds
    LEFT JOIN vacant_metrics vacancy ON vacancy.room_id=room_day.room_id
    GROUP BY room_day.room_id, room_day.room_name, room_day.property_id,
             room_day.property_name, vacancy.longest_vacant_days,
             vacancy.ending_vacant_days
    ORDER BY room_day.property_name, room_day.room_name, room_day.room_id`;
}

function sendFinancialReportError(res, error) {
  if (!(error instanceof FinancialReportError)) return false;
  res.status(error.statusCode).json({ error: error.message, code: error.code });
  return true;
}

async function validateReportFilters(query, userId, filters, allowedPropertyIds) {
  if (allowedPropertyIds !== null
      && filters.propertyId !== null
      && !allowedPropertyIds.includes(filters.propertyId)) {
    throw new FinancialReportError(403, 'REPORT_PROPERTY_FORBIDDEN', 'Bạn chưa được giao khu này');
  }
  if (filters.propertyId !== null) {
    const property = await query(
      'SELECT id FROM properties WHERE user_id=$1 AND id=$2',
      [userId, filters.propertyId]
    );
    if (!property.rows[0]) {
      throw new FinancialReportError(404, 'REPORT_PROPERTY_NOT_FOUND', 'Không tìm thấy khu');
    }
  }
  if (filters.roomId !== null) {
    const room = await query(
      'SELECT id, property_id FROM rooms WHERE user_id=$1 AND id=$2',
      [userId, filters.roomId]
    );
    if (!room.rows[0]) {
      throw new FinancialReportError(404, 'REPORT_ROOM_NOT_FOUND', 'Không tìm thấy phòng');
    }
    const roomPropertyId = Number(room.rows[0].property_id);
    if (filters.propertyId !== null && roomPropertyId !== filters.propertyId) {
      throw new FinancialReportError(400, 'REPORT_ROOM_PROPERTY_MISMATCH', 'Phòng không thuộc khu đã chọn');
    }
    if (allowedPropertyIds !== null && !allowedPropertyIds.includes(roomPropertyId)) {
      throw new FinancialReportError(403, 'REPORT_ROOM_FORBIDDEN', 'Bạn chưa được giao phòng này');
    }
  }
}

async function getFinancialReport(req, res, dependencies = {}) {
  let range;
  let filters;
  try {
    range = reportRange(req.query);
    filters = reportFilters(req.query);
  } catch (error) {
    if (sendFinancialReportError(res, error)) return res;
    throw error;
  }

  const query = dependencies.query || db.query;
  const allowedPropertyIds = req.workspace?.isOwner === false
    ? [...new Set((req.workspace.propertyIds || []).map(Number).filter(Number.isSafeInteger))]
    : null;
  try {
    await validateReportFilters(query, req.userId, filters, allowedPropertyIds);
  } catch (error) {
    if (sendFinancialReportError(res, error)) return res;
    throw error;
  }
  const params = [
    req.userId,
    range.fromPeriod,
    range.toPeriod,
    filters.propertyId,
    filters.roomId,
    allowedPropertyIds
  ];
  const [result, occupancyResult] = await Promise.all([
    query(reportSql(), params),
    query(occupancyReportSql(), params)
  ]);
  res.set('Cache-Control', 'no-store');
  return res.json({
    report: {
      ...financialReportJson(result.rows[0] || {}, range, filters),
      occupancy: occupancyReportJson(occupancyResult.rows || [], range)
    }
  });
}

async function getMonthlyFinancialReport(req, res, dependencies = {}) {
  req.query = { ...req.query, periodType: 'month' };
  return getFinancialReport(req, res, dependencies);
}

module.exports = {
  FinancialReportError,
  PERIOD_PATTERN,
  REPORT_TIME_ZONE,
  financialReportJson,
  getFinancialReport,
  getMonthlyFinancialReport,
  occupancyReportJson,
  occupancyReportSql,
  occupancyRoomJson,
  optionalPropertyId,
  optionalRoomId,
  percentage,
  reportFilters,
  reportPeriod,
  reportRange,
  reportSql,
  sendFinancialReportError,
  validateReportFilters
};
