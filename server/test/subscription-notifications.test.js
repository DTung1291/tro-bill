'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  authorizedCronRequest,
  expiryReminderCron,
  processExpiryNotifications,
  reminderType
} = require('../subscription-notifications');

test('schema chống gửi trùng từng mốc nhắc của một ngày hết hạn', () => {
  const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
  assert.match(schema, /CREATE TABLE IF NOT EXISTS subscription_notifications/);
  assert.match(
    schema,
    /UNIQUE \(subscription_id, notification_type, scheduled_for\)/
  );
  assert.match(schema, /status IN \('sending', 'sent', 'failed'\)/);
  assert.match(schema, /status <> 'sent' OR sent_at IS NOT NULL/);
});

test('cron dùng Bearer secret và so sánh cả độ dài', () => {
  const secret = 'a'.repeat(32);
  const req = (value) => ({ get: () => value });
  assert.equal(authorizedCronRequest(req(`Bearer ${secret}`), secret), true);
  assert.equal(authorizedCronRequest(req('Bearer sai'), secret), false);
  assert.equal(authorizedCronRequest(req(''), ''), false);
});

test('endpoint cron từ chối request không có Bearer secret đúng', async (t) => {
  const originalSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'c'.repeat(40);
  t.after(() => {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  });
  const record = { statusCode: 200, body: null };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; }
  };
  await expiryReminderCron({ get: () => 'Bearer sai' }, res);
  assert.equal(record.statusCode, 401);
  assert.equal(record.body.code, 'CRON_UNAUTHORIZED');
});

test('chọn đúng mốc nhắc 7 ngày, 3 ngày và 1 ngày', () => {
  assert.equal(reminderType(7), 'expiry_7d');
  assert.equal(reminderType(3), 'expiry_3d');
  assert.equal(reminderType(1), 'expiry_1d');
});

test('cron claim, gửi và đánh dấu sent; lần đã claim được bỏ qua', async () => {
  const calls = [];
  let claimCount = 0;
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM subscriptions s')) {
      return {
        rows: [
          {
            user_id: 7,
            email: 'owner@example.com',
            subscription_id: 10,
            plan_name: 'Pro',
            ends_on: '2026-09-01',
            days_remaining: 7
          },
          {
            user_id: 8,
            email: 'second@example.com',
            subscription_id: 11,
            plan_name: 'Standard',
            ends_on: '2026-09-01',
            days_remaining: 3
          }
        ]
      };
    }
    if (sql.includes('INSERT INTO subscription_notifications')) {
      claimCount += 1;
      return { rows: claimCount === 1 ? [{ id: 50 }] : [] };
    }
    return { rows: [] };
  };
  const sentMessages = [];
  const sendEmail = async (message) => {
    sentMessages.push(message);
    return { emailId: 'brevo-1' };
  };

  const result = await processExpiryNotifications({ query, sendEmail });
  assert.deepEqual(result, { candidates: 2, sent: 1, failed: 0, skipped: 1 });
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].daysRemaining, 7);
  const claim = calls.find((call) => call.sql.includes('INSERT INTO subscription_notifications'));
  assert.deepEqual(claim.params, [7, 10, 'expiry_7d', '2026-09-01', 'owner@example.com']);
  const markedSent = calls.find((call) => call.sql.includes("SET status='sent'"));
  assert.deepEqual(markedSent.params, [50, 'brevo-1']);
});

test('email lỗi được ghi mã an toàn để cron sau có thể retry', async () => {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM subscriptions s')) {
      return {
        rows: [{
          user_id: 7,
          email: 'owner@example.com',
          subscription_id: 10,
          plan_name: 'Pro',
          ends_on: '2026-09-01',
          days_remaining: 1
        }]
      };
    }
    if (sql.includes('INSERT INTO subscription_notifications')) return { rows: [{ id: 51 }] };
    return { rows: [] };
  };
  const sendEmail = async () => {
    const error = new Error('provider secret detail');
    error.code = 'EMAIL_SEND_FAILED';
    throw error;
  };

  const result = await processExpiryNotifications({ query, sendEmail });
  assert.deepEqual(result, { candidates: 1, sent: 0, failed: 1, skipped: 0 });
  const failed = calls.find((call) => call.sql.includes("SET status='failed'"));
  assert.deepEqual(failed.params, [51, 'EMAIL_SEND_FAILED']);
  assert.equal(JSON.stringify(calls).includes('provider secret detail'), false);
});
