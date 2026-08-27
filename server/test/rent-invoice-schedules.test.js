'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-invoice-schedules';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createInvoiceSchedule,
  invoiceScheduleCron,
  processDueInvoiceSchedules,
  retryInvoiceSchedule,
  scheduleInput,
  vietnamDate
} = require('../rent-invoice-schedules');

const root = path.join(__dirname, '..', '..');

function responseRecorder() {
  const record = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; },
    set(name, value) { record.headers[name] = value; return res; }
  };
  return { record, res };
}

function scheduleRow(overrides = {}) {
  return {
    id: 51,
    user_id: 7,
    invoice_id: 41,
    tenant_id: 'tenant-1',
    channel: 'email',
    template_type: 'invoice',
    scheduled_for: '2026-08-27',
    recipient_email_snapshot: 'tenant@example.com',
    status: 'scheduled',
    attempt_count: 0,
    provider_message_id: null,
    last_error_code: null,
    sent_at: null,
    cancelled_at: null,
    created_at: '2026-08-26T00:00:00.000Z',
    updated_at: '2026-08-26T00:00:00.000Z',
    ...overrides
  };
}

test('ngày hẹn dùng múi giờ Việt Nam và chỉ nhận 1–90 ngày tới', () => {
  const now = new Date('2026-08-26T18:30:00.000Z');
  assert.equal(vietnamDate(now), '2026-08-27');
  const valid = scheduleInput({
    params: { invoiceId: '41' },
    body: { tenantId: 'tenant-1', templateType: 'invoice', scheduledFor: '2026-08-28' }
  }, now);
  assert.equal(valid.scheduledFor, '2026-08-28');
  assert.throws(
    () => scheduleInput({
      params: { invoiceId: '41' },
      body: { tenantId: 'tenant-1', templateType: 'invoice', scheduledFor: '2026-08-27' }
    }, now),
    (error) => error.code === 'SCHEDULE_DATE_NOT_FUTURE'
  );
  assert.throws(
    () => scheduleInput({
      params: { invoiceId: '41' },
      body: { tenantId: 'tenant-1', templateType: 'invoice', scheduledFor: '2026-11-27' }
    }, now),
    (error) => error.code === 'SCHEDULE_DATE_TOO_FAR'
  );
});

test('tạo lịch khóa hóa đơn, phòng và khách theo user rồi chỉ trả email đã che', async () => {
  const calls = [];
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM tenants')) {
      return { rows: [{ id: 'tenant-1', email: 'tenant@example.com' }] };
    }
    if (sql.includes('INSERT INTO rent_invoice_deliveries')) {
      return { rows: [scheduleRow()] };
    }
    throw new Error(`Truy vấn không mong đợi: ${sql}`);
  };
  const response = responseRecorder();
  await createInvoiceSchedule({
    userId: 7,
    params: { invoiceId: '41' },
    body: { tenantId: 'tenant-1', templateType: 'invoice', scheduledFor: '2026-08-27' }
  }, response.res, {
    query,
    now: new Date('2026-08-26T00:00:00.000Z'),
    assertEmailConfigured() { return { valid: true }; },
    async invoiceSummary(receivedQuery, userId, invoiceId) {
      assert.equal(receivedQuery, query);
      assert.equal(userId, 7);
      assert.equal(invoiceId, 41);
      return { roomId: 'room-1' };
    }
  });
  assert.equal(response.record.statusCode, 201);
  assert.equal(response.record.body.created, true);
  assert.equal(response.record.body.schedule.recipient, 't*****@example.com');
  assert.deepEqual(calls[0].params, [7, 'room-1', 'tenant-1']);
  assert.deepEqual(calls[1].params, [7, 41, 'tenant-1', 'invoice', '2026-08-27', 'tenant@example.com']);
  assert.match(calls[1].sql, /ON CONFLICT \(user_id, invoice_id, tenant_id, channel, template_type, scheduled_for\)/);
  assert.equal(response.record.headers['Cache-Control'], 'no-store');
});

