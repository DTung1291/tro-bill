'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-tenancy-history-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const db = require('../db');
const {
  createInvoiceLink,
  generateToken,
  publicInvoiceJson,
  resolvePublicInvoiceLink
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

test('link mới chụp tháng bắt đầu thuê và không suy đoán lịch sử khách cũ', async (t) => {
  const originalQuery = db.query;
  let captured;
  db.query = async (sql, params) => {
    captured = { sql, params };
    return { rows: [{
      id: 15,
      invoice_id: 41,
      token_last4: params[3],
      expires_at: '2099-08-28T00:00:00.000Z',
      created_at: '2026-08-25T00:00:00.000Z',
      view_count: 0
    }] };
  };
  t.after(() => { db.query = originalQuery; });

  const response = responseRecorder();
  await createInvoiceLink({
    userId: 7,
    params: { invoiceId: '41' },
    body: {},
    protocol: 'https',
    get: () => 'tro-bill.example'
  }, response.res);

  assert.equal(response.record.statusCode, 201);
  assert.match(captured.sql, /LEFT JOIN rooms room[\s\S]*room\.user_id=invoice\.user_id/);
  assert.match(captured.sql, /room\.rent_start_date ~ '\^\[0-9\]\{4\}/);
  assert.match(captured.sql, /left\(room\.rent_start_date, 7\) <= invoice\.period/);
  assert.match(captured.sql, /ELSE invoice\.period/);
});

test('JSON công khai chỉ trả tổng hợp hóa đơn và giao dịch cần thiết', () => {
  const result = publicInvoiceJson({
    invoice_id: 41,
    room_name_snapshot: 'P403',
    period: '2026-08',
    issued_total_vnd: '3000000',
    paid_amount_vnd: '1000000',
    expires_at: '2099-08-28T00:00:00.000Z',
    tenancy_start_period: '2026-06',
    history_invoices: [{
      period: '2026-06',
      issued_total_vnd: '2800000',
      paid_amount_vnd: '2800000'
    }, {
      period: '2026-08',
      issued_total_vnd: '3000000',
      paid_amount_vnd: '1000000'
    }],
    history_payments: [{
      period: '2026-08',
      entry_type: 'payment',
      amount_vnd: '1000000',
      payment_method: 'bank_transfer',
      receipt_code: 'PT-202608-00001F',
      occurred_at: '2026-08-25T01:00:00.000Z',
      note: 'không được trả về',
      external_reference: 'không được trả về'
    }]
  });

  assert.equal(result.history.scopeStartPeriod, '2026-06');
  assert.equal(result.history.scopeEndPeriod, '2026-08');
  assert.deepEqual(result.history.invoices.map(item => item.status), ['paid', 'partial']);
  assert.deepEqual(result.history.payments, [{
    period: '2026-08',
    entryType: 'payment',
    amountVnd: 1000000,
    paymentMethod: 'bank_transfer',
    receiptCode: 'PT-202608-00001F',
    occurredAt: '2026-08-25T01:00:00.000Z'
  }]);
  assert.equal('note' in result.history.payments[0], false);
  assert.equal('externalReference' in result.history.payments[0], false);
});

test('truy vấn lịch sử khóa user, phòng, đầu đợt thuê và tháng đang chia sẻ', async (t) => {
  const originalGetClient = db.getClient;
  const calls = [];
  db.getClient = async () => ({
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM rent_invoice_share_links')) {
        return { rows: [{
          id: 15,
          user_id: 7,
          invoice_id: 41,
          tenancy_start_period: '2026-06',
          expires_at: '2099-08-28T00:00:00.000Z',
          revoked_at: null
        }] };
      }
      if (sql.includes('FROM rent_invoices invoice')) {
        return { rows: [{
          invoice_id: 41,
          room_id: 'room-403',
          room_name_snapshot: 'P403',
          period: '2026-08',
          issued_total_vnd: '3000000',
          paid_amount_vnd: '0'
        }] };
      }
      if (sql.includes('FROM rent_invoices history')) {
        return { rows: [{
          period: '2026-08',
          issued_total_vnd: '3000000',
          paid_amount_vnd: '0'
        }] };
      }
      if (sql.includes('JOIN rent_invoices history')) return { rows: [] };
      return { rows: [] };
    },
    release() {}
  });
  t.after(() => { db.getClient = originalGetClient; });

  const response = responseRecorder();
  await resolvePublicInvoiceLink({ body: { token: generateToken() } }, response.res);

  assert.equal(response.record.statusCode, 200);
  const invoiceHistory = calls.find(call => call.sql.includes('FROM rent_invoices history'));
  const paymentHistory = calls.find(call => call.sql.includes('JOIN rent_invoices history'));
  assert.deepEqual(invoiceHistory.params, [7, 'room-403', '2026-06', '2026-08']);
  assert.deepEqual(paymentHistory.params, [7, 'room-403', '2026-06', '2026-08']);
  for (const call of [invoiceHistory, paymentHistory]) {
    assert.match(call.sql, /history\.user_id=\$1 AND history\.room_id=\$2/);
    assert.match(call.sql, /history\.period BETWEEN \$3 AND \$4/);
  }
  assert.equal(response.record.body.history.invoices.length, 1);
});

test('migration cô lập link cũ và giao diện render lịch sử không chèn HTML động', () => {
  const root = path.join(__dirname, '..', '..');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260825_rent_invoice_tenancy_scope.sql'),
    'utf8'
  );
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'invoice.html'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'invoice-public.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'invoice-public.css'), 'utf8');

  for (const source of [migration, schema]) {
    assert.match(source, /tenancy_start_period TEXT/);
    assert.match(source, /SET tenancy_start_period=invoice\.period/);
    assert.match(source, /rent_invoice_share_links_tenancy_period_valid/);
    assert.match(source, /ALTER COLUMN tenancy_start_period SET NOT NULL/);
  }
  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;[\s\S]*runtime_scope_select_ready/);
  assert.match(html, /id="invoice-history"/);
  assert.match(html, /invoice-public\.css\?v=7[\s\S]*invoice-public\.js\?v=7/);
  assert.match(js, /function renderHistory/);
  assert.match(js, /renderHistory\(data\.history \|\| \{\}\)/);
  assert.doesNotMatch(js, /innerHTML|insertAdjacentHTML|document\.write/);
  assert.match(css, /\.public-invoice-history-item/);
});
