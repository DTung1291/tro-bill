'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  financialReportJson,
  getMonthlyFinancialReport,
  reportPeriod,
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

test('chuẩn hóa báo cáo và tính lợi nhuận tiền mặt từ thực thu trừ chi phí', () => {
  assert.deepEqual(financialReportJson(metricRow(), '2026-09'), {
    period: '2026-09',
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
});

test('chỉ chấp nhận kỳ báo cáo YYYY-MM hợp lệ', () => {
  assert.equal(reportPeriod('2026-09'), '2026-09');
  assert.throws(
    () => reportPeriod('2026-13'),
    error => error.code === 'INVALID_REPORT_PERIOD' && error.statusCode === 400
  );
  assert.throws(() => reportPeriod(''), /Tháng báo cáo không hợp lệ/);
});

test('SQL không cộng lặp nợ cũ, chốt cuối tháng theo giờ Việt Nam và loại cọc khỏi thực thu', () => {
  const sql = reportSql(false);
  assert.match(sql, /COALESCE\(invoice\.final_total_vnd, invoice\.issued_total_vnd\)/);
  assert.match(sql, /invoice\.period<=\$2/);
  assert.match(sql, /GREATEST\(invoice_total_vnd - paid_by_period_end_vnd, 0\)/);
  assert.match(sql, /transaction\.occurred_at AT TIME ZONE 'Asia\/Ho_Chi_Minh'/);
  assert.match(sql, /transaction\.entry_type IN \('payment', 'reversal'\)/);
  assert.match(sql, /transaction\.payment_method<>'deposit'/);
  assert.match(sql, /expense\.period=\$2/);
  assert.doesNotMatch(sql, /prior_debt_vnd/);
});

test('API dùng scope khu của nhân viên và không lộ chi phí chung khi chưa được giao toàn bộ khu', async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    return { rows: [metricRow()] };
  };
  const response = responseRecorder();
  await getMonthlyFinancialReport({
    userId: 7,
    query: { period: '2026-09' },
    workspace: { isOwner: false, propertyIds: [12, 12, 13] }
  }, response.res, { query });

  assert.deepEqual(calls[0].params, [7, '2026-09', [12, 13]]);
  assert.match(calls[0].sql, /scoped_room\.property_id=ANY\(\$3::bigint\[\]\)/);
  assert.match(calls[0].sql, /unassigned_property\.id=ANY\(\$3::bigint\[\]\)/);
  assert.equal(response.record.headers['cache-control'], 'no-store');
  assert.equal(response.record.body.report.profitVnd, 3500000);
});

test('API chủ sở hữu tổng hợp toàn tài khoản và trả lỗi kỳ sai trước khi query', async () => {
  let queryCount = 0;
  const query = async () => {
    queryCount += 1;
    return { rows: [metricRow()] };
  };
  const ownerResponse = responseRecorder();
  await getMonthlyFinancialReport({
    userId: 7,
    query: { period: '2026-09' },
    workspace: { isOwner: true, propertyIds: null }
  }, ownerResponse.res, { query });
  assert.equal(queryCount, 1);
  assert.equal(ownerResponse.record.statusCode, 200);

  const invalidResponse = responseRecorder();
  await getMonthlyFinancialReport({
    userId: 7,
    query: { period: '09/2026' },
    workspace: { isOwner: true }
  }, invalidResponse.res, { query });
  assert.equal(queryCount, 1);
  assert.equal(invalidResponse.record.statusCode, 400);
  assert.equal(invalidResponse.record.body.code, 'INVALID_REPORT_PERIOD');
});

test('route và giao diện nối báo cáo máy chủ, có trạng thái tải và layout mobile', () => {
  const root = path.join(__dirname, '..', '..');
  const indexSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const apiSource = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const cssSource = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const serverSource = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');

  assert.match(serverSource, /\/api\/financial-reports\/monthly/);
  assert.match(serverSource, /requireWorkspace\('overview'\)/);
  assert.match(apiSource, /getMonthlyFinancialReport/);
  assert.match(indexSource, /id="financial-report-revenue"/);
  assert.match(indexSource, /id="financial-report-collected"/);
  assert.match(indexSource, /id="financial-report-outstanding"/);
  assert.match(indexSource, /id="financial-report-expenses"/);
  assert.match(indexSource, /id="financial-report-profit"/);
  assert.match(appSource, /FINANCIAL_REPORT_CACHE/);
  assert.match(appSource, /loadFinancialReport\(STATE\.currentPeriod/);
  assert.match(appSource, /Đã phân bổ vào hóa đơn/);
  assert.doesNotMatch(appSource, /Thực thu \(đã trừ khấu hao\)/);
  assert.match(cssSource, /\.financial-report-grid\s*\{/);
  assert.match(cssSource, /grid-template-columns: 1fr 1fr/);
  assert.match(indexSource, /style\.css\?v=116/);
  assert.match(indexSource, /api\.js\?v=109/);
  assert.match(indexSource, /app\.js\?v=120/);
});
