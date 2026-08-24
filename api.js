/**
 * TrọBill — api.js
 * Lớp giao tiếp với backend: phiên đăng nhập bằng cookie HttpOnly + gọi REST.
 * Cùng origin với server nên dùng đường dẫn tương đối.
 */
'use strict';

const API = (() => {
  const LEGACY_TOKEN_KEY = 'trobill_token';
  let sessionActive = false;

  // JWT của phiên bản cũ không còn được sử dụng. Xóa ngay để token không tiếp
  // tục nằm trong vùng JavaScript có thể đọc sau khi người dùng nâng cấp.
  try {
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch (_) {}

  function clearSession() {
    sessionActive = false;
  }

  function isLoggedIn() {
    return sessionActive;
  }

  async function request(method, url, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        credentials: 'same-origin',
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      throw new Error('Không kết nối được máy chủ');
    }

    let data = null;
    try {
      data = await res.json();
    } catch (_) {
      data = null;
    }

    if (!res.ok) {
      if (res.status === 401) clearSession();
      const err = new Error((data && data.error) || 'Lỗi máy chủ');
      err.code = res.status;
      err.errorCode = data && data.code;
      throw err;
    }
    const doesNotCreateSession = [
      '/api/auth/register',
      '/api/auth/resend-verification',
      '/api/auth/forgot-password',
      '/api/auth/reset-password',
      '/api/auth/logout-all',
      '/api/auth/logout'
    ];
    if (!doesNotCreateSession.includes(url)) sessionActive = true;
    return data;
  }

  // ----- Auth -----
  async function register(email, password, acceptance = {}) {
    return request('POST', '/api/auth/register', {
      email,
      password,
      acceptPrivacy: acceptance.acceptPrivacy === true,
      acceptTerms: acceptance.acceptTerms === true
    });
  }
  async function login(email, password) {
    return request('POST', '/api/auth/login', { email, password });
  }
  async function verifyEmail(token) {
    return request('POST', '/api/auth/verify-email', { token });
  }
  async function resendVerification(email) {
    return request('POST', '/api/auth/resend-verification', { email });
  }
  async function forgotPassword(email) {
    return request('POST', '/api/auth/forgot-password', { email });
  }
  async function resetPassword(token, password) {
    return request('POST', '/api/auth/reset-password', { token, password });
  }
  async function logout() {
    await request('POST', '/api/auth/logout');
    clearSession();
  }
  async function logoutAll() {
    await request('POST', '/api/auth/logout-all');
    clearSession();
  }

  // ----- State -----
  function getState() {
    return request('GET', '/api/state');
  }
  function putState(state) {
    return request('PUT', '/api/state', state);
  }

  function me() {
    return request('GET', '/api/me');
  }

  function getSubscription() {
    return request('GET', '/api/subscription');
  }

  const privacy = {
    getStatus: () => request('GET', '/api/privacy/status'),
    acceptPolicies: () => request('POST', '/api/privacy/accept', {
      acceptPrivacy: true,
      acceptTerms: true
    }),
    revealTenantCccd: (tenantId, purpose = 'view') => request(
      'POST',
      `/api/privacy/tenants/${encodeURIComponent(tenantId)}/reveal-cccd`,
      { purpose }
    ),
    listAuditLogs: (limit = 50) => request(
      'GET',
      `/api/privacy/audit-logs?limit=${encodeURIComponent(limit)}`
    ),
    exportData: (password) => request('POST', '/api/privacy/export', { password }),
    deleteAccount: async (password, confirmation) => {
      const result = await request('DELETE', '/api/account', { password, confirmation });
      clearSession();
      return result;
    }
  };

  // ----- Cấu hình toàn cục (ủng hộ) -----
  function getConfig() {
    return request('GET', '/api/config');
  }

  // ----- Admin -----
  const admin = {
    listUsers: () => request('GET', '/api/admin/users'),
    getUserState: (id) => request('GET', `/api/admin/users/${id}/state`),
    deleteUser: (id, reason) => request('DELETE', `/api/admin/users/${id}`, { reason }),
    resetPassword: (id, password) => request('POST', `/api/admin/users/${id}/password`, { password }),
    setAdmin: (id, isAdmin) => request('POST', `/api/admin/users/${id}/admin`, { isAdmin }),
    revealTenantCccd: (userId, tenantId, reason) => request(
      'POST',
      `/api/admin/users/${userId}/tenants/${encodeURIComponent(tenantId)}/reveal-cccd`,
      { reason }
    ),
    listSensitiveAccessLogs: (limit = 100) => request(
      'GET',
      `/api/admin/sensitive-access-logs?limit=${encodeURIComponent(limit)}`
    ),
    setConfig: (cfg) => request('PUT', '/api/admin/config', cfg)
  };

  return {
    clearSession,
    isLoggedIn,
    register,
    login,
    verifyEmail,
    resendVerification,
    forgotPassword,
    resetPassword,
    logout,
    logoutAll,
    getState,
    putState,
    me,
    getSubscription,
    privacy,
    getConfig,
    admin
  };
})();
