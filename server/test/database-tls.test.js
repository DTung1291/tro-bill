'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { databaseConnectionString, normalizeDatabaseUrl } = require('../db');
const { databaseCredential } = require('../../scripts/secret-scan');

test('chuẩn hóa các SSL mode cũ sang verify-full', () => {
  assert.equal(
    normalizeDatabaseUrl('postgresql://user:secret@db.example.invalid/db?sslmode=require'),
    'postgresql://user:secret@db.example.invalid/db?sslmode=verify-full'
  );
  assert.equal(
    normalizeDatabaseUrl('postgresql://user:secret@db.example.invalid/db?channel_binding=require&sslmode=verify-ca'),
    'postgresql://user:secret@db.example.invalid/db?channel_binding=require&sslmode=verify-full'
  );
  assert.equal(
    normalizeDatabaseUrl('postgresql://user:secret@db.example.invalid/db?sslmode=prefer&application_name=trobill'),
    'postgresql://user:secret@db.example.invalid/db?sslmode=verify-full&application_name=trobill'
  );
});

test('không làm thay đổi URL đã dùng mode an toàn hoặc không có sslmode', () => {
  const secure = 'postgresql://user:secret@db.example.invalid/db?sslmode=verify-full';
  const local = 'postgresql://user:secret@localhost/db';
  assert.equal(normalizeDatabaseUrl(secure), secure);
  assert.equal(normalizeDatabaseUrl(local), local);
});

test('override role database chỉ đổi username và vẫn giữ password/query an toàn', () => {
  assert.equal(
    databaseConnectionString(
      'postgresql://legacy:secret@db.example.invalid/app?sslmode=require',
      { roleOverride: 'tro_bill_runtime_sql' }
    ),
    'postgresql://tro_bill_runtime_sql:secret@db.example.invalid/app?sslmode=verify-full'
  );
  assert.throws(
    () => databaseConnectionString(
      'postgresql://legacy:secret@db.example.invalid/app',
      { roleOverride: 'runtime role; DROP ROLE legacy' }
    ),
    /DATABASE_ROLE_OVERRIDE/
  );
});

test('secret scanner chỉ miễn URL database placeholder rõ ràng', () => {
  assert.equal(databaseCredential('postgresql://user:secret@host/db'), false);
  assert.equal(databaseCredential('postgresql://user:secret@db.example.invalid/db'), false);
  const realisticUrl = [
    'postgresql://production_owner:',
    'credential-shaped-value-1234567890',
    '@db.example.com/app'
  ].join('');
  assert.equal(databaseCredential(realisticUrl), true);
});
