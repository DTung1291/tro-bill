'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-electronic-invoice-profile-tests';
process.env.RATE_LIMIT_HASH_SECRET ||= 'test-rate-limit-secret-for-electronic-invoice-profiles';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  deriveEligibilityStatus,
  getElectronicInvoiceProfile,
  profileInput,
  updateElectronicInvoiceProfile
} = require('../electronic-invoice-profiles');

function responseRecorder() {
  const record = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; },
    set(name, value) { record.headers[name] = value; return res; }
  };
  return { record, res };
}

function profileRow(overrides = {}) {
  return {
    user_id: 7,
    legal_entity_type: 'individual_real_estate_lessor',
    business_activity_type: 'long_term_real_estate_rental',
    annual_revenue_band: 'lte_500m',
    tax_code: '',
    business_address: '40 Vũ Hữu, Hà Nội',
    registration_status: 'not_registered',
    provider: '',
    provider_account_ref: '',
    legal_basis_reference: 'Điều 7 Nghị định 254/2026/NĐ-CP',
    effective_from: '2026-09-07',
    expires_on: null,
    eligibility_status: 'not_required',
    provider_credential_ref: '',
    provider_credential_verified_at: null,
    owner_attested_at: '2026-09-07T02:00:00.000Z',
    reviewed_at: null,
    created_at: '2026-09-07T02:00:00.000Z',
    updated_at: '2026-09-07T02:00:00.000Z',
    ...overrides
  };
}

test('phân loại miễn trừ cho thuê BĐS trước ngưỡng doanh thu chung', () => {
  assert.equal(deriveEligibilityStatus({
    legalEntityType: 'individual_real_estate_lessor',
    businessActivityType: 'long_term_real_estate_rental',
    annualRevenueBand: 'gt_1b',
    registrationStatus: 'not_registered'
  }), 'not_required');
  assert.equal(deriveEligibilityStatus({
    legalEntityType: 'household_business',
    businessActivityType: 'long_term_real_estate_rental',
    annualRevenueBand: 'lte_500m',
    registrationStatus: 'registered_code'
  }), 'voluntary_not_ready');
});

test('dịch vụ lưu trú trên một tỷ cần HĐĐT nhưng hồ sơ hỗn hợp phải rà soát', () => {
  assert.equal(deriveEligibilityStatus({
    legalEntityType: 'household_business',
    businessActivityType: 'accommodation_service',
    annualRevenueBand: 'gt_1b',
    registrationStatus: 'registered_code'
  }), 'required_not_ready');
  assert.equal(deriveEligibilityStatus({
    legalEntityType: 'enterprise',
    businessActivityType: 'accommodation_service',
    annualRevenueBand: 'lte_500m',
    registrationStatus: 'not_registered'
  }), 'required_not_ready');
  assert.equal(deriveEligibilityStatus({
    legalEntityType: 'household_business',
    businessActivityType: 'mixed',
    annualRevenueBand: 'gt_1b',
    registrationStatus: 'registered_code'
  }), 'review_required');
});

test('input bắt buộc xác nhận, mã số thuế và ngày hiệu lực hợp lệ', () => {
  assert.throws(
    () => profileInput({}),
    error => error.code === 'ELECTRONIC_INVOICE_PROFILE_ATTESTATION_REQUIRED'
  );
  assert.throws(
    () => profileInput({
      attestAccuracy: true,
      legalEntityType: 'enterprise',
      businessActivityType: 'accommodation_service',
      annualRevenueBand: 'gt_1b',
      registrationStatus: 'registered_code',
      businessAddress: 'Hà Nội',
      legalBasisReference: 'Hồ sơ đăng ký',
      effectiveFrom: '2026-09-07'
    }),
    error => error.code === 'ELECTRONIC_INVOICE_TAX_CODE_REQUIRED'
  );
  assert.throws(
    () => profileInput({
      attestAccuracy: true,
      legalEntityType: 'individual_real_estate_lessor',
      businessActivityType: 'long_term_real_estate_rental',
      annualRevenueBand: 'lte_500m',
      registrationStatus: 'not_registered',
      businessAddress: 'Hà Nội',
      legalBasisReference: 'Điều 7',
      effectiveFrom: '2026-09-31'
    }),
    error => error.code === 'INVALID_EFFECTIVE_FROM'
  );
});

test('trạng thái chưa đăng ký tự xóa cấu hình provider không còn hiệu lực', () => {
  const input = profileInput({
    attestAccuracy: true,
    legalEntityType: 'individual_real_estate_lessor',
    businessActivityType: 'long_term_real_estate_rental',
    annualRevenueBand: 'lte_500m',
    taxCode: '',
    businessAddress: ' 40   Vũ Hữu, Hà Nội ',
    registrationStatus: 'not_registered',
    provider: 'misa_meinvoice',
    providerAccountRef: 'tenant-secret-looking-reference',
    legalBasisReference: ' Điều 7 Nghị định 254/2026/NĐ-CP ',
    effectiveFrom: '2026-09-07'
  });
  assert.equal(input.provider, '');
  assert.equal(input.providerAccountRef, '');
  assert.equal(input.businessAddress, '40 Vũ Hữu, Hà Nội');
  assert.equal(input.eligibilityStatus, 'not_required');
});

