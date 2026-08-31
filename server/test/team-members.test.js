'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-team-member-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  createTeamMember,
  deleteTeamMember,
  listTeamMembers,
  normalizeEmail,
  normalizeRole,
  updateTeamMember
} = require('../team-members');

const root = path.join(__dirname, '..', '..');

function responseRecorder() {
  const record = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; },
    set(name, value) { record.headers[name] = value; return res; }
  };
  return { record, res };
}

function entitlementRow(overrides = {}) {
  return {
    subscription_id: 10,
    status: 'active',
    starts_at: new Date('2026-08-01T00:00:00Z'),
    ends_at: null,
    plan_id: 4,
    plan_code: 'business',
    plan_name: 'Business',
    room_limit: 100,
    staff_limit: 2,
    room_count: 7,
    ...overrides
  };
}

function memberRow(overrides = {}) {
  return {
    account_user_id: 7,
    member_user_id: 8,
    member_email: 'staff@example.com',
    role: 'manager',
    created_at: '2026-08-31T00:00:00.000Z',
    updated_at: '2026-08-31T00:00:00.000Z',
    ...overrides
  };
}

test('chỉ nhận email hợp lệ và ba vai trò nhân viên', () => {
  assert.equal(normalizeEmail(' STAFF@Example.com '), 'staff@example.com');
  assert.equal(normalizeRole(' manager '), 'manager');
  assert.equal(normalizeRole('accountant'), 'accountant');
  assert.equal(normalizeRole('meter_reader'), 'meter_reader');
  assert.throws(() => normalizeEmail('khong-phai-email'), /Email/);
  assert.throws(
    () => normalizeRole('owner'),
    (error) => error.code === 'INVALID_MEMBER_ROLE'
  );
});

test('danh sách luôn trả chủ sở hữu, vai trò và hạn mức nhân viên', async () => {
  const calls = [];
  const query = async (sql, params = []) => {
    calls.push({ sql, params });
    if (sql.includes('FROM account_memberships membership')) {
      return {
        rows: [
          memberRow({ member_user_id: 7, member_email: 'owner@example.com', role: 'owner' }),
          memberRow()
        ]
      };
    }
    if (sql.includes('FROM subscriptions s')) return { rows: [entitlementRow()] };
    throw new Error(`Truy vấn không mong đợi: ${sql}`);
  };
  const response = responseRecorder();
  await listTeamMembers({ userId: 7 }, response.res, { query });

  assert.equal(response.record.body.members[0].roleLabel, 'Chủ sở hữu');
  assert.equal(response.record.body.members[1].roleLabel, 'Quản lý');
  assert.deepEqual(response.record.body.staffUsage, {
    used: 1, limit: 2, remaining: 1, canManage: true
  });
  assert.deepEqual(response.record.body.roles.map(role => role.value), [
    'manager', 'accountant', 'meter_reader'
  ]);
  assert.equal(response.record.headers['Cache-Control'], 'no-store');
  assert.deepEqual(calls[0].params, [7]);
});

test('thêm thành viên khóa theo chủ, kiểm tra gói và chỉ dùng user đã xác minh', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM subscriptions s')) return { rows: [entitlementRow()] };
      if (sql.includes('FROM users') && sql.includes('email_verified_at')) {
        return { rows: [{ id: 8, email: 'staff@example.com' }] };
      }
      if (sql.includes('COUNT(*)::int AS staff_count')) return { rows: [{ staff_count: 0 }] };
      if (sql.includes('INSERT INTO account_memberships')) return { rows: [memberRow()] };
      return { rows: [] };
    },
    release() {}
  };
  const response = responseRecorder();
  await createTeamMember(
    { userId: 7, body: { email: 'staff@example.com', role: 'accountant' } },
    response.res,
    { getClient: async () => client }
  );

  assert.equal(response.record.statusCode, 201);
  assert.equal(calls.some(call => call.sql.includes("'team-write:'")), true);
  const findUser = calls.find(call => call.sql.includes('email_verified_at'));
  assert.deepEqual(findUser.params, ['staff@example.com']);
  const insert = calls.find(call => call.sql.includes('INSERT INTO account_memberships'));
  assert.deepEqual(insert.params, [7, 8, 'accountant']);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('gói không hỗ trợ nhân viên bị chặn trước khi tìm email', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('FROM subscriptions s')) {
        return { rows: [entitlementRow({ plan_code: 'free', plan_name: 'Free', staff_limit: 0 })] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const response = responseRecorder();
  await createTeamMember(
    { userId: 7, body: { email: 'staff@example.com', role: 'manager' } },
    response.res,
    { getClient: async () => client }
  );
  assert.equal(response.record.statusCode, 403);
  assert.equal(response.record.body.code, 'STAFF_FEATURE_NOT_AVAILABLE');
  assert.equal(calls.some(call => call.sql.includes('email_verified_at')), false);
  assert.equal(calls.at(-1).sql, 'ROLLBACK');
});

