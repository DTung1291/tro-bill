'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  contractReminderType,
  processRentalContractExpiryNotifications,
  rentalContractExpiryReminderCron
} = require('../rental-contract-notifications');
const { rentalContractExpiryEmailHtml } = require('../email');

const root = path.join(__dirname, '..', '..');

function responseRecorder() {
  const record = { statusCode: 200, body: null };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; }
  };
  return { record, res };
}

test('phân loại đúng các mốc nhắc 30, 14, 7, 3 và 1 ngày', () => {
  assert.equal(contractReminderType(30), 'expiry_30d');
  assert.equal(contractReminderType(15), 'expiry_30d');
  assert.equal(contractReminderType(14), 'expiry_14d');
  assert.equal(contractReminderType(8), 'expiry_14d');
  assert.equal(contractReminderType(7), 'expiry_7d');
  assert.equal(contractReminderType(3), 'expiry_3d');
  assert.equal(contractReminderType(1), 'expiry_1d');
  assert.equal(contractReminderType(0), 'expiry_1d');
});

test('cron hợp đồng từ chối request thiếu Bearer secret đúng', async (t) => {
  const previous = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'c'.repeat(40);
  t.after(() => {
    if (previous === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previous;
  });
  const { record, res } = responseRecorder();
  await rentalContractExpiryReminderCron({ get: () => 'Bearer sai' }, res);
  assert.equal(record.statusCode, 401);
  assert.equal(record.body.code, 'CRON_UNAUTHORIZED');
});

test('cron chọn hợp đồng theo ngày Việt Nam, claim một lần và đánh dấu sent', async () => {
  const calls = [];
  let claimCount = 0;
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM rental_contracts contract')) {
      return {
        rows: [
          {
            user_id: 7,
            email: 'owner@example.com',
            contract_id: 36,
            contract_code: 'HD-2026-000010',
            room_name: 'P101',
            tenant_name: 'Nguyễn Văn A',
            ends_on: '2026-09-27',
            days_remaining: 30
          },
          {
            user_id: 8,
            email: 'second@example.com',
            contract_id: 37,
            contract_code: 'HD-2026-000011',
            room_name: 'P102',
            tenant_name: 'Trần Văn B',
            ends_on: '2026-09-04',
            days_remaining: 7
          }
        ]
      };
    }
    if (sql.includes('INSERT INTO rental_contract_notifications')) {
      claimCount += 1;
      return { rows: claimCount === 1 ? [{ id: 80 }] : [] };
    }
    return { rows: [] };
  };
  const messages = [];
  const sendEmail = async (message) => {
    messages.push(message);
    return { emailId: 'brevo-contract-1' };
  };

  const result = await processRentalContractExpiryNotifications({ query, sendEmail });
  assert.deepEqual(result, { candidates: 2, sent: 1, failed: 0, skipped: 1 });
  assert.equal(messages.length, 1);
  assert.deepEqual(messages[0], {
    email: 'owner@example.com',
    contractCode: 'HD-2026-000010',
    roomName: 'P101',
    tenantName: 'Nguyễn Văn A',
    daysRemaining: 30,
    endsOn: '2026-09-27',
    notificationId: 80
  });
  const candidates = calls.find((call) => call.sql.includes('FROM rental_contracts contract'));
  assert.match(candidates.sql, /timezone\('Asia\/Ho_Chi_Minh', now\(\)\)::date/);
  assert.match(candidates.sql, /contract\.status='active'/);
  assert.match(candidates.sql, /contract\.ends_on <= clock\.today \+ 30/);
  assert.match(candidates.sql, /LIMIT 20/);
  const claim = calls.find((call) => call.sql.includes('INSERT INTO rental_contract_notifications'));
  assert.deepEqual(claim.params, [7, 36, 'expiry_30d', '2026-09-27', 'owner@example.com']);
  const markedSent = calls.find((call) => call.sql.includes("SET status='sent'"));
  assert.deepEqual(markedSent.params, [80, 'brevo-contract-1']);
});

test('email lỗi lưu mã an toàn để lần cron sau retry', async () => {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM rental_contracts contract')) {
      return {
        rows: [{
          user_id: 7,
          email: 'owner@example.com',
          contract_id: 36,
          contract_code: 'HD-2026-000010',
          room_name: 'P101',
          tenant_name: 'Nguyễn Văn A',
          ends_on: '2026-08-29',
          days_remaining: 1
        }]
      };
    }
    if (sql.includes('INSERT INTO rental_contract_notifications')) return { rows: [{ id: 81 }] };
    return { rows: [] };
  };
  const sendEmail = async () => {
    const error = new Error('provider secret detail');
    error.code = 'EMAIL_SEND_FAILED';
    throw error;
  };

  const result = await processRentalContractExpiryNotifications({ query, sendEmail });
  assert.deepEqual(result, { candidates: 1, sent: 0, failed: 1, skipped: 0 });
  const failed = calls.find((call) => call.sql.includes("SET status='failed'"));
  assert.deepEqual(failed.params, [81, 'EMAIL_SEND_FAILED']);
  assert.equal(JSON.stringify(calls).includes('provider secret detail'), false);
});

test('email hợp đồng escape dữ liệu và không chứa CCCD', () => {
  const html = rentalContractExpiryEmailHtml({
    contractCode: '<script>alert(1)</script>',
    roomName: '<img src=x>',
    tenantName: 'Nguyễn <b>A</b>',
    daysRemaining: 7,
    endsOn: '2026-09-04',
    appUrl: 'https://tro-bill.vercel.app/'
  });
  assert.doesNotMatch(html, /<script>|<img src=x>|<b>A<\/b>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /không chứa CCCD/);
  assert.doesNotMatch(html, /048[0-9]{9}/);
});

test('schema, migration, route, cron và UI cùng hỗ trợ nhắc hợp đồng', () => {
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260828_rental_contract_expiry_notifications.sql'),
    'utf8'
  );
  const serverSource = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));

  for (const source of [schema, migration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS rental_contract_notifications/);
    assert.match(source, /rental_contract_notifications_owner_fk/);
    assert.match(source, /UNIQUE \(contract_id, notification_type, scheduled_for\)/);
    assert.match(source, /GRANT UPDATE \(status, recipient_email_snapshot, attempt_count, provider_message_id, last_error_code, sent_at, updated_at\)/);
    assert.doesNotMatch(source, /GRANT DELETE ON rental_contract_notifications/);
  }
  assert.match(serverSource, /\/api\/cron\/rental-contract-expiry/);
  assert.deepEqual(
    vercel.crons.find((cron) => cron.path === '/api/cron/rental-contract-expiry'),
    { path: '/api/cron/rental-contract-expiry', schedule: '30 0 * * *' }
  );
  assert.match(appSource, /function rentalContractExpiryStatus/);
  assert.match(appSource, /rental-contract-expiry--/);
  assert.match(html, /rental-contract-cycle\.js\?v=2/);
  assert.match(html, /app\.js\?v=115/);
});
