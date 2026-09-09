'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  annualRevenueEvidenceJson,
  annualRevenueEvidenceSql,
  financialReportJson,
  getFinancialReport,
  getMonthlyFinancialReport,
  occupancyReportJson,
  occupancyReportSql,
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
    rent_vnd: '4000000',
    electricity_vnd: '500000',
    water_vnd: '250000',
    services_vnd: '500000',
    discount_vnd: '100000',
    surcharge_vnd: '500000',
    late_fee_vnd: '350000',
    adjustment_net_vnd: '750000',
    uncategorized_vnd: '0',
    deposit_collected_vnd: '1000000',
    deposit_refunded_vnd: '200000',
    deposit_deducted_vnd: '300000',
    invoice_count: 2,
    unpaid_invoice_count: 1,
    generated_at: new Date('2026-09-06T03:00:00.000Z'),
    ...overrides
  };
}

function occupancyRow(overrides = {}) {
  return {
    room_id: 'room-a101',
    room_name: 'A101',
    property_id: 12,
    property_name: 'Khu A',
    total_room_days: 92,
    occupied_room_days: 60,
    vacant_room_days: 20,
    reserved_room_days: 5,
    maintenance_room_days: 7,
    longest_vacant_days: 12,
    ending_vacant_days: 4,
    ending_status: 'vacant',
    inferred_occupancy_start: false,
    ...overrides
  };
}

