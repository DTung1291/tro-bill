'use strict';

const db = require('./db');
const subscription = require('./subscription');
const { recordDataAudits, requestDataAuditEntry } = require('./data-audit');
const {
  RentPaymentError,
  invoiceDetailInput,
  receiptCode
} = require('./rent-payments');
const { transactionCode: depositTransactionCode } = require('./deposits');

const REFUND_METHODS = new Set(['bank_transfer', 'cash', 'manual', 'other']);

class RentalFinalSettlementError extends Error {
  constructor(statusCode, code, message) {
    super(message);
    this.name = 'RentalFinalSettlementError';
    this.statusCode = statusCode;
    this.code = code;
  }
}

function sendSettlementError(res, error) {
  if (error instanceof RentalFinalSettlementError) {
    res.status(error.statusCode).json({ error: error.message, code: error.code });
    return true;
  }
  if (subscription.sendEntitlementError(res, error)) return true;
  return false;
}

function positiveId(value, label = 'Hợp đồng') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new RentalFinalSettlementError(400, 'INVALID_FINAL_SETTLEMENT_ID', `${label} không hợp lệ`);
  }
  return id;
}

function integerVnd(value, label) {
  const amount = Number(value);
  if (!Number.isSafeInteger(amount) || amount < 0 || amount > 999999999999) {
    throw new RentalFinalSettlementError(400, 'INVALID_FINAL_SETTLEMENT_AMOUNT', `${label} không hợp lệ`);
  }
  return amount;
}

function settlementInput(body = {}) {
  const depositAppliedVnd = integerVnd(body.depositAppliedVnd, 'Tiền cọc bù công nợ');
  const depositRefundedVnd = integerVnd(body.depositRefundedVnd, 'Tiền cọc hoàn lại');
  const refundMethod = String(body.refundMethod || 'manual').trim().toLowerCase();
  const reason = String(body.reason || '').trim();
  if (!REFUND_METHODS.has(refundMethod)) {
    throw new RentalFinalSettlementError(
      400,
      'INVALID_FINAL_SETTLEMENT_REFUND_METHOD',
      'Phương thức hoàn cọc không hợp lệ'
    );
  }
  if (reason.length < 10 || reason.length > 500) {
    throw new RentalFinalSettlementError(
      400,
      'INVALID_FINAL_SETTLEMENT_REASON',
      'Lý do quyết toán phải có từ 10 đến 500 ký tự'
    );
  }
  return { depositAppliedVnd, depositRefundedVnd, refundMethod, reason };
}

