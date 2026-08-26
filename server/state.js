'use strict';

const db = require('./db');
const RoomRates = require('../rate-history');
const { recordDataAudit, requestAuditContext } = require('./data-audit');
const { TENANT_DATA_NOTICE_VERSION } = require('./privacy-constants');
const { enforceStateWrite, sendEntitlementError } = require('./subscription');
const { RentBankSettingsError, normalizeRentBankSettings } = require('./rent-bank-settings');
const {
  DEFAULT_AFTER_DAYS,
  DEFAULT_BEFORE_DAYS,
  RentInvoiceReminderSettingsError,
  normalizeInvoiceReminderSettings
} = require('./rent-invoice-reminder-settings');

// ---------- helpers chuyển đổi kiểu ----------
const num = (v, d = 0) => (v === null || v === undefined || v === '' ? d : Number(v));
// billing sentinel: DB NULL -> '' cho client (client dùng '' làm "chưa nhập")
const orEmpty = (v) => (v === null || v === undefined ? '' : Number(v));
// client '' / undefined -> NULL cho DB
const orNull = (v) => (v === '' || v === undefined || v === null ? null : Number(v));
const strOrNull = (v) => (v === '' || v === undefined || v === null ? null : String(v));
const INVOICE_ADJUSTMENT_FIELDS = ['discountAmount', 'surchargeAmount', 'lateFeeAmount'];
const TENANT_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function hasInvalidInvoiceAdjustment(source = {}) {
  return INVOICE_ADJUSTMENT_FIELDS.some((field) => {
    const value = source[field];
    if (value === '' || value === undefined || value === null) return false;
    const parsed = Number(value);
    return !Number.isSafeInteger(parsed) || parsed < 0 || parsed > 999999999999;
  });
}

function maskCccd(value) {
  const cccd = String(value || '').trim();
  if (!cccd) return '';
  const visible = cccd.slice(-4);
  return `${'•'.repeat(Math.max(0, cccd.length - visible.length))}${visible}`;
}

function isMaskedCccd(value) {
  return /[•*]/.test(String(value || ''));
}

const TENANT_SENSITIVE_FIELDS = [
  ['fullName', 'full_name'],
  ['phone', 'phone'],
  ['email', 'email'],
  ['cccd', 'cccd'],
  ['issueDate', 'issue_date'],
  ['dob', 'dob'],
  ['gender', 'gender'],
  ['address', 'address']
];

function changedTenantFields(existing, tenant, resolvedCccd) {
  if (!existing) return TENANT_SENSITIVE_FIELDS.map(([clientField]) => clientField);
  return TENANT_SENSITIVE_FIELDS
    .filter(([clientField, databaseField]) => {
      const nextValue = clientField === 'cccd' ? resolvedCccd : tenant[clientField];
      return String(existing[databaseField] || '') !== String(nextValue || '');
    })
    .map(([clientField]) => clientField);
}