function annualRevenueRows() {
  return [
    {
      row_kind: 'month', period: '2026-01', revenue_vnd: '4000000', rent_vnd: '3000000',
      electricity_vnd: '400000', water_vnd: '200000', services_vnd: '300000',
      adjustment_net_vnd: '100000', uncategorized_vnd: '0', invoice_count: 1
    },
    {
      row_kind: 'month', period: '2026-02', revenue_vnd: '2000000', rent_vnd: '1000000',
      electricity_vnd: '100000', water_vnd: '50000', services_vnd: '100000',
      adjustment_net_vnd: '-50000', uncategorized_vnd: '800000', invoice_count: 1
    },
    {
      row_kind: 'location', property_id: '12', property_name: 'Khu A',
      property_address: '40 Vũ Hữu', revenue_vnd: '6000000', rent_vnd: '4000000',
      electricity_vnd: '500000', water_vnd: '250000', services_vnd: '400000',
      adjustment_net_vnd: '50000', uncategorized_vnd: '800000', invoice_count: 2
    }
  ];
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
    breakdown: {
      invoice: {
        rentVnd: 4000000,
        electricityVnd: 500000,
        waterVnd: 250000,
        servicesVnd: 500000,
        discountVnd: 100000,
        surchargeVnd: 500000,
        lateFeeVnd: 350000,
        adjustmentNetVnd: 750000,
        uncategorizedVnd: 0
      },
      deposit: {
        collectedVnd: 1000000,
        refundedVnd: 200000,
        deductedVnd: 300000,
        netCashflowVnd: 800000
      }
    },
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

test('chuẩn hóa chứng từ đối chiếu doanh thu năm theo tháng và địa điểm', () => {
  const range = reportRange({ periodType: 'year', period: '2026' });
  const result = annualRevenueEvidenceJson(annualRevenueRows(), range, 6000000);
  assert.equal(result.year, 2026);
  assert.equal(result.basis, 'issued_invoice_total');
  assert.equal(result.currency, 'VND');
  assert.equal(result.activeMonthCount, 2);
  assert.equal(result.monthlyRevenueVnd, 6000000);
  assert.equal(result.reconciliationDifferenceVnd, 0);
  assert.equal(result.months[1].adjustmentNetVnd, -50000);
  assert.deepEqual(result.locations[0], {
    propertyId: 12,
    propertyName: 'Khu A',
    propertyAddress: '40 Vũ Hữu',
    revenueVnd: 6000000,
    rentVnd: 4000000,
    electricityVnd: 500000,
    waterVnd: 250000,
    servicesVnd: 400000,
    adjustmentNetVnd: 50000,
    uncategorizedVnd: 800000,
    invoiceCount: 2
  });
  assert.equal(annualRevenueEvidenceJson(annualRevenueRows(), reportRange({
    periodType: 'month', period: '2026-01'
  }), 4000000), null);
});

test('tổng hợp tỷ lệ lấp đầy theo ngày-phòng và chuỗi phòng trống', () => {
  const range = reportRange({ periodType: 'quarter', period: '2026-Q3' });
  const result = occupancyReportJson([
    occupancyRow(),
    occupancyRow({
      room_id: 'room-b201',
      room_name: 'B201',
      property_id: 13,
      property_name: 'Khu B',
      occupied_room_days: 30,
      vacant_room_days: 52,
      reserved_room_days: 10,
      maintenance_room_days: 0,
      longest_vacant_days: 35,
      ending_vacant_days: 0,
      ending_status: 'occupied',
      inferred_occupancy_start: true
    })
  ], range);

  assert.equal(result.calendarDays, 92);
  assert.equal(result.roomCount, 2);
  assert.equal(result.totalRoomDays, 184);
  assert.equal(result.rentableRoomDays, 177);
  assert.equal(result.occupiedRoomDays, 90);
  assert.equal(result.vacantRoomDays, 72);
  assert.equal(result.reservedRoomDays, 15);
  assert.equal(result.maintenanceRoomDays, 7);
  assert.equal(result.occupancyRatePercent, 50.85);
  assert.equal(result.longestVacantDays, 35);
  assert.equal(result.endingVacantRoomCount, 1);
  assert.equal(result.inferredStartRoomCount, 1);
  assert.equal(result.inventoryMode, 'current_rooms');
  assert.equal(result.rooms[0].occupancyRatePercent, 70.59);
  assert.equal(result.rooms[0].endingVacantDays, 4);
  assert.equal(result.rooms[1].endingVacantDays, 0);
});

test('SQL lấp đầy dùng lịch sử hợp đồng, giữ chỗ, sửa chữa và ưu tiên trạng thái', () => {
  const sql = occupancyReportSql();
  assert.match(sql, /FROM rooms room/);
  assert.match(sql, /LEAST\(requested_end_date, CURRENT_DATE \+ INTERVAL '1 day'\)/);
  assert.match(sql, /room\.property_id=ANY\(\$6::bigint\[\]\)/);
  assert.match(sql, /contract\.status IN \('active','ended'\)/);
  assert.match(sql, /event\.event_type IN \('checked_out','room_transferred'\)/);
  assert.match(sql, /legacy_occupancy_spans/);
  assert.match(sql, /FROM rental_reservations reservation/);
  assert.match(sql, /FROM room_maintenance_periods maintenance/);
  assert.match(sql, /WHEN occupied\.room_id IS NOT NULL THEN 'occupied'/);
  assert.match(sql, /WHEN reserved\.room_id IS NOT NULL THEN 'reserved'/);
  assert.match(sql, /WHEN maintenance\.room_id IS NOT NULL THEN 'maintenance'/);
  assert.match(sql, /ROW_NUMBER\(\) OVER \(PARTITION BY room_id ORDER BY day\)/);
  assert.match(sql, /ending_vacant_days/);
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
  assert.match(sql, /COALESCE\(invoice\.final_detail_snapshot, invoice\.detail_snapshot/);
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
  assert.match(sql, /detail_snapshot #> '\{rent,amountVnd\}'/);
  assert.match(sql, /trash_vnd \+ wifi_vnd \+ management_vnd/);
  assert.match(sql, /surcharge_vnd \+ late_fee_vnd - discount_vnd/);
  assert.match(sql, /tenant_deposit_transactions deposit/);
  assert.match(sql, /COALESCE\(original_deposit\.entry_type, deposit\.entry_type\)='collection'/);
  assert.match(sql, /deposit_account\.room_id=\$5/);
  assert.match(sql, /deposit_room\.property_id=\$4/);
  assert.doesNotMatch(sql, /prior_debt_vnd/);
});

test('SQL đối chiếu doanh thu năm đủ 12 tháng, cơ cấu và khu hiện tại', () => {
  const sql = annualRevenueEvidenceSql();
  assert.match(sql, /generate_series/);
  assert.match(sql, /invoice\.period BETWEEN \$2 AND \$3/);
  assert.match(sql, /COALESCE\(invoice\.final_total_vnd, invoice\.issued_total_vnd\)/);
  assert.match(sql, /LEFT JOIN rooms room/);
  assert.match(sql, /LEFT JOIN properties property/);
  assert.match(sql, /room\.property_id=ANY\(\$6::bigint\[\]\)/);
  assert.match(sql, /invoice_total_vnd - rent_vnd - electricity_vnd - water_vnd/);
  assert.match(sql, /'month'::text AS row_kind/);
  assert.match(sql, /'location'::text/);
});

test('API chủ sở hữu tổng hợp theo quý và lọc khu đã xác thực', async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (/SELECT id FROM properties/.test(sql)) return { rows: [{ id: 12 }] };
    if (/classified_days/.test(sql)) return { rows: [occupancyRow()] };
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
  assert.deepEqual(calls[2].params, [7, '2026-07', '2026-09', 12, null, null]);
  assert.equal(response.record.headers['cache-control'], 'no-store');
  assert.equal(response.record.body.report.period, '2026-Q3');
  assert.equal(response.record.body.report.filters.propertyId, 12);
  assert.equal(response.record.body.report.profitVnd, 3500000);
  assert.equal(response.record.body.report.breakdown.deposit.netCashflowVnd, 800000);
  assert.equal(response.record.body.report.occupancy.roomCount, 1);
  assert.equal(response.record.body.report.occupancy.longestVacantDays, 12);
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
    if (/classified_days/.test(sql)) return { rows: [occupancyRow()] };
    if (/generate_series/.test(sql)) return { rows: annualRevenueRows() };
    return { rows: [metricRow()] };
  };
  const response = responseRecorder();
  await getFinancialReport({
    userId: 7,
    query: { periodType: 'year', period: '2026' },
    workspace: { isOwner: false, propertyIds: [12, 12, 13] }
  }, response.res, { query });

  assert.deepEqual(calls[0].params, [7, '2026-01', '2026-12', null, null, [12, 13]]);
  assert.deepEqual(calls[1].params, [7, '2026-01', '2026-12', null, null, [12, 13]]);
  assert.deepEqual(calls[2].params, [7, '2026-01', '2026-12', null, null, [12, 13]]);
  assert.match(calls[0].sql, /scoped_room\.property_id=ANY\(\$6::bigint\[\]\)/);
  assert.match(calls[0].sql, /unassigned_property\.id=ANY\(\$6::bigint\[\]\)/);
  assert.equal(response.record.body.report.annualRevenueEvidence.months.length, 2);
  assert.equal(response.record.body.report.annualRevenueEvidence.reconciliationDifferenceVnd, 0);

  const forbidden = responseRecorder();
  await getFinancialReport({
    userId: 7,
    query: { periodType: 'month', period: '2026-09', propertyId: '99' },
    workspace: { isOwner: false, propertyIds: [12, 13] }
  }, forbidden.res, { query });
  assert.equal(calls.length, 3);
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
  assert.equal(queryCount, 2);
  assert.equal(legacy.record.body.report.range.type, 'month');

  const invalid = responseRecorder();
  await getFinancialReport({
    userId: 7,
    query: { periodType: 'quarter', period: '09/2026' },
    workspace: { isOwner: true }
  }, invalid.res, { query });
  assert.equal(queryCount, 2);
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
  assert.match(indexSource, /id="financial-breakdown-rent"/);
  assert.match(indexSource, /id="financial-breakdown-utilities"/);
  assert.match(indexSource, /id="financial-breakdown-services"/);
  assert.match(indexSource, /id="financial-breakdown-adjustments"/);
  assert.match(indexSource, /id="financial-breakdown-deposit"/);
  assert.match(indexSource, /id="annual-revenue-evidence"/);
  assert.match(indexSource, /id="annual-revenue-month-rows"/);
  assert.match(indexSource, /id="annual-revenue-location-rows"/);
  assert.match(indexSource, /id="occupancy-report-rate"/);
  assert.match(indexSource, /id="occupancy-room-list"/);
  assert.match(appSource, /reloadFinancialReportFromFilters/);
  assert.match(appSource, /function renderFinancialBreakdown/);
  assert.match(appSource, /function renderAnnualRevenueEvidence/);
  assert.match(appSource, /function renderOccupancyReport/);
  assert.match(appSource, /Đang tổng hợp dữ liệu lấp đầy và thời gian phòng trống/);
  assert.match(appSource, /occupancy\.occupancyRatePercent/);
  assert.match(appSource, /deposit\.netCashflowVnd/);
  assert.match(appSource, /FINANCIAL_REPORT_FILTER\.propertyId/);
  assert.match(appSource, /FINANCIAL_REPORT_FILTER\.roomId/);
  assert.match(cssSource, /\.financial-report-filters\s*\{/);
  assert.match(cssSource, /\.financial-breakdown-grid\s*\{/);
  assert.match(cssSource, /\.annual-revenue-table\s*\{/);
  assert.match(cssSource, /\.occupancy-report-grid\s*\{/);
  assert.match(cssSource, /\.occupancy-room-row\s*\{/);
  assert.match(cssSource, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\)/);
  assert.match(indexSource, /style\.css\?v=131/);
  assert.match(indexSource, /api\.js\?v=116/);
  assert.match(indexSource, /app\.js\?v=138/);
});
