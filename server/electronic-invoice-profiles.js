'use strict';

const db = require('./db');
const { recordDataAudits, requestDataAuditEntry } = require('./data-audit');

const LEGAL_ENTITY_TYPES = Object.freeze([
  'unknown',
  'individual_real_estate_lessor',
  'household_business',
  'enterprise',
  'other'
]);
const BUSINESS_ACTIVITY_TYPES = Object.freeze([
  'unknown',
  'long_term_real_estate_rental',
  'accommodation_service',
  'mixed',
  'other'
]);
const ANNUAL_REVENUE_BANDS = Object.freeze([
  'unknown',
  'lte_500m',
  'gt_500m_lte_1b',
  'gt_1b'
]);
const REGISTRATION_STATUSES = Object.freeze([
  'not_registered',
  'registered_code',
  'registered_non_code',
  'per_occurrence',
  'suspended'
]);
const PROVIDERS = Object.freeze([
  '',
  'misa_meinvoice',
  'vnpt_invoice',
  'viettel_sinvoice',
  'other'
]);
const ACTIVE_REGISTRATIONS = new Set(['registered_code', 'registered_non_code']);

class ElectronicInvoiceProfileError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'ElectronicInvoiceProfileError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function enumValue(value, allowed, code, message) {
  const normalized = String(value ?? '').trim();
  if (!allowed.includes(normalized)) {
    throw new ElectronicInvoiceProfileError(400, code, message);
  }
  return normalized;
}

function textValue(value, maximum, code, message) {
  const normalized = String(value ?? '').trim().replace(/\s+/g, ' ');
  if (normalized.length > maximum) {
    throw new ElectronicInvoiceProfileError(400, code, message);
  }
  return normalized;
}

