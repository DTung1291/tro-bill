'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
const subscriptionsTable = schema.match(
  /CREATE TABLE IF NOT EXISTS subscriptions \(([\s\S]*?)\n\);/
);
const paymentsTable = schema.match(
  /CREATE TABLE IF NOT EXISTS subscription_payments \(([\s\S]*?)\n\);/
);

test('payment thuộc đúng user và subscription ở tầng database', () => {
  assert.ok(subscriptionsTable, 'Thiếu bảng subscriptions');
  assert.ok(paymentsTable, 'Thiếu bảng subscription_payments');

  assert.match(
    subscriptionsTable[1],
    /CONSTRAINT subscriptions_user_id_id_unique UNIQUE \(user_id, id\)/
  );
  assert.match(
    schema,
    /IF NOT EXISTS \([\s\S]*conname = 'subscriptions_user_id_id_unique'[\s\S]*ALTER TABLE subscriptions[\s\S]*ADD CONSTRAINT subscriptions_user_id_id_unique UNIQUE \(user_id, id\);[\s\S]*END \$\$;/,
    'Migration phải bổ sung constraint ownership cho DB đã có subscriptions'
  );
  assert.match(
    paymentsTable[1],
    /FOREIGN KEY \(user_id, subscription_id\)[\s\S]*REFERENCES subscriptions\(user_id, id\) ON DELETE CASCADE/
  );
});

test('payment lưu giá trị VND, chu kỳ và trạng thái hợp lệ', () => {
  assert.ok(paymentsTable, 'Thiếu bảng subscription_payments');

  const definition = paymentsTable[1];
  assert.match(definition, /amount_vnd\s+NUMERIC\(12, 0\) NOT NULL/);
  assert.match(definition, /CHECK \(amount_vnd > 0\)/);
  assert.match(definition, /CHECK \(currency = 'VND'\)/);
  assert.match(definition, /CHECK \(billing_cycle IN \('monthly', 'yearly'\)\)/);
  assert.match(
    definition,
    /CHECK \(status IN \('pending', 'paid', 'failed', 'refunded', 'canceled'\)\)/
  );
  assert.match(definition, /CHECK \(status <> 'paid' OR paid_at IS NOT NULL\)/);
});

test('mã giao dịch nhà cung cấp không thể được ghi nhận hai lần', () => {
  assert.match(
    schema,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_payments_provider_reference[\s\S]*ON subscription_payments\(provider, provider_reference\)[\s\S]*WHERE provider_reference IS NOT NULL AND provider_reference <> '';/
  );
});

test('mỗi giao dịch đối soát chỉ được dùng cho một payment', () => {
  assert.match(paymentsTable[1], /settlement_provider\s+TEXT/);
  assert.match(paymentsTable[1], /settlement_reference\s+TEXT/);
  assert.match(
    paymentsTable[1],
    /CHECK \(\(settlement_provider IS NULL\) = \(settlement_reference IS NULL\)\)/
  );
  assert.match(
    schema,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_payments_settlement_reference[\s\S]*ON subscription_payments\(settlement_provider, settlement_reference\)/
  );
});