test('cron claim lịch đến hạn bằng SKIP LOCKED và đánh dấu gửi thành công', async () => {
  const calls = [];
  let deliveryInput;
  const row = scheduleRow({ status: 'sending', attempt_count: 1 });
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('WITH due AS')) return { rows: [row] };
    if (sql.includes("SET status='sent'")) return { rows: [] };
    throw new Error(`Truy vấn không mong đợi: ${sql}`);
  };
  const result = await processDueInvoiceSchedules({
    query,
    async executeInvoiceEmailDelivery(input, dependencies) {
      deliveryInput = input;
      assert.equal(dependencies.query, query);
      return { delivery: { delivered: true, emailId: 'brevo-51' } };
    }
  });
  assert.deepEqual(result, { candidates: 1, sent: 1, failed: 0, skipped: 0 });
  assert.match(calls[0].sql, /FOR UPDATE SKIP LOCKED/);
  assert.deepEqual(calls[0].params, [5]);
  assert.equal(deliveryInput.idempotencyKey, 'rent-invoice-schedule-51');
  assert.deepEqual(calls[1].params, [51, 'brevo-51']);
});

test('lịch nhắc nợ được bỏ qua an toàn nếu hóa đơn đã thanh toán đủ', async () => {
  const updates = [];
  const query = async (sql, params) => {
    if (sql.includes('WITH due AS')) {
      return { rows: [scheduleRow({ template_type: 'reminder', status: 'sending', attempt_count: 1 })] };
    }
    updates.push({ sql, params });
    return { rows: [] };
  };
  const result = await processDueInvoiceSchedules({
    query,
    async executeInvoiceEmailDelivery() {
      const error = new Error('Đã thanh toán');
      error.code = 'INVOICE_ALREADY_PAID';
      throw error;
    }
  });
  assert.deepEqual(result, { candidates: 1, sent: 0, failed: 0, skipped: 1 });
  assert.deepEqual(updates[0].params, [51, 'skipped', 'INVOICE_ALREADY_PAID']);
});

test('lỗi email tạm thời được lưu trạng thái failed để cron sau thử lại', async () => {
  const updates = [];
  const query = async (sql, params) => {
    if (sql.includes('WITH due AS')) {
      return { rows: [scheduleRow({ status: 'sending', attempt_count: 1 })] };
    }
    updates.push({ sql, params });
    return { rows: [] };
  };
  const result = await processDueInvoiceSchedules({
    query,
    async executeInvoiceEmailDelivery() {
      const error = new Error('provider detail must not be stored');
      error.code = 'EMAIL_SEND_FAILED';
      throw error;
    }
  });
  assert.deepEqual(result, { candidates: 1, sent: 0, failed: 1, skipped: 0 });
  assert.deepEqual(updates[0].params, [51, 'failed', 'EMAIL_SEND_FAILED']);
  assert.equal(updates[0].params.some((value) => String(value).includes('provider detail')), false);
});

test('chủ tài khoản gửi lại lịch lỗi ngay lập tức và vẫn dùng idempotency key cũ', async () => {
  const calls = [];
  let deliveryInput;
  const query = async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes("SET status='sending'")) {
      return { rows: [scheduleRow({ status: 'sending', attempt_count: 2 })] };
    }
    if (sql.includes("SET status='sent'")) {
      return {
        rows: [scheduleRow({
          status: 'sent',
          attempt_count: 2,
          provider_message_id: 'brevo-retry-51',
          sent_at: '2026-08-27T00:00:00.000Z'
        })]
      };
    }
    throw new Error(`Truy vấn không mong đợi: ${sql}`);
  };
  const response = responseRecorder();
  await retryInvoiceSchedule({
    userId: 7,
    params: { id: '51' },
    protocol: 'https',
    get() { return 'tro-bill.example'; }
  }, response.res, {
    query,
    async executeInvoiceEmailDelivery(input) {
      deliveryInput = input;
      return { delivery: { delivered: true, emailId: 'brevo-retry-51' } };
    }
  });
  assert.equal(response.record.statusCode, 200);
  assert.equal(response.record.body.delivered, true);
  assert.equal(response.record.body.schedule.status, 'sent');
  assert.deepEqual(calls[0].params, [7, 51, 5]);
  assert.match(calls[0].sql, /status='failed' AND attempt_count < \$3/);
  assert.equal(deliveryInput.idempotencyKey, 'rent-invoice-schedule-51');
  assert.equal(deliveryInput.req.get('host'), 'tro-bill.example');
  assert.equal(response.record.headers['Cache-Control'], 'no-store');
});