test('staff không được đọc hồ sơ pháp lý của workspace chủ trọ', async () => {
  const response = responseRecorder();
  let queried = false;
  await getElectronicInvoiceProfile({
    userId: 7,
    workspace: { isOwner: false }
  }, response.res, {
    query: async () => { queried = true; return { rows: [] }; }
  });
  assert.equal(response.record.statusCode, 403);
  assert.equal(response.record.body.code, 'ELECTRONIC_INVOICE_PROFILE_OWNER_REQUIRED');
  assert.equal(queried, false);
});

test('lưu hồ sơ theo owner, reset xác minh cũ và audit không chứa giá trị nhạy cảm', async () => {
  const calls = [];
  const stored = profileRow();
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FOR UPDATE')) return { rows: [] };
      if (sql.includes('INSERT INTO electronic_invoice_profiles')) return { rows: [stored] };
      return { rows: [] };
    },
    release() {}
  };
  const response = responseRecorder();
  await updateElectronicInvoiceProfile({
    userId: 7,
    accountUserId: 7,
    actorUserId: 7,
    userEmail: 'owner@example.com',
    workspace: { isOwner: true },
    headers: {},
    get() { return ''; },
    body: {
      attestAccuracy: true,
      legalEntityType: 'individual_real_estate_lessor',
      businessActivityType: 'long_term_real_estate_rental',
      annualRevenueBand: 'lte_500m',
      taxCode: '',
      businessAddress: '40 Vũ Hữu, Hà Nội',
      registrationStatus: 'not_registered',
      legalBasisReference: 'Điều 7 Nghị định 254/2026/NĐ-CP',
      effectiveFrom: '2026-09-07'
    }
  }, response.res, { getClient: async () => client });

  assert.equal(response.record.body.profile.eligibilityStatus, 'not_required');
  const upsert = calls.find(call => call.sql.includes('INSERT INTO electronic_invoice_profiles'));
  assert.equal(upsert.params.includes('40 Vũ Hữu, Hà Nội'), true);
  assert.match(upsert.sql, /provider_credential_ref=''/);
  const audit = calls.find(call => call.sql.includes('INSERT INTO data_audit_logs'));
  assert.ok(audit);
  assert.equal(audit.params.some(value => String(value).includes('40 Vũ Hữu')), false);
  assert.equal(audit.params.some(value => String(value).includes('Nghị định 254')), false);
  assert.equal(calls.some(call => call.sql === 'COMMIT'), true);
});

test('schema, migration và routes giữ profile owner-scoped, không cấp DELETE runtime', () => {
  const root = path.join(__dirname, '..', '..');
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260907_electronic_invoice_profiles.sql'),
    'utf8'
  );
  const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  const health = fs.readFileSync(path.join(root, 'server', 'health.js'), 'utf8');
  for (const source of [schema, migration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS electronic_invoice_profiles/);
    assert.match(source, /user_id\s+BIGINT PRIMARY KEY REFERENCES users\(id\) ON DELETE CASCADE/);
    assert.match(source, /provider_credential_ref\s+TEXT NOT NULL DEFAULT ''/);
    assert.match(source, /GRANT SELECT, INSERT, UPDATE ON electronic_invoice_profiles/);
    assert.doesNotMatch(source, /GRANT SELECT, INSERT, UPDATE, DELETE ON electronic_invoice_profiles/);
  }
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;[\s\S]*electronic_invoice_profile_ownership_ready/);
  assert.match(server, /\/api\/electronic-invoice\/profile/);
  assert.match(server, /requireWorkspace\('any'\)/);
  assert.match(health, /to_regclass\('public\.electronic_invoice_profiles'\)/);
});

test('client chỉ hiển thị hồ sơ cho owner, xóa khỏi bộ nhớ khi đổi phiên và không nhận API key', () => {
  const root = path.join(__dirname, '..', '..');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.match(html, /id="electronic-invoice-profile-card"/);
  assert.match(html, /không phải hóa đơn điện tử thuế/i);
  assert.match(html, /Không nhập API key\/mật khẩu/);
  assert.doesNotMatch(html, /id="electronic-invoice-api-key"/);
  assert.match(api, /getElectronicInvoiceProfile[\s\S]*GET[\s\S]*\/api\/electronic-invoice\/profile/);
  assert.match(api, /updateElectronicInvoiceProfile[\s\S]*PUT[\s\S]*\/api\/electronic-invoice\/profile/);
  assert.match(app, /card\.hidden = !isOwnerWorkspace\(\)/);
  assert.match(app, /ELECTRONIC_INVOICE_PROFILE = null;[\s\S]*function clearSensitiveStateFromMemory/);
  assert.match(app, /function clearSensitiveStateFromMemory[\s\S]*ELECTRONIC_INVOICE_PROFILE = null;/);
  assert.match(app, /attestAccuracy:[\s\S]*electronic-invoice-attestation/);
});
