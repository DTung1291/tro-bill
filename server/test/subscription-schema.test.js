'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
const subscriptionsTable = schema.match(
  /CREATE TABLE IF NOT EXISTS subscriptions \(([\s\S]*?)\n\);/
);
const subscriptionsBackfill = schema.match(
  /INSERT INTO subscriptions \(user_id, plan_id, status, starts_at\)([\s\S]*?)ON CONFLICT \(user_id\) DO NOTHING;/
);

test('subscription lưu gói hiện tại, thời hạn và trạng thái hợp lệ', () => {
  assert.ok(subscriptionsTable, 'Thiếu bảng subscriptions');

  const definition = subscriptionsTable[1];
  assert.match(definition, /user_id\s+BIGINT NOT NULL UNIQUE REFERENCES users\(id\) ON DELETE CASCADE/);
  assert.match(definition, /plan_id\s+BIGINT NOT NULL REFERENCES plans\(id\) ON DELETE RESTRICT/);
  assert.match(definition, /starts_at\s+TIMESTAMPTZ NOT NULL DEFAULT now\(\)/);
  assert.match(definition, /ends_at\s+TIMESTAMPTZ/);
  assert.match(definition, /billing_cycle\s+TEXT/);
  assert.match(
    definition,
    /CHECK \(status IN \('trialing', 'active', 'grace_period', 'expired', 'canceled'\)\)/
  );
  assert.match(definition, /CHECK \(ends_at IS NULL OR ends_at > starts_at\)/);
  assert.match(
    definition,
    /CHECK \(billing_cycle IS NULL OR billing_cycle IN \('monthly', 'yearly'\)\)/
  );
});

test('mỗi tài khoản chỉ có một subscription hiện tại', () => {
  assert.ok(subscriptionsTable, 'Thiếu bảng subscriptions');
  assert.match(subscriptionsTable[1], /user_id\s+BIGINT NOT NULL UNIQUE/);
});

test('tài khoản cũ được backfill Free mà không ghi đè gói hiện tại', () => {
  assert.ok(subscriptionsBackfill, 'Thiếu backfill subscription Free');

  const statement = subscriptionsBackfill[1];
  assert.match(statement, /SELECT u\.id, p\.id, 'active', u\.created_at/);
  assert.match(statement, /JOIN plans p ON p\.code = 'free'/);
});