// ============================================================
//  GET /api/state — lắp ráp toàn bộ state từ các bảng dữ liệu
// ============================================================
async function buildState(uid, options = {}) {
  const [settingsR, roomsR, ratesR, tenantsR, billingR, expensesR, snapsR, billsR] = await Promise.all([
    db.query('SELECT * FROM settings WHERE user_id=$1', [uid]),
    db.query('SELECT * FROM rooms WHERE user_id=$1 ORDER BY sort_order, name', [uid]),
    db.query('SELECT * FROM room_rate_history WHERE user_id=$1 ORDER BY room_id, effective_from', [uid]),
    db.query('SELECT * FROM tenants WHERE user_id=$1 ORDER BY sort_order', [uid]),
    db.query('SELECT * FROM billing_entries WHERE user_id=$1', [uid]),
    db.query('SELECT * FROM expense_entries WHERE user_id=$1 ORDER BY period, sort_order', [uid]),
    db.query('SELECT * FROM history_snapshots WHERE user_id=$1 ORDER BY period', [uid]),
    db.query(
      `SELECT hb.* FROM history_bills hb
       JOIN history_snapshots hs ON hs.id = hb.snapshot_id
       WHERE hs.user_id=$1 ORDER BY hb.snapshot_id, hb.sort_order`,
      [uid]
    )
  ]);

  const s = settingsR.rows[0] || {};
  const settings = {
    deduction: num(s.deduction, 450000),
    bankId: s.bank_id || '',
    bankAccount: s.bank_account || '',
    bankOwnerName: s.bank_owner_name || '',
    bankTransferPattern: s.bank_transfer_pattern || '',
    reminderEnabled: !!s.reminder_enabled,
    reminderDay: num(s.reminder_day, 30),
    reminderTime: s.reminder_time || '20:00',
    invoiceReminderEnabled: !!s.invoice_reminder_enabled,
    invoiceReminderBeforeDays: Array.isArray(s.invoice_reminder_before_days)
      ? s.invoice_reminder_before_days.map(Number)
      : [...DEFAULT_BEFORE_DAYS],
    invoiceReminderAfterDays: Array.isArray(s.invoice_reminder_after_days)
      ? s.invoice_reminder_after_days.map(Number)
      : [...DEFAULT_AFTER_DAYS]
  };
  const theme = s.theme || 'system';

  // tenants gom theo room
  const tenantsByRoom = {};
  for (const t of tenantsR.rows) {
    (tenantsByRoom[t.room_id] ||= []).push({
      id: t.id,
      fullName: t.full_name,
      phone: t.phone,
      email: t.email || '',
      cccd: options.maskCccd === false ? t.cccd : maskCccd(t.cccd),
      issueDate: t.issue_date,
      dob: t.dob,
      gender: t.gender,
      address: t.address,
      dataNoticeAcknowledged: !!t.data_notice_acknowledged_at &&
        t.data_notice_version === TENANT_DATA_NOTICE_VERSION,
      dataNoticeVersion: t.data_notice_version || ''
    });
  }

  const ratesByRoom = {};
  for (const rate of ratesR.rows) {
    (ratesByRoom[rate.room_id] ||= []).push({
      effectiveFrom: rate.effective_from,
      rentPrice: num(rate.rent_price),
      electricRate: num(rate.electric_rate, 3200),
      waterRate: num(rate.water_rate, 50000),
      trashFee: num(rate.trash_fee, 50000),
      wifiFee: num(rate.wifi_fee),
      manageFee: num(rate.manage_fee)
    });
  }

  const rooms = roomsR.rows.map((r) => {
    const room = {
      id: r.id,
      name: r.name,
      rentStartDate: r.rent_start_date || '',
      rentPrice: num(r.rent_price),
      electricRate: num(r.electric_rate, 3200),
      waterRate: num(r.water_rate, 50000),
      waterType: r.water_type || 'người',
      peopleCount: num(r.people_count, 1),
      trashFee: num(r.trash_fee, 50000),
      wifiFee: num(r.wifi_fee),
      manageFee: num(r.manage_fee),
      electricPrev: num(r.electric_prev),
      waterPrev: num(r.water_prev),
      notes: r.notes || '',
      tenants: tenantsByRoom[r.id] || [],
      rateHistory: ratesByRoom[r.id] || []
    };
    room.rateHistory = RoomRates.normalizeHistory(room);
    return room;
  });

  // billingData: { period: { roomId: entry } }
  const billingData = {};
  for (const b of billingR.rows) {
    const entry = {
      electricNew: orEmpty(b.electric_new),
      waterUnits: orEmpty(b.water_units),
      waterNew: orEmpty(b.water_new),
      utilityOnly: !!b.utility_only,
      discountAmount: num(b.discount_amount),
      surchargeAmount: num(b.surcharge_amount),
      lateFeeAmount: num(b.late_fee_amount),
      paid: !!b.paid
    };
    if (b.electric_old_override !== null) entry.electricOldOverride = Number(b.electric_old_override);
    if (b.water_old_override !== null) entry.waterOldOverride = Number(b.water_old_override);
    if (b.note !== null && b.note !== '') entry.note = b.note;
    (billingData[b.period] ||= {})[b.room_id] = entry;
  }

  const expenses = {};
  for (const expense of expensesR.rows) {
    (expenses[expense.period] ||= []).push({
      id: expense.id,
      category: expense.category || 'other',
      name: expense.name || '',
      amount: num(expense.amount),
      paidDate: expense.paid_date || '',
      note: expense.note || ''
    });
  }

  // history: snapshot + bills
  const billsBySnap = {};
  for (const hb of billsR.rows) {
    (billsBySnap[hb.snapshot_id] ||= []).push({
      roomId: hb.room_id,
      roomName: hb.room_name,
      rentPrice: num(hb.rent_price),
      rentBasePrice: num(hb.rent_base_price, num(hb.rent_price)),
      rentDays: hb.rent_days === null ? null : Number(hb.rent_days),
      rentDaysInMonth: hb.rent_days_in_month === null ? null : Number(hb.rent_days_in_month),
      rentProrated: !!hb.rent_prorated,
      rentStartsAfterPeriod: !!hb.rent_starts_after_period,
      electricOld: num(hb.electric_old),
      electricNew: hb.electric_new === null ? null : Number(hb.electric_new),
      electricRate: num(hb.electric_rate),
      kwh: num(hb.kwh),
      electricAmt: num(hb.electric_amt),
      waterType: hb.water_type || 'người',
      waterRate: num(hb.water_rate),
      waterUnits: num(hb.water_units),
      waterAmt: num(hb.water_amt),
      waterPrev: hb.water_prev === null ? null : Number(hb.water_prev),
      waterNew: hb.water_new === null ? null : Number(hb.water_new),
      trashFee: num(hb.trash_fee),
      wifiFee: num(hb.wifi_fee),
      manageFee: num(hb.manage_fee),
      utilityOnly: !!hb.utility_only,
      discountAmount: num(hb.discount_amount),
      surchargeAmount: num(hb.surcharge_amount),
      lateFeeAmount: num(hb.late_fee_amount),
      total: num(hb.total),
      paid: !!hb.paid
    });
  }
  const history = snapsR.rows.map((hs) => ({
    period: hs.period,
    deduction: num(hs.deduction, 450000),
    timestamp: Number(hs.created_at),
    bills: billsBySnap[hs.id] || []
  }));

  return { rooms, billingData, expenses, settings, history, theme };
}

