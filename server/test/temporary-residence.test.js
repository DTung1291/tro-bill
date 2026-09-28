'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { currentTenantPredicate } = require('../tenant-occupancy');

const root = path.resolve(__dirname, '../..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const state = fs.readFileSync(path.join(root, 'server/state.js'), 'utf8');
const maintenance = fs.readFileSync(path.join(root, 'server/room-maintenance.js'), 'utf8');
const lifecycle = fs.readFileSync(path.join(root, 'server/rental-lifecycle.js'), 'utf8');
const source = app.slice(
  app.indexOf('function temporaryResidenceStatus('),
  app.indexOf('function renderTemporaryResidenceAlerts(')
);
const status = vm.runInNewContext(`${source}\ntemporaryResidenceStatus`, {
  vietnamCalendarDate: () => '2026-09-28',
  dateLabel: value => value
});

test('nhắc trước hạn 30 ngày, ngày hết hạn và quá hạn', () => {
  assert.equal(status({ temporaryResidenceExpiresOn: '2026-10-29' }).level, 'valid');
  assert.equal(status({ temporaryResidenceExpiresOn: '2026-10-28' }).level, 'soon');
  assert.equal(status({ temporaryResidenceExpiresOn: '2026-09-28' }).level, 'expired');
  assert.equal(status({ temporaryResidenceExpiresOn: '2026-09-27' }).level, 'expired');
});

test('sau trả phòng vẫn giữ ngày nhưng không nhắc', () => {
  const former = status({ temporaryResidenceCurrent: false, temporaryResidenceExpiresOn: '2026-09-01' });
  assert.equal(former.level, 'former');
  assert.match(state, /currentTenantPredicate\('tenant'\)/);
});

test('khách có hợp đồng đã kết thúc không chiếm phòng hoặc chặn thao tác phòng trống', () => {
  const predicate = currentTenantPredicate('occupant');
  assert.match(predicate, /current_contract\.room_id=occupant\.room_id/);
  assert.match(predicate, /current_contract\.status='active'/);
  assert.match(predicate, /ended_contract\.status='ended'/);
  assert.match(maintenance, /COUNT\(\*\)::int AS active_tenant_count FROM tenants occupant[\s\S]*currentTenantPredicate\('occupant'\)/);
  assert.match(maintenance, /AS has_tenant[\s\S]*currentTenantPredicate\('occupant'\)|currentTenantPredicate\('occupant'\)[\s\S]*AS has_tenant/);
  assert.equal((lifecycle.match(/currentTenantPredicate\('occupant'\)/g) || []).length, 2);
  assert.throws(() => currentTenantPredicate('untrusted; DROP TABLE tenants'), /không hợp lệ/);
});

test('hồ sơ chưa có ngày hết hạn không bị coi là quá hạn', () => {
  assert.equal(status({ temporaryResidenceExpiresOn: '' }).level, 'missing');
});

test('migration có thể chạy lại và cấp đúng cột cho runtime', () => {
  const migration = fs.readFileSync(path.join(root, 'server/migrations/20260928_tenant_temporary_residence.sql'), 'utf8');
  const schema = fs.readFileSync(path.join(root, 'server/schema.sql'), 'utf8');
  assert.match(migration, /ADD COLUMN IF NOT EXISTS temporary_residence_registered_on DATE/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS temporary_residence_expires_on DATE/);
  assert.match(migration, /GRANT SELECT \(temporary_residence_registered_on, temporary_residence_expires_on\), INSERT/);
  assert.match(schema, /tenants_temporary_residence_dates_valid/);
});
