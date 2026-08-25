'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const schema = fs.readFileSync(path.join(__dirname, '..', 'schema.sql'), 'utf8');
const refundTable = schema.match(
  /CREATE TABLE IF NOT EXISTS subscription_refund_requests \(([\s\S]*?)\n\);/
);

test('refund request khóa ownership theo user và payment', () => {
  assert.ok(refundTable, 'Thiếu bảng subscription_refund_requests');
  assert.match(
    refundTable[1],
    /FOREIGN KEY \(user_id, payment_id\)[\s\S]*REFERENCES subscription_payments\(user_id, id\) ON DELETE CASCADE/
  );
  assert.match(
    schema,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_refund_one_active_per_payment[\s\S]*WHERE status IN \('pending', 'reviewing', 'approved'\)/
  );
  assert.match(
    schema,
    /CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_refund_one_completed_per_payment[\s\S]*WHERE status = 'refunded'/
  );
});

test('refund request có loại, số tiền và vòng đời hợp lệ', () => {
  assert.ok(refundTable, 'Thiếu bảng subscription_refund_requests');
  const definition = refundTable[1];
  assert.match(definition, /CHECK \(request_type IN \('refund', 'mistaken_transfer'\)\)/);
  assert.match(definition, /CHECK \(requested_amount_vnd > 0\)/);
  assert.match(definition, /CHECK \(char_length\(reason\) BETWEEN 10 AND 500\)/);
  assert.match(
    definition,
    /CHECK \(status IN \('pending', 'reviewing', 'approved', 'rejected', 'refunded', 'canceled'\)\)/
  );
});

test('chỉ đánh dấu refunded khi có thời điểm và mã giao dịch hoàn', () => {
  assert.ok(refundTable, 'Thiếu bảng subscription_refund_requests');
  assert.match(
    refundTable[1],
    /CHECK \(status <> 'refunded' OR \(refunded_at IS NOT NULL AND refund_reference IS NOT NULL\)\)/
  );
  assert.match(
    refundTable[1],
    /CHECK \(refund_reference IS NULL OR char_length\(refund_reference\) BETWEEN 3 AND 100\)/
  );
});

test('runtime role chỉ được đọc, tạo và cập nhật workflow hoàn tiền', () => {
  assert.match(
    schema,
    /GRANT SELECT, INSERT, UPDATE ON subscription_refund_requests TO tro_bill_runtime/
  );
  assert.match(
    schema,
    /GRANT USAGE, SELECT ON SEQUENCE subscription_refund_requests_id_seq TO tro_bill_runtime/
  );
  assert.doesNotMatch(
    schema,
    /GRANT[\s\S]{0,80}DELETE ON subscription_refund_requests TO tro_bill_runtime/
  );
});
