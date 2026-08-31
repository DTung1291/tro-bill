'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-final-settlement-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createFinalSettlement,
  finalizeInvoiceDetail,
  getFinalSettlement,
  settlementCode,
  settlementInput,
  verifyHandoverReadings
} = require('../rental-final-settlements');

const root = path.join(__dirname, '..', '..');

function responseRecorder() {
  const record = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; },
    set(name, value) { record.headers[String(name).toLowerCase()] = value; return res; }
  };
  return { record, res };
}

function contractRow(overrides = {}) {
  return {
    id: 36,
    user_id: 7,
    contract_code: 'HD-2026-000010',
    room_id: 'room-1',
    room_name_snapshot: 'P101',
    tenant_id: 'tenant-1',
    tenant_name_snapshot: 'Nguyễn Văn A',
    status: 'ended',
    starts_on: '2026-08-10',
    monthly_rent_vnd: '3100000',
    ...overrides
  };
}

function invoiceDetail(overrides = {}) {
  return {
    rent: {
      amountVnd: 2200000,
      basePriceVnd: 3100000,
      chargedDays: 22,
      daysInMonth: 31,
      prorated: true,
      startsAfterPeriod: false
    },
    electricity: {
      previousReading: 100,
      currentReading: 130,
      units: 30,
      rateVnd: 3333,
      amountVnd: 100000
    },
    water: {
      billingType: 'cubic_meter',
      previousReading: 35,
      currentReading: 40,
      units: 5,
      rateVnd: 10000,
      amountVnd: 50000
    },
    services: { trashVnd: 50000, wifiVnd: 0, managementVnd: 0 },
    adjustments: { discountVnd: 0, surchargeVnd: 0, lateFeeVnd: 0 },
    utilityOnly: false,
    ...overrides
  };
}

function eventRow() {
  return {
    id: 91,
    event_type: 'checked_out',
    contract_id: 36,
    occurred_on: '2026-08-20'
  };
}

function handoverRow(overrides = {}) {
  return {
    id: 72,
    handover_code: 'BBBG-2026-OUT-000020',
    handover_type: 'check_out',
    occurred_on: '2026-08-20',
    deposit_account_id: 4,
    electricity_reading: '130.000',
    water_reading: '40.000',
    ...overrides
  };
}

function invoiceRow(overrides = {}) {
  return {
    id: 8,
    room_id: 'room-1',
    period: '2026-08',
    issued_total_vnd: '2400000',
    detail_snapshot: invoiceDetail(),
    final_total_vnd: null,
    final_detail_snapshot: null,
    finalization_contract_id: null,
    finalized_at: null,
    ...overrides
  };
}

test('bill cuối tính cả ngày bắt đầu và ngày trả phòng', () => {
  const result = finalizeInvoiceDetail(invoiceDetail(), 2400000, contractRow(), '2026-08-20');
  assert.equal(result.chargedDays, 11);
  assert.equal(result.firstChargedDay, 10);
  assert.equal(result.lastChargedDay, 20);
  assert.equal(result.finalRentVnd, 1100000);
  assert.equal(result.finalTotalVnd, 1300000);
  assert.equal(result.finalDetail.rent.prorated, true);
  assert.equal(settlementCode(36, '2026-08-20'), 'QTT-2026-000010');
});

test('bill cuối của tháng đầy đủ giữ nguyên đủ số ngày', () => {
  const fullDetail = invoiceDetail({
    rent: {
      amountVnd: 3100000,
      basePriceVnd: 3100000,
      chargedDays: 31,
      daysInMonth: 31,
      prorated: false,
      startsAfterPeriod: false
    }
  });
  const result = finalizeInvoiceDetail(fullDetail, 3300000, contractRow({ starts_on: '2026-07-10' }), '2026-08-31');
  assert.equal(result.chargedDays, 31);
  assert.equal(result.finalRentVnd, 3100000);
  assert.equal(result.finalTotalVnd, 3300000);
  assert.equal(result.finalDetail.rent.prorated, false);
});

test('chặn quyết toán nếu chỉ số trả phòng không khớp hóa đơn', () => {
  assert.throws(
    () => verifyHandoverReadings(handoverRow({ electricity_reading: '131.000' }), invoiceDetail()),
    (error) => error.code === 'FINAL_HANDOVER_READING_MISMATCH'
  );
});

