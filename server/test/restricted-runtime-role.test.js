'use strict';

process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..');

test('schema và migration đồng bộ role SQL sau khi thu hồi toàn bộ quyền dư', () => {
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260827_restricted_runtime_role.sql'),
    'utf8'
  );

  for (const source of [schema, migration]) {
    assert.match(source, /target_role CONSTANT text := 'tro_bill_runtime_sql'/);
    assert.match(source, /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public/);
    assert.match(source, /REVOKE ALL PRIVILEGES \(%I\) ON TABLE/);
    assert.match(source, /has_table_privilege\(source_role/);
    assert.match(source, /has_column_privilege\(source_role/);
    assert.match(source, /has_sequence_privilege\(source_role/);
    assert.doesNotMatch(source, /PASSWORD\s+'[^']+'/i);
  }
  assert.match(migration, /NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE/);
  assert.match(migration, /parent\.rolname='neon_superuser'/);
});

test('migration hợp đồng cấp quyền cho role SQL đang dùng trên Vercel', () => {
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260827_rental_contracts.sql'),
    'utf8'
  );
  assert.match(migration, /'tro_bill_runtime_sql'/);
  assert.match(
    migration,
    /GRANT UPDATE \(status, status_reason, activated_at, ended_at, cancelled_at, updated_at\) ON rental_contracts/
  );
  assert.match(migration, /REVOKE UPDATE, DELETE, TRUNCATE[^\n]*rental_contract_amendments/);
});

test('migration khóa credential runtime cũ nhưng giữ role làm mẫu quyền', () => {
  const migration = fs.readFileSync(
    path.join(
      root,
      'server',
      'migrations',
      '20260907_disable_legacy_runtime_logins.sql'
    ),
    'utf8'
  );

  assert.match(migration, /^BEGIN;/);
  assert.match(migration, /COMMIT;/);
  assert.match(migration, /ARRAY\['tro_bill_runtime', 'tro_bill_app'\]/);
  assert.match(migration, /FROM pg_stat_activity/);
  assert.match(migration, /pid <> pg_backend_pid\(\)/);
  assert.match(migration, /IF active_session_count > 0 THEN/);
  assert.match(migration, /RAISE EXCEPTION/);
  assert.match(migration, /ALTER ROLE %I NOLOGIN/);
  assert.match(migration, /restricted_runtime_login_ready/);
  assert.match(migration, /legacy_runtime_logins_disabled/);
  assert.match(migration, /no_runtime_neon_superuser_membership/);
  assert.doesNotMatch(migration, /DROP ROLE/i);
  assert.doesNotMatch(migration, /pg_terminate_backend/i);
  assert.doesNotMatch(migration, /PASSWORD\s+/i);
});