test('gửi lại thất bại tiếp tục lưu mã lỗi an toàn để thử lại lần sau', async () => {
  const query = async (sql) => {
    if (sql.includes("SET status='sending'")) {
      return { rows: [scheduleRow({ status: 'sending', attempt_count: 2 })] };
    }
    if (sql.includes('SET status=$2')) {
      return {
        rows: [scheduleRow({
          status: 'failed',
          attempt_count: 2,
          last_error_code: 'EMAIL_SEND_FAILED'
        })]
      };
    }
    throw new Error(`Truy vấn không mong đợi: ${sql}`);
  };
  const response = responseRecorder();
  await retryInvoiceSchedule({ userId: 7, params: { id: '51' } }, response.res, {
    query,
    async executeInvoiceEmailDelivery() {
      const error = new Error('provider secret detail');
      error.code = 'EMAIL_SEND_FAILED';
      throw error;
    }
  });
  assert.equal(response.record.statusCode, 502);
  assert.equal(response.record.body.delivered, false);
  assert.equal(response.record.body.schedule.status, 'failed');
  assert.equal(response.record.body.code, 'EMAIL_SEND_FAILED');
  assert.doesNotMatch(response.record.body.error, /provider|secret/i);
});

test('không gửi lại lịch tài khoản khác hoặc lịch đã đủ năm lần thử', async () => {
  const calls = [];
  const response = responseRecorder();
  await retryInvoiceSchedule({ userId: 7, params: { id: '51' } }, response.res, {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql.includes("SET status='sending'")) return { rows: [] };
      return { rows: [{ status: 'failed', attempt_count: 5 }] };
    }
  });
  assert.equal(response.record.statusCode, 409);
  assert.equal(response.record.body.code, 'SCHEDULE_RETRY_LIMIT_REACHED');
  assert.deepEqual(calls[0].params, [7, 51, 5]);
  assert.deepEqual(calls[1].params, [7, 51]);
});

test('endpoint cron bắt buộc Bearer secret', async () => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'cron-secret-that-is-long-enough-for-tests';
  try {
    const response = responseRecorder();
    await invoiceScheduleCron({ get() { return 'Bearer sai'; } }, response.res);
    assert.equal(response.record.statusCode, 401);
    assert.equal(response.record.body.code, 'CRON_UNAUTHORIZED');
  } finally {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  }
});

test('schema, migration, API, UI và cron hỗ trợ hẹn ngày gửi hóa đơn', () => {
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260826_rent_invoice_schedules.sql'),
    'utf8'
  );
  const serverSource = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  const apiSource = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  const checklist = fs.readFileSync(path.join(root, 'MONETIZATION_CHECKLIST.md'), 'utf8');

  assert.match(schema, /CREATE TABLE IF NOT EXISTS rent_invoice_deliveries/);
  assert.doesNotMatch(schema, /tenant_id\s+TEXT NOT NULL REFERENCES tenants/);
  assert.match(schema, /UNIQUE \(user_id, invoice_id, tenant_id, channel, template_type, scheduled_for\)/);
  assert.match(
    migration,
    /BEGIN;[\s\S]*CREATE TABLE IF NOT EXISTS rent_invoice_deliveries[\s\S]*COMMIT;/
  );
  assert.match(migration, /privilege_type IN \('DELETE','TRUNCATE'\)/);
  assert.match(serverSource, /\/api\/rent-invoices\/:invoiceId\/delivery-schedules/);
  assert.match(serverSource, /\/api\/rent-invoice-delivery-schedules\/:id\/retry/);
  assert.match(serverSource, /\/api\/cron\/rent-invoice-deliveries/);
  assert.match(apiSource, /function scheduleRentInvoiceEmail/);
  assert.match(apiSource, /function retryRentInvoiceDeliverySchedule/);
  assert.match(appSource, /function scheduleBillMessageEmail/);
  assert.match(appSource, /function retryBillMessageSchedule/);
  assert.match(appSource, /dataset\.retryInvoiceSchedule/);
  assert.match(html, /id="bill-message-schedule-date"/);
  assert.match(html, /id="bill-message-schedule-list"/);
  assert.deepEqual(
    vercel.crons.find((cron) => cron.path === '/api/cron/rent-invoice-deliveries'),
    { path: '/api/cron/rent-invoice-deliveries', schedule: '15 0 * * *' }
  );
  assert.match(checklist, /\[x\] Cho phép hẹn ngày gửi hóa đơn\./);
  assert.match(checklist, /\[x\] Lưu trạng thái gửi thành công\/thất bại và cho phép gửi lại\./);
});