test('không thể sửa hoặc xóa membership chủ sở hữu', async () => {
  const updateResponse = responseRecorder();
  await updateTeamMember(
    { userId: 7, params: { id: '7' }, body: { role: 'manager' } },
    updateResponse.res
  );
  assert.equal(updateResponse.record.statusCode, 409);
  assert.equal(updateResponse.record.body.code, 'OWNER_ROLE_IMMUTABLE');

  const deleteResponse = responseRecorder();
  await deleteTeamMember(
    { userId: 7, params: { id: '7' } },
    deleteResponse.res
  );
  assert.equal(deleteResponse.record.statusCode, 409);
  assert.equal(deleteResponse.record.body.code, 'OWNER_ROLE_IMMUTABLE');
});

test('chủ tài khoản vẫn được xóa nhân viên khi gói không còn hiệu lực', async () => {
  const calls = [];
  const client = {
    async query(sql, params = []) {
      calls.push({ sql, params });
      if (sql.includes('DELETE FROM account_memberships')) {
        return { rows: [{ member_user_id: 8 }] };
      }
      return { rows: [] };
    },
    release() {}
  };
  const response = responseRecorder();
  await deleteTeamMember(
    { userId: 7, params: { id: '8' } },
    response.res,
    { getClient: async () => client }
  );

  assert.equal(response.record.statusCode, 200);
  assert.deepEqual(response.record.body, { ok: true });
  assert.equal(calls.some(call => call.sql.includes('FROM subscriptions s')), false);
  assert.equal(calls.at(-1).sql, 'COMMIT');
});

test('schema và migration bảo vệ bốn vai trò, backfill chủ và quyền runtime', () => {
  const schema = fs.readFileSync(path.join(root, 'server', 'schema.sql'), 'utf8');
  const migration = fs.readFileSync(
    path.join(root, 'server', 'migrations', '20260830_account_roles.sql'),
    'utf8'
  );
  for (const source of [schema, migration]) {
    assert.match(source, /CREATE TABLE IF NOT EXISTS account_memberships/);
    assert.match(source, /'owner', 'manager', 'accountant', 'meter_reader'/);
    assert.match(source, /account_memberships_owner_shape_valid/);
    assert.match(source, /INSERT INTO account_memberships[\s\S]*SELECT id, id, 'owner', id/);
    assert.match(source, /CREATE OR REPLACE FUNCTION assign_owner_account_membership/);
    assert.match(source, /CREATE TRIGGER users_assign_owner_account_membership/);
  }
  assert.match(schema, /GRANT SELECT, INSERT, UPDATE, DELETE ON account_memberships/);
  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE ON account_memberships/);
  assert.match(migration, /owner_membership_backfill_ready/);
  assert.match(migration, /memberships_runtime_ready/);
});

test('UI và API khai báo đủ thao tác quản lý ba vai trò nhân viên', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(html, /id="team-members-card"/);
  assert.match(html, /id="team-member-form"/);
  assert.match(html, /value="manager"[\s\S]*value="accountant"[\s\S]*value="meter_reader"/);
  assert.match(app, /function renderTeamMembers/);
  assert.match(app, /API\.getTeamMembers\(\)/);
  assert.match(app, /data-team-remove="\$\{member\.userId\}">Xóa<\/button>/);
  assert.match(api, /request\('POST', '\/api\/team\/members'/);
  assert.match(api, /request\('PATCH', `\/api\/team\/members/);
  assert.match(css, /\.team-members-list/);
  assert.match(css, /\.team-member-form button:disabled/);
  assert.match(css, /@media \(max-width:[\s\S]*\.team-member-row/);
});
