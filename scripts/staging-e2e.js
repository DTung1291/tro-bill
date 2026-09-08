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
  const bypassSecret = String(environment.VERCEL_AUTOMATION_BYPASS_SECRET || '').trim();
  const marker = `E2E-${new Date().toISOString().replace(/\D/g, '').slice(0, 14)}-${crypto.randomUUID()}`;
  let sessionCookie = '';
  let accountContext = '';

  async function request(path, options = {}) {
    const method = options.method || 'GET';
    const headers = {
      Accept: 'application/json',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(sessionCookie ? { Cookie: sessionCookie } : {}),
      ...(accountContext ? { 'X-Trobill-Account-Context': accountContext } : {}),
      ...(method !== 'GET' && method !== 'HEAD' ? { Origin: baseUrl } : {}),
      ...(bypassSecret ? {
        'x-vercel-protection-bypass': bypassSecret,
        'x-vercel-set-bypass-cookie': 'true'
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

  const health = await request('/api/health/ready', { expectedStatuses: [200] });
  if (health.body?.environment !== 'staging') {
    throw new Error(`Từ chối chạy: health environment là ${health.body?.environment || 'không xác định'}`);
  }
  if (health.body?.checks?.database !== 'ok' || health.body?.checks?.schema !== 'ok') {
    throw new Error('Staging chưa sẵn sàng: database hoặc schema không đạt');
  }

  const login = await request('/api/auth/login', {
    method: 'POST',
    body: { email, password },
    expectedStatuses: [200]
  });
  sessionCookie = extractSessionCookie(login.response.headers);
  accountContext = String(login.body?.accountContext || '');
  if (!/^[a-f0-9]{64}$/.test(accountContext)) {
    throw new Error('Đăng nhập không trả account context hợp lệ');
  }

  const me = await request('/api/me', { expectedStatuses: [200] });
  if (String(me.body?.email || '').toLowerCase() !== email
      || me.body?.accountContext !== accountContext) {
    throw new Error('Phiên staging không khớp tài khoản E2E đã cấu hình');
  }

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
    checks: ['health', 'login-cookie', 'account-context', 'property-write-read-cleanup']
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
