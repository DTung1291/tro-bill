'use strict';

const crypto = require('node:crypto');
const db = require('./db');

const PERIOD_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const READY_STATUSES = new Set(['voluntary_ready', 'required_ready']);

class ElectronicInvoicePreflightError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'ElectronicInvoicePreflightError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function positiveId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new ElectronicInvoicePreflightError(
      400,
      'INVALID_ELECTRONIC_INVOICE_PREFLIGHT_REFERENCE',
      `${label} không hợp lệ`
    );
  }
  return id;
}

function periodBounds(period) {
  if (!PERIOD_PATTERN.test(String(period || ''))) {
    throw new ElectronicInvoicePreflightError(
      500,
      'INVALID_ELECTRONIC_INVOICE_SOURCE_PERIOD',
      'Kỳ hóa đơn nguồn không hợp lệ'
    );
  }
  const [year, month] = period.split('-').map(Number);
  const start = `${period}-01`;
  const end = new Date(Date.UTC(year, month, 0)).toISOString().slice(0, 10);
  return { start, end };
}

function dateJson(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function addLine(lines, code, description, amountVnd, metadata = {}) {
  const amount = Number(amountVnd);
  if (!Number.isFinite(amount) || amount === 0) return;
  lines.push({ code, description, amountVnd: amount, ...metadata });
}

function canonicalInvoiceLines(detail = {}) {
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) return [];
  const lines = [];
  addLine(lines, 'rent', 'Tiền phòng', detail.rent?.amountVnd, {
    metadata: {
      basePriceVnd: Number(detail.rent?.basePriceVnd) || 0,
      chargedDays: Number(detail.rent?.chargedDays) || 0,
      daysInMonth: Number(detail.rent?.daysInMonth) || 0,
      prorated: detail.rent?.prorated === true
    }
  });
  addLine(lines, 'electricity', 'Tiền điện', detail.electricity?.amountVnd, {
    metadata: {
      quantity: Number(detail.electricity?.units) || 0,
      unit: 'kWh',
      unitPriceVnd: Number(detail.electricity?.rateVnd) || 0
    }
  });
  addLine(lines, 'water', 'Tiền nước', detail.water?.amountVnd, {
    metadata: {
      quantity: Number(detail.water?.units) || 0,
      unit: detail.water?.billingType === 'person' ? 'người' : 'm3',
      unitPriceVnd: Number(detail.water?.rateVnd) || 0
    }
  });
  addLine(lines, 'trash', 'Phí rác', detail.services?.trashVnd);
  addLine(lines, 'wifi', 'Phí Wifi', detail.services?.wifiVnd);
  addLine(lines, 'management', 'Phí quản lý và dịch vụ', detail.services?.managementVnd);
  addLine(lines, 'discount', 'Giảm giá', -(Number(detail.adjustments?.discountVnd) || 0));
  addLine(lines, 'surcharge', 'Phụ thu', detail.adjustments?.surchargeVnd);
  addLine(lines, 'late_fee', 'Phí chậm thanh toán', detail.adjustments?.lateFeeVnd);
  return lines;
}

function blocker(code, message) {
  return { code, message };
}

