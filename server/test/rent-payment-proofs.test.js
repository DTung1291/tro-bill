'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-payment-proof-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const { generateToken, tokenHash } = require('../rent-invoice-links');
const {
  MAX_PROOF_BYTES,
  listInvoicePaymentProofs,
  proofImageInput,
  submitPublicPaymentProof
} = require('../rent-payment-proofs');

function jpegDataUrl(size = 140) {
  const bytes = Buffer.alloc(size, 2);
  bytes[0] = 0xff;
  bytes[1] = 0xd8;
  bytes[2] = 0xff;
  bytes[size - 2] = 0xff;
  bytes[size - 1] = 0xd9;
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
}

function responseRecorder() {
  const record = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; },
    set(name, value) { record.headers[name] = value; return res; }
  };
  return { record, res };
}

test('minh chứng chỉ nhận JPEG nhỏ và tính SHA-256 phía server', () => {
  const parsed = proofImageInput(jpegDataUrl());
  assert.equal(parsed.imageData.length, 140);
  assert.match(parsed.sha256, /^[a-f0-9]{64}$/);
  assert.throws(
    () => proofImageInput('data:image/png;base64,iVBORw0KGgo='),
    (error) => error.code === 'INVALID_PAYMENT_PROOF'
  );
  assert.throws(
    () => proofImageInput(jpegDataUrl(MAX_PROOF_BYTES + 1)),
    (error) => error.code === 'INVALID_PAYMENT_PROOF'
  );
});

test('khách chỉ gửi một minh chứng qua link còn hạn và hóa đơn còn nợ', async (t) => {
  const originalGetClient = db.getClient;
  const token = generateToken();
  const calls = [];
  db.getClient = async () => ({
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM rent_invoice_share_links link')) {
        return { rows: [{
          id: 15,
          user_id: 7,
          invoice_id: 41,
          expires_at: '2099-08-28T00:00:00.000Z',
          revoked_at: null,
          issued_total_vnd: '3000000'
        }] };
      }
      if (sql.includes('SUM(amount_vnd)')) {
        return { rows: [{ paid_amount_vnd: '1000000' }] };
      }
      if (sql.includes('INSERT INTO rent_payment_proofs')) {
        return { rows: [{ status: 'pending', submitted_at: '2026-08-25T00:00:00.000Z' }] };
      }
      return { rows: [] };
    },
    release() {}
  });
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await submitPublicPaymentProof({
    body: { token, dataUrl: jpegDataUrl() }
  }, response.res);

  assert.equal(response.record.statusCode, 201);
  assert.equal(response.record.body.proof.status, 'pending');
  const lookup = calls.find((call) => call.sql.includes('FROM rent_invoice_share_links link'));
  assert.deepEqual(lookup.params, [tokenHash(token)]);
  assert.equal(lookup.params.includes(token), false);
  const insert = calls.find((call) => call.sql.includes('INSERT INTO rent_payment_proofs'));
  assert.deepEqual(insert.params.slice(0, 3), [7, 41, 15]);
  assert.equal(Buffer.isBuffer(insert.params[3]), true);
  assert.match(insert.sql, /ON CONFLICT \(share_link_id\) DO NOTHING/);
  assert.equal(calls.some((call) => /UPDATE rent_invoices|INSERT INTO rent_payment_transactions/.test(call.sql)), false);
  assert.equal(calls.some((call) => call.sql === 'COMMIT'), true);
  assert.equal(response.record.headers['Cache-Control'], 'no-store');
});

test('link đã gửi minh chứng không được ghi đè ảnh cũ', async (t) => {
  const originalGetClient = db.getClient;
  db.getClient = async () => ({
    async query(sql) {
      if (sql.includes('FROM rent_invoice_share_links link')) {
        return { rows: [{
          id: 15, user_id: 7, invoice_id: 41,
          expires_at: '2099-08-28T00:00:00.000Z', revoked_at: null,
          issued_total_vnd: '3000000'
        }] };
      }
      if (sql.includes('SUM(amount_vnd)')) return { rows: [{ paid_amount_vnd: '0' }] };
      if (sql.includes('INSERT INTO rent_payment_proofs')) return { rows: [] };
      return { rows: [] };
    },
    release() {}
  });
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await submitPublicPaymentProof({
    body: { token: generateToken(), dataUrl: jpegDataUrl() }
  }, response.res);
  assert.equal(response.record.statusCode, 409);
  assert.equal(response.record.body.code, 'PAYMENT_PROOF_ALREADY_SUBMITTED');
});

test('chủ trọ chỉ xem minh chứng thuộc đúng user và hóa đơn', async (t) => {
  const originalQuery = db.query;
  let captured;
  db.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [{
      id: '5', invoice_id: '41', status: 'pending', byte_size: 140,
      sha256: 'a'.repeat(64), submitted_at: '2026-08-25T00:00:00.000Z',
      token_last4: 'Ab_9', image_base64: Buffer.from([0xff, 0xd8, 0xff, 0xff, 0xd9]).toString('base64')
    }] };
  };
  t.after(() => { db.query = originalQuery; });

  const response = responseRecorder();
  await listInvoicePaymentProofs({ userId: 7, params: { invoiceId: '41' } }, response.res);
  assert.deepEqual(captured.params, [7, 41]);
  assert.match(captured.sql, /WHERE proof\.user_id=\$1 AND proof\.invoice_id=\$2/);
  assert.match(response.record.body.proofs[0].imageDataUrl, /^data:image\/jpeg;base64,/);
  assert.equal(response.record.body.proofs[0].invoiceId, 41);
});

test('schema, API và UI giữ ảnh nhỏ, khóa ownership và không tự xác nhận thanh toán', () => {
  const root = path.join(__dirname, '..', '..');
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260825_rent_payment_proofs.sql'),
    'utf8'
  );
  const serverSource = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  const apiSource = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const htmlSource = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const publicHtml = fs.readFileSync(path.join(root, 'invoice.html'), 'utf8');
  const publicJs = fs.readFileSync(path.join(root, 'invoice-public.js'), 'utf8');

  for (const source of [schema, migration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS rent_payment_proofs/);
    assert.match(source, /UNIQUE \(user_id, invoice_id, id\)/);
    assert.match(source, /FOREIGN KEY \(user_id, invoice_id, share_link_id\)/);
    assert.match(source, /byte_size BETWEEN 100 AND 196608/);
    assert.match(source, /REVOKE UPDATE, DELETE, TRUNCATE/);
    assert.match(source, /GRANT SELECT, INSERT ON rent_payment_proofs/);
  }
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;[\s\S]*runtime_delete_blocked/);
  assert.match(serverSource, /\/api\/public\/rent-invoice-links\/payment-proof/);
  assert.match(serverSource, /\/api\/rent-invoices\/:invoiceId\/payment-proofs/);
  assert.match(apiSource, /function getRentInvoicePaymentProofs/);
  assert.match(appSource, /function renderInvoicePaymentProofs/);
  assert.match(htmlSource, /id="invoice-payment-proof-list"/);
  assert.match(htmlSource, /style\.css\?v=107[\s\S]*api\.js\?v=103[\s\S]*app\.js\?v=108/);
  assert.match(publicHtml, /id="invoice-payment-proof-form"/);
  assert.match(publicHtml, /invoice-public\.css\?v=7[\s\S]*invoice-public\.js\?v=7/);
  assert.match(publicJs, /toDataURL\('image\/jpeg'/);
  assert.match(publicJs, /credentials: 'omit'/);
  assert.match(publicJs, /let activeToken = ''/);
  assert.doesNotMatch(publicJs, /localStorage|sessionStorage|innerHTML/);
});
