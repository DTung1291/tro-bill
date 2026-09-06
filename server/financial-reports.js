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

function financialReportJson(row, rangeOrPeriod, filters = {}) {
  const range = typeof rangeOrPeriod === 'string'
    ? reportRange({ periodType: 'month', period: rangeOrPeriod })
    : rangeOrPeriod;
  const revenueVnd = amount(row.revenue_vnd);
  const collectedVnd = amount(row.collected_vnd);
  const outstandingVnd = Math.max(0, amount(row.outstanding_vnd));
  const expensesVnd = amount(row.expenses_vnd);
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
    invoice_metrics AS (
      SELECT COALESCE(SUM(invoice_total_vnd) FILTER (WHERE period BETWEEN $2 AND $3), 0)
               AS revenue_vnd,
             COUNT(*) FILTER (WHERE period BETWEEN $2 AND $3)::int AS invoice_count,
             COALESCE(SUM(GREATEST(invoice_total_vnd - paid_by_period_end_vnd, 0)), 0)
               AS outstanding_vnd,
             COUNT(*) FILTER (
               WHERE invoice_total_vnd - paid_by_period_end_vnd > 0
             )::int AS unpaid_invoice_count
      FROM invoice_balances
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
           expense_metrics.expenses_vnd, now() AS generated_at
    FROM invoice_metrics, collection_metrics, expense_metrics`;
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
  const result = await query(reportSql(), params);
  res.set('Cache-Control', 'no-store');
  return res.json({ report: financialReportJson(result.rows[0] || {}, range, filters) });
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
  optionalPropertyId,
  optionalRoomId,
  reportFilters,
  reportPeriod,
  reportRange,
  reportSql,
  sendFinancialReportError,
  validateReportFilters
};