test('input bắt buộc xử lý toàn bộ số dư cọc và lý do đủ dài ở bước nghiệp vụ', () => {
  const input = settlementInput({
    depositAppliedVnd: 1300000,
    depositRefundedVnd: 1700000,
    refundMethod: 'bank_transfer',
    reason: 'Khách đã trả phòng và hai bên đối chiếu đầy đủ'
  });
  assert.equal(input.depositAppliedVnd, 1300000);
  assert.throws(
    () => settlementInput({ depositAppliedVnd: 0, depositRefundedVnd: 0, reason: 'ngắn' }),
    (error) => error.code === 'INVALID_FINAL_SETTLEMENT_REASON'
  );
});

function contextQuery(calls, options = {}) {
  return async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM rental_final_settlements')) return { rows: [] };
    if (sql.includes('FROM rental_contracts')) return { rows: [contractRow()] };
    if (sql.includes('FROM rental_lifecycle_events')) return { rows: [eventRow()] };
    if (sql.includes('FROM rental_handover_records')) return { rows: [handoverRow()] };
    if (sql.includes('FROM rent_invoices') && sql.includes('room_id=$2 AND period=$3')) {
      return { rows: [invoiceRow()] };
    }
    if (sql.includes('FROM tenant_deposit_accounts account')) {
      return { rows: [{ id: 4, tenant_id: 'tenant-1', balance_vnd: '3000000' }] };
    }
    if (sql.includes('SELECT id FROM rent_invoices')) return { rows: [{ id: 8 }] };
    if (sql.includes('AS effective_total_vnd')) {
      return { rows: [{ id: 8, period: '2026-08', effective_total_vnd: '2400000', paid_amount_vnd: options.paid || '0' }] };
    }
    return { rows: [] };
  };
}

test('GET preview trả số ngày, số dư cọc và gợi ý phân bổ nhưng chưa ghi ledger', async () => {
  const calls = [];
  const response = responseRecorder();
  await getFinalSettlement(
    { userId: 7, params: { id: '36' } },
    response.res,
    { query: contextQuery(calls) }
  );
  assert.equal(response.record.statusCode, 200);
  assert.equal(response.record.body.finalized, false);
  assert.equal(response.record.body.preview.invoice.chargedDays, 11);
  assert.equal(response.record.body.preview.invoice.finalTotalVnd, 1300000);
  assert.equal(response.record.body.preview.deposit.suggestedAppliedVnd, 1300000);
  assert.equal(response.record.body.preview.deposit.suggestedRefundedVnd, 1700000);
  assert.equal(response.record.headers['cache-control'], 'no-store');
  assert.equal(calls.some((call) => call.sql.includes('INSERT INTO')), false);
});

