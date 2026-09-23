'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { childEnvironment, databaseTarget, profiles, validateProfile } = require('../../scripts/start-local');

const base = {
  APP_ENV: 'development',
  DATABASE_ENVIRONMENT: 'staging',
  DATABASE_URL: 'postgresql://user:password@ep-stg-abc.neon.tech/neondb?sslmode=verify-full',
  PRODUCTION_DATABASE_HOST: 'ep-prod-def.neon.tech',
  JWT_SECRET: 's'.repeat(40),
  COOKIE_SECURE: 'false',
  APP_URL: 'http://localhost:3000',
  PORT: '3000'
};

test('local mặc định dùng staging và ba profile có file riêng', () => {
  assert.equal(profiles.stg.file, '.env.local-stg');
  assert.equal(profiles.dev.file, '.env.local-dev');
  assert.equal(profiles.pro.file, '.env.local-pro');
  assert.equal(validateProfile('stg', base).databaseEnvironment, 'staging');
});

test('staging và Production không thể cùng trỏ một Neon endpoint', () => {
  const production = { ...base, DATABASE_ENVIRONMENT: 'production' };
  assert.throws(() => validateProfile('stg', base, production), /cùng endpoint/);
  assert.throws(() => validateProfile('pro', production, base), /cùng endpoint/);
  assert.equal(databaseTarget(base.DATABASE_URL), 'ep-stg-abc.neon.tech');
  assert.equal(databaseTarget('postgresql://user:password@ep-stg-abc-pooler.neon.tech/other_db'), 'ep-stg-abc.neon.tech');
  assert.equal(validateProfile('stg', base, { DATABASE_URL: 'postgresql://user:password@production-db.example.invalid/db' }).name, 'stg');
});

test('từ chối profile sai nhãn, URL mẫu, seed Super Admin và cookie không hợp local', () => {
  assert.throws(() => validateProfile('stg', { ...base, DATABASE_ENVIRONMENT: 'production' }), /DATABASE_ENVIRONMENT/);
  assert.throws(() => validateProfile('stg', { ...base, PRODUCTION_DATABASE_HOST: '' }), /PRODUCTION_DATABASE_HOST/);
  assert.throws(() => validateProfile('stg', { ...base, PRODUCTION_DATABASE_HOST: 'ep-prod-def.neon.tech:5432' }), /PRODUCTION_DATABASE_HOST/);
  assert.throws(() => validateProfile('stg', { ...base, PRODUCTION_DATABASE_HOST: 'ep-stg-abc-pooler.neon.tech' }), /endpoint Production/);
  assert.throws(() => validateProfile('stg', { ...base, DATABASE_URL: 'postgresql://user:password@staging-db.example.invalid/neondb' }), /giá trị mẫu/);
  assert.throws(() => validateProfile('stg', { ...base, SUPER_ADMIN_EMAIL: 'admin@example.test' }), /SUPER_ADMIN_EMAIL/);
  assert.throws(() => validateProfile('stg', { ...base, BREVO_API_KEY: 'must-not-send-email' }), /BREVO_API_KEY/);
  assert.throws(() => validateProfile('stg', { ...base, COOKIE_SECURE: 'true' }), /COOKIE_SECURE/);
  assert.throws(() => validateProfile('stg', { ...base, JWT_SECRET: 'replace-with-a-long-placeholder-secret' }), /JWT_SECRET/);
});

test('child không kế thừa database/secret cũ và server bỏ nạp .env khi dùng profile', () => {
  const oldDatabaseUrl = process.env.DATABASE_URL;
  const oldSeedEmail = process.env.SUPER_ADMIN_EMAIL;
  process.env.DATABASE_URL = 'postgresql://user:password@ep-prod.neon.tech/neondb';
  process.env.SUPER_ADMIN_EMAIL = 'must-not-be-inherited@example.test';
  try {
    const env = childEnvironment(base);
    assert.equal(env.DATABASE_URL, base.DATABASE_URL);
    assert.equal(env.SUPER_ADMIN_EMAIL, undefined);
    assert.equal(env.NODE_ENV, 'development');
  } finally {
    if (oldDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = oldDatabaseUrl;
    if (oldSeedEmail === undefined) delete process.env.SUPER_ADMIN_EMAIL;
    else process.env.SUPER_ADMIN_EMAIL = oldSeedEmail;
  }
  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  const dbSource = fs.readFileSync(path.join(__dirname, '..', 'db.js'), 'utf8');
  assert.match(serverSource, /if \(!process\.env\.TROBILL_LOCAL_PROFILE\) require\('dotenv'\)\.config\(\)/);
  assert.match(dbSource, /if \(!process\.env\.TROBILL_LOCAL_PROFILE\) require\('dotenv'\)\.config\(\)/);
});
