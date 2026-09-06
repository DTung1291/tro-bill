'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  financialReportJson,
  getFinancialReport,
  getMonthlyFinancialReport,
  reportFilters,
  reportPeriod,
  reportRange,
  reportSql
} = require('../financial-reports');

function responseRecorder() {
  const record = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { record.statusCode = code; return res; },
    set(name, value) { record.headers[String(name).toLowerCase()] = value; return res; },
    json(body) { record.body = body; return res; }
  };
  return { record, res };
}

function metricRow(overrides = {}) {
  return {
    revenue_vnd: '6000000',
    collected_vnd: '4750000',
    outstanding_vnd: '2250000',
    expenses_vnd: '1250000',
    invoice_count: 2,
    unpaid_invoice_count: 1,
    generated_at: new Date('2026-09-06T03:00:00.000Z'),
    ...overrides
  };
}

test('chuẩn hóa báo cáo theo khoảng lọc và tính lợi nhuận tiền mặt', () => {
  const range = reportRange({ periodType: 'quarter', period: '2026-Q3' });
  assert.deepEqual(financialReportJson(metricRow(), range, { propertyId: 12, roomId: null }), {
    period: '2026-Q3',
    range: {
      type: 'quarter',
      key: '2026-Q3',
      fromPeriod: '2026-07',
      toPeriod: '2026-09'
    },
    filters: { propertyId: 12, roomId: null, expenseMode: 'property_only' },
    timeZone: 'Asia/Ho_Chi_Minh',
    revenueVnd: 6000000,
    collectedVnd: 4750000,
    outstandingVnd: 2250000,
    expensesVnd: 1250000,
    profitVnd: 3500000,
    invoiceCount: 2,
    unpaidInvoiceCount: 1,
    generatedAt: '2026-09-06T03:00:00.000Z'
  });
  assert.equal(
    financialReportJson(metricRow(), range, { propertyId: 12, roomId: 'A101' }).filters.expenseMode,
    'linked_room_only'
  );
});

test('chấp nhận tháng, quý, năm và quy đổi đúng khoảng tháng', () => {
  assert.equal(reportPeriod('2026-09'), '2026-09');
  assert.deepEqual(reportRange({ periodType: 'month', period: '2026-09' }), {
    type: 'month', key: '2026-09', fromPeriod: '2026-09', toPeriod: '2026-09'
  });
  assert.deepEqual(reportRange({ periodType: 'quarter', period: '2026-q4' }), {
    type: 'quarter', key: '2026-Q4', fromPeriod: '2026-10', toPeriod: '2026-12'
  });
  assert.deepEqual(reportRange({ periodType: 'year', period: '2026' }), {
    type: 'year', key: '2026', fromPeriod: '2026-01', toPeriod: '2026-12'
  });
  assert.throws(() => reportRange({ periodType: 'quarter', period: '2026-Q5' }), error => (
    error.code === 'INVALID_REPORT_PERIOD' && error.statusCode === 400
  ));
  assert.throws(() => reportRange({ periodType: 'year', period: '0999' }), /Năm báo cáo không hợp lệ/);
  assert.throws(() => reportRange({ periodType: 'week', period: '2026-09' }), error => (
    error.code === 'INVALID_REPORT_PERIOD_TYPE'
  ));
});

test('chuẩn hóa bộ lọc khu và phòng, từ chối định danh sai', () => {
  assert.deepEqual(reportFilters({ propertyId: '12', roomId: ' A101 ' }), {
    propertyId: 12,
    roomId: 'A101'
  });
  assert.deepEqual(reportFilters({ propertyId: '', roomId: '' }), {
    propertyId: null,
    roomId: null
  });
  assert.throws(() => reportFilters({ propertyId: '-1' }), error => (
    error.code === 'INVALID_REPORT_PROPERTY'
  ));
  assert.throws(() => reportFilters({ roomId: 'x'.repeat(201) }), error => (
    error.code === 'INVALID_REPORT_ROOM'
  ));
});

test('SQL chốt nợ cuối kỳ, lọc khoảng thời gian/khu/phòng và không phân bổ chi phí chung', () => {
  const sql = reportSql();
  assert.match(sql, /COALESCE\(invoice\.final_total_vnd, invoice\.issued_total_vnd\)/);
  assert.match(sql, /invoice\.period<=\$3/);
  assert.match(sql, /period BETWEEN \$2 AND \$3/);
  assert.match(sql, /GREATEST\(invoice_total_vnd - paid_by_period_end_vnd, 0\)/);
  assert.match(sql, /transaction\.occurred_at AT TIME ZONE 'Asia\/Ho_Chi_Minh'/);
  assert.match(sql, /transaction\.entry_type IN \('payment', 'reversal'\)/);
  assert.match(sql, /transaction\.payment_method<>'deposit'/);
  assert.match(sql, /filter_room\.property_id=\$4/);
  assert.match(sql, /transaction_invoice\.room_id=\$5/);
  assert.match(sql, /expense\.period BETWEEN \$2 AND \$3/);
  assert.match(sql, /expense\.maintenance_room_id_snapshot=\$5/);
  assert.match(sql, /expense\.property_id=\$4/);
  assert.doesNotMatch(sql, /prior_debt_vnd/);
});

