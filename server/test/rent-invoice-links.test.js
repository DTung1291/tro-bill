'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-invoice-link-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';
process.env.APP_URL = 'https://tro-bill.example';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const {
  createInvoiceLink,
  expiryHours,
  generateToken,
  resolvePublicInvoiceLink,
  tokenHash
} = require('../rent-invoice-links');

function responseRecorder() {
  const record = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; },
    set(name, value) { record.headers[name] = value; return res; }
  };
  return { record, res };
}

function request(body = {}, options = {}) {
  return {
    userId: 7,
    protocol: 'https',
    params: options.params || {},
    body,
    get(name) { return String(name).toLowerCase() === 'host' ? 'request.example' : ''; }
  };
}

function shareLinkRow(overrides = {}) {
  return {
    id: 15,
    user_id: 7,
    invoice_id: 41,
    token_hash: 'a'.repeat(64),
    token_last4: 'Ab_9',
    expires_at: '2099-08-28T00:00:00.000Z',
    revoked_at: null,
    view_count: '0',
    last_viewed_at: null,
    created_at: '2026-08-25T00:00:00.000Z',
    ...overrides
  };
}

test('token liên kết có 256-bit entropy, chỉ lưu SHA-256 và giới hạn thời hạn', () => {
  const token = generateToken();
  assert.match(token, /^tbril_[A-Za-z0-9_-]{43}$/);
  assert.match(tokenHash(token), /^[a-f0-9]{64}$/);
  assert.equal(expiryHours(undefined), 72);
  assert.equal(expiryHours(720), 720);
  assert.throws(() => expiryHours(721), (error) => error.code === 'INVALID_INVOICE_LINK_EXPIRY');
});

test('tạo link chỉ cho hóa đơn thuộc user và token rõ chỉ nằm trong URL trả một lần', async (t) => {
  const originalQuery = db.query;
  let captured;
  db.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [shareLinkRow({ token_hash: params[2], token_last4: params[3] })] };
  };
  t.after(() => { db.query = originalQuery; });

  const response = responseRecorder();
  await createInvoiceLink(request(
    { expiresInHours: 168 },
    { params: { invoiceId: '41' } }
  ), response.res);

  assert.equal(response.record.statusCode, 201);
  assert.match(captured.sql, /WHERE invoice\.user_id=\$1 AND invoice\.id=\$2/);
  assert.deepEqual(captured.params.slice(0, 2), [7, 41]);
  assert.match(captured.params[2], /^[a-f0-9]{64}$/);
  assert.equal(captured.params[4], 168);
  assert.match(response.record.body.publicUrl, /^https:\/\/tro-bill\.example\/invoice\.html#t=tbril_/);
  assert.equal(response.record.body.publicUrl.includes('?'), false);
  assert.equal(JSON.stringify(response.record.body.link).includes(captured.params[2]), false);
  assert.equal(response.record.headers['Cache-Control'], 'no-store');
});

test('mở link công khai kiểm tra hạn/thu hồi, trả dữ liệu tối thiểu và tăng lượt xem', async (t) => {
  const originalGetClient = db.getClient;
  const token = generateToken();
  const calls = [];
  db.getClient = async () => ({
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM rent_invoice_share_links')) {
        return { rows: [shareLinkRow()] };
      }
      if (sql.includes('FROM rent_invoices invoice')) {
        return { rows: [{
          invoice_id: 41,
          room_name_snapshot: 'P403',
          period: '2026-08',
          issued_total_vnd: '3000000',
          paid_amount_vnd: '1000000'
        }] };
      }
      return { rows: [] };
    },
    release() {}
  });
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await resolvePublicInvoiceLink(request({ token }), response.res);
  assert.equal(response.record.body.invoice.roomName, 'P403');
  assert.equal(response.record.body.invoice.remainingVnd, 2000000);
  assert.equal(response.record.body.invoice.status, 'partial');
  assert.equal('userId' in response.record.body.invoice, false);
  assert.equal('tenant' in response.record.body.invoice, false);
  const lookup = calls.find((call) => call.sql.includes('FROM rent_invoice_share_links'));
  assert.deepEqual(lookup.params, [tokenHash(token)]);
  assert.equal(lookup.params.includes(token), false);
  assert.equal(calls.some((call) => call.sql.includes('view_count=view_count + 1')), true);
  assert.equal(calls.some((call) => call.sql === 'COMMIT'), true);
});

test('link hết hạn bị từ chối và không tăng lượt xem', async (t) => {
  const originalGetClient = db.getClient;
  const calls = [];
  db.getClient = async () => ({
    async query(sql) {
      calls.push(sql);
      if (sql.includes('FROM rent_invoice_share_links')) {
        return { rows: [shareLinkRow({ expires_at: '2020-01-01T00:00:00.000Z' })] };
      }
      return { rows: [] };
    },
    release() {}
  });
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await resolvePublicInvoiceLink(request({ token: generateToken() }), response.res);
  assert.equal(response.record.statusCode, 410);
  assert.equal(response.record.body.code, 'INVOICE_LINK_EXPIRED');
  assert.equal(calls.some((sql) => sql.includes('view_count=view_count + 1')), false);
  assert.equal(calls.includes('ROLLBACK'), true);
});

test('schema, API và trang công khai không lưu token rõ hoặc lộ qua query/referrer', () => {
  const root = path.join(__dirname, '..', '..');
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260825_rent_invoice_share_links.sql'),
    'utf8'
  );
  const serverSource = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  const apiSource = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const publicHtml = fs.readFileSync(path.join(root, 'invoice.html'), 'utf8');
  const publicJs = fs.readFileSync(path.join(root, 'invoice-public.js'), 'utf8');

  for (const source of [schema, migration]) {
    const table = source.match(/CREATE TABLE IF NOT EXISTS rent_invoice_share_links \([\s\S]*?\n\);/)?.[0] || '';
    assert.match(table, /token_hash\s+TEXT NOT NULL UNIQUE/);
    assert.doesNotMatch(table, /token\s+TEXT|public_url/i);
    assert.match(source, /REVOKE UPDATE, DELETE, TRUNCATE/);
    assert.match(source, /GRANT UPDATE \(revoked_at, view_count, last_viewed_at\)/);
  }
  assert.match(serverSource, /\/api\/public\/rent-invoice-links\/resolve/);
  assert.match(apiSource, /function createRentInvoiceShareLink/);
  assert.match(apiSource, /function revokeRentInvoiceShareLink/);
  assert.match(appSource, /function openInvoiceShareModal/);
  assert.match(htmlSource, /id="invoice-share-modal"/);
  assert.match(htmlSource, /style\.css\?v=104[\s\S]*api\.js\?v=101[\s\S]*app\.js\?v=105/);
  assert.match(publicHtml, /name="referrer" content="no-referrer"/);
  assert.match(publicHtml, /Content-Security-Policy/);
  assert.match(publicHtml, /invoice-public\.css\?v=7[\s\S]*invoice-public\.js\?v=7/);
  assert.match(publicJs, /location\.hash/);
  assert.match(publicJs, /history\.replaceState\(null, '', location\.pathname\)/);
  assert.match(publicJs, /credentials: 'omit'/);
  assert.doesNotMatch(publicJs, /innerHTML/);
});