function sourceFingerprint(value) {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function contractCandidateJson(row) {
  return {
    contractId: Number(row.id),
    contractCode: row.contract_code,
    tenantName: row.tenant_name_snapshot || '',
    startsOn: dateJson(row.starts_on),
    endsOn: dateJson(row.ends_on)
  };
}

function buildPreflight({ invoice, profile, contracts, selectedContractId = null }) {
  const candidates = contracts.map(contractCandidateJson);
  let selected = null;
  const finalizationContractId = Number(invoice.finalization_contract_id) || null;
  if (selectedContractId && finalizationContractId && selectedContractId !== finalizationContractId) {
    throw new ElectronicInvoicePreflightError(
      409,
      'ELECTRONIC_INVOICE_FINALIZATION_CONTRACT_MISMATCH',
      'Hóa đơn quyết toán đã khóa với một hợp đồng khác'
    );
  }
  if (finalizationContractId) {
    selected = contracts.find(row => Number(row.id) === finalizationContractId) || null;
  } else if (selectedContractId) {
    selected = contracts.find(row => Number(row.id) === selectedContractId) || null;
    if (!selected) {
      throw new ElectronicInvoicePreflightError(
        409,
        'ELECTRONIC_INVOICE_CONTRACT_NOT_IN_PERIOD',
        'Hợp đồng đã chọn không thuộc phòng và kỳ của hóa đơn này'
      );
    }
  } else if (contracts.length === 1) {
    [selected] = contracts;
  }

  const totalVnd = Number(invoice.final_total_vnd ?? invoice.issued_total_vnd) || 0;
  const collectedVnd = Math.max(0, Number(invoice.paid_amount_vnd) || 0);
  const detail = invoice.final_detail_snapshot || invoice.detail_snapshot || {};
  const lines = canonicalInvoiceLines(detail);
  const lineTotalVnd = lines.reduce((sum, line) => sum + line.amountVnd, 0);
  const blockers = [];
  const { start: periodStart, end: periodEnd } = periodBounds(invoice.period);

  if (!profile) blockers.push(blocker(
    'ELECTRONIC_INVOICE_PROFILE_MISSING',
    'Chưa khai báo hồ sơ hóa đơn điện tử trong Cài đặt.'
  ));
  if (profile && !READY_STATUSES.has(profile.eligibility_status)) blockers.push(blocker(
    'ELECTRONIC_INVOICE_PROFILE_NOT_READY',
    'Hồ sơ pháp lý chưa được xác nhận ở trạng thái sẵn sàng phát hành.'
  ));
  if (!String(profile?.seller_legal_name || '').trim()) blockers.push(blocker(
    'ELECTRONIC_INVOICE_SELLER_NAME_MISSING',
    'Thiếu tên người bán hoặc tên pháp lý của đơn vị.'
  ));
  if (!String(profile?.tax_code || '').trim()) blockers.push(blocker(
    'ELECTRONIC_INVOICE_SELLER_TAX_CODE_MISSING',
    'Thiếu mã số thuế của người bán.'
  ));
  if (!String(profile?.business_address || '').trim()) blockers.push(blocker(
    'ELECTRONIC_INVOICE_SELLER_ADDRESS_MISSING',
    'Thiếu địa chỉ kinh doanh của người bán.'
  ));
  if (!String(profile?.provider || '').trim()) blockers.push(blocker(
    'ELECTRONIC_INVOICE_PROVIDER_MISSING',
    'Chưa chọn nhà cung cấp hóa đơn điện tử.'
  ));
  if (!profile?.provider_credential_ref || !profile?.provider_credential_verified_at) blockers.push(blocker(
    'ELECTRONIC_INVOICE_PROVIDER_NOT_VERIFIED',
    'Kết nối sandbox/nhà cung cấp chưa được xác minh.'
  ));
  if (!profile?.reviewed_at) blockers.push(blocker(
    'ELECTRONIC_INVOICE_ACCOUNTING_REVIEW_MISSING',
    'Chưa có người phụ trách kế toán hoặc pháp lý duyệt nghiệp vụ.'
  ));
  if (!profile?.invoice_type || !profile?.invoice_template_code
      || !profile?.invoice_series || profile?.signing_method === 'unknown') blockers.push(blocker(
    'ELECTRONIC_INVOICE_TEMPLATE_NOT_VERIFIED',
    'Loại hóa đơn, mẫu số, ký hiệu hoặc phương thức ký chưa được xác minh.'
  ));
  if (profile?.effective_from && dateJson(profile.effective_from) > periodEnd) blockers.push(blocker(
    'ELECTRONIC_INVOICE_PROFILE_NOT_EFFECTIVE',
    'Hồ sơ hóa đơn điện tử chưa có hiệu lực trong kỳ này.'
  ));
  if (profile?.expires_on && dateJson(profile.expires_on) < periodStart) blockers.push(blocker(
    'ELECTRONIC_INVOICE_PROFILE_EXPIRED',
    'Hồ sơ hóa đơn điện tử đã hết hiệu lực trước kỳ này.'
  ));
  if (contracts.length === 0) blockers.push(blocker(
    'ELECTRONIC_INVOICE_CONTRACT_MISSING',
    'Không tìm thấy hợp đồng đang thuê hoặc đã kết thúc thuộc kỳ hóa đơn.'
  ));
  if (contracts.length > 1 && !selected) blockers.push(blocker(
    'ELECTRONIC_INVOICE_CONTRACT_SELECTION_REQUIRED',
    'Có nhiều hợp đồng thuộc cùng phòng và kỳ; cần chọn đúng khách thuê.'
  ));
  if (finalizationContractId && !selected) blockers.push(blocker(
    'ELECTRONIC_INVOICE_FINALIZATION_CONTRACT_MISSING',
    'Không tìm thấy hợp đồng đã dùng để chốt hóa đơn quyết toán.'
  ));
  if (selected && !String(selected.tenant_name_snapshot || '').trim()) blockers.push(blocker(
    'ELECTRONIC_INVOICE_BUYER_NAME_MISSING',
    'Hợp đồng thiếu tên khách thuê.'
  ));
  if (selected && !String(selected.tenant_address_snapshot || '').trim()) blockers.push(blocker(
    'ELECTRONIC_INVOICE_BUYER_ADDRESS_MISSING',
    'Hợp đồng thiếu địa chỉ khách thuê.'
  ));
  if (lines.length === 0) blockers.push(blocker(
    'ELECTRONIC_INVOICE_DETAIL_MISSING',
    'Hóa đơn nguồn chưa có chi tiết khoản thu để đồng bộ.'
  ));
  if (lines.some(line => !Number.isSafeInteger(line.amountVnd))) blockers.push(blocker(
    'ELECTRONIC_INVOICE_LINE_AMOUNT_NOT_INTEGER',
    'Có khoản thu không phải số tiền VND nguyên.'
  ));
  if (lines.length > 0 && Math.round(lineTotalVnd) !== totalVnd) blockers.push(blocker(
    'ELECTRONIC_INVOICE_TOTAL_MISMATCH',
    'Tổng các khoản thu không khớp tổng hóa đơn nguồn.'
  ));
  if (!Number.isSafeInteger(totalVnd) || totalVnd < 1) blockers.push(blocker(
    'ELECTRONIC_INVOICE_TOTAL_INVALID',
    'Tổng hóa đơn nguồn phải là số tiền VND nguyên lớn hơn 0.'
  ));

  const snapshot = {
    schemaVersion: 1,
    seller: {
      legalName: String(profile?.seller_legal_name || '').trim(),
      taxCode: String(profile?.tax_code || '').trim(),
      address: String(profile?.business_address || '').trim()
    },
    buyer: selected ? {
      contractId: Number(selected.id),
      contractCode: selected.contract_code,
      name: String(selected.tenant_name_snapshot || '').trim(),
      address: String(selected.tenant_address_snapshot || '').trim()
    } : null,
    invoice: {
      sourceInvoiceId: Number(invoice.id),
      roomId: invoice.room_id,
      roomName: invoice.room_name_snapshot || '',
      period: invoice.period,
      totalVnd,
      finalizedAt: invoice.finalized_at || null,
      lines
    },
    collection: {
      collectedVnd,
      remainingVnd: Math.max(0, totalVnd - collectedVnd),
      transactionCount: Number(invoice.transaction_count) || 0
    }
  };

  return {
    dispatchAllowed: false,
    dispatchNotice: 'Đây chỉ là bản tiền kiểm nội bộ; TrọBill chưa gửi dữ liệu hoặc phát hành hóa đơn qua nhà cung cấp.',
    sourceFingerprint: sourceFingerprint(snapshot),
    blockers,
    contractCandidates: candidates,
    snapshot
  };
}

function ensureOwner(req) {
  if (!req.workspace || req.workspace.isOwner !== true) {
    throw new ElectronicInvoicePreflightError(
      403,
      'ELECTRONIC_INVOICE_PREFLIGHT_OWNER_REQUIRED',
      'Chỉ chủ tài khoản được kiểm tra dữ liệu hóa đơn điện tử'
    );
  }
}

function sendError(res, error) {
  if (!(error instanceof ElectronicInvoicePreflightError)) return false;
  res.status(error.statusCode).json({ error: error.message, code: error.code });
  return true;
}

async function getElectronicInvoicePreflight(req, res, dependencies = {}) {
  let invoiceId;
  let selectedContractId = null;
  try {
    ensureOwner(req);
    invoiceId = positiveId(req.params?.invoiceId, 'Hóa đơn');
    if (req.query?.contractId) {
      selectedContractId = positiveId(req.query.contractId, 'Hợp đồng');
    }
  } catch (error) {
    if (sendError(res, error)) return res;
    throw error;
  }
  const query = dependencies.query || db.query;
  const invoiceResult = await query(
    `SELECT invoice.id, invoice.room_id, invoice.room_name_snapshot, invoice.period,
            invoice.issued_total_vnd, invoice.detail_snapshot,
            invoice.final_total_vnd, invoice.final_detail_snapshot,
            invoice.finalization_contract_id, invoice.finalized_at,
            COALESCE(SUM(transaction.amount_vnd), 0) AS paid_amount_vnd,
            COUNT(transaction.id)::int AS transaction_count
     FROM rent_invoices invoice
     LEFT JOIN rent_payment_transactions transaction
       ON transaction.user_id=invoice.user_id AND transaction.invoice_id=invoice.id
     WHERE invoice.user_id=$1 AND invoice.id=$2
     GROUP BY invoice.id`,
    [req.userId, invoiceId]
  );
  const invoice = invoiceResult.rows[0];
  if (!invoice) {
    return res.status(404).json({
      error: 'Không tìm thấy hóa đơn',
      code: 'ELECTRONIC_INVOICE_SOURCE_NOT_FOUND'
    });
  }
  const { start, end } = periodBounds(invoice.period);
  const [profileResult, contractResult] = await Promise.all([
    query('SELECT * FROM electronic_invoice_profiles WHERE user_id=$1', [req.userId]),
    query(
      `SELECT id, contract_code, tenant_name_snapshot, tenant_address_snapshot,
              starts_on, ends_on
       FROM rental_contracts
       WHERE user_id=$1 AND room_id=$2
         AND status IN ('active','ended')
         AND starts_on <= $4::date
         AND (ends_on IS NULL OR ends_on >= $3::date)
       ORDER BY starts_on, id`,
      [req.userId, invoice.room_id, start, end]
    )
  ]);
  try {
    const preflight = buildPreflight({
      invoice,
      profile: profileResult.rows[0] || null,
      contracts: contractResult.rows,
      selectedContractId
    });
    res.set('Cache-Control', 'no-store');
    res.set('Pragma', 'no-cache');
    return res.json({ preflight });
  } catch (error) {
    if (sendError(res, error)) return res;
    throw error;
  }
}

module.exports = {
  ElectronicInvoicePreflightError,
  buildPreflight,
  canonicalInvoiceLines,
  getElectronicInvoicePreflight,
  periodBounds,
  sourceFingerprint
};
