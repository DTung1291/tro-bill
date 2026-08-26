'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-invoice-delivery';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const { deliverInvoiceEmail } = require('../rent-invoice-delivery');

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

function request(body = {}) {
  return {
    userId: 7,
    protocol: 'https',
    params: { invoiceId: '41' },
    body: {
      tenantId: 'tenant-1',
      templateType: 'invoice',
      expiresInHours: 72,
      deliveryKey: 'delivery-key-1234567890',
      ...body
    },
    get(name) { return String(name).toLowerCase() === 'host' ? 'tro-bill.example' : ''; }
  };
}

function summary(overrides = {}) {
  return {
    invoiceId: 41,
    transferContent: 'HD00000015',
    roomId: 'room-1',
    roomName: 'P403',
    period: '2026-08',
    invoiceTotalVnd: 3000000,
    paidAmountVnd: 500000,
    priorDebtVnd: 250000,
    totalDueVnd: 2750000,
    dueDate: '2026-08-31',
    overdueDays: 5,
    ...overrides
  };
}

function dependencies(overrides = {}) {
  return {
    assertEmailConfigured() { return { valid: true }; },
    async checkDeliveryRateLimit() { return true; },
    async recordDeliveryAttempt() { return true; },
    async invoiceSummary() { return summary(); },
    async issueInvoiceLink() {
      return {
        link: { id: 8, invoiceId: 41, tokenLast4: 'Ab_9' },
        publicUrl: 'https://tro-bill.example/invoice.html#t=tbril_secure'
      };
    },
    async sendRentInvoiceEmail() {
      return { delivered: true, emailId: 'brevo-message-1' };
    },
    ...overrides
  };
}

test('gửi email khóa người nhận theo user, phòng và hóa đơn rồi tạo link bảo mật', async (t) => {
  const originalQuery = db.query;
  let recipientQuery;
  let sentMessage;
  db.query = async (sql, params) => {
    recipientQuery = { sql, params };
    return {
      rows: [{
        id: 'tenant-1',
        full_name: 'Nguyễn Văn A',
        email: 'tenant@example.com',
        bank_id: 'VCB',
        bank_account: '0123456789',
        bank_owner_name: 'Nguyễn Văn B'
      }]
    };
  };
  t.after(() => { db.query = originalQuery; });

  const response = responseRecorder();
  await deliverInvoiceEmail(request(), response.res, dependencies({
    async sendRentInvoiceEmail(message) {
      sentMessage = message;
      return { delivered: true, emailId: 'brevo-message-1' };
    }
  }));

  assert.equal(response.record.statusCode, 201);
  assert.deepEqual(recipientQuery.params, [7, 'room-1', 'tenant-1']);
  assert.match(recipientQuery.sql, /tenant\.user_id=\$1 AND tenant\.room_id=\$2 AND tenant\.id=\$3/);
  assert.equal(sentMessage.email, 'tenant@example.com');
  assert.match(sentMessage.message, /2\.750\.000\s₫/);
  assert.match(sentMessage.message, /HD00000015/);
  assert.match(sentMessage.message, /https:\/\/tro-bill\.example\/invoice\.html#t=tbril_secure/);
  assert.match(sentMessage.idempotencyKey, /^rent-invoice-[a-f0-9]{64}$/);
  assert.equal(sentMessage.idempotencyKey.includes('tenant-1'), false);
  assert.equal(response.record.body.recipient, 't*****@example.com');
  assert.equal(response.record.body.publicUrl, sentMessage.invoiceUrl);
  assert.equal(response.record.headers['Cache-Control'], 'no-store');
});

test('không tạo link hoặc gửi khi khách chưa có email', async (t) => {
  const originalQuery = db.query;
  let linkCalls = 0;
  let emailCalls = 0;
  db.query = async () => ({
    rows: [{ id: 'tenant-1', full_name: 'A', email: '' }]
  });
  t.after(() => { db.query = originalQuery; });
  const response = responseRecorder();
  await deliverInvoiceEmail(request(), response.res, dependencies({
    async issueInvoiceLink() { linkCalls += 1; },
    async sendRentInvoiceEmail() { emailCalls += 1; }
  }));
  assert.equal(response.record.statusCode, 409);
  assert.equal(response.record.body.code, 'TENANT_EMAIL_MISSING');
  assert.equal(linkCalls, 0);
  assert.equal(emailCalls, 0);
});

test('không gửi nhắc nợ khi hóa đơn đã thanh toán đủ', async (t) => {
  const originalQuery = db.query;
  let linkCalls = 0;
  db.query = async () => ({
    rows: [{ id: 'tenant-1', full_name: 'A', email: 'tenant@example.com' }]
  });
  t.after(() => { db.query = originalQuery; });
  const response = responseRecorder();
  await deliverInvoiceEmail(
    request({ templateType: 'reminder' }),
    response.res,
    dependencies({
      async invoiceSummary() { return summary({ totalDueVnd: 0, overdueDays: 0 }); },
      async issueInvoiceLink() { linkCalls += 1; }
    })
  );
  assert.equal(response.record.statusCode, 409);
  assert.equal(response.record.body.code, 'INVOICE_ALREADY_PAID');
  assert.equal(linkCalls, 0);
});

test('lỗi nhà cung cấp email được trả thành lỗi có thể hiểu và không lộ chi tiết', async (t) => {
  const originalQuery = db.query;
  db.query = async () => ({
    rows: [{ id: 'tenant-1', full_name: 'A', email: 'tenant@example.com' }]
  });
  t.after(() => { db.query = originalQuery; });
  const response = responseRecorder();
  await deliverInvoiceEmail(request(), response.res, dependencies({
    async sendRentInvoiceEmail() {
      const error = new Error('Brevo internal secret response');
      error.code = 'EMAIL_SEND_FAILED';
      throw error;
    }
  }));
  assert.equal(response.record.statusCode, 502);
  assert.equal(response.record.body.code, 'EMAIL_SEND_FAILED');
  assert.doesNotMatch(response.record.body.error, /secret/i);
});

test('schema, API và giao diện hỗ trợ email, Zalo/ứng dụng và link hệ thống', () => {
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260826_tenant_invoice_email.sql'),
    'utf8'
  );
  const serverSource = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  const stateSource = fs.readFileSync(path.join(root, 'server', 'state.js'), 'utf8');
  const apiSource = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const checklist = fs.readFileSync(path.join(root, 'MONETIZATION_CHECKLIST.md'), 'utf8');

  assert.match(schema, /tenants[\s\S]*email\s+TEXT NOT NULL DEFAULT ''/);
  assert.match(schema, /CONSTRAINT tenants_email_valid/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS email/);
  assert.match(stateSource, /email: t\.email \|\| ''/);
  assert.match(serverSource, /\/api\/rent-invoices\/:invoiceId\/deliver-email/);
  assert.match(apiSource, /function deliverRentInvoiceEmail/);
  assert.match(appSource, /function ensureBillMessageSystemLink/);
  assert.match(appSource, /function sendBillMessageEmail/);
  assert.match(html, /id="tenant-email"/);
  assert.match(html, /id="bill-message-create-link"/);
  assert.match(html, /id="bill-message-share">📤 Zalo \/ ứng dụng/);
  assert.match(html, /id="bill-message-email">✉️ Gửi email/);
  assert.match(checklist, /\[x\] Gửi hoặc chia sẻ qua Zalo, email và liên kết hệ thống\./);
});