function dateValue(value, field, required = false) {
  const normalized = String(value ?? '').trim();
  if (!normalized) {
    if (required) {
      throw new ElectronicInvoiceProfileError(
        400,
        `INVALID_${field.toUpperCase()}`,
        `${field === 'effective_from' ? 'Ngày hiệu lực' : 'Ngày hết hiệu lực'} là bắt buộc`
      );
    }
    return null;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
    throw new ElectronicInvoiceProfileError(
      400,
      `INVALID_${field.toUpperCase()}`,
      `${field === 'effective_from' ? 'Ngày hiệu lực' : 'Ngày hết hiệu lực'} không hợp lệ`
    );
  }
  const parsed = new Date(`${normalized}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== normalized) {
    throw new ElectronicInvoiceProfileError(
      400,
      `INVALID_${field.toUpperCase()}`,
      `${field === 'effective_from' ? 'Ngày hiệu lực' : 'Ngày hết hiệu lực'} không hợp lệ`
    );
  }
  return normalized;
}

function deriveEligibilityStatus(input = {}) {
  if (input.registrationStatus === 'suspended') return 'suspended';
  if (
    input.legalEntityType === 'unknown'
    || input.businessActivityType === 'unknown'
    || input.annualRevenueBand === 'unknown'
  ) return 'review_required';

  const isPersonalBusiness = [
    'individual_real_estate_lessor',
    'household_business'
  ].includes(input.legalEntityType);
  const isRegistered = ACTIVE_REGISTRATIONS.has(input.registrationStatus);

  // Điều 7 Nghị định 254/2026 tách hoạt động cho thuê BĐS của hộ/cá nhân khỏi
  // nghĩa vụ bắt buộc. Đăng ký chủ động vẫn được giữ là luồng tự nguyện.
  if (
    isPersonalBusiness
    && input.businessActivityType === 'long_term_real_estate_rental'
  ) {
    if (input.registrationStatus === 'per_occurrence') return 'review_required';
    return isRegistered ? 'voluntary_not_ready' : 'not_required';
  }

  if (
    input.legalEntityType === 'other'
    || ['mixed', 'other'].includes(input.businessActivityType)
  ) return 'review_required';

  const required = input.legalEntityType === 'enterprise'
    || input.annualRevenueBand === 'gt_1b';
  if (required) return 'required_not_ready';
  return isRegistered ? 'voluntary_not_ready' : 'not_required';
}

function profileInput(body = {}) {
  if (body.attestAccuracy !== true) {
    throw new ElectronicInvoiceProfileError(
      400,
      'ELECTRONIC_INVOICE_PROFILE_ATTESTATION_REQUIRED',
      'Bạn cần xác nhận thông tin hồ sơ là chính xác trước khi lưu'
    );
  }
  const legalEntityType = enumValue(
    body.legalEntityType,
    LEGAL_ENTITY_TYPES,
    'INVALID_ELECTRONIC_INVOICE_LEGAL_ENTITY',
    'Loại chủ thể hóa đơn điện tử không hợp lệ'
  );
  const businessActivityType = enumValue(
    body.businessActivityType,
    BUSINESS_ACTIVITY_TYPES,
    'INVALID_ELECTRONIC_INVOICE_ACTIVITY',
    'Loại hoạt động kinh doanh không hợp lệ'
  );
  const annualRevenueBand = enumValue(
    body.annualRevenueBand,
    ANNUAL_REVENUE_BANDS,
    'INVALID_ELECTRONIC_INVOICE_REVENUE_BAND',
    'Nhóm doanh thu năm không hợp lệ'
  );
  const registrationStatus = enumValue(
    body.registrationStatus,
    REGISTRATION_STATUSES,
    'INVALID_ELECTRONIC_INVOICE_REGISTRATION',
    'Trạng thái đăng ký hóa đơn điện tử không hợp lệ'
  );
  let provider = enumValue(
    body.provider ?? '',
    PROVIDERS,
    'INVALID_ELECTRONIC_INVOICE_PROVIDER',
    'Nhà cung cấp hóa đơn điện tử không hợp lệ'
  );
  let providerAccountRef = textValue(
    body.providerAccountRef,
    200,
    'INVALID_ELECTRONIC_INVOICE_PROVIDER_ACCOUNT',
    'Mã tài khoản nhà cung cấp không được quá 200 ký tự'
  );
  const taxCode = textValue(
    body.taxCode,
    20,
    'INVALID_ELECTRONIC_INVOICE_TAX_CODE',
    'Mã số thuế không được quá 20 ký tự'
  ).replace(/\s/g, '');
  const sellerLegalName = textValue(
    body.sellerLegalName,
    300,
    'INVALID_ELECTRONIC_INVOICE_SELLER_NAME',
    'Tên người bán hoặc tên pháp lý không được quá 300 ký tự'
  );
  const businessAddress = textValue(
    body.businessAddress,
    1000,
    'INVALID_ELECTRONIC_INVOICE_ADDRESS',
    'Địa chỉ kinh doanh không được quá 1.000 ký tự'
  );
  const legalBasisReference = textValue(
    body.legalBasisReference,
    500,
    'INVALID_ELECTRONIC_INVOICE_LEGAL_BASIS',
    'Căn cứ rà soát không được quá 500 ký tự'
  );
  const hasClassification = legalEntityType !== 'unknown'
    || businessActivityType !== 'unknown'
    || annualRevenueBand !== 'unknown';
  const effectiveFrom = dateValue(body.effectiveFrom, 'effective_from', hasClassification);
  const expiresOn = dateValue(body.expiresOn, 'expires_on');

  if (taxCode && !/^\d{10}(?:-\d{3})?$/.test(taxCode)) {
    throw new ElectronicInvoiceProfileError(
      400,
      'INVALID_ELECTRONIC_INVOICE_TAX_CODE',
      'Mã số thuế phải gồm 10 chữ số hoặc 10 chữ số, dấu gạch ngang và 3 chữ số'
    );
  }
  if (
    ['household_business', 'enterprise'].includes(legalEntityType)
    && !taxCode
  ) {
    throw new ElectronicInvoiceProfileError(
      400,
      'ELECTRONIC_INVOICE_TAX_CODE_REQUIRED',
      'Mã số thuế là bắt buộc với hộ kinh doanh hoặc doanh nghiệp'
    );
  }
  if (ACTIVE_REGISTRATIONS.has(registrationStatus) && !taxCode) {
    throw new ElectronicInvoiceProfileError(
      400,
      'ELECTRONIC_INVOICE_TAX_CODE_REQUIRED',
      'Mã số thuế là bắt buộc khi đã đăng ký hóa đơn điện tử'
    );
  }
  if (hasClassification && businessAddress.length < 3) {
    throw new ElectronicInvoiceProfileError(
      400,
      'ELECTRONIC_INVOICE_ADDRESS_REQUIRED',
      'Địa chỉ kinh doanh là bắt buộc khi đã phân loại hồ sơ'
    );
  }
  if (hasClassification && sellerLegalName.length < 2) {
    throw new ElectronicInvoiceProfileError(
      400,
      'ELECTRONIC_INVOICE_SELLER_NAME_REQUIRED',
      'Tên người bán hoặc tên pháp lý là bắt buộc khi đã phân loại hồ sơ'
    );
  }
  if (hasClassification && legalBasisReference.length < 3) {
    throw new ElectronicInvoiceProfileError(
      400,
      'ELECTRONIC_INVOICE_LEGAL_BASIS_REQUIRED',
      'Cần ghi căn cứ hoặc ghi chú rà soát hồ sơ'
    );
  }
  if (effectiveFrom && expiresOn && expiresOn < effectiveFrom) {
    throw new ElectronicInvoiceProfileError(
      400,
      'INVALID_ELECTRONIC_INVOICE_PROFILE_DATES',
      'Ngày hết hiệu lực phải bằng hoặc sau ngày hiệu lực'
    );
  }
  if (!ACTIVE_REGISTRATIONS.has(registrationStatus)) {
    provider = '';
    providerAccountRef = '';
  } else if (!provider) {
    providerAccountRef = '';
  }

  const input = {
    legalEntityType,
    businessActivityType,
    annualRevenueBand,
    sellerLegalName,
    taxCode,
    businessAddress,
    registrationStatus,
    provider,
    providerAccountRef,
    legalBasisReference,
    effectiveFrom,
    expiresOn
  };
  return { ...input, eligibilityStatus: deriveEligibilityStatus(input) };
}

function defaultProfile() {
  return {
    exists: false,
    legalEntityType: 'unknown',
    businessActivityType: 'unknown',
    annualRevenueBand: 'unknown',
    sellerLegalName: '',
    taxCode: '',
    businessAddress: '',
    registrationStatus: 'not_registered',
    provider: '',
    providerAccountRef: '',
    legalBasisReference: '',
    effectiveFrom: null,
    expiresOn: null,
    eligibilityStatus: 'review_required',
    providerConnectionVerified: false,
    ownerAttestedAt: null,
    reviewedAt: null,
    createdAt: null,
    updatedAt: null
  };
}

function outputDate(value) {
  if (!value) return null;
  const raw = String(value);
  if (/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(raw)) return raw.slice(0, 10);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString().slice(0, 10);
}

function profileJson(row) {
  if (!row) return defaultProfile();
  return {
    exists: true,
    legalEntityType: row.legal_entity_type,
    businessActivityType: row.business_activity_type,
    annualRevenueBand: row.annual_revenue_band,
    sellerLegalName: row.seller_legal_name || '',
    taxCode: row.tax_code || '',
    businessAddress: row.business_address || '',
    registrationStatus: row.registration_status,
    provider: row.provider || '',
    providerAccountRef: row.provider_account_ref || '',
    legalBasisReference: row.legal_basis_reference || '',
    effectiveFrom: outputDate(row.effective_from),
    expiresOn: outputDate(row.expires_on),
    eligibilityStatus: row.eligibility_status,
    providerConnectionVerified: !!(
      row.provider_credential_ref && row.provider_credential_verified_at
    ),
    ownerAttestedAt: row.owner_attested_at
      ? new Date(row.owner_attested_at).toISOString()
      : null,
    reviewedAt: row.reviewed_at ? new Date(row.reviewed_at).toISOString() : null,
    createdAt: row.created_at ? new Date(row.created_at).toISOString() : null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null
  };
}

function sendProfileError(res, error) {
  if (!(error instanceof ElectronicInvoiceProfileError)) return false;
  res.status(error.statusCode).json({ error: error.message, code: error.code });
  return true;
}

function ensureOwner(req) {
  if (!req.workspace || req.workspace.isOwner !== true) {
    throw new ElectronicInvoiceProfileError(
      403,
      'ELECTRONIC_INVOICE_PROFILE_OWNER_REQUIRED',
      'Chỉ chủ tài khoản được xem hoặc cập nhật hồ sơ hóa đơn điện tử'
    );
  }
}

async function profileRow(userId, query = db.query) {
  const result = await query(
    'SELECT * FROM electronic_invoice_profiles WHERE user_id=$1',
    [userId]
  );
  return result.rows[0] || null;
}

async function getElectronicInvoiceProfile(req, res, dependencies = {}) {
  try {
    ensureOwner(req);
  } catch (error) {
    if (sendProfileError(res, error)) return res;
    throw error;
  }
  const row = await profileRow(req.userId, dependencies.query || db.query);
  res.set('Cache-Control', 'no-store');
  return res.json({ profile: profileJson(row) });
}

function changedProfileFields(current, next) {
  const mappings = [
    ['legal_entity_type', 'legalEntityType'],
    ['business_activity_type', 'businessActivityType'],
    ['annual_revenue_band', 'annualRevenueBand'],
    ['seller_legal_name', 'sellerLegalName'],
    ['tax_code', 'taxCode'],
    ['business_address', 'businessAddress'],
    ['registration_status', 'registrationStatus'],
    ['provider', 'provider'],
    ['provider_account_ref', 'providerAccountRef'],
    ['legal_basis_reference', 'legalBasisReference'],
    ['effective_from', 'effectiveFrom'],
    ['expires_on', 'expiresOn'],
    ['eligibility_status', 'eligibilityStatus']
  ];
  if (!current) return mappings.map(([, field]) => field);
  return mappings
    .filter(([databaseField, clientField]) => {
      const oldValue = ['effective_from', 'expires_on'].includes(databaseField)
        ? (outputDate(current[databaseField]) || '')
        : (current[databaseField] === null ? '' : String(current[databaseField] ?? ''));
      const nextValue = next[clientField] === null ? '' : String(next[clientField] ?? '');
      return oldValue !== nextValue;
    })
    .map(([, field]) => field);
}

async function updateElectronicInvoiceProfile(req, res, dependencies = {}) {
  let input;
  try {
    ensureOwner(req);
    input = profileInput(req.body);
  } catch (error) {
    if (sendProfileError(res, error)) return res;
    throw error;
  }
  const client = await (dependencies.getClient || db.getClient)();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended(
         'electronic-invoice-profile:' || $1::text, 0
       ))`,
      [req.userId]
    );
    const existing = await client.query(
      'SELECT * FROM electronic_invoice_profiles WHERE user_id=$1 FOR UPDATE',
      [req.userId]
    );
    const current = existing.rows[0] || null;
    const changedFields = changedProfileFields(current, input);
    const result = await client.query(
      `INSERT INTO electronic_invoice_profiles (
         user_id, legal_entity_type, business_activity_type, annual_revenue_band,
         seller_legal_name, tax_code, business_address, registration_status, provider,
         provider_account_ref, legal_basis_reference, effective_from, expires_on,
         eligibility_status, owner_attested_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,now())
       ON CONFLICT (user_id) DO UPDATE SET
         legal_entity_type=EXCLUDED.legal_entity_type,
         business_activity_type=EXCLUDED.business_activity_type,
         annual_revenue_band=EXCLUDED.annual_revenue_band,
         seller_legal_name=EXCLUDED.seller_legal_name,
         tax_code=EXCLUDED.tax_code,
         business_address=EXCLUDED.business_address,
         registration_status=EXCLUDED.registration_status,
         provider=EXCLUDED.provider,
         provider_account_ref=EXCLUDED.provider_account_ref,
         legal_basis_reference=EXCLUDED.legal_basis_reference,
         effective_from=EXCLUDED.effective_from,
         expires_on=EXCLUDED.expires_on,
         eligibility_status=EXCLUDED.eligibility_status,
         owner_attested_at=now(),
         provider_credential_ref='',
         provider_credential_verified_at=NULL,
         reviewed_by_user_id=NULL,
         reviewed_at=NULL,
         updated_at=now()
       RETURNING *`,
      [
        req.userId,
        input.legalEntityType,
        input.businessActivityType,
        input.annualRevenueBand,
        input.sellerLegalName,
        input.taxCode,
        input.businessAddress,
        input.registrationStatus,
        input.provider,
        input.providerAccountRef,
        input.legalBasisReference,
        input.effectiveFrom,
        input.expiresOn,
        input.eligibilityStatus
      ]
    );
    if (changedFields.length > 0) {
      await recordDataAudits(client.query.bind(client), [requestDataAuditEntry(
        req,
        current ? 'electronic_invoice_profile_updated' : 'electronic_invoice_profile_created',
        'electronic_invoice_profile',
        String(req.userId),
        {
          changedFields,
          purpose: 'Chủ tài khoản xác nhận hồ sơ hóa đơn điện tử'
        }
      )]);
    }
    await client.query('COMMIT');
    res.set('Cache-Control', 'no-store');
    return res.json({ profile: profileJson(result.rows[0]) });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendProfileError(res, error)) return res;
    throw error;
  } finally {
    client.release();
  }
}

async function loadElectronicInvoiceProfileExport(userId, query = db.query) {
  return profileJson(await profileRow(userId, query));
}

module.exports = {
  ANNUAL_REVENUE_BANDS,
  BUSINESS_ACTIVITY_TYPES,
  ElectronicInvoiceProfileError,
  LEGAL_ENTITY_TYPES,
  PROVIDERS,
  REGISTRATION_STATUSES,
  deriveEligibilityStatus,
  getElectronicInvoiceProfile,
  loadElectronicInvoiceProfileExport,
  profileInput,
  profileJson,
  updateElectronicInvoiceProfile
};
