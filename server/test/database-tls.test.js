'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const { normalizeDatabaseUrl } = require('../db');

test('chuẩn hóa các SSL mode cũ sang verify-full', () => {
  assert.equal(
    normalizeDatabaseUrl('postgresql://user:secret@host/db?sslmode=require'),
    'postgresql://user:secret@host/db?sslmode=verify-full'
  );
  assert.equal(
    normalizeDatabaseUrl('postgresql://user:secret@host/db?channel_binding=require&sslmode=verify-ca'),
    'postgresql://user:secret@host/db?channel_binding=require&sslmode=verify-full'
  );
  assert.equal(
    normalizeDatabaseUrl('postgresql://user:secret@host/db?sslmode=prefer&application_name=trobill'),
    'postgresql://user:secret@host/db?sslmode=verify-full&application_name=trobill'
  );
});

test('không làm thay đổi URL đã dùng mode an toàn hoặc không có sslmode', () => {
  const secure = 'postgresql://user:secret@host/db?sslmode=verify-full';
  const local = 'postgresql://user:secret@localhost/db';
  assert.equal(normalizeDatabaseUrl(secure), secure);
  assert.equal(normalizeDatabaseUrl(local), local);
});
