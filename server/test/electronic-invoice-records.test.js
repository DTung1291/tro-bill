'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';
process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-electronic-invoice-record-tests';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  assertStatusTransition,
  getElectronicInvoiceRecords,
  providerEventInput,
  recordProviderStatus
} = require('../electronic-invoice-records');

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

function eventInput(overrides = {}) {
  return {
    userId: 7,
    sourceInvoiceId: 8,
    provider: 'misa_meinvoice',
    providerDocumentId: 'provider-document-123',
    providerEventId: 'provider-event-123',
    sourceFingerprint: HASH_A,
    payloadSha256: HASH_B,
    normalizedStatus: 'issued',
    providerStatus: 'DaPhatHanh',
    lookupCode: 'LOOKUP-2026-001',
    taxAuthorityCode: 'CQT-001',
    invoiceNumber: '00000123',
    occurredAt: '2026-09-08T00:00:00.000Z',
    issuedAt: '2026-09-08T00:00:00.000Z',
    ...overrides
  };
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

function recordRow(overrides = {}) {
  return {
    id: 31,
    source_invoice_id: 8,
    provider: 'misa_meinvoice',
    provider_document_id: 'provider-document-123',
    source_fingerprint: HASH_A,
    lookup_code: 'LOOKUP-2026-001',
    tax_authority_code: 'CQT-001',
    invoice_number: '00000123',
    normalized_status: 'issued',
    provider_status: 'DaPhatHanh',
    issued_at: '2026-09-08T00:00:00.000Z',
    last_event_at: '2026-09-08T00:00:00.000Z',
    created_at: '2026-09-08T00:00:00.000Z',
    updated_at: '2026-09-08T00:00:00.000Z',
    ...overrides
  };
}

function eventRow(overrides = {}) {
  return {
    id: 41,
    record_id: 31,
    previous_status: null,
    new_status: 'issued',
    provider_status: 'DaPhatHanh',
    payload_sha256: HASH_B,
    occurred_at: '2026-09-08T00:00:00.000Z',
    created_at: '2026-09-08T00:00:00.000Z',
    ...overrides
  };
}

test('input provider chỉ nhận mã, trạng thái, hash và thời điểm hợp lệ', () => {
  const normalized = providerEventInput(eventInput());
  assert.equal(normalized.userId, 7);
  assert.equal(normalized.lookupCode, 'LOOKUP-2026-001');
  assert.throws(
    () => providerEventInput(eventInput({ provider: 'unknown-provider' })),
    error => error.code === 'INVALID_ELECTRONIC_INVOICE_PROVIDER'
  );
  assert.throws(
    () => providerEventInput(eventInput({ payloadSha256: 'raw-provider-payload' })),
    error => error.code === 'INVALID_ELECTRONIC_INVOICE_EVENT_HASH'
  );
  assert.throws(
    () => providerEventInput(eventInput({ occurredAt: '' })),
    error => error.code === 'INVALID_ELECTRONIC_INVOICE_PROVIDER_EVENT_TIME'
  );
});

test('vòng đời chặn quay ngược hoặc rời trạng thái kết thúc', () => {
  assert.doesNotThrow(() => assertStatusTransition('submitted', 'issued'));
  assert.doesNotThrow(() => assertStatusTransition('issued', 'adjusted'));
  assert.throws(
    () => assertStatusTransition('issued', 'draft'),
    error => error.code === 'ELECTRONIC_INVOICE_STATUS_TRANSITION_INVALID'
  );
  assert.throws(
    () => assertStatusTransition('cancelled', 'submitted'),
    error => error.code === 'ELECTRONIC_INVOICE_STATUS_TRANSITION_INVALID'
  );
});

test('sự kiện provider đầu tiên lưu record và event trong cùng transaction', async () => {
  const calls = [];
  let released = false;
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM electronic_invoice_status_events event')) return { rows: [] };
      if (sql.includes('FROM rent_invoices') && sql.includes('FOR SHARE')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('FROM electronic_invoice_records') && sql.includes('FOR UPDATE')) return { rows: [] };
      if (sql.includes('INSERT INTO electronic_invoice_records')) return { rows: [recordRow()] };
      if (sql.includes('INSERT INTO electronic_invoice_status_events')) return { rows: [eventRow()] };
      return { rows: [] };
    },
    release() { released = true; }
  };
  const result = await recordProviderStatus(eventInput(), { getClient: async () => client });
  assert.equal(result.replay, false);
  assert.equal(result.record.lookupCode, 'LOOKUP-2026-001');
  assert.equal(result.event.status, 'issued');
  assert.equal(released, true);
  assert.equal(calls.some(call => call.sql === 'BEGIN'), true);
  assert.equal(calls.some(call => call.sql === 'COMMIT'), true);
  const recordInsert = calls.find(call => call.sql.includes('INSERT INTO electronic_invoice_records'));
  assert.equal(recordInsert.params.includes('raw-provider-payload'), false);
  assert.equal(recordInsert.params.includes(HASH_B), false);
  const eventInsert = calls.find(call => call.sql.includes('INSERT INTO electronic_invoice_status_events'));
  assert.equal(eventInsert.params.includes(HASH_B), true);
});

