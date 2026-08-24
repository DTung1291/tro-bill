'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
const paymentsTable = schema.match(
  /CREATE TABLE IF NOT EXISTS subscription_payments \(([\s\S]*?)\n\);/
);
const eventsTable = schema.match(
  /CREATE TABLE IF NOT EXISTS payment_events \(([\s\S]*?)\n\);/
);

test('payment event chống webhook trùng theo provider và event id', () => {
  assert.ok(eventsTable, 'Thiếu bảng payment_events');
  assert.match(
    eventsTable[1],
    /CONSTRAINT payment_events_provider_event_unique UNIQUE \(provider, event_id\)/
  );
  assert.match(eventsTable[1], /CHECK \(char_length\(event_id\) BETWEEN 1 AND 255\)/);
  assert.match(eventsTable[1], /CHECK \(char_length\(event_type\) BETWEEN 1 AND 100\)/);
});

test('payment event liên kết đúng payment của user ở tầng database', () => {
  assert.ok(paymentsTable, 'Thiếu bảng subscription_payments');
  assert.ok(eventsTable, 'Thiếu bảng payment_events');
  assert.match(
    paymentsTable[1],
    /CONSTRAINT subscription_payments_user_id_id_unique UNIQUE \(user_id, id\)/
  );
  assert.match(
    schema,
    /conname = 'subscription_payments_user_id_id_unique'[\s\S]*ALTER TABLE subscription_payments[\s\S]*ADD CONSTRAINT subscription_payments_user_id_id_unique UNIQUE \(user_id, id\);/
  );
  assert.match(
    eventsTable[1],
    /FOREIGN KEY \(user_id, payment_id\)[\s\S]*REFERENCES subscription_payments\(user_id, id\) ON DELETE SET NULL/
  );
  assert.match(
    eventsTable[1],
    /CHECK \(\(user_id IS NULL\) = \(payment_id IS NULL\)\)/
  );
});

test('payment event lưu bằng chứng xác minh và vòng đời xử lý an toàn', () => {
  assert.ok(eventsTable, 'Thiếu bảng payment_events');
  const definition = eventsTable[1];

  assert.match(definition, /payload\s+JSONB NOT NULL DEFAULT '\{\}'::jsonb/);
  assert.match(definition, /payload_sha256\s+TEXT NOT NULL/);
  assert.match(definition, /CHECK \(payload_sha256 ~ '\^\[a-f0-9\]\{64\}\$'\)/);
  assert.match(definition, /signature_valid\s+BOOLEAN NOT NULL DEFAULT false/);
  assert.match(definition, /attempt_count\s+INTEGER NOT NULL DEFAULT 0/);
  assert.match(
    definition,
    /CHECK \(status IN \('received', 'processing', 'processed', 'failed', 'ignored'\)\)/
  );
  assert.match(definition, /CHECK \(attempt_count >= 0\)/);
  assert.match(definition, /CHECK \(status <> 'processed' OR processed_at IS NOT NULL\)/);
});