async function getState(req, res) {
  res.json(await buildState(req.userId, { maskCccd: true }));
}

// ============================================================
//  PUT /api/state — nhận toàn bộ state, tách vào các bảng (1 transaction)
//  Chiến lược: xóa sạch dữ liệu cũ của user rồi ghi lại (đơn giản, an toàn
//  với quy mô nhà trọ; toàn bộ nằm trong transaction nên không mất dữ liệu).
// ============================================================
async function putState(req, res) {
  const uid = req.userId;
  const body = req.body || {};
  const rooms = Array.isArray(body.rooms) ? body.rooms : [];
  const billingData = body.billingData && typeof body.billingData === 'object' ? body.billingData : {};
  const expenses = body.expenses && typeof body.expenses === 'object' ? body.expenses : {};
  const settings = body.settings && typeof body.settings === 'object' ? body.settings : {};
  const history = Array.isArray(body.history) ? body.history : [];
  const theme = body.theme || 'system';
  let rentBankSettings;
  let invoiceReminderSettings;
  try {
    rentBankSettings = normalizeRentBankSettings(settings);
    invoiceReminderSettings = normalizeInvoiceReminderSettings(settings, { allowMissing: true });
  } catch (error) {
    if (error instanceof RentBankSettingsError || error instanceof RentInvoiceReminderSettingsError) {
      return res.status(400).json({ error: error.message, code: error.code });
    }
    throw error;
  }

  const roomIds = new Set();
  const tenantIds = new Set();
  for (const room of rooms) {
    const roomId = String(room && room.id || '').trim();
    if (!roomId || roomId.length > 200 || roomIds.has(roomId)) {
      return res.status(400).json({ error: 'Danh sách phòng chứa ID không hợp lệ hoặc bị trùng' });
    }
    roomIds.add(roomId);
    for (const tenant of Array.isArray(room.tenants) ? room.tenants : []) {
      const tenantId = String(tenant && tenant.id || '').trim();
      if (!tenantId || tenantId.length > 200 || tenantIds.has(tenantId)) {
        return res.status(400).json({ error: 'Danh sách khách thuê chứa ID không hợp lệ hoặc bị trùng' });
      }
      const tenantEmail = String(tenant && tenant.email || '').trim().toLowerCase();
      if (tenantEmail && (tenantEmail.length > 254 || !TENANT_EMAIL_PATTERN.test(tenantEmail))) {
        return res.status(400).json({
          error: 'Email nhận hóa đơn của khách thuê không hợp lệ',
          code: 'INVALID_TENANT_EMAIL'
        });
      }
      tenantIds.add(tenantId);
    }
  }
  for (const period of Object.keys(billingData)) {
    for (const roomId of Object.keys(billingData[period] || {})) {
      if (!roomIds.has(roomId)) {
        return res.status(400).json({ error: 'Dữ liệu hóa đơn chứa phòng không thuộc tài khoản' });
      }
      if (hasInvalidInvoiceAdjustment(billingData[period][roomId])) {
        return res.status(400).json({
          error: 'Giảm giá, phụ thu hoặc phí chậm thanh toán không hợp lệ',
          code: 'INVALID_INVOICE_ADJUSTMENT'
        });
      }
    }
  }
  for (const snapshot of history) {
    if ((Array.isArray(snapshot?.bills) ? snapshot.bills : []).some(hasInvalidInvoiceAdjustment)) {
      return res.status(400).json({
        error: 'Điều chỉnh trong lịch sử hóa đơn không hợp lệ',
        code: 'INVALID_INVOICE_ADJUSTMENT'
      });
    }
  }

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // Server quyết định quyền ghi và giới hạn phòng từ subscription trong DB.
    // Kiểm tra client chỉ để UX; không thể dùng client để tự mở khóa gói.
    await enforceStateWrite(uid, rooms.length, client.query.bind(client));

    const existingTenantResult = await client.query(
      `SELECT id, full_name, phone, email, cccd, issue_date, dob, gender, address,
              data_notice_version, data_notice_acknowledged_at
       FROM tenants WHERE user_id=$1`,
      [uid]
    );
    const existingTenants = new Map(existingTenantResult.rows.map(tenant => [tenant.id, tenant]));
    const removedTenantIds = Array.from(existingTenants.keys())
      .filter((tenantId) => !tenantIds.has(tenantId));
    if (removedTenantIds.length > 0) {
      const outstandingDepositResult = await client.query(
        `SELECT a.tenant_id, a.tenant_name_snapshot,
                COALESCE(SUM(t.amount_vnd), 0) AS balance_vnd
         FROM tenant_deposit_accounts a
         LEFT JOIN tenant_deposit_transactions t
           ON t.user_id=a.user_id AND t.account_id=a.id
         WHERE a.user_id=$1 AND a.tenant_id=ANY($2::text[])
         GROUP BY a.id
         HAVING COALESCE(SUM(t.amount_vnd), 0) > 0
         ORDER BY a.id
         LIMIT 1`,
        [uid, removedTenantIds]
      );
      if (outstandingDepositResult.rows[0]) {
        const deposit = outstandingDepositResult.rows[0];
        await client.query('ROLLBACK');
        return res.status(409).json({
          error: `Khách ${deposit.tenant_name_snapshot || deposit.tenant_id} còn ${num(deposit.balance_vnd)} đồng tiền cọc. Hãy hoàn hoặc khấu trừ hết cọc trước khi xóa.`,
          code: 'TENANT_DEPOSIT_BALANCE_REMAINS',
          tenantId: deposit.tenant_id,
          balanceVnd: num(deposit.balance_vnd)
        });
      }
    }
    const resolvedTenants = new Map();
    const tenantAudits = [];

    for (const room of rooms) {
      for (const tenant of Array.isArray(room.tenants) ? room.tenants : []) {
        const existing = existingTenants.get(tenant.id);
        const submittedCccd = String(tenant.cccd || '').trim();
        if (isMaskedCccd(submittedCccd) && !existing) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'CCCD đã che không thể dùng để tạo khách thuê mới' });
        }
        const resolvedCccd = isMaskedCccd(submittedCccd)
          ? String(existing.cccd || '')
          : submittedCccd;
        if (!resolvedCccd) {
          await client.query('ROLLBACK');
          return res.status(400).json({ error: 'Số CCCD của khách thuê không được để trống' });
        }

        const fields = changedTenantFields(existing, tenant, resolvedCccd);
        const noticePreviouslyAcknowledged = !!(
          existing &&
          existing.data_notice_acknowledged_at &&
          existing.data_notice_version === TENANT_DATA_NOTICE_VERSION
        );
        const noticeAcknowledged = noticePreviouslyAcknowledged || tenant.dataNoticeAcknowledged === true;
        if ((!existing || fields.length > 0) && !noticeAcknowledged) {
          await client.query('ROLLBACK');
          return res.status(400).json({
            error: 'Cần xác nhận đã thông báo mục đích thu thập dữ liệu cho khách thuê',
            code: 'TENANT_DATA_NOTICE_REQUIRED'
          });
        }

        resolvedTenants.set(tenant.id, {
          cccd: resolvedCccd,
          dataNoticeAcknowledgedAt: noticePreviouslyAcknowledged
            ? existing.data_notice_acknowledged_at
            : (noticeAcknowledged ? new Date().toISOString() : null),
          dataNoticeVersion: noticeAcknowledged
            ? TENANT_DATA_NOTICE_VERSION
            : ''
        });
        if (!existing) {
          tenantAudits.push({ action: 'tenant_sensitive_create', tenantId: tenant.id, fields });
        } else if (fields.length > 0) {
          tenantAudits.push({ action: 'tenant_sensitive_update', tenantId: tenant.id, fields });
        }
      }
    }
    for (const tenantId of existingTenants.keys()) {
      if (!tenantIds.has(tenantId)) {
        tenantAudits.push({ action: 'tenant_sensitive_delete', tenantId, fields: [] });
      }
    }

    // settings (upsert)
    await client.query(
      `INSERT INTO settings
         (user_id, deduction, bank_id, bank_account, bank_owner_name,
          bank_transfer_pattern, reminder_enabled, reminder_day, reminder_time,
          invoice_reminder_enabled, invoice_reminder_before_days,
          invoice_reminder_after_days, theme)
       VALUES (
         $1,$2,$3,$4,$5,$6,$7,$8,$9,
         COALESCE($10, false), COALESCE($11, ARRAY[3,1]::integer[]),
         COALESCE($12, ARRAY[1,3,7]::integer[]), $13
       )
       ON CONFLICT (user_id) DO UPDATE SET
         deduction=$2, bank_id=$3, bank_account=$4, bank_owner_name=$5,
         bank_transfer_pattern=$6, reminder_enabled=$7, reminder_day=$8,
         reminder_time=$9,
         invoice_reminder_enabled=COALESCE($10, settings.invoice_reminder_enabled),
         invoice_reminder_before_days=COALESCE($11, settings.invoice_reminder_before_days),
         invoice_reminder_after_days=COALESCE($12, settings.invoice_reminder_after_days),
         theme=$13`,
      [
        uid,
        num(settings.deduction, 450000),
        rentBankSettings.bankId,
        rentBankSettings.accountNumber,
        rentBankSettings.ownerName,
        settings.bankTransferPattern || '',
        !!settings.reminderEnabled,
        num(settings.reminderDay, 30),
        settings.reminderTime || '20:00',
        invoiceReminderSettings.enabled,
        invoiceReminderSettings.beforeDays,
        invoiceReminderSettings.afterDays,
        theme
      ]
    );

    // Xóa dữ liệu con của user (cascade sẽ dọn tenants/history_bills)
    await client.query('DELETE FROM billing_entries WHERE user_id=$1', [uid]);
    await client.query('DELETE FROM expense_entries WHERE user_id=$1', [uid]);
    await client.query('DELETE FROM history_snapshots WHERE user_id=$1', [uid]);
    await client.query('DELETE FROM rooms WHERE user_id=$1', [uid]);

    // rooms + lịch sử biểu phí + tenants
    let rIdx = 0;
    for (const r of rooms) {
      const rateHistory = RoomRates.normalizeHistory(r);
      const latestRates = rateHistory[rateHistory.length - 1];
      await client.query(
        `INSERT INTO rooms
            (id, user_id, name, rent_start_date, rent_price, electric_rate, water_rate, water_type,
            people_count, trash_fee, wifi_fee, manage_fee, electric_prev, water_prev,
            notes, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [
          r.id, uid, r.name || 'Phòng không tên', r.rentStartDate || '', latestRates.rentPrice, latestRates.electricRate,
          latestRates.waterRate, r.waterType || 'người', num(r.peopleCount, 1),
          latestRates.trashFee, latestRates.wifiFee, latestRates.manageFee, num(r.electricPrev),
          num(r.waterPrev), r.notes || '', rIdx++
        ]
      );
      for (const rate of rateHistory) {
        await client.query(
          `INSERT INTO room_rate_history
             (user_id, room_id, effective_from, rent_price, electric_rate, water_rate,
              trash_fee, wifi_fee, manage_fee)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            uid, r.id, rate.effectiveFrom, rate.rentPrice, rate.electricRate,
            rate.waterRate, rate.trashFee, rate.wifiFee, rate.manageFee
          ]
        );
      }
      let tIdx = 0;
      for (const t of Array.isArray(r.tenants) ? r.tenants : []) {
        const resolved = resolvedTenants.get(t.id);
        await client.query(
          `INSERT INTO tenants
             (id, room_id, user_id, full_name, phone, email, cccd, issue_date, dob, gender,
              address, data_notice_version, data_notice_acknowledged_at, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            t.id, r.id, uid, t.fullName || '', t.phone || '',
            String(t.email || '').trim().toLowerCase(), resolved.cccd,
            t.issueDate || '', t.dob || '', t.gender || 'Nam', t.address || '',
            resolved.dataNoticeVersion, resolved.dataNoticeAcknowledgedAt, tIdx++
          ]
        );
      }
    }

    // billing_entries
    for (const period of Object.keys(billingData)) {
      const byRoom = billingData[period] || {};
      for (const roomId of Object.keys(byRoom)) {
        const e = byRoom[roomId] || {};
        await client.query(
          `INSERT INTO billing_entries
             (user_id, period, room_id, electric_new, water_units, water_new,
              electric_old_override, water_old_override, note, utility_only,
              discount_amount, surcharge_amount, late_fee_amount, paid)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
          [
            uid, period, roomId, orNull(e.electricNew), orNull(e.waterUnits),
            orNull(e.waterNew), orNull(e.electricOldOverride), orNull(e.waterOldOverride),
            strOrNull(e.note), !!e.utilityOnly, num(e.discountAmount),
            num(e.surchargeAmount), num(e.lateFeeAmount), !!e.paid
          ]
        );
      }
    }

    // expense_entries
    for (const period of Object.keys(expenses)) {
      const items = Array.isArray(expenses[period]) ? expenses[period] : [];
      let expenseIndex = 0;
      for (const expense of items) {
        await client.query(
          `INSERT INTO expense_entries
             (id, user_id, period, category, name, amount, paid_date, note, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
          [
            expense.id, uid, period, expense.category || 'other', expense.name || '',
            num(expense.amount), expense.paidDate || '', expense.note || '', expenseIndex++
          ]
        );
      }
    }

    // history_snapshots + history_bills
    for (const h of history) {
      const snap = await client.query(
        `INSERT INTO history_snapshots (user_id, period, deduction, created_at)
         VALUES ($1,$2,$3,$4) RETURNING id`,
        [uid, h.period, num(h.deduction, 450000), Number(h.timestamp) || Date.now()]
      );
      const snapId = snap.rows[0].id;
      let bIdx = 0;
      for (const b of Array.isArray(h.bills) ? h.bills : []) {
        await client.query(
          `INSERT INTO history_bills
             (snapshot_id, room_id, room_name, rent_price, rent_base_price, rent_days,
              rent_days_in_month, rent_prorated, rent_starts_after_period, electric_old, electric_new,
              electric_rate, kwh, electric_amt, water_type, water_rate, water_units,
              water_amt, water_prev, water_new, trash_fee, wifi_fee, manage_fee, utility_only,
              discount_amount, surcharge_amount, late_fee_amount, total, paid, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29,$30)`,
          [
            snapId, b.roomId, b.roomName, num(b.rentPrice), num(b.rentBasePrice, num(b.rentPrice)),
            orNull(b.rentDays), orNull(b.rentDaysInMonth), !!b.rentProrated, !!b.rentStartsAfterPeriod,
            num(b.electricOld),
            b.electricNew === null || b.electricNew === undefined ? null : Number(b.electricNew),
            num(b.electricRate), num(b.kwh), num(b.electricAmt), b.waterType || 'người',
            num(b.waterRate), num(b.waterUnits), num(b.waterAmt),
            b.waterPrev === null || b.waterPrev === undefined ? null : Number(b.waterPrev),
            b.waterNew === null || b.waterNew === undefined ? null : Number(b.waterNew),
            num(b.trashFee), num(b.wifiFee), num(b.manageFee), !!b.utilityOnly,
            num(b.discountAmount), num(b.surchargeAmount), num(b.lateFeeAmount),
            num(b.total), !!b.paid, bIdx++
          ]
        );
      }
    }

    const auditContext = requestAuditContext(req);
    for (const audit of tenantAudits) {
      await recordDataAudit(client.query.bind(client), {
        actorUserId: uid,
        actorEmail: req.userEmail || '',
        subjectUserId: uid,
        action: audit.action,
        resourceType: 'tenant',
        resourceId: audit.tenantId,
        changedFields: audit.fields,
        ...auditContext
      });
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    if (sendEntitlementError(res, err)) return;
    console.error('putState lỗi:', err.message);
    res.status(500).json({ error: 'Không lưu được dữ liệu' });
  } finally {
    client.release();
  }
}

module.exports = {
  buildState,
  changedTenantFields,
  getState,
  isMaskedCccd,
  maskCccd,
  num,
  orNull,
  putState,
  strOrNull
};
