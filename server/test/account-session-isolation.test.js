'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..', '..');

test('API client gắn account context vào request dữ liệu nhưng vẫn cho /api/me kiểm tra cookie mới', async () => {
  const accountContext = 'a'.repeat(64);
  const calls = [];
  const responses = [
    { ok: true, status: 200, body: { email: 'a@example.com', isAdmin: false, accountContext } },
    { ok: true, status: 200, body: { ok: true } },
    { ok: true, status: 200, body: { email: 'b@example.com', isAdmin: false, accountContext: 'b'.repeat(64) } }
  ];
  const context = {
    console,
    Promise,
    encodeURIComponent,
    localStorage: { removeItem() {} },
    fetch: async (url, options) => {
      calls.push({ url, options });
      const response = responses.shift();
      return {
        ok: response.ok,
        status: response.status,
        json: async () => response.body
      };
    }
  };
  vm.createContext(context);
  const apiSource = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  vm.runInContext(`${apiSource}\n;globalThis.__API = API;`, context);
  const api = context.__API;

  await api.login('a@example.com', 'password');
  assert.equal(api.getAccountContext(), accountContext);
  await api.putState({ rooms: [] });
  assert.equal(
    calls[1].options.headers['X-Trobill-Account-Context'],
    accountContext,
    'request dữ liệu phải được khóa vào tài khoản đã nạp trong tab'
  );

  await api.me();
  assert.equal(
    Object.hasOwn(calls[2].options.headers, 'X-Trobill-Account-Context'),
    false,
    '/api/me phải đọc được phiên cookie mới để phát hiện đổi tài khoản'
  );
});

test('API client dừng phiên ngay khi server phát hiện tab cũ', async () => {
  const accountContext = 'a'.repeat(64);
  let mismatchError = null;
  const context = {
    console,
    Promise,
    encodeURIComponent,
    localStorage: { removeItem() {} },
    fetch: async (url) => {
      if (url === '/api/auth/login') {
        return {
          ok: true,
          status: 200,
          json: async () => ({ email: 'a@example.com', accountContext })
        };
      }
      return {
        ok: false,
        status: 409,
        json: async () => ({
          error: 'Tài khoản của tab đã thay đổi.',
          code: 'SESSION_ACCOUNT_CHANGED'
        })
      };
    }
  };
  vm.createContext(context);
  const apiSource = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  vm.runInContext(`${apiSource}\n;globalThis.__API = API;`, context);
  const api = context.__API;
  api.onSessionMismatch((error) => { mismatchError = error; });

  await api.login('a@example.com', 'password');
  await assert.rejects(api.putState({ rooms: [] }), /Tài khoản của tab/);
  await Promise.resolve();

  assert.equal(api.isLoggedIn(), false);
  assert.equal(mismatchError.errorCode, 'SESSION_ACCOUNT_CHANGED');
});

test('giao diện hủy autosave và đồng bộ thay đổi phiên giữa các tab', () => {
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.match(appSource, /new BroadcastChannel\(AUTH_CHANNEL_NAME\)/);
  assert.match(appSource, /cancelPendingStateSave\(\);[\s\S]*API\.clearSession\(\);[\s\S]*clearSensitiveStateFromMemory\(\)/);
  assert.match(appSource, /expectedGeneration !== _sessionGeneration/);
});

test('giao diện xếp hàng PUT state để snapshot cũ không ghi đè snapshot mới', () => {
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.match(appSource, /let _saveInFlight = null/);
  assert.match(appSource, /const previousSave = _saveInFlight/);
  assert.match(appSource, /if \(previousSave\)[\s\S]*await previousSave/);
  assert.match(appSource, /_saveInFlight = currentSave/);
  assert.match(appSource, /revision === _saveRevision/);
});
