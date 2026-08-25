'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-invoice-detail-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { invoiceDetailInput } = require('../rent-payments');
const { publicInvoiceJson } = require('../rent-invoice-links');

function validDetail() {
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
      currentReading: 150,
      units: 50,
      rateVnd: 3500,
      amountVnd: 175000
    },
    water: {
      billingType: 'cubic_meter',
      previousReading: 20,
      currentReading: 25,
      units: 5,
      rateVnd: 20000,
      amountVnd: 100000
    },
    services: { trashVnd: 50000, wifiVnd: 100000, managementVnd: 0 },
    adjustments: { discountVnd: 25000, surchargeVnd: 10000, lateFeeVnd: 0 },
    utilityOnly: false
  };
}

test('snapshot chi tiết chuẩn hóa và bắt buộc khớp tổng hóa đơn', () => {
  const normalized = invoiceDetailInput(validDetail(), 2610000);
  assert.equal(normalized.rent.chargedDays, 22);
  assert.equal(normalized.electricity.units, 50);
  assert.equal(normalized.water.billingType, 'cubic_meter');
  assert.equal(normalized.services.wifiVnd, 100000);

  assert.throws(
    () => invoiceDetailInput(validDetail(), 2600000),
    (error) => error.code === 'INVOICE_DETAIL_TOTAL_MISMATCH'
  );
  assert.throws(
    () => invoiceDetailInput({
      ...validDetail(),
      electricity: { ...validDetail().electricity, currentReading: 90 }
    }, 2610000),
    (error) => error.code === 'INVALID_INVOICE_DETAIL'
  );
});

test('API công khai trả breakdown đã chuẩn hóa nhưng không thêm dữ liệu khách thuê', () => {
  const result = publicInvoiceJson({
    invoice_id: 41,
    room_name_snapshot: 'P403',
    period: '2026-08',
    issued_total_vnd: '2610000',
    paid_amount_vnd: '0',
    expires_at: '2099-01-01T00:00:00.000Z',
    detail_snapshot: validDetail(),
    bank_id: 'VCB',
    bank_account: '123456789',
    bank_owner_name: 'NGUYEN VAN A',
    meter_photos: [{
      meter_type: 'electricity',
      mime_type: 'image/jpeg',
      image_base64: '/9j/2Q=='
    }]
  });
  assert.equal(result.details.rent.amountVnd, 2200000);
  assert.equal(result.details.electricity.amountVnd, 175000);
  assert.equal(result.details.water.amountVnd, 100000);
  assert.equal(result.meterPhotos.electricity, 'data:image/jpeg;base64,/9j/2Q==');
  assert.equal(result.payment.settlementMode, 'direct_to_landlord');
  assert.equal(result.payment.amountVnd, 2610000);
  assert.equal(result.payment.accountNumber, '123456789');
  assert.match(result.payment.imageUrl, /^https:\/\/img\.vietqr\.io\/image\/VCB-123456789-compact2\.png/);
  assert.match(result.payment.imageUrl, /amount=2610000/);
  assert.match(result.payment.imageUrl, /addInfo=HD00000015/);
  assert.deepEqual(Object.keys(result).sort(), ['details', 'invoice', 'link', 'meterPhotos', 'payment']);
});

test('migration backfill snapshot và trang khách thuê render phòng, điện, nước, dịch vụ an toàn', () => {
  const root = path.join(__dirname, '..', '..');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260825_rent_invoice_detail_snapshot.sql'),
    'utf8'
  );
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const publicHtml = fs.readFileSync(path.join(root, 'invoice.html'), 'utf8');
  const publicJs = fs.readFileSync(path.join(root, 'invoice-public.js'), 'utf8');
  const publicCss = fs.readFileSync(path.join(root, 'invoice-public.css'), 'utf8');

  for (const source of [migration, schema]) {
    assert.match(source, /detail_snapshot\s+JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
    assert.match(source, /jsonb_typeof\(detail_snapshot\)='object'/);
    assert.match(source, /octet_length\(detail_snapshot::text\) <= 8192/);
  }
  assert.match(migration, /UPDATE rent_invoices invoice[\s\S]*FROM history_bills bill/);
  assert.match(migration, /ROUND\(COALESCE\(bill\.total, 0\)\)=invoice\.issued_total_vnd/);
  assert.match(appSource, /function currentInvoiceDetail/);
  assert.match(appSource, /function historicalInvoiceDetail/);
  assert.match(publicHtml, /id="invoice-detail-list"/);
  assert.match(publicHtml, /invoice-public\.css\?v=5[\s\S]*invoice-public\.js\?v=5/);
  assert.match(publicHtml, /id="invoice-payment"/);
  assert.match(publicHtml, /img-src 'self' data: https:\/\/img\.vietqr\.io/);
  assert.match(publicJs, /appendDetailRow\(list, 'Tiền phòng'/);
  assert.match(publicJs, /'Tiền điện'/);
  assert.match(publicJs, /'Tiền nước'/);
  assert.match(publicJs, /'Phí quản lý & dịch vụ'/);
  assert.match(publicJs, /function renderPayment/);
  assert.match(publicJs, /settlementMode === 'direct_to_landlord'/);
  assert.doesNotMatch(publicJs, /innerHTML/);
  assert.match(publicCss, /\.public-invoice-detail-row/);
});

test('đồng bộ không gắn breakdown của client vào tổng lịch sử khác biệt', () => {
  const source = fs.readFileSync(
    path.join(__dirname, '..', 'rent-payments.js'),
    'utf8'
  );
  assert.match(source, /const detail = totalVnd === entry\.totalVnd \? entry\.detail : \{\}/);
  assert.match(source, /JSON\.stringify\(detail\)/);
});
