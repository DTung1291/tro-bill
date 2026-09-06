'use strict';

const db = require('./db');

const PERIOD_PATTERN = /^[0-9]{4}-(0[1-9]|1[0-2])$/;
const REPORT_TIME_ZONE = 'Asia/Ho_Chi_Minh';

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
    throw new FinancialReportError(
      400,
      'INVALID_REPORT_PERIOD',
      'Tháng báo cáo không hợp lệ'
    );
  }
  return period;
}

function amount(value) {
  return Math.round(Number(value) || 0);
}

function financialReportJson(row, period) {
  const revenueVnd = amount(row.revenue_vnd);
  const collectedVnd = amount(row.collected_vnd);
  const outstandingVnd = Math.max(0, amount(row.outstanding_vnd));
  const expensesVnd = amount(row.expenses_vnd);
  return {
    period,
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

function scopeSql(scoped) {
  if (!scoped) {
    return {
      invoice: '',
      transaction: '',
      expense: ''
    };
  }
  const roomScope = (invoiceAlias) => `
        AND EXISTS (
          SELECT 1 FROM rooms scoped_room
          WHERE scoped_room.user_id=${invoiceAlias}.user_id
            AND scoped_room.id=${invoiceAlias}.room_id
            AND scoped_room.property_id=ANY($3::bigint[])
        )`;
  return {
    invoice: roomScope('invoice'),
    transaction: roomScope('transaction_invoice'),
    expense: `
        AND (
          expense.property_id=ANY($3::bigint[])
          OR (
            expense.property_id IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM properties unassigned_property
              WHERE unassigned_property.user_id=$1
                AND NOT (unassigned_property.id=ANY($3::bigint[]))
            )
          )
        )`
  };
}

function reportSql(scoped = false) {
  const scope = scopeSql(scoped);
  return `
    WITH bounds AS (
      SELECT to_date($2 || '-01', 'YYYY-MM-DD') AS start_date,
             to_date($2 || '-01', 'YYYY-MM-DD') + INTERVAL '1 month' AS end_date
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
        AND invoice.period<=$2${scope.invoice}
      GROUP BY invoice.id, bounds.end_date
    ),
    invoice_metrics AS (
      SELECT COALESCE(SUM(invoice_total_vnd) FILTER (WHERE period=$2), 0) AS revenue_vnd,
             COUNT(*) FILTER (WHERE period=$2)::int AS invoice_count,
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
        AND transaction.occurred_at AT TIME ZONE '${REPORT_TIME_ZONE}' < bounds.end_date${scope.transaction}
    ),
    expense_metrics AS (
      SELECT COALESCE(SUM(expense.amount), 0) AS expenses_vnd
      FROM expense_entries expense
      WHERE expense.user_id=$1 AND expense.period=$2${scope.expense}
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

async function getMonthlyFinancialReport(req, res, dependencies = {}) {
  let period;
  try {
    period = reportPeriod(req.query?.period);
  } catch (error) {
    if (sendFinancialReportError(res, error)) return res;
    throw error;
  }

  const query = dependencies.query || db.query;
  const propertyIds = req.workspace?.isOwner === false
    ? [...new Set((req.workspace.propertyIds || []).map(Number).filter(Number.isSafeInteger))]
    : null;
  const params = propertyIds === null
    ? [req.userId, period]
    : [req.userId, period, propertyIds];
  const result = await query(reportSql(propertyIds !== null), params);
  res.set('Cache-Control', 'no-store');
  return res.json({ report: financialReportJson(result.rows[0] || {}, period) });
}

module.exports = {
  FinancialReportError,
  PERIOD_PATTERN,
  REPORT_TIME_ZONE,
  financialReportJson,
  getMonthlyFinancialReport,
  reportPeriod,
  reportSql,
  sendFinancialReportError
};
