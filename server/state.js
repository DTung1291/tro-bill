'use strict';

const db = require('./db');

// ---------- helpers chuyển đổi kiểu ----------
const num = (v, d = 0) => (v === null || v === undefined || v === '' ? d : Number(v));
// billing sentinel: DB NULL -> '' cho client (client dùng '' làm "chưa nhập")
const orEmpty = (v) => (v === null || v === undefined ? '' : Number(v));
// client '' / undefined -> NULL cho DB
const orNull = (v) => (v === '' || v === undefined || v === null ? null : Number(v));
const strOrNull = (v) => (v === '' || v === undefined || v === null ? null : String(v));

// ============================================================
//  GET /api/state — lắp ráp toàn bộ state từ 7 bảng
// ============================================================
async function buildState(uid) {
  const [settingsR, roomsR, tenantsR, billingR, snapsR, billsR] = await Promise.all([
    db.query('SELECT * FROM settings WHERE user_id=$1', [uid]),
    db.query('SELECT * FROM rooms WHERE user_id=$1 ORDER BY sort_order, name', [uid]),
    db.query('SELECT * FROM tenants WHERE user_id=$1 ORDER BY sort_order', [uid]),
    db.query('SELECT * FROM billing_entries WHERE user_id=$1', [uid]),
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
    reminderTime: s.reminder_time || '20:00'
  };
  const theme = s.theme || 'system';

  // tenants gom theo room
  const tenantsByRoom = {};
  for (const t of tenantsR.rows) {
    (tenantsByRoom[t.room_id] ||= []).push({
      id: t.id,
      fullName: t.full_name,
      phone: t.phone,
      cccd: t.cccd,
      issueDate: t.issue_date,
      dob: t.dob,
      gender: t.gender,
      address: t.address
    });
  }

  const rooms = roomsR.rows.map((r) => ({
    id: r.id,
    name: r.name,
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
    tenants: tenantsByRoom[r.id] || []
  }));

  // billingData: { period: { roomId: entry } }
  const billingData = {};
  for (const b of billingR.rows) {
    const entry = {
      electricNew: orEmpty(b.electric_new),
      waterUnits: orEmpty(b.water_units),
      waterNew: orEmpty(b.water_new),
      paid: !!b.paid
    };
    if (b.electric_old_override !== null) entry.electricOldOverride = Number(b.electric_old_override);
    if (b.water_old_override !== null) entry.waterOldOverride = Number(b.water_old_override);
    if (b.note !== null && b.note !== '') entry.note = b.note;
    (billingData[b.period] ||= {})[b.room_id] = entry;
  }

  // history: snapshot + bills
  const billsBySnap = {};
  for (const hb of billsR.rows) {
    (billsBySnap[hb.snapshot_id] ||= []).push({
      roomId: hb.room_id,
      roomName: hb.room_name,
      rentPrice: num(hb.rent_price),
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

  return { rooms, billingData, settings, history, theme };
}

async function getState(req, res) {
  res.json(await buildState(req.userId));
}

// ============================================================
//  PUT /api/state — nhận toàn bộ state, tách vào 7 bảng (1 transaction)
//  Chiến lược: xóa sạch dữ liệu cũ của user rồi ghi lại (đơn giản, an toàn
//  với quy mô nhà trọ; toàn bộ nằm trong transaction nên không mất dữ liệu).
// ============================================================
async function putState(req, res) {
  const uid = req.userId;
  const body = req.body || {};
  const rooms = Array.isArray(body.rooms) ? body.rooms : [];
  const billingData = body.billingData && typeof body.billingData === 'object' ? body.billingData : {};
  const settings = body.settings && typeof body.settings === 'object' ? body.settings : {};
  const history = Array.isArray(body.history) ? body.history : [];
  const theme = body.theme || 'system';

  const client = await db.getClient();
  try {
    await client.query('BEGIN');

    // settings (upsert)
    await client.query(
      `INSERT INTO settings
         (user_id, deduction, bank_id, bank_account, bank_owner_name,
          bank_transfer_pattern, reminder_enabled, reminder_day, reminder_time, theme)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (user_id) DO UPDATE SET
         deduction=$2, bank_id=$3, bank_account=$4, bank_owner_name=$5,
         bank_transfer_pattern=$6, reminder_enabled=$7, reminder_day=$8,
         reminder_time=$9, theme=$10`,
      [
        uid,
        num(settings.deduction, 450000),
        settings.bankId || '',
        settings.bankAccount || '',
        settings.bankOwnerName || '',
        settings.bankTransferPattern || '',
        !!settings.reminderEnabled,
        num(settings.reminderDay, 30),
        settings.reminderTime || '20:00',
        theme
      ]
    );

    // Xóa dữ liệu con của user (cascade sẽ dọn tenants/history_bills)
    await client.query('DELETE FROM billing_entries WHERE user_id=$1', [uid]);
    await client.query('DELETE FROM history_snapshots WHERE user_id=$1', [uid]);
    await client.query('DELETE FROM rooms WHERE user_id=$1', [uid]);

    // rooms + tenants
    let rIdx = 0;
    for (const r of rooms) {
      await client.query(
        `INSERT INTO rooms
           (id, user_id, name, rent_price, electric_rate, water_rate, water_type,
            people_count, trash_fee, wifi_fee, manage_fee, electric_prev, water_prev,
            notes, sort_order)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          r.id, uid, r.name || 'Phòng không tên', num(r.rentPrice), num(r.electricRate, 3200),
          num(r.waterRate, 50000), r.waterType || 'người', num(r.peopleCount, 1),
          num(r.trashFee, 50000), num(r.wifiFee), num(r.manageFee), num(r.electricPrev),
          num(r.waterPrev), r.notes || '', rIdx++
        ]
      );
      let tIdx = 0;
      for (const t of Array.isArray(r.tenants) ? r.tenants : []) {
        await client.query(
          `INSERT INTO tenants
             (id, room_id, user_id, full_name, phone, cccd, issue_date, dob, gender, address, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            t.id, r.id, uid, t.fullName || '', t.phone || '', t.cccd || '',
            t.issueDate || '', t.dob || '', t.gender || 'Nam', t.address || '', tIdx++
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
              electric_old_override, water_old_override, note, paid)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          [
            uid, period, roomId, orNull(e.electricNew), orNull(e.waterUnits),
            orNull(e.waterNew), orNull(e.electricOldOverride), orNull(e.waterOldOverride),
            strOrNull(e.note), !!e.paid
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
             (snapshot_id, room_id, room_name, rent_price, electric_old, electric_new,
              electric_rate, kwh, electric_amt, water_type, water_rate, water_units,
              water_amt, water_prev, water_new, trash_fee, wifi_fee, manage_fee, total, paid, sort_order)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)`,
          [
            snapId, b.roomId, b.roomName, num(b.rentPrice), num(b.electricOld),
            b.electricNew === null || b.electricNew === undefined ? null : Number(b.electricNew),
            num(b.electricRate), num(b.kwh), num(b.electricAmt), b.waterType || 'người',
            num(b.waterRate), num(b.waterUnits), num(b.waterAmt),
            b.waterPrev === null || b.waterPrev === undefined ? null : Number(b.waterPrev),
            b.waterNew === null || b.waterNew === undefined ? null : Number(b.waterNew),
            num(b.trashFee), num(b.wifiFee), num(b.manageFee), num(b.total), !!b.paid, bIdx++
          ]
        );
      }
    }

    await client.query('COMMIT');
    res.json({ ok: true });
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('putState lỗi:', err.message);
    res.status(500).json({ error: 'Không lưu được dữ liệu' });
  } finally {
    client.release();
  }
}

module.exports = { getState, putState, buildState, orNull, strOrNull, num };