test('POST quyết toán ghi invoice, phiếu thu, hai bút toán cọc và biên quyết toán trong một transaction', async () => {
  const calls = [];
  let depositSequence = 300;
  const baseQuery = contextQuery(calls);
  const client = {
    async query(sql, params = []) {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK'
          || sql.includes('pg_advisory_xact_lock')) {
        calls.push({ sql, params });
        return { rows: [] };
      }
      if (sql.includes('COUNT(*)::int AS room_count')) {
        calls.push({ sql, params });
        return { rows: [{ room_count: 1 }] };
      }
      if (sql.includes('UPDATE rent_invoices')) {
        calls.push({ sql, params });
        return { rows: [{ id: 8 }] };
      }
      if (sql.includes("nextval('rent_payment_receipts_id_seq')")) {
        calls.push({ sql, params });
        return { rows: [{ id: 100 }] };
      }
      if (sql.includes('INSERT INTO rent_payment_receipts')) {
        calls.push({ sql, params });
        return { rows: [{ id: 100, receipt_code: 'PT-202608-00002S' }] };
      }
      if (sql.includes('INSERT INTO rent_payment_transactions')) {
        calls.push({ sql, params });
        return { rows: [{ id: 200 }] };
      }
      if (sql.includes("nextval('tenant_deposit_transactions_id_seq')")) {
        calls.push({ sql, params });
        depositSequence += 1;
        return { rows: [{ id: depositSequence }] };
      }
      if (sql.includes('INSERT INTO tenant_deposit_transactions')) {
        calls.push({ sql, params });
        return { rows: [{ id: params[0] }] };
      }
      if (sql.includes("nextval('rental_final_settlements_id_seq')")) {
        calls.push({ sql, params });
        return { rows: [{ id: 400 }] };
      }
      if (sql.includes('INSERT INTO rental_final_settlements')) {
        calls.push({ sql, params });
        return { rows: [{
          id: 400,
          settlement_code: params[2],
          contract_id: 36,
          checkout_event_id: 91,
          handover_id: 72,
          invoice_id: 8,
          deposit_account_id: 4,
          rent_payment_receipt_id: 100,
          period: '2026-08',
          occurred_on: '2026-08-20',
          invoice_original_total_vnd: '2400000',
          invoice_final_total_vnd: '1300000',
          prior_debt_vnd: '0',
          paid_before_vnd: '0',
          deposit_balance_before_vnd: '3000000',
          deposit_applied_vnd: '1300000',
          deposit_refunded_vnd: '1700000',
          rent_overpayment_vnd: '0',
          remaining_due_vnd: '0',
          refund_method: 'bank_transfer',
          detail_snapshot: JSON.parse(params[23]),
          reason: params[24],
          created_at: '2026-08-30T00:00:00.000Z'
        }] };
      }
      return baseQuery(sql, params);
    },
    release() {}
  };
  const response = responseRecorder();
  await createFinalSettlement(
    {
      userId: 7,
      params: { id: '36' },
      body: {
        depositAppliedVnd: 1300000,
        depositRefundedVnd: 1700000,
        refundMethod: 'bank_transfer',
        reason: 'Khách đã trả phòng và hai bên đối chiếu đầy đủ'
      }
    },
    response.res,
    { getClient: async () => client, enforceWrite: async () => {} }
  );
  assert.equal(response.record.statusCode, 201);
  assert.equal(response.record.body.settlement.code, 'QTT-2026-0000B4');
  assert.equal(response.record.body.settlement.totalRefundVnd, 1700000);
  assert.equal(calls.filter((call) => call.sql.includes('INSERT INTO tenant_deposit_transactions')).length, 2);
  assert.equal(calls.some((call) => call.sql === 'COMMIT'), true);
  const invoiceUpdate = calls.find((call) => call.sql.includes('UPDATE rent_invoices'));
  assert.equal(invoiceUpdate.params[3], 1300000);
  const receiptInsert = calls.find((call) => call.sql.includes('INSERT INTO rent_payment_receipts'));
  assert.deepEqual(receiptInsert.params.slice(0, 6), [
    100,
    7,
    'room-1',
    '2026-08',
    'PT-202608-00002S',
    1300000
  ]);
  const depositInserts = calls.filter(
    (call) => call.sql.includes('INSERT INTO tenant_deposit_transactions')
  );
  assert.deepEqual(depositInserts.map((call) => call.params[4]), ['deduction', 'refund']);
  assert.deepEqual(depositInserts.map((call) => call.params[5]), [-1300000, -1700000]);
  assert.deepEqual(
    calls.filter(call => call.sql.includes('INSERT INTO data_audit_logs')).map(call => call.params[3]),
    [
      'rental_contract_final_settlement_created',
      'rent_invoice_finalized',
      'rent_payment_transaction_recorded',
      'deposit_transaction_recorded',
      'deposit_transaction_recorded'
    ]
  );
});

test('schema/migration giữ snapshot final bất biến và bảng quyết toán append-only đúng thứ tự', () => {
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260830_rental_final_settlements.sql'),
    'utf8'
  );
  for (const source of [schema, migration]) {
    assert.match(source, /final_total_vnd/);
    assert.match(source, /rent_invoice_finalization_immutable_before_update/);
    assert.match(source, /CREATE TABLE IF NOT EXISTS rental_final_settlements/);
    assert.match(source, /rental_final_settlements_contract_owner_fk/);
    assert.match(source, /REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rental_final_settlements/);
    assert.match(source, /rent_overpayment_vnd/);
  }
  assert.ok(
    schema.indexOf('CREATE TABLE IF NOT EXISTS rental_final_settlements')
      > schema.indexOf('CREATE TABLE IF NOT EXISTS tenant_deposit_transactions')
  );
});

test('API và UI chỉ mở quyết toán sau checkout, có đối chiếu cọc và bản in nhiều trang', () => {
  const serverIndex = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  assert.match(serverIndex, /\/api\/rental-contracts\/:id\/final-settlement/);
  assert.match(api, /getRentalFinalSettlement/);
  assert.match(api, /createRentalFinalSettlement/);
  assert.match(html, /id="rental-final-settlement-modal"/);
  assert.match(app, /event\.eventType === 'checked_out'/);
  assert.match(app, /ensureRentInvoicesSynced\(\)[\s\S]*checkoutRentalContract/);
  assert.match(app, /print-area--rental-final-settlement/);
  assert.match(css, /@page rentalFinalSettlement/);
  assert.match(css, /break-inside: avoid-page/);
});
