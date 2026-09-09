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
    {
      ok: true,
      status: 200,
      body: {
        accountUserId: 7,
        email: 'a@example.com',
        isAdmin: true,
        accountContext
      }
    },
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
  assert.equal(api.getSessionAccountId(), 7);
  assert.equal(api.getSessionEmail(), 'a@example.com');
  assert.equal(api.isSessionAdmin(), true);
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
  api.clearSession();
  assert.equal(api.getSessionAccountId(), null);
  assert.equal(api.getSessionEmail(), '');
  assert.equal(api.isSessionAdmin(), false);
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

test('reload khóa dashboard cho đến khi server xác nhận phiên đăng nhập', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

  assert.match(html, /id="auth-screen" class="auth-screen auth-screen--pending" aria-busy="true"/);
  assert.doesNotMatch(html, /id="auth-screen"[^>]*\shidden(?:\s|>)/);
  assert.match(html, /class="auth-loading" role="status" aria-live="polite"/);
  assert.match(styles, /\.auth-screen--pending \.auth-card\s*\{\s*display: none;/);
  assert.match(styles, /\.auth-screen--pending \.auth-loading\s*\{\s*display: flex;/);
  assert.match(appSource, /el\.classList\.remove\('auth-screen--pending'\);[\s\S]*el\.hidden = !show;/);
});

test('giao diện xếp hàng PUT state để snapshot cũ không ghi đè snapshot mới', () => {
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  assert.match(appSource, /let _saveInFlight = null/);
  assert.match(appSource, /const previousSave = _saveInFlight/);
  assert.match(appSource, /if \(previousSave\)[\s\S]*await previousSave/);
  assert.match(appSource, /_saveInFlight = currentSave/);
  assert.match(appSource, /revision === _saveRevision/);
});

test('khởi động owner bỏ vòng workspace và chuyển dữ liệu phụ sang nền có context guard', () => {
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const configureSource = appSource.slice(
    appSource.indexOf('async function configureWorkspace()'),
    appSource.indexOf('function workspacePageAllowed')
  );
  const startSource = appSource.slice(
    appSource.indexOf('async function startApp()'),
    appSource.indexOf('// Hiện nút vào trang quản trị')
  );
  const criticalPromise = startSource.slice(
    startSource.indexOf('const [serverState, entitlement, rentPaymentsResult, maintenanceResult]'),
    startSource.indexOf('if (expectedGeneration !== _sessionGeneration')
  );

  assert.match(configureSource, /API\.getSessionAccountId\(\)/);
  assert.match(configureSource, /WORKSPACES_NEED_REFRESH = true/);
  assert.match(configureSource, /if \(sessionOwnWorkspace &&/);
  assert.match(configureSource, /const result = await API\.getWorkspaces\(\)/);
  assert.match(criticalPromise, /API\.getState\(\)/);
  assert.match(criticalPromise, /API\.getSubscription\(\)/);
  assert.match(criticalPromise, /API\.getRentPaymentSummaries\(\)/);
  assert.match(criticalPromise, /API\.getRoomMaintenance\(\)/);
  assert.doesNotMatch(criticalPromise, /API\.getPlans|API\.getTeamMembers|API\.getRentBankAccounts/);
  assert.match(startSource, /document\.documentElement\.dataset\.appReady = 'true'/);
  assert.match(startSource, /window\.setTimeout\(\(\) => \{[\s\S]*loadDeferredWorkspaceData\(workspace, \{ isCurrent \}\)/);
  assert.match(startSource, /refreshWorkspaceDirectory\(\{ isCurrent \}\)/);
  assert.match(startSource, /expectedAccountContext === API\.getAccountContext\(\)/);
  assert.match(startSource, /expectedWorkspaceId === API\.getWorkspaceAccountId\(\)/);
});