test('retry cùng event trả replay, event cùng ID khác payload bị từ chối', async () => {
  const replay = {
    ...eventRow(),
    provider_document_id: 'provider-document-123',
    source_invoice_id: 8,
    source_fingerprint: HASH_A
  };
  function fakeClient() {
    return {
      async query(sql) {
        if (sql.includes('FROM electronic_invoice_status_events event')) return { rows: [replay] };
        return { rows: [] };
      },
      release() {}
    };
  }
  const result = await recordProviderStatus(eventInput(), { getClient: async () => fakeClient() });
  assert.equal(result.replay, true);
  assert.equal(result.recordId, 31);
  await assert.rejects(
    recordProviderStatus(eventInput({ payloadSha256: 'c'.repeat(64) }), {
      getClient: async () => fakeClient()
    }),
    error => error.code === 'ELECTRONIC_INVOICE_PROVIDER_EVENT_MISMATCH'
  );
});

test('không cho sự kiện provider đến trễ ghi đè trạng thái mới hơn', async () => {
  const client = {
    async query(sql) {
      if (sql.includes('FROM electronic_invoice_status_events event')) return { rows: [] };
      if (sql.includes('FROM rent_invoices') && sql.includes('FOR SHARE')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('FROM electronic_invoice_records') && sql.includes('FOR UPDATE')) {
        return { rows: [recordRow({ last_event_at: '2026-09-08T01:00:00.000Z' })] };
      }
      return { rows: [] };
    },
    release() {}
  };
  await assert.rejects(
    recordProviderStatus(eventInput({ occurredAt: '2026-09-08T00:59:59.000Z' }), {
      getClient: async () => client
    }),
    error => error.code === 'ELECTRONIC_INVOICE_EVENT_OUT_OF_ORDER'
  );
});

test('API chỉ cho owner đọc record đúng hóa đơn và ghép lịch sử append-only', async () => {
  const denied = responseRecorder();
  let deniedCalls = 0;
  await getElectronicInvoiceRecords({
    userId: 7,
    workspace: { isOwner: false },
    params: { invoiceId: '8' }
  }, denied.res, { query: async () => { deniedCalls += 1; return { rows: [] }; } });
  assert.equal(denied.record.statusCode, 403);
  assert.equal(deniedCalls, 0);

  const calls = [];
  const response = responseRecorder();
  await getElectronicInvoiceRecords({
    userId: 7,
    workspace: { isOwner: true },
    params: { invoiceId: '8' }
  }, response.res, {
    query: async (sql, params) => {
      calls.push({ sql, params });
      if (sql.startsWith('SELECT 1 FROM rent_invoices')) return { rows: [{ '?column?': 1 }] };
      if (sql.includes('FROM electronic_invoice_records') && !sql.includes('JOIN')) {
        return { rows: [recordRow()] };
      }
      if (sql.includes('FROM electronic_invoice_status_events')) return { rows: [eventRow()] };
      return { rows: [] };
    }
  });
  assert.equal(response.record.statusCode, 200);
  assert.equal(response.record.body.records[0].events.length, 1);
  assert.equal(response.record.body.records[0].events[0].status, 'issued');
  assert.equal(response.record.headers['Cache-Control'], 'no-store');
  assert.deepEqual(calls.map(call => call.params), [[7, 8], [7, 8], [7, 8]]);
});

test('schema giữ ownership, idempotency, immutable reference và least privilege', () => {
  const root = path.join(__dirname, '..', '..');
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260908_electronic_invoice_records.sql'),
    'utf8'
  );
  const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  for (const source of [schema, migration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS electronic_invoice_records/);
    assert.match(source, /electronic_invoice_records_source_owner_fk/);
    assert.match(source, /electronic_invoice_events_provider_event_unique/);
    assert.match(source, /electronic_invoice_event_append_only_before_update/);
    assert.match(source, /electronic invoice status transition is invalid/);
    assert.match(source, /GRANT SELECT, INSERT, UPDATE ON electronic_invoice_records/);
    assert.match(source, /GRANT SELECT, INSERT ON electronic_invoice_status_events/);
    assert.doesNotMatch(source, /GRANT SELECT, INSERT, UPDATE, DELETE ON electronic_invoice_records/);
    assert.doesNotMatch(source, /GRANT SELECT, INSERT, UPDATE ON electronic_invoice_status_events/);
  }
  assert.match(migration, /COMMIT;[\s\S]*electronic_invoice_record_runtime_ready/);
  assert.match(server, /rent-invoices\/:invoiceId\/electronic-invoice-records/);
  assert.match(api, /getElectronicInvoiceRecords[\s\S]*electronic-invoice-records/);
  assert.match(app, /electronicInvoiceRecords/);
  assert.match(html, /id="electronic-invoice-records"/);
});
