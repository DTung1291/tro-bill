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
      '/api/auth/logout'
    ];
    if (!doesNotCreateSession.includes(url)) sessionActive = true;
    return data;
  }

  // ----- Auth -----
  async function register(email, password) {
    return request('POST', '/api/auth/register', { email, password });
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
  async function logout() {
    await request('POST', '/api/auth/logout');
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

  // ----- Cấu hình toàn cục (ủng hộ) -----
  function getConfig() {
    return request('GET', '/api/config');
  }

  // ----- Admin -----
  const admin = {
    listUsers: () => request('GET', '/api/admin/users'),
    getUserState: (id) => request('GET', `/api/admin/users/${id}/state`),
    deleteUser: (id) => request('DELETE', `/api/admin/users/${id}`),
    resetPassword: (id, password) => request('POST', `/api/admin/users/${id}/password`, { password }),
    setAdmin: (id, isAdmin) => request('POST', `/api/admin/users/${id}/admin`, { isAdmin }),
    setConfig: (cfg) => request('PUT', '/api/admin/config', cfg)
  };

  return {
    clearSession,
    isLoggedIn,
    register,
    login,
    verifyEmail,
    resendVerification,
    logout,
    getState,
    putState,
    me,
    getConfig,
    admin
  };
})();
