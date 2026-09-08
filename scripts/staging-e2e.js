#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');

const CONFIRMATION = 'I_ACKNOWLEDGE_THIS_IS_A_DEDICATED_STAGING_ACCOUNT';
const REQUEST_TIMEOUT_MS = 20_000;

function requiredEnvironment(name, environment = process.env) {
  const value = String(environment[name] || '').trim();
  if (!value) throw new Error(`Thiếu biến môi trường ${name}`);
  return value;
}

function validateTarget(rawUrl, environment = process.env) {
  let url;
  try {
    url = new URL(String(rawUrl || '').trim());
  } catch {
    throw new Error('STAGING_BASE_URL không hợp lệ');
  }

  if (url.username || url.password || url.search || url.hash) {
    throw new Error('STAGING_BASE_URL không được chứa credential, query hoặc fragment');
  }
  if (url.pathname !== '/' && url.pathname !== '') {
    throw new Error('STAGING_BASE_URL phải là origin, không kèm path');
  }

  const hostname = url.hostname.toLowerCase();
  if (hostname === 'tro-bill.vercel.app' || hostname.endsWith('.tro-bill.vercel.app')) {
    throw new Error('Từ chối chạy E2E trên production');
  }

  const localTarget = hostname === 'localhost' || hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(localTarget && environment.ALLOW_LOCAL_E2E === 'true')) {
    throw new Error('Staging E2E chỉ chấp nhận HTTPS; localhost cần ALLOW_LOCAL_E2E=true');
  }

  return url.origin;
}

function validateDedicatedAccount(email, environment = process.env) {
  if (environment.STAGING_E2E_CONFIRMATION !== CONFIRMATION) {
    throw new Error('Thiếu xác nhận tài khoản staging chuyên dụng');
  }
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized.includes('@')) throw new Error('STAGING_E2E_EMAIL không hợp lệ');
  return normalized;
}

function extractSessionCookie(headers) {
  const values = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie()
    : [headers.get('set-cookie') || ''];
  for (const value of values) {
    const match = String(value).match(/(?:^|[,;]\s*)trobill_session=([^;,\s]+)/i);
    if (match) return `trobill_session=${match[1]}`;
  }
  throw new Error('Đăng nhập không trả cookie phiên TrọBill');
}

function safeResponseCode(body) {
  if (!body || typeof body !== 'object') return '';
  return String(body.code || body.error || '').slice(0, 160);
}