test('API chủ sở hữu tổng hợp theo quý và lọc khu đã xác thực', async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT id FROM properties/.test(sql)) return { rows: [{ id: 12 }] };
    return { rows: [metricRow()] };
  };
  const response = responseRecorder();
  await getFinancialReport({
    userId: 7,
    query: { periodType: 'quarter', period: '2026-Q3', propertyId: '12' },
    workspace: { isOwner: true, propertyIds: null }
  }, response.res, { query });

  assert.deepEqual(calls[0].params, [7, 12]);
  assert.deepEqual(calls[1].params, [7, '2026-07', '2026-09', 12, null, null]);
  assert.equal(response.record.headers['cache-control'], 'no-store');
  assert.equal(response.record.body.report.period, '2026-Q3');
  assert.equal(response.record.body.report.filters.propertyId, 12);
  assert.equal(response.record.body.report.profitVnd, 3500000);
});

test('API xác thực phòng thuộc khu và trả lỗi khi bộ lọc không khớp', async () => {
  let metricQueryCount = 0;
  const query = async sql => {
    if (/SELECT id FROM properties/.test(sql)) return { rows: [{ id: 12 }] };
    if (/SELECT id, property_id FROM rooms/.test(sql)) return { rows: [{ id: 'B201', property_id: 13 }] };
    metricQueryCount += 1;
    return { rows: [metricRow()] };
  };
  const response = responseRecorder();
  await getFinancialReport({
    userId: 7,
    query: { periodType: 'month', period: '2026-09', propertyId: '12', roomId: 'B201' },
    workspace: { isOwner: true }
  }, response.res, { query });

  assert.equal(metricQueryCount, 0);
  assert.equal(response.record.statusCode, 400);
  assert.equal(response.record.body.code, 'REPORT_ROOM_PROPERTY_MISMATCH');
});

test('API dùng scope khu của nhân viên và chặn khu ngoài phân công', async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [metricRow()] };
  };
  const response = responseRecorder();
  await getFinancialReport({
    userId: 7,
    query: { periodType: 'year', period: '2026' },
    workspace: { isOwner: false, propertyIds: [12, 12, 13] }
  }, response.res, { query });

  assert.deepEqual(calls[0].params, [7, '2026-01', '2026-12', null, null, [12, 13]]);
  assert.match(calls[0].sql, /scoped_room\.property_id=ANY\(\$6::bigint\[\]\)/);
  assert.match(calls[0].sql, /unassigned_property\.id=ANY\(\$6::bigint\[\]\)/);

  const forbidden = responseRecorder();
  await getFinancialReport({
    userId: 7,
    query: { periodType: 'month', period: '2026-09', propertyId: '99' },
    workspace: { isOwner: false, propertyIds: [12, 13] }
  }, forbidden.res, { query });
  assert.equal(calls.length, 1);
  assert.equal(forbidden.record.statusCode, 403);
  assert.equal(forbidden.record.body.code, 'REPORT_PROPERTY_FORBIDDEN');
});

test('route tháng cũ vẫn tương thích và lỗi kỳ sai không query database', async () => {
  let queryCount = 0;
  const query = async () => {
    queryCount += 1;
    return { rows: [metricRow()] };
  };
  const legacy = responseRecorder();
  await getMonthlyFinancialReport({
    userId: 7,
    query: { period: '2026-09' },
    workspace: { isOwner: true }
  }, legacy.res, { query });
  assert.equal(queryCount, 1);
  assert.equal(legacy.record.body.report.range.type, 'month');

  const invalid = responseRecorder();
  await getFinancialReport({
    userId: 7,
    query: { periodType: 'quarter', period: '09/2026' },
    workspace: { isOwner: true }
  }, invalid.res, { query });
  assert.equal(queryCount, 1);
  assert.equal(invalid.record.statusCode, 400);
  assert.equal(invalid.record.body.code, 'INVALID_REPORT_PERIOD');
});

test('route và giao diện nối đủ bộ lọc, trạng thái tải và layout mobile', () => {
  const root = path.join(__dirname, '..', '..');
  const indexSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const apiSource = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const cssSource = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const serverSource = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');

  assert.match(serverSource, /\/api\/financial-reports\/summary/);
  assert.match(serverSource, /\/api\/financial-reports\/monthly/);
  assert.match(serverSource, /requireWorkspace\('overview'\)/);
  assert.match(apiSource, /function getFinancialReport\(filters = \{\}\)/);
  assert.match(apiSource, /periodType: filters\.periodType/);
  assert.match(indexSource, /id="financial-report-period-type"/);
  assert.match(indexSource, /id="financial-report-year"/);
  assert.match(indexSource, /id="financial-report-quarter"/);
  assert.match(indexSource, /id="financial-report-property"/);
  assert.match(indexSource, /id="financial-report-room"/);
  assert.match(appSource, /reloadFinancialReportFromFilters/);
  assert.match(appSource, /FINANCIAL_REPORT_FILTER\.propertyId/);
  assert.match(appSource, /FINANCIAL_REPORT_FILTER\.roomId/);
  assert.match(cssSource, /\.financial-report-filters\s*\{/);
  assert.match(cssSource, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(indexSource, /style\.css\?v=117/);
  assert.match(indexSource, /api\.js\?v=110/);
  assert.match(indexSource, /app\.js\?v=121/);
});
