'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-properties-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createProperty,
  deleteProperty,
  propertyInput,
  propertyJson
} = require('../properties');

const root = path.join(__dirname, '..', '..');

function responseRecorder() {
  const record = { statusCode: 200, body: null };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; },
    set() { return res; }
  };
  return { record, res };
}

function activeSubscriptionRow() {
  return {
    subscription_id: 10,
    status: 'active',
    starts_at: new Date('2026-08-01T00:00:00Z'),
    ends_at: null,
    plan_id: 1,
    plan_code: 'free',
    plan_name: 'Free',
    room_limit: 10,
    staff_limit: 0,
    room_count: 1
  };
}

function propertyRow(overrides = {}) {
  return {
    id: 2,
    user_id: 7,
    name: 'Khu B',
    address: '20 Trần Phú',
    note: '',
    is_default: false,
    sort_order: 1,
    room_count: 0,
    created_at: '2026-08-30T00:00:00.000Z',
    updated_at: '2026-08-30T00:00:00.000Z',
    ...overrides
  };
}

test('chuẩn hóa khu và không nhận nội dung vượt giới hạn', () => {
  assert.deepEqual(propertyInput({ name: '  Khu B  ', address: '  Đà Nẵng ', note: ' gần chợ ' }), {
    name: 'Khu B', address: 'Đà Nẵng', note: 'gần chợ'
  });
  assert.throws(
    () => propertyInput({ name: '', address: '' }),
    (error) => error.code === 'INVALID_PROPERTY_NAME'
  );
  assert.equal(propertyJson(propertyRow()).roomCount, 0);
});

test('tạo khu khóa theo tài khoản, kiểm tra gói và gắn đúng user_id', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('COUNT(*)::int AS room_count')) return { rows: [{ room_count: 1 }] };
      if (sql.includes('FROM subscriptions s')) return { rows: [activeSubscriptionRow()] };
      if (sql.includes('INSERT INTO properties (user_id, name, is_default')) return { rows: [] };
      if (sql.includes('SELECT * FROM properties') && sql.includes('LIMIT 1')) {
        return { rows: [propertyRow({ id: 1, name: 'Khu trọ chính', is_default: true })] };
      }
      if (sql.includes('property_count')) return { rows: [{ property_count: 1 }] };
      if (sql.includes('INSERT INTO properties (user_id, name, address')) {
        return { rows: [propertyRow()] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const response = responseRecorder();
  await createProperty(
    { userId: 7, body: { name: 'Khu B', address: '20 Trần Phú' } },
    response.res,
    { getClient: async () => client }
  );

  assert.equal(response.record.statusCode, 201);
  assert.equal(response.record.body.property.name, 'Khu B');
  assert.equal(calls.some(call => call.sql.includes("'state-write:'")), true);
  const insert = calls.find(call => call.sql.includes('INSERT INTO properties (user_id, name, address'));
  assert.deepEqual(insert.params.slice(0, 3), [7, 'Khu B', '20 Trần Phú']);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('không cho xóa khu mặc định', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('COUNT(*)::int AS room_count')) return { rows: [{ room_count: 0 }] };
      if (sql.includes('FROM subscriptions s')) return { rows: [activeSubscriptionRow()] };
      if (sql.includes('SELECT * FROM properties') && sql.includes('FOR UPDATE')) {
        return { rows: [propertyRow({ id: 1, name: 'Khu trọ chính', is_default: true })] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const response = responseRecorder();
  await deleteProperty(
    { userId: 7, params: { id: '1' } },
    response.res,
    { getClient: async () => client }
  );
  assert.equal(response.record.statusCode, 409);
  assert.equal(response.record.body.code, 'DEFAULT_PROPERTY_REQUIRED');
  assert.equal(calls.some(call => call.sql.startsWith('DELETE FROM properties')), false);
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
});

test('schema và migration có backfill, ownership FK và quyền runtime', () => {
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260830_multi_properties.sql'),
    'utf8'
  );
  for (const source of [schema, migration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS properties/);
    assert.match(source, /idx_properties_one_default/);
    assert.match(source, /rooms_property_owner_fk/);
    assert.match(source, /REFERENCES properties\(user_id, id\) ON DELETE RESTRICT/);
    assert.match(source, /UPDATE rooms[\s\S]*properties\.is_default/);
    assert.match(source, /CREATE OR REPLACE FUNCTION assign_default_room_property/);
    assert.match(source, /CREATE TRIGGER rooms_assign_default_property/);
  }
  assert.match(migration, /'tro_bill_runtime_sql'/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON properties/);
});

test('UI quản lý, lọc, gắn phòng theo khu và giữ cấu trúc khi import', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(html, /id="room-property-filter"/);
  assert.match(html, /id="property-modal"[\s\S]*id="property-form"/);
  assert.match(html, /id="room-property"/);
  assert.match(app, /ACTIVE_PROPERTY_FILTER/);
  assert.match(app, /function reconcileImportedProperties/);
  assert.match(app, /roomPropertyAddress\(room\)/);
  assert.doesNotMatch(app, /contract-property-address'\)\.value = '40 Vũ Hữu/);
  assert.match(api, /request\('POST', '\/api\/properties'/);
  assert.match(api, /request\('PATCH', `\/api\/properties/);
  assert.match(css, /\.property-modal-body[\s\S]*grid-template-columns/);
  assert.match(css, /@media \(max-width:[\s\S]*\.property-modal-body \{ grid-template-columns: 1fr/);
});