async function run(environment = process.env, fetchImpl = fetch) {
  const baseUrl = validateTarget(requiredEnvironment('STAGING_BASE_URL', environment), environment);
  const email = validateDedicatedAccount(requiredEnvironment('STAGING_E2E_EMAIL', environment), environment);
  const password = requiredEnvironment('STAGING_E2E_PASSWORD', environment);
  const secondaryEmail = validateDedicatedAccount(
    requiredEnvironment('STAGING_E2E_EMAIL_B', environment),
    environment
  );
  const secondaryPassword = requiredEnvironment('STAGING_E2E_PASSWORD_B', environment);
  if (secondaryEmail === email) throw new Error('Hai tài khoản staging E2E phải khác nhau');
  const bypassSecret = String(environment.VERCEL_AUTOMATION_BYPASS_SECRET || '').trim();
  const marker = `E2E-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${crypto.randomUUID()}`;
  let sessionCookie = '';
  let accountContext = '';

  async function request(path, options = {}) {
    const method = options.method || 'GET';
    const requestCookie = options.sessionCookie === undefined
      ? sessionCookie
      : options.sessionCookie;
    const requestContext = options.accountContext === undefined
      ? accountContext
      : options.accountContext;
    const headers = {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(requestCookie ? { Cookie: requestCookie } : {}),
      ...(requestContext ? { 'X-Trobill-Account-Context': requestContext } : {}),
      ...(method !== 'GET' && method !== 'HEAD' ? { Origin: baseUrl } : {}),
      ...(bypassSecret ? {
        'x-vercel-protection-bypass': bypassSecret
      } : {})
    };
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method,
      headers,
      body: options.body ? JSON.stringify(options.body) : undefined,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    let body = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!options.expectedStatuses.includes(response.status)) {
      const suffix = safeResponseCode(body);
      throw new Error(`${method} ${path} trả HTTP ${response.status}${suffix ? ` (${suffix})` : ''}`);
    }
    return { response, body };
  }

  async function loginAccount(accountEmail, accountPassword) {
    const login = await request('/api/auth/login', {
      method: 'POST',
      body: { email: accountEmail, password: accountPassword },
      sessionCookie: '',
      accountContext: '',
      expectedStatuses: [200]
    });
    const cookie = extractSessionCookie(login.response.headers);
    const context = String(login.body?.accountContext || '');
    if (!/^[a-f0-9]{64}$/.test(context)) {
      throw new Error(`Đăng nhập ${accountEmail} không trả account context hợp lệ`);
    }
    const me = await request('/api/me', {
      sessionCookie: cookie,
      accountContext: '',
      expectedStatuses: [200]
    });
    if (String(me.body?.email || '').toLowerCase() !== accountEmail
        || me.body?.accountContext !== context) {
      throw new Error(`Phiên staging không khớp tài khoản ${accountEmail}`);
    }
    return { cookie, context };
  }

  const health = await request('/api/health/ready', { expectedStatuses: [200, 503] });
  if (health.body?.environment !== 'staging') {
    throw new Error(`Từ chối chạy: health environment là ${health.body?.environment || 'không xác định'}`);
  }
  if (health.response.status !== 200
      || health.body?.checks?.database !== 'ok'
      || health.body?.checks?.schema !== 'ok') {
    const missing = Array.isArray(health.body?.checks?.missingMigrations)
      ? health.body.checks.missingMigrations.join(', ')
      : '';
    throw new Error(`Staging chưa sẵn sàng: database hoặc schema không đạt${
      missing ? `; cần ${missing}` : ''
    }`);
  }

  const primaryAccount = await loginAccount(email, password);
  sessionCookie = primaryAccount.cookie;
  accountContext = primaryAccount.context;

  let primaryError = null;
  try {
    const created = await request('/api/properties', {
      method: 'POST',
      body: {
        name: marker,
        address: 'Dữ liệu giả lập kiểm thử staging',
        note: 'Tự động xóa sau khi kiểm thử'
      },
      expectedStatuses: [201]
    });
    if (created.body?.property?.name !== marker || !created.body?.property?.id) {
      throw new Error('API tạo khu không trả đúng dữ liệu E2E');
    }

    const listed = await request('/api/properties', { expectedStatuses: [200] });
    if (!listed.body?.properties?.some((property) => property.name === marker)) {
      throw new Error('Không đọc lại được dữ liệu E2E vừa tạo');
    }

    const secondaryAccount = await loginAccount(secondaryEmail, secondaryPassword);
    const secondaryProperties = await request('/api/properties', {
      sessionCookie: secondaryAccount.cookie,
      accountContext: secondaryAccount.context,
      expectedStatuses: [200]
    });
    if ((secondaryProperties.body?.properties || []).some((property) => property.name === marker)) {
      throw new Error('Tài khoản B nhìn thấy dữ liệu vừa tạo bởi tài khoản A');
    }

    const staleTab = await request('/api/properties', {
      sessionCookie: secondaryAccount.cookie,
      accountContext: primaryAccount.context,
      expectedStatuses: [409]
    });
    if (staleTab.body?.code !== 'SESSION_ACCOUNT_CHANGED') {
      throw new Error('Server không chặn cookie tài khoản B dùng account context của A');
    }

    const primaryAfterSwitch = await request('/api/properties', {
      sessionCookie: primaryAccount.cookie,
      accountContext: primaryAccount.context,
      expectedStatuses: [200]
    });
    if (!(primaryAfterSwitch.body?.properties || []).some((property) => property.name === marker)) {
      throw new Error('Cookie tài khoản A không còn đọc đúng dữ liệu sau khi đăng nhập B');
    }
  } catch (error) {
    primaryError = error;
  }

  let cleanupError = null;
  try {
    const listed = await request('/api/properties', { expectedStatuses: [200] });
    const matches = (listed.body?.properties || []).filter((property) => (
      property.name === marker && property.isDefault !== true
    ));
    for (const property of matches) {
      await request(`/api/properties/${encodeURIComponent(property.id)}`, {
        method: 'DELETE',
        expectedStatuses: [200]
      });
    }
    const afterCleanup = await request('/api/properties', { expectedStatuses: [200] });
    if ((afterCleanup.body?.properties || []).some((property) => property.name === marker)) {
      throw new Error('Cleanup chưa xóa hết dữ liệu E2E');
    }
  } catch (error) {
    cleanupError = error;
  }

  if (primaryError && cleanupError) {
    throw new Error(`${primaryError.message}; cleanup lỗi: ${cleanupError.message}`);
  }
  if (primaryError) throw primaryError;
  if (cleanupError) throw cleanupError;

  return {
    ok: true,
    environment: health.body.environment,
    revision: health.body.revision,
    checks: [
      'health',
      'login-cookie',
      'account-context',
      'two-account-isolation',
      'stale-tab-block',
      'property-write-read-cleanup'
    ]
  };
}

if (require.main === module) {
  run()
    .then((result) => {
      process.stdout.write(`Staging E2E thành công (${result.revision || 'revision không xác định'}): ${result.checks.join(', ')}\n`);
    })
    .catch((error) => {
      process.stderr.write(`Staging E2E thất bại: ${error.message}\n`);
      process.exitCode = 1;
    });
}

module.exports = {
  CONFIRMATION,
  extractSessionCookie,
  run,
  validateDedicatedAccount,
  validateTarget
};
