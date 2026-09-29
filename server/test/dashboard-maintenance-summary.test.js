'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-dashboard-maintenance-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.NODE_ENV = 'test';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { summarizeMaintenanceWork } = require('../tenant-maintenance-requests');

function responseRecorder() {
  const record = { statusCode: 200, headers: {}, body: null };
  const res = {
    status(code) { record.statusCode = code; return res; },
    set(name, value) { record.headers[name] = value; return res; },
    json(body) { record.body = body; return res; }
  };
  return { record, res };
}

test('owner summary uses only open requests in own workspace without per-room limit', async () => {
  const { record, res } = responseRecorder();
  let captured;
  await summarizeMaintenanceWork(
    { userId: 7, actorUserId: 7, workspace: { isOwner: true } },
    res,
    { query: async (sql, params) => {
      captured = { sql, params };
      return { rows: [{ room_id: 'room-a', open_count: 101, unassigned_count: 3 }] };
    } }
  );
  assert.deepEqual(captured.params, [7]);
  assert.match(captured.sql, /request\.user_id=\$1/);
  assert.match(captured.sql, /room\.user_id=request\.user_id/);
  assert.match(captured.sql, /request\.status IN \('new', 'acknowledged', 'in_progress'\)/);
  assert.doesNotMatch(captured.sql, /LIMIT/);
  assert.equal(record.headers['Cache-Control'], 'no-store');
  assert.deepEqual(record.body, { rooms: [{ roomId: 'room-a', openCount: 101, unassignedCount: 3 }] });
});

test('staff summary requires both assigned member and allowed property', async () => {
  const { record, res } = responseRecorder();
  let captured;
  await summarizeMaintenanceWork(
    { userId: 7, actorUserId: 23, workspace: { isOwner: false, propertyIds: [4, 5] } },
    res,
    { query: async (sql, params) => {
      captured = { sql, params };
      return { rows: [{ room_id: 'room-a', open_count: 2, unassigned_count: 0 }] };
    } }
  );
  assert.deepEqual(captured.params, [7, [4, 5], 23]);
  assert.match(captured.sql, /room\.property_id=ANY\(\$2::bigint\[\]\)/);
  assert.match(captured.sql, /assignment\.member_user_id=\$3/);
  assert.deepEqual(record.body, { rooms: [{ roomId: 'room-a', openCount: 2, unassignedCount: 0 }] });
});

test('empty staff property scope remains fail-closed', async () => {
  const { res } = responseRecorder();
  let params;
  await summarizeMaintenanceWork(
    { userId: 7, actorUserId: 23, workspace: { isOwner: false, propertyIds: [] } },
    res,
    { query: async (_sql, input) => { params = input; return { rows: [] }; } }
  );
  assert.deepEqual(params, [7, [], 23]);
});

test('summary route is authenticated and requires rooms operation', () => {
  const server = fs.readFileSync(path.join(__dirname, '..', 'index.js'), 'utf8');
  assert.match(server, /'\/api\/tenant-maintenance-summary',[\s\S]*?requireAuth,[\s\S]*?requireWorkspace\('rooms'\)[\s\S]*?summarizeMaintenanceWork/);
});
