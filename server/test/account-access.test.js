'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-account-access-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  listWorkspaces,
  requireWorkspace,
  workspaceJson
} = require('../account-access');

function responseRecorder() {
  const record = { statusCode: 200, body: null, headers: {} };
  const res = {
    status(code) { record.statusCode = code; return res; },
    json(body) { record.body = body; return res; },
    set(name, value) { record.headers[name] = value; return res; }
  };
  return { record, res };
}

function request(userId, workspaceId = '') {
  return {
    userId,
    get(name) {
      return name === 'x-trobill-workspace-account-id' ? workspaceId : undefined;
    }
  };
}

function rows() {
  return [
    {
      account_user_id: 8,
      account_email: 'staff@example.com',
      role: 'owner',
      property_ids: [88],
      operations: ['overview', 'rooms', 'meters', 'expenses', 'invoices']
    },
    {
      account_user_id: 7,
      account_email: 'owner@example.com',
      role: 'accountant',
      property_ids: [12, 13],
      operations: ['overview', 'invoices']
    }
  ];
}

test('workspace JSON chỉ giữ nghiệp vụ hợp lệ theo vai trò', () => {
  const workspace = workspaceJson({
    account_user_id: 7,
    account_email: 'owner@example.com',
    role: 'meter_reader',
    property_ids: ['12'],
    operations: ['meters', 'invoices']
  }, 8);
  assert.deepEqual(workspace.propertyIds, [12]);
  assert.deepEqual(workspace.operations, ['meters']);
  assert.equal(workspace.canAccess, true);
});

test('danh sách workspace gồm tài khoản riêng và tài khoản được giao', async () => {
  const response = responseRecorder();
  await listWorkspaces(
    { userId: 8 },
    response.res,
    { query: async () => ({ rows: rows() }) }
  );
  assert.equal(response.record.statusCode, 200);
  assert.equal(response.record.body.workspaces.length, 2);
  assert.equal(response.record.body.workspaces[0].isOwner, true);
  assert.equal(response.record.body.workspaces[1].role, 'accountant');
  assert.equal(response.record.headers['Cache-Control'], 'no-store');
});

test('workspace của chính người đăng nhập giữ owner và không truy vấn membership', async () => {
  let queried = false;
  const middleware = requireWorkspace('rooms', {
    query: async () => { queried = true; return { rows: [] }; }
  });
  const req = request(8, '8');
  const response = responseRecorder();
  let nextCalled = false;
  await middleware(req, response.res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(queried, false);
  assert.equal(req.userId, 8);
  assert.equal(req.workspace.isOwner, true);
});

test('workspace nhân viên đổi user scope chỉ sau khi đủ khu và nghiệp vụ', async () => {
  const middleware = requireWorkspace('invoices', {
    query: async () => ({ rows: rows() })
  });
  const req = request(8, '7');
  const response = responseRecorder();
  let nextCalled = false;
  await middleware(req, response.res, () => { nextCalled = true; });
  assert.equal(nextCalled, true);
  assert.equal(req.actorUserId, 8);
  assert.equal(req.userId, 7);
  assert.equal(req.accountUserId, 7);
  assert.deepEqual(req.workspace.propertyIds, [12, 13]);
});

test('workspace từ chối nghiệp vụ không được giao và không đổi user scope', async () => {
  const middleware = requireWorkspace('rooms', {
    query: async () => ({ rows: rows() })
  });
  const req = request(8, '7');
  const response = responseRecorder();
  let nextCalled = false;
  await middleware(req, response.res, () => { nextCalled = true; });
  assert.equal(nextCalled, false);
  assert.equal(response.record.statusCode, 403);
  assert.equal(response.record.body.code, 'WORKSPACE_OPERATION_DENIED');
  assert.equal(req.userId, 8);
});

test('workspace chưa có đủ assignment bị từ chối', async () => {
  const pendingRows = rows();
  pendingRows[1] = { ...pendingRows[1], property_ids: [] };
  const middleware = requireWorkspace('any', {
    query: async () => ({ rows: pendingRows })
  });
  const req = request(8, '7');
  const response = responseRecorder();
  await middleware(req, response.res, () => assert.fail('Không được gọi next'));
  assert.equal(response.record.statusCode, 403);
  assert.equal(response.record.body.code, 'WORKSPACE_ACCESS_DENIED');
});

test('giao diện workspace dịch nhãn nghiệp vụ và ẩn lối ghi ngoài phạm vi', () => {
  const root = path.join(__dirname, '..', '..');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  assert.match(html, /id="workspace-select"/);
  assert.match(html, /id="workspace-access-banner"/);
  assert.match(app, /rooms: 'Phòng và khách thuê'/);
  assert.match(app, /enterAllMeters\.hidden = staffWorkspace && !hasWorkspaceOperation\('meters'\)/);
  assert.match(app, /if \(!isOwnerWorkspace\(\)\) return;/);
  assert.match(app, /Không gian nhân viên hiện chỉ cho phép xem/);
  assert.match(css, /\[hidden\] \{ display: none !important; \}/);
});
