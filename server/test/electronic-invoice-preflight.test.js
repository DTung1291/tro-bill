'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-electronic-invoice-preflight-tests';
process.env.RATE_LIMIT_HASH_SECRET ||= 'test-rate-limit-secret-for-electronic-invoice-preflight';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  buildPreflight,
  canonicalInvoiceLines,
  getElectronicInvoicePreflight,
  periodBounds
} = require('../electronic-invoice-preflight');

function responseRecorder() {
  const record = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; },
    set(name, value) { record.headers[name] = value; return res; }
  };
  return { record, res };
}

function detailSnapshot() {
  return {
    rent: { amountVnd: 3000000, basePriceVnd: 3000000, chargedDays: 31, daysInMonth: 31, prorated: false },
    electricity: { units: 100, rateVnd: 3500, amountVnd: 350000 },
    water: { billingType: 'person', units: 2, rateVnd: 100000, amountVnd: 200000 },
    services: { trashVnd: 50000, wifiVnd: 100000, managementVnd: 0 },
    adjustments: { discountVnd: 100000, surchargeVnd: 0, lateFeeVnd: 0 }
  };
}

function invoiceRow(overrides = {}) {
  return {
    id: 8,
    room_id: 'room-1',
    room_name_snapshot: 'P101',
    period: '2026-08',
    issued_total_vnd: 3600000,
    detail_snapshot: detailSnapshot(),
    final_total_vnd: null,
    final_detail_snapshot: null,
    finalization_contract_id: null,
    finalized_at: null,
    paid_amount_vnd: 1000000,
    transaction_count: 1,
    ...overrides
  };
}

function profileRow(overrides = {}) {
  return {
    seller_legal_name: 'Hộ kinh doanh Nguyễn Thị Bông',
    tax_code: '0123456789',
    business_address: '40 Vũ Hữu, Đà Nẵng',
    provider: 'misa_meinvoice',
    provider_credential_ref: 'secret://workspace/7/einvoice',
    provider_credential_verified_at: '2026-09-07T00:00:00.000Z',
    eligibility_status: 'required_ready',
    reviewed_at: '2026-09-07T00:00:00.000Z',
    invoice_type: 'sales',
    invoice_template_code: '1C26TAA',
    invoice_series: 'C26TAA',
    signing_method: 'remote_signing',
    effective_from: '2026-01-01',
    expires_on: null,
    ...overrides
  };
}

function contractRow(id = 11, overrides = {}) {
  return {
    id,
    contract_code: `HD-2026-${String(id).padStart(6, '0')}`,
    tenant_name_snapshot: 'Nguyễn Văn A',
    tenant_address_snapshot: 'Đà Nẵng',
    tenant_cccd_snapshot: '012345678901',
    tenant_phone_snapshot: '0900000000',
    tenant_email: 'tenant@example.com',
    starts_on: '2026-01-01',
    ends_on: null,
    ...overrides
  };
}

test('chuẩn hóa các khoản thu và giữ discount là dòng âm', () => {
  const lines = canonicalInvoiceLines(detailSnapshot());
  assert.equal(lines.length, 6);
  assert.equal(lines.find(line => line.code === 'discount').amountVnd, -100000);
  assert.equal(lines.reduce((sum, line) => sum + line.amountVnd, 0), 3600000);
  assert.deepEqual(periodBounds('2026-02'), { start: '2026-02-01', end: '2026-02-28' });
});

