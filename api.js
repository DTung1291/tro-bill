/**
 * TrọBill — api.js
 * Lớp giao tiếp với backend: quản lý JWT + gọi REST.
 * Cùng origin với server nên dùng đường dẫn tương đối.
 */
'use strict';

const API = (() => {
  const TOKEN_KEY = 'trobill_token';

  function getToken() {
    return localStorage.getItem(TOKEN_KEY) || '';
  }
  function setToken(t) {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  }
  function isLoggedIn() {
    return !!getToken();
  }

  async function request(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    const token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;

    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
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

    // 401 khi ĐÃ gửi token = phiên hết hạn/không hợp lệ -> đăng xuất.
    // 401 khi CHƯA có token (vd đăng nhập sai) -> hiện thông báo thật của server.
    if (res.status === 401 && token) {
      setToken('');
      const err = new Error((data && data.error) || 'Phiên đăng nhập đã hết hạn');
      err.code = 401;
      throw err;
    }

    if (!res.ok) {
      const err = new Error((data && data.error) || 'Lỗi máy chủ');
      err.code = res.status;
      throw err;
    }
    return data;
  }

  // ----- Auth -----
  async function register(email, password) {
    const data = await request('POST', '/api/auth/register', { email, password });
    setToken(data.token);
    return data;
  }
  async function login(email, password) {
    const data = await request('POST', '/api/auth/login', { email, password });
    setToken(data.token);
    return data;
  }
  function logout() {
    setToken('');
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

  return { getToken, setToken, isLoggedIn, register, login, logout, getState, putState, me, getConfig, admin };
})();
