'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-schema-diagnostics-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  SCHEMA_DIAGNOSTICS_QUERY,
  SCHEMA_MIGRATION_CHECKS,
  missingSchemaMigrations
} = require('../schema-diagnostics');

test('diagnostic ánh xạ từng nhóm schema sang đúng migration tiến tới', () => {
  const complete = Object.fromEntries(SCHEMA_MIGRATION_CHECKS.map(([key]) => [key, true]));
  assert.deepEqual(missingSchemaMigrations(complete), []);

  complete.electronic_invoice_profiles = false;
  complete.electronic_invoice_preflight = false;
  assert.deepEqual(missingSchemaMigrations(complete), [
    '20260907_electronic_invoice_profiles.sql',
    '20260907_electronic_invoice_preflight.sql'
  ]);

  for (const [key] of SCHEMA_MIGRATION_CHECKS) {
    assert.match(SCHEMA_DIAGNOSTICS_QUERY, new RegExp(`AS\\s+${key}(?:,|\\s*$)`, 'im'));
  }
});