function dateOnly(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function periodFromDate(value) {
  return dateOnly(value).slice(0, 7);
}

function daysInPeriod(period) {
  const [year, month] = period.split('-').map(Number);
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function dayOfMonth(value) {
  return Number(dateOnly(value).slice(8, 10));
}

function finalizeInvoiceDetail(detail, originalTotalVnd, contract, checkoutOn) {
  let original;
  try {
    original = invoiceDetailInput(detail || {}, originalTotalVnd);
  } catch (error) {
    if (error instanceof RentPaymentError) {
      throw new RentalFinalSettlementError(
        409,
        'FINAL_INVOICE_DETAIL_INVALID',
        'Chi tiết hóa đơn tháng trả phòng chưa hợp lệ; hãy lưu lại chỉ số và đồng bộ hóa đơn'
      );
    }
    throw error;
  }
  if (Object.keys(original).length === 0) {
    throw new RentalFinalSettlementError(
      409,
      'FINAL_INVOICE_DETAIL_REQUIRED',
      'Chưa có chi tiết hóa đơn tháng trả phòng; hãy vào Hóa đơn và lưu chỉ số trước'
    );
  }
  const period = periodFromDate(checkoutOn);
  const periodDays = daysInPeriod(period);
  const contractStartPeriod = periodFromDate(contract.starts_on);
  const firstChargedDay = contractStartPeriod === period ? dayOfMonth(contract.starts_on) : 1;
  const lastChargedDay = dayOfMonth(checkoutOn);
  if (contractStartPeriod > period || firstChargedDay > lastChargedDay) {
    throw new RentalFinalSettlementError(
      409,
      'INVALID_FINAL_SETTLEMENT_PERIOD',
      'Ngày trả phòng không nằm trong thời gian thuê của hợp đồng'
    );
  }
  const chargedDays = lastChargedDay - firstChargedDay + 1;
  const basePriceVnd = Math.round(Number(original.rent.basePriceVnd));
  const finalRentVnd = original.utilityOnly
    ? 0
    : Math.round((basePriceVnd * chargedDays) / periodDays);
  const finalDetail = {
    ...original,
    rent: {
      ...original.rent,
      amountVnd: finalRentVnd,
      chargedDays,
      daysInMonth: periodDays,
      prorated: !original.utilityOnly && chargedDays < periodDays,
      startsAfterPeriod: false
    }
  };
  const finalTotalVnd = Math.round(
    Number(originalTotalVnd) - Number(original.rent.amountVnd) + finalRentVnd
  );
  try {
    invoiceDetailInput(finalDetail, finalTotalVnd);
  } catch (error) {
    if (error instanceof RentPaymentError) {
      throw new RentalFinalSettlementError(
        409,
        'FINAL_INVOICE_CALCULATION_INVALID',
        'Không thể tính lại tiền phòng cho hóa đơn cuối'
      );
    }
    throw error;
  }
  return {
    period,
    chargedDays,
    daysInMonth: periodDays,
    firstChargedDay,
    lastChargedDay,
    originalRentVnd: Number(original.rent.amountVnd),
    finalRentVnd,
    finalTotalVnd,
    finalDetail
  };
}

function verifyHandoverReadings(handover, detail) {
  const mismatches = [];
  const electricity = handover.electricity_reading === null
    ? null
    : Number(handover.electricity_reading);
  if (electricity !== null
      && Math.abs(electricity - Number(detail.electricity.currentReading)) > 0.0005) {
    mismatches.push('điện');
  }
  const water = handover.water_reading === null ? null : Number(handover.water_reading);
  if (water !== null && detail.water.billingType === 'cubic_meter'
      && Math.abs(water - Number(detail.water.currentReading)) > 0.0005) {
    mismatches.push('nước');
  }
  if (mismatches.length > 0) {
    throw new RentalFinalSettlementError(
      409,
      'FINAL_HANDOVER_READING_MISMATCH',
      `Chỉ số ${mismatches.join(' và ')} trên hóa đơn không khớp biên bản trả phòng`
    );
  }
}

function settlementCode(id, occurredOn) {
  return `QTT-${dateOnly(occurredOn).slice(0, 4)}-${Number(id).toString(36).toUpperCase().padStart(6, '0')}`;
}

function settlementJson(row) {
  if (!row) return null;
  const detail = row.detail_snapshot && typeof row.detail_snapshot === 'object'
    ? row.detail_snapshot
    : {};
  return {
    id: Number(row.id),
    code: row.settlement_code,
    contractId: Number(row.contract_id),
    checkoutEventId: Number(row.checkout_event_id),
    handoverId: Number(row.handover_id),
    invoiceId: Number(row.invoice_id),
    depositAccountId: row.deposit_account_id === null ? null : Number(row.deposit_account_id),
    rentPaymentReceiptId: row.rent_payment_receipt_id === null
      ? null
      : Number(row.rent_payment_receipt_id),
    period: row.period,
    occurredOn: dateOnly(row.occurred_on),
    invoiceOriginalTotalVnd: Number(row.invoice_original_total_vnd) || 0,
    invoiceFinalTotalVnd: Number(row.invoice_final_total_vnd) || 0,
    priorDebtVnd: Number(row.prior_debt_vnd) || 0,
    paidBeforeVnd: Number(row.paid_before_vnd) || 0,
    depositBalanceBeforeVnd: Number(row.deposit_balance_before_vnd) || 0,
    depositAppliedVnd: Number(row.deposit_applied_vnd) || 0,
    depositRefundedVnd: Number(row.deposit_refunded_vnd) || 0,
    rentOverpaymentVnd: Number(row.rent_overpayment_vnd) || 0,
    totalRefundVnd: (Number(row.deposit_refunded_vnd) || 0)
      + (Number(row.rent_overpayment_vnd) || 0),
    remainingDueVnd: Number(row.remaining_due_vnd) || 0,
    refundMethod: row.refund_method,
    reason: row.reason,
    detail,
    createdAt: row.created_at
  };
}

async function ensureWritable(query, userId, dependencies = {}) {
  if (dependencies.enforceWrite) return dependencies.enforceWrite(userId, query);
  const { rows } = await query('SELECT COUNT(*)::int AS room_count FROM rooms WHERE user_id=$1', [userId]);
  return subscription.enforceStateWrite(userId, Number(rows[0]?.room_count) || 0, query);
}

async function loadExistingSettlement(query, userId, contractId) {
  const { rows } = await query(
    `SELECT * FROM rental_final_settlements
     WHERE user_id=$1 AND contract_id=$2`,
    [userId, contractId]
  );
  return rows[0] || null;
}

async function loadSettlementContext(query, userId, contractId, { lock = false } = {}) {
  const lockClause = lock ? ' FOR UPDATE' : '';
  const contractResult = await query(
    `SELECT * FROM rental_contracts WHERE user_id=$1 AND id=$2${lockClause}`,
    [userId, contractId]
  );
  const contract = contractResult.rows[0];
  if (!contract) {
    throw new RentalFinalSettlementError(404, 'CONTRACT_NOT_FOUND', 'Không tìm thấy hợp đồng');
  }
  if (contract.status !== 'ended') {
    throw new RentalFinalSettlementError(
      409,
      'CONTRACT_NOT_CHECKED_OUT',
      'Chỉ có thể chốt bill sau khi hợp đồng đã trả phòng'
    );
  }
  const eventResult = await query(
    `SELECT * FROM rental_lifecycle_events
     WHERE user_id=$1 AND contract_id=$2 AND event_type='checked_out'
     ORDER BY occurred_on DESC, id DESC LIMIT 1`,
    [userId, contractId]
  );
  const checkoutEvent = eventResult.rows[0];
  if (!checkoutEvent) {
    throw new RentalFinalSettlementError(
      409,
      'CHECKOUT_EVENT_REQUIRED',
      'Hợp đồng chưa có sự kiện trả phòng hợp lệ'
    );
  }
  const handoverResult = await query(
    `SELECT * FROM rental_handover_records
     WHERE user_id=$1 AND contract_id=$2 AND handover_type='check_out'
     ORDER BY occurred_on DESC, id DESC LIMIT 1`,
    [userId, contractId]
  );
  const handover = handoverResult.rows[0];
  if (!handover || dateOnly(handover.occurred_on) !== dateOnly(checkoutEvent.occurred_on)) {
    throw new RentalFinalSettlementError(
      409,
      'CHECKOUT_HANDOVER_REQUIRED',
      'Thiếu biên bản trả phòng đúng ngày kết thúc hợp đồng'
    );
  }
  const period = periodFromDate(checkoutEvent.occurred_on);
  const invoiceResult = await query(
    `SELECT * FROM rent_invoices
     WHERE user_id=$1 AND room_id=$2 AND period=$3${lockClause}`,
    [userId, contract.room_id, period]
  );
  const invoice = invoiceResult.rows[0];
  if (!invoice) {
    throw new RentalFinalSettlementError(
      409,
      'FINAL_INVOICE_REQUIRED',
      'Chưa có hóa đơn tháng trả phòng; hãy vào Hóa đơn và đồng bộ dữ liệu trước'
    );
  }
  if (invoice.finalized_at && Number(invoice.finalization_contract_id) !== contractId) {
    throw new RentalFinalSettlementError(
      409,
      'FINAL_INVOICE_ALREADY_USED',
      'Hóa đơn tháng trả phòng đã được chốt cho hợp đồng khác'
    );
  }
  const calculation = finalizeInvoiceDetail(
    invoice.final_detail_snapshot || invoice.detail_snapshot,
    invoice.final_total_vnd === null || invoice.final_total_vnd === undefined
      ? Number(invoice.issued_total_vnd)
      : Number(invoice.final_total_vnd),
    contract,
    checkoutEvent.occurred_on
  );
  verifyHandoverReadings(handover, calculation.finalDetail);

  if (lock) {
    await query(
      `SELECT pg_advisory_xact_lock(hashtextextended('deposit-account:' || $1::text || ':' || $2, 0))`,
      [userId, contract.tenant_id]
    );
  }

  let depositAccount = null;
  if (handover.deposit_account_id !== null && handover.deposit_account_id !== undefined) {
    const depositResult = await query(
      `SELECT account.*,
              COALESCE((SELECT SUM(tx.amount_vnd)
                        FROM tenant_deposit_transactions tx
                        WHERE tx.user_id=account.user_id AND tx.account_id=account.id), 0)
                AS balance_vnd
       FROM tenant_deposit_accounts account
       WHERE account.user_id=$1 AND account.id=$2`,
      [userId, handover.deposit_account_id]
    );
    depositAccount = depositResult.rows[0] || null;
  }
  if (!depositAccount) {
    const depositResult = await query(
      `SELECT account.*,
              COALESCE((SELECT SUM(tx.amount_vnd)
                        FROM tenant_deposit_transactions tx
                        WHERE tx.user_id=account.user_id AND tx.account_id=account.id), 0)
                AS balance_vnd
       FROM tenant_deposit_accounts account
       WHERE account.user_id=$1 AND account.tenant_id=$2`,
      [userId, contract.tenant_id]
    );
    depositAccount = depositResult.rows[0] || null;
  }

  if (lock) {
    await query(
      `SELECT id FROM rent_invoices
       WHERE user_id=$1 AND room_id=$2 AND period BETWEEN $3 AND $4
       ORDER BY period, id FOR UPDATE`,
      [userId, contract.room_id, periodFromDate(contract.starts_on), period]
    );
  }
  const balanceResult = await query(
    `SELECT invoice.id, invoice.period,
            COALESCE(invoice.final_total_vnd, invoice.issued_total_vnd) AS effective_total_vnd,
            COALESCE(SUM(tx.amount_vnd), 0) AS paid_amount_vnd
     FROM rent_invoices invoice
     LEFT JOIN rent_payment_transactions tx
       ON tx.user_id=invoice.user_id AND tx.invoice_id=invoice.id
     WHERE invoice.user_id=$1 AND invoice.room_id=$2
       AND invoice.period BETWEEN $3 AND $4
     GROUP BY invoice.id
     ORDER BY invoice.period, invoice.id`,
    [userId, contract.room_id, periodFromDate(contract.starts_on), period]
  );
  const invoices = balanceResult.rows.map((row) => ({
    id: Number(row.id),
    period: row.period,
    effectiveTotalVnd: Number(row.effective_total_vnd) || 0,
    paidAmountVnd: Number(row.paid_amount_vnd) || 0
  }));
  const current = invoices.find((row) => row.id === Number(invoice.id));
  const currentPaidVnd = current?.paidAmountVnd || 0;
  const priorInvoices = invoices.filter((row) => row.period < period);
  const priorDebtVnd = priorInvoices.reduce(
    (sum, row) => sum + Math.max(0, row.effectiveTotalVnd - row.paidAmountVnd),
    0
  );
  const paidBeforeVnd = invoices.reduce((sum, row) => sum + row.paidAmountVnd, 0);
  const currentRemainingVnd = Math.max(0, calculation.finalTotalVnd - currentPaidVnd);
  const rentOverpaymentVnd = Math.max(0, currentPaidVnd - calculation.finalTotalVnd);
  const outstandingBeforeDepositVnd = priorDebtVnd + currentRemainingVnd;
  const depositBalanceVnd = Math.max(0, Number(depositAccount?.balance_vnd) || 0);
  return {
    contract,
    checkoutEvent,
    handover,
    invoice,
    depositAccount,
    invoices,
    calculation,
    priorDebtVnd,
    paidBeforeVnd,
    currentPaidVnd,
    rentOverpaymentVnd,
    outstandingBeforeDepositVnd,
    depositBalanceVnd,
    suggestedDepositAppliedVnd: Math.min(depositBalanceVnd, outstandingBeforeDepositVnd),
    suggestedDepositRefundedVnd: Math.max(
      0,
      depositBalanceVnd - Math.min(depositBalanceVnd, outstandingBeforeDepositVnd)
    )
  };
}

function previewJson(context) {
  const { contract, checkoutEvent, handover, invoice, depositAccount, calculation } = context;
  return {
    contract: {
      id: Number(contract.id),
      code: contract.contract_code,
      roomId: contract.room_id,
      roomName: contract.room_name_snapshot,
      tenantId: contract.tenant_id,
      tenantName: contract.tenant_name_snapshot,
      startsOn: dateOnly(contract.starts_on),
      checkoutOn: dateOnly(checkoutEvent.occurred_on)
    },
    handover: {
      id: Number(handover.id),
      code: handover.handover_code,
      electricityReading: handover.electricity_reading === null
        ? null
        : Number(handover.electricity_reading),
      waterReading: handover.water_reading === null ? null : Number(handover.water_reading)
    },
    invoice: {
      id: Number(invoice.id),
      period: calculation.period,
      originalTotalVnd: Number(invoice.issued_total_vnd) || 0,
      finalTotalVnd: calculation.finalTotalVnd,
      originalRentVnd: calculation.originalRentVnd,
      finalRentVnd: calculation.finalRentVnd,
      chargedDays: calculation.chargedDays,
      daysInMonth: calculation.daysInMonth,
      detail: calculation.finalDetail
    },
    priorDebtVnd: context.priorDebtVnd,
    paidBeforeVnd: context.paidBeforeVnd,
    currentPaidVnd: context.currentPaidVnd,
    outstandingBeforeDepositVnd: context.outstandingBeforeDepositVnd,
    rentOverpaymentVnd: context.rentOverpaymentVnd,
    deposit: {
      accountId: depositAccount ? Number(depositAccount.id) : null,
      balanceVnd: context.depositBalanceVnd,
      suggestedAppliedVnd: context.suggestedDepositAppliedVnd,
      suggestedRefundedVnd: context.suggestedDepositRefundedVnd
    }
  };
}

async function getFinalSettlement(req, res, dependencies = {}) {
  let contractId;
  try {
    contractId = positiveId(req.params?.id);
  } catch (error) {
    if (sendSettlementError(res, error)) return res;
    throw error;
  }
  const query = dependencies.query || db.query;
  const existing = await loadExistingSettlement(query, req.userId, contractId);
  res.set('Cache-Control', 'no-store');
  if (existing) return res.json({ finalized: true, settlement: settlementJson(existing) });
  try {
    const context = await loadSettlementContext(query, req.userId, contractId);
    return res.json({ finalized: false, preview: previewJson(context) });
  } catch (error) {
    if (sendSettlementError(res, error)) return res;
    throw error;
  }
}

async function insertDepositEntry(client, userId, accountId, entryType, amountVnd, method, note, key, occurredOn) {
  if (amountVnd <= 0) return null;
  const idResult = await client.query("SELECT nextval('tenant_deposit_transactions_id_seq') AS id");
  const id = Number(idResult.rows[0].id);
  const result = await client.query(
    `INSERT INTO tenant_deposit_transactions
       (id, user_id, account_id, transaction_code, entry_type, amount_vnd,
        payment_method, note, source, idempotency_key, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'checkout_final_settlement',$9,$10)
     RETURNING *`,
    [
      id,
      userId,
      accountId,
      depositTransactionCode(id, entryType),
      entryType,
      -amountVnd,
      method,
      note,
      key,
      `${dateOnly(occurredOn)}T12:00:00.000Z`
    ]
  );
  return result.rows[0];
}

async function applyDepositToInvoices(client, userId, context, amountVnd, reason) {
  if (amountVnd <= 0) return { receipt: null, allocations: [] };
  const receiptIdResult = await client.query("SELECT nextval('rent_payment_receipts_id_seq') AS id");
  const receiptId = Number(receiptIdResult.rows[0].id);
  const receiptResult = await client.query(
    `INSERT INTO rent_payment_receipts
       (id, user_id, room_id, target_period, receipt_code, amount_vnd,
        payment_method, note, source, idempotency_key, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,'deposit',$7,'checkout_deposit',$8,$9)
     RETURNING *`,
    [
      receiptId,
      userId,
      context.contract.room_id,
      context.calculation.period,
      receiptCode(receiptId, context.calculation.period),
      amountVnd,
      reason,
      `final-settlement:${context.contract.id}:receipt`,
      `${dateOnly(context.checkoutEvent.occurred_on)}T12:00:00.000Z`
    ]
  );
  let remaining = amountVnd;
  const allocations = [];
  for (const invoice of context.invoices) {
    if (remaining <= 0) break;
    const total = invoice.id === Number(context.invoice.id)
      ? context.calculation.finalTotalVnd
      : invoice.effectiveTotalVnd;
    const due = Math.max(0, total - invoice.paidAmountVnd);
    if (due <= 0) continue;
    const allocated = Math.min(remaining, due);
    const result = await client.query(
      `INSERT INTO rent_payment_transactions
         (user_id, invoice_id, receipt_id, entry_type, amount_vnd,
          payment_method, note, source, occurred_at)
       VALUES ($1,$2,$3,'payment',$4,'deposit',$5,$6,$7)
       RETURNING id`,
      [
        userId,
        invoice.id,
        receiptId,
        allocated,
        reason,
        invoice.period < context.calculation.period
          ? 'checkout_deposit_prior'
          : 'checkout_deposit_current',
        `${dateOnly(context.checkoutEvent.occurred_on)}T12:00:00.000Z`
      ]
    );
    allocations.push({
      transactionId: Number(result.rows[0].id),
      invoiceId: invoice.id,
      period: invoice.period,
      amountVnd: allocated
    });
    remaining -= allocated;
  }
  if (remaining !== 0) {
    throw new RentalFinalSettlementError(
      409,
      'FINAL_DEPOSIT_ALLOCATION_FAILED',
      'Không thể phân bổ hết tiền cọc vào công nợ'
    );
  }
  return { receipt: receiptResult.rows[0], allocations };
}

async function createFinalSettlement(req, res, dependencies = {}) {
  let contractId;
  let input;
  try {
    contractId = positiveId(req.params?.id);
    input = settlementInput(req.body);
  } catch (error) {
    if (sendSettlementError(res, error)) return res;
    throw error;
  }
  const getClient = dependencies.getClient || db.getClient;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended('final-settlement:' || $1::text || ':' || $2::text, 0))`,
      [req.userId, contractId]
    );
    const existing = await loadExistingSettlement(client.query.bind(client), req.userId, contractId, true);
    if (existing) {
      const sameInput = Number(existing.deposit_applied_vnd) === input.depositAppliedVnd
        && Number(existing.deposit_refunded_vnd) === input.depositRefundedVnd
        && existing.refund_method === input.refundMethod
        && existing.reason === input.reason;
      if (!sameInput) {
        throw new RentalFinalSettlementError(
          409,
          'FINAL_SETTLEMENT_ALREADY_EXISTS',
          'Hợp đồng đã có biên quyết toán bất biến với nội dung khác'
        );
      }
      await client.query('COMMIT');
      return res.json({ reused: true, settlement: settlementJson(existing) });
    }
    await ensureWritable(client.query.bind(client), req.userId, dependencies);
    const context = await loadSettlementContext(
      client.query.bind(client),
      req.userId,
      contractId,
      { lock: true }
    );
    if (input.depositAppliedVnd + input.depositRefundedVnd !== context.depositBalanceVnd) {
      throw new RentalFinalSettlementError(
        409,
        'FINAL_DEPOSIT_BALANCE_MISMATCH',
        'Tiền cọc bù công nợ và hoàn lại phải bằng đúng số dư cọc hiện tại'
      );
    }
    if (input.depositAppliedVnd > context.outstandingBeforeDepositVnd) {
      throw new RentalFinalSettlementError(
        409,
        'FINAL_DEPOSIT_EXCEEDS_DEBT',
        'Tiền cọc bù công nợ không được vượt quá số tiền còn thiếu'
      );
    }
    if ((input.depositAppliedVnd > 0 || input.depositRefundedVnd > 0)
        && !context.depositAccount) {
      throw new RentalFinalSettlementError(
        409,
        'FINAL_DEPOSIT_ACCOUNT_REQUIRED',
        'Không tìm thấy sổ tiền cọc của khách thuê'
      );
    }
    const finalizedInvoice = await client.query(
      `UPDATE rent_invoices
       SET final_total_vnd=$4, final_detail_snapshot=$5::jsonb,
           finalization_contract_id=$3, finalized_at=now(), updated_at=now()
       WHERE user_id=$1 AND id=$2 AND finalized_at IS NULL
       RETURNING id`,
      [
        req.userId,
        context.invoice.id,
        contractId,
        context.calculation.finalTotalVnd,
        JSON.stringify(context.calculation.finalDetail)
      ]
    );
    if (!finalizedInvoice.rows[0]) {
      throw new RentalFinalSettlementError(
        409,
        'FINAL_INVOICE_ALREADY_FINALIZED',
        'Hóa đơn tháng trả phòng đã được chốt trước đó'
      );
    }
    const applied = await applyDepositToInvoices(
      client,
      req.userId,
      context,
      input.depositAppliedVnd,
      input.reason
    );
    const depositApply = await insertDepositEntry(
      client,
      req.userId,
      context.depositAccount?.id,
      'deduction',
      input.depositAppliedVnd,
      input.refundMethod,
      `Bù công nợ khi trả phòng: ${input.reason}`.slice(0, 500),
      `final-settlement:${contractId}:deposit-apply`,
      context.checkoutEvent.occurred_on
    );
    const depositRefund = await insertDepositEntry(
      client,
      req.userId,
      context.depositAccount?.id,
      'refund',
      input.depositRefundedVnd,
      input.refundMethod,
      `Hoàn cọc khi trả phòng: ${input.reason}`.slice(0, 500),
      `final-settlement:${contractId}:deposit-refund`,
      context.checkoutEvent.occurred_on
    );
    const settlementIdResult = await client.query("SELECT nextval('rental_final_settlements_id_seq') AS id");
    const settlementId = Number(settlementIdResult.rows[0].id);
    const remainingDueVnd = context.outstandingBeforeDepositVnd - input.depositAppliedVnd;
    const detailSnapshot = {
      contract: {
        code: context.contract.contract_code,
        roomId: context.contract.room_id,
        roomName: context.contract.room_name_snapshot,
        tenantId: context.contract.tenant_id,
        tenantName: context.contract.tenant_name_snapshot,
        startsOn: dateOnly(context.contract.starts_on),
        checkoutOn: dateOnly(context.checkoutEvent.occurred_on)
      },
      handover: {
        code: context.handover.handover_code,
        electricityReading: context.handover.electricity_reading === null
          ? null
          : Number(context.handover.electricity_reading),
        waterReading: context.handover.water_reading === null
          ? null
          : Number(context.handover.water_reading)
      },
      invoice: context.calculation.finalDetail,
      calculation: {
        chargedDays: context.calculation.chargedDays,
        daysInMonth: context.calculation.daysInMonth,
        firstChargedDay: context.calculation.firstChargedDay,
        lastChargedDay: context.calculation.lastChargedDay,
        originalRentVnd: context.calculation.originalRentVnd,
        finalRentVnd: context.calculation.finalRentVnd,
        outstandingBeforeDepositVnd: context.outstandingBeforeDepositVnd
      },
      allocations: applied.allocations
    };
    const inserted = await client.query(
      `INSERT INTO rental_final_settlements
         (id, user_id, settlement_code, contract_id, checkout_event_id,
          handover_id, invoice_id, deposit_account_id, rent_payment_receipt_id,
          deposit_apply_transaction_id, deposit_refund_transaction_id,
          period, occurred_on, invoice_original_total_vnd, invoice_final_total_vnd,
          prior_debt_vnd, paid_before_vnd, deposit_balance_before_vnd,
          deposit_applied_vnd, deposit_refunded_vnd, rent_overpayment_vnd,
          remaining_due_vnd, refund_method, detail_snapshot, reason)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24::jsonb,$25)
       RETURNING *`,
      [
        settlementId,
        req.userId,
        settlementCode(settlementId, context.checkoutEvent.occurred_on),
        contractId,
        context.checkoutEvent.id,
        context.handover.id,
        context.invoice.id,
        context.depositAccount?.id || null,
        applied.receipt?.id || null,
        depositApply?.id || null,
        depositRefund?.id || null,
        context.calculation.period,
        dateOnly(context.checkoutEvent.occurred_on),
        Number(context.invoice.issued_total_vnd),
        context.calculation.finalTotalVnd,
        context.priorDebtVnd,
        context.paidBeforeVnd,
        context.depositBalanceVnd,
        input.depositAppliedVnd,
        input.depositRefundedVnd,
        context.rentOverpaymentVnd,
        remainingDueVnd,
        input.refundMethod,
        JSON.stringify(detailSnapshot),
        input.reason
      ]
    );
    await recordDataAudits(client.query.bind(client), [
      requestDataAuditEntry(
        req,
        'rental_contract_final_settlement_created',
        'rental_contract',
        contractId,
        {
          changedFields: ['status', 'finalTotalVnd', 'depositVnd'],
          purpose: input.reason
        }
      ),
      requestDataAuditEntry(
        req,
        'rent_invoice_finalized',
        'rent_invoice',
        context.invoice.id,
        {
          changedFields: ['finalTotalVnd', 'detailSnapshot'],
          purpose: `Quyết toán ${inserted.rows[0].settlement_code}`
        }
      ),
      ...applied.allocations.map(allocation => requestDataAuditEntry(
        req,
        'rent_payment_transaction_recorded',
        'rent_payment_transaction',
        allocation.transactionId,
        {
          changedFields: ['entryType', 'amountVnd', 'paymentMethod'],
          purpose: `Cấn trừ cọc khi quyết toán kỳ ${allocation.period}`
        }
      )),
      ...[depositApply, depositRefund].filter(Boolean).map(transaction => requestDataAuditEntry(
        req,
        'deposit_transaction_recorded',
        'deposit_transaction',
        transaction.id,
        {
          changedFields: ['entryType', 'amountVnd', 'paymentMethod'],
          purpose: `Quyết toán ${inserted.rows[0].settlement_code}`
        }
      ))
    ]);
    await client.query('COMMIT');
    return res.status(201).json({ reused: false, settlement: settlementJson(inserted.rows[0]) });
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    if (sendSettlementError(res, error)) return res;
    if (error.code === '23505') {
      return res.status(409).json({
        error: 'Hợp đồng đã có biên quyết toán',
        code: 'FINAL_SETTLEMENT_ALREADY_EXISTS'
      });
    }
    throw error;
  } finally {
    client.release();
  }
}

async function loadRentalFinalSettlementExport(userId) {
  const { rows } = await db.query(
    `SELECT * FROM rental_final_settlements
     WHERE user_id=$1 ORDER BY occurred_on, id`,
    [userId]
  );
  return rows.map(settlementJson);
}

module.exports = {
  REFUND_METHODS,
  RentalFinalSettlementError,
  createFinalSettlement,
  finalizeInvoiceDetail,
  getFinalSettlement,
  loadRentalFinalSettlementExport,
  loadSettlementContext,
  previewJson,
  settlementCode,
  settlementInput,
  settlementJson,
  verifyHandoverReadings
};