test('tiền kiểm tạo snapshot tối thiểu, tổng đúng và không cho phép gửi', () => {
  const preflight = buildPreflight({
    invoice: invoiceRow(),
    profile: profileRow(),
    contracts: [contractRow()]
  });
  assert.equal(preflight.dispatchAllowed, false);
  assert.deepEqual(preflight.blockers, []);
  assert.equal(preflight.snapshot.buyer.name, 'Nguyễn Văn A');
  assert.equal(preflight.snapshot.invoice.totalVnd, 3600000);
  assert.equal(preflight.snapshot.collection.remainingVnd, 2600000);
  assert.match(preflight.sourceFingerprint, /^[a-f0-9]{64}$/);
  const serialized = JSON.stringify(preflight);
  assert.doesNotMatch(serialized, /012345678901/);
  assert.doesNotMatch(serialized, /0900000000/);
  assert.doesNotMatch(serialized, /tenant@example\.com/);
  assert.doesNotMatch(serialized, /secret:\/\//);
});

test('không tự đoán khách khi nhiều hợp đồng cùng thuộc kỳ', () => {
  const preflight = buildPreflight({
    invoice: invoiceRow(),
    profile: profileRow(),
    contracts: [
      contractRow(11, { ends_on: '2026-08-10' }),
      contractRow(12, { starts_on: '2026-08-11', tenant_name_snapshot: 'Trần Thị B' })
    ]
  });
  assert.equal(preflight.snapshot.buyer, null);
  assert.equal(preflight.contractCandidates.length, 2);
  assert.equal(preflight.blockers.some(item => (
    item.code === 'ELECTRONIC_INVOICE_CONTRACT_SELECTION_REQUIRED'
  )), true);

  const selected = buildPreflight({
    invoice: invoiceRow(),
    profile: profileRow(),
    contracts: [contractRow(11), contractRow(12, { tenant_name_snapshot: 'Trần Thị B' })],
    selectedContractId: 12
  });
  assert.equal(selected.snapshot.buyer.name, 'Trần Thị B');
});

test('hóa đơn đã chốt luôn khóa đúng hợp đồng quyết toán và kiểm tra hiệu lực hồ sơ', () => {
  const contracts = [contractRow(11), contractRow(12, { tenant_name_snapshot: 'Trần Thị B' })];
  const preflight = buildPreflight({
    invoice: invoiceRow({ finalization_contract_id: 12, finalized_at: '2026-08-31T00:00:00.000Z' }),
    profile: profileRow({ expires_on: '2026-07-31' }),
    contracts
  });
  assert.equal(preflight.snapshot.buyer.contractId, 12);
  assert.equal(preflight.blockers.some(item => item.code === 'ELECTRONIC_INVOICE_PROFILE_EXPIRED'), true);
  assert.equal(preflight.blockers.some(item => (
    item.code === 'ELECTRONIC_INVOICE_CONTRACT_SELECTION_REQUIRED'
  )), false);
  assert.throws(
    () => buildPreflight({
      invoice: invoiceRow({ finalization_contract_id: 12 }),
      profile: profileRow(),
      contracts,
      selectedContractId: 11
    }),
    error => error.code === 'ELECTRONIC_INVOICE_FINALIZATION_CONTRACT_MISMATCH'
  );
});

test('profile hoặc chi tiết chưa đủ được trả thành blocker thay vì gửi dữ liệu', () => {
  const preflight = buildPreflight({
    invoice: invoiceRow({ detail_snapshot: {} }),
    profile: null,
    contracts: []
  });
  assert.equal(preflight.dispatchAllowed, false);
  assert.equal(preflight.blockers.some(item => item.code === 'ELECTRONIC_INVOICE_PROFILE_MISSING'), true);
  assert.equal(preflight.blockers.some(item => item.code === 'ELECTRONIC_INVOICE_CONTRACT_MISSING'), true);
  assert.equal(preflight.blockers.some(item => item.code === 'ELECTRONIC_INVOICE_DETAIL_MISSING'), true);
});

test('endpoint khóa owner, scope user và chỉ chọn hợp đồng giao kỳ', async () => {
  const denied = responseRecorder();
  let deniedQueries = 0;
  await getElectronicInvoicePreflight({
    userId: 7,
    workspace: { isOwner: false },
    params: { invoiceId: '8' },
    query: {}
  }, denied.res, { query: async () => { deniedQueries += 1; return { rows: [] }; } });
  assert.equal(denied.record.statusCode, 403);
  assert.equal(deniedQueries, 0);

  const calls = [];
  const response = responseRecorder();
  await getElectronicInvoicePreflight({
    userId: 7,
    workspace: { isOwner: true },
    params: { invoiceId: '8' },
    query: { contractId: '11' }
  }, response.res, {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.includes('FROM rent_invoices invoice')) return { rows: [invoiceRow()] };
      if (sql.includes('FROM electronic_invoice_profiles')) return { rows: [profileRow()] };
      if (sql.includes('FROM rental_contracts')) return { rows: [contractRow()] };
      return { rows: [] };
    }
  });
  assert.equal(response.record.statusCode, 200);
  assert.equal(response.record.body.preflight.snapshot.buyer.contractId, 11);
  assert.equal(response.record.headers['Cache-Control'], 'no-store');
  const invoiceQuery = calls.find(call => call.sql.includes('FROM rent_invoices invoice'));
  const contractQuery = calls.find(call => call.sql.includes('FROM rental_contracts'));
  assert.deepEqual(invoiceQuery.params, [7, 8]);
  assert.deepEqual(contractQuery.params, [7, 'room-1', '2026-08-01', '2026-08-31']);
  assert.match(contractQuery.sql, /status IN \('active','ended'\)/);
});

test('schema, route và UI công khai rõ đây là tiền kiểm không phát hành', () => {
  const root = path.join(__dirname, '..', '..');
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260907_electronic_invoice_preflight.sql'),
    'utf8'
  );
  const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  const health = fs.readFileSync(path.join(root, 'server', 'health.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  for (const source of [schema, migration]) {
    assert.match(source, /seller_legal_name TEXT NOT NULL DEFAULT ''/);
    assert.match(source, /electronic_invoice_profiles_seller_name_length_valid/);
  }
  assert.match(server, /rent-invoices\/:invoiceId\/electronic-invoice-preflight/);
  assert.match(server, /requireWorkspace\('invoices'\)/);
  assert.match(health, /column_name='seller_legal_name'/);
  assert.match(api, /getElectronicInvoicePreflight[\s\S]*electronic-invoice-preflight/);
  assert.match(html, /id="electronic-invoice-preflight-modal"/);
  assert.match(html, /Chỉ tiền kiểm nội bộ/);
  assert.match(app, /dispatchNotice/);
  assert.doesNotMatch(html, />\s*(Gửi|Phát hành) hóa đơn điện tử\s*</i);
});
