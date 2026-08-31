'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-auto-reminders';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  enqueueAutomaticInvoiceReminders,
  invoiceScheduleCron
} = require('../rent-invoice-schedules');
const {
  RentInvoiceReminderSettingsError,
  normalizeInvoiceReminderSettings
} = require('../rent-invoice-reminder-settings');

const root = path.join(__dirname, '..', '..');

function responseRecorder() {
  const record = { statusCode: 200, body: null };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; }
  };
  return { record, res };
}

test('chuẩn hóa mốc nhắc theo danh sách hỗ trợ và loại bỏ trùng lặp', () => {
  assert.deepEqual(normalizeInvoiceReminderSettings({
    invoiceReminderEnabled: true,
    invoiceReminderBeforeDays: [1, 7, 1, 3],
    invoiceReminderAfterDays: [30, 3, 1, 3]
  }), {
    enabled: true,
    beforeDays: [7, 3, 1],
    afterDays: [1, 3, 30]
  });
  assert.throws(
    () => normalizeInvoiceReminderSettings({
      invoiceReminderEnabled: true,
      invoiceReminderBeforeDays: [0],
      invoiceReminderAfterDays: []
    }),
    (error) => error instanceof RentInvoiceReminderSettingsError
      && error.code === 'INVALID_INVOICE_REMINDER_DAYS'
  );
  assert.throws(
    () => normalizeInvoiceReminderSettings({
      invoiceReminderEnabled: true,
      invoiceReminderBeforeDays: [],
      invoiceReminderAfterDays: []
    }),
    (error) => error.code === 'INVOICE_REMINDER_DAYS_REQUIRED'
  );
});

test('client cũ không gửi cấu hình mới thì server giữ nguyên giá trị database', () => {
  assert.deepEqual(
    normalizeInvoiceReminderSettings({ reminderEnabled: true }, { allowMissing: true }),
    { enabled: null, beforeDays: null, afterDays: null }
  );
});

test('cron chỉ xếp lịch cho hóa đơn còn nợ của kỳ thuê hiện tại và đúng mốc cấu hình', async () => {
  let received;
  const result = await enqueueAutomaticInvoiceReminders({
    now: new Date('2026-08-26T18:30:00.000Z'),
    async query(sql, params) {
      received = { sql, params };
      return { rows: [{ queued: 2, skipped: 1 }] };
    }
  });
  assert.deepEqual(result, { queued: 2, skipped: 1, scheduledFor: '2026-08-27' });
  assert.deepEqual(received.params, ['2026-08-27']);
  assert.match(received.sql, /invoice_reminder_enabled=true/);
  assert.match(received.sql, /invoice\.period >= left\(room\.rent_start_date, 7\)/);
  assert.match(received.sql, /COALESCE\(invoice\.final_total_vnd, invoice\.issued_total_vnd\) > COALESCE/);
  assert.match(received.sql, /JOIN LATERAL[\s\S]*ORDER BY current_tenant\.sort_order/);
  assert.match(received.sql, /reminder_offset_days=ANY\(invoice_reminder_before_days\)/);
  assert.match(received.sql, /-reminder_offset_days=ANY\(invoice_reminder_after_days\)/);
  assert.match(received.sql, /'automatic', reminder_offset_days/);
  assert.match(received.sql, /ON CONFLICT[\s\S]*DO NOTHING/);
  assert.match(received.sql, /REMINDER_CONFIG_DISABLED/);
});

test('cron tạo lịch tự động trước rồi mới claim gửi, đồng thời trả số liệu vận hành', async () => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'cron-secret-that-is-long-enough-for-auto-reminder-tests';
  const calls = [];
  try {
    const response = responseRecorder();
    await invoiceScheduleCron({
      get(name) {
        return String(name).toLowerCase() === 'authorization'
          ? `Bearer ${process.env.CRON_SECRET}`
          : '';
      }
    }, response.res, {
      async enqueueAutomaticInvoiceReminders() {
        calls.push('enqueue');
        return { queued: 3, skipped: 2 };
      },
      async processDueInvoiceSchedules() {
        calls.push('process');
        return { candidates: 3, sent: 2, failed: 1, skipped: 0 };
      }
    });
    assert.deepEqual(calls, ['enqueue', 'process']);
    assert.equal(response.record.statusCode, 200);
    assert.deepEqual(response.record.body, {
      ok: true,
      candidates: 3,
      sent: 2,
      failed: 1,
      skipped: 0,
      queued: 3,
      configurationSkipped: 2
    });
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});

test('schema, state, giao diện và checklist có cấu hình nhắc hóa đơn tự động', () => {
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260827_rent_invoice_auto_reminders.sql'),
    'utf8'
  );
  const state = fs.readFileSync(path.join(root, 'server', 'state.js'), 'utf8');
  const schedules = fs.readFileSync(path.join(root, 'server', 'rent-invoice-schedules.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const checklist = fs.readFileSync(path.join(root, 'MONETIZATION_CHECKLIST.md'), 'utf8');

  assert.match(schema, /invoice_reminder_before_days INTEGER\[\]/);
  assert.match(schema, /trigger_source\s+TEXT NOT NULL DEFAULT 'manual'/);
  assert.match(migration, /BEGIN;[\s\S]*ALTER TABLE settings[\s\S]*COMMIT;/);
  assert.match(migration, /rent_invoice_deliveries_reminder_offset_valid/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS rent_invoice_deliveries_tenant_id_fkey/);
  assert.match(migration, /AS tenant_autosave_safe/);
  assert.match(state, /invoiceReminderEnabled: !isScopedStaff && !!s\.invoice_reminder_enabled/);
  assert.match(state, /invoice_reminder_enabled=COALESCE/);
  assert.match(schedules, /async function enqueueAutomaticInvoiceReminders/);
  assert.match(schedules, /INVOICE_ALREADY_PAID/);
  assert.match(html, /id="invoice-reminder-enabled"/);
  assert.match(html, /name="invoice-reminder-before"/);
  assert.match(html, /name="invoice-reminder-after"/);
  assert.match(app, /save-invoice-reminder-settings/);
  assert.match(css, /\.invoice-reminder-groups/);
  assert.match(checklist, /\[x\] Tự động nhắc trước hạn và sau hạn theo cấu hình\./);
  assert.match(checklist, /\[x\] Dừng nhắc ngay khi hóa đơn đã được thanh toán đủ\./);
});
