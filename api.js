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

  function getPlans() {
    return request('GET', '/api/plans');
  }

  function createSubscriptionOrder(planCode, billingCycle) {
    return request('POST', '/api/subscription/orders', { planCode, billingCycle });
  }

  function getSubscriptionPayments(limit = 30) {
    return request(
      'GET',
      `/api/subscription/payments?limit=${encodeURIComponent(limit)}`
    );
  }

  function getSubscriptionReceipt(paymentId) {
    return request(
      'GET',
      `/api/subscription/payments/${encodeURIComponent(paymentId)}/receipt`
    );
  }

  function createSubscriptionRefundRequest(paymentId, input) {
    return request(
      'POST',
      `/api/subscription/payments/${encodeURIComponent(paymentId)}/refund-requests`,
      input
    );
  }

  function cancelSubscriptionRefundRequest(requestId) {
    return request(
      'POST',
      `/api/subscription/refund-requests/${encodeURIComponent(requestId)}/cancel`
    );
  }

  function getRentPaymentSummaries(period = '') {
    const query = period ? `?period=${encodeURIComponent(period)}` : '';
    return request('GET', `/api/rent-payments/summary${query}`);
  }

  function settleRentInvoice(input) {
    return request('POST', '/api/rent-payments/settle', input);
  }

  function syncRentInvoices(entries) {
    return request('POST', '/api/rent-payments/sync', { entries });
  }

  function migrateLegacyRentPayments(entries) {
    return request('POST', '/api/rent-payments/migrate-legacy', { entries });
  }

  function getRentPaymentTransactions(invoiceId) {
    return request(
      'GET',
      `/api/rent-payments/invoices/${encodeURIComponent(invoiceId)}/transactions`
    );
  }

  function reverseRentPaymentTransaction(transactionId, reason) {
    return request(
      'POST',
      `/api/rent-payments/transactions/${encodeURIComponent(transactionId)}/reverse`,
      { reason }
    );
  }

  function getTenantDeposit(tenantId) {
    return request(
      'GET',
      `/api/deposits/tenants/${encodeURIComponent(tenantId)}`
    );
  }

  function createDepositTransaction(input) {
    return request('POST', '/api/deposits/transactions', input);
  }

  function reverseDepositTransaction(transactionId, reason) {
    return request(
      'POST',
      `/api/deposits/transactions/${encodeURIComponent(transactionId)}/reverse`,
      { reason }
    );
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
    startSubscriptionTrial: (id, input) => request(
      'POST',
      `/api/admin/users/${id}/subscription/trial`,
      input
    ),
    changeSubscription: (id, input) => request(
      'POST',
      `/api/admin/users/${id}/subscription/change`,
      input
    ),
    listManualSubscriptionChangeLogs: (limit = 100) => request(
      'GET',
      `/api/admin/subscription/manual-change-logs?limit=${encodeURIComponent(limit)}`
    ),
    revealTenantCccd: (userId, tenantId, reason) => request(
      'POST',
      `/api/admin/users/${userId}/tenants/${encodeURIComponent(tenantId)}/reveal-cccd`,
      { reason }
    ),
    listSensitiveAccessLogs: (limit = 100) => request(
      'GET',
      `/api/admin/sensitive-access-logs?limit=${encodeURIComponent(limit)}`
    ),
    getConfig: () => request('GET', '/api/admin/config'),
    setConfig: (cfg) => request('PUT', '/api/admin/config', cfg),
    setSubscriptionPaymentConfig: (cfg) => request(
      'PUT',
      '/api/admin/config/subscription-payment',
      cfg
    ),
    listPlans: () => request('GET', '/api/admin/plans'),
    updatePlan: (code, changes) => request(
      'PUT',
      `/api/admin/plans/${encodeURIComponent(code)}`,
      changes
    ),
    listSubscriptionRefundRequests: (status = 'active') => request(
      'GET',
      `/api/admin/subscription/refund-requests?status=${encodeURIComponent(status)}`
    ),
    transitionSubscriptionRefundRequest: (requestId, input) => request(
      'POST',
      `/api/admin/subscription/refund-requests/${encodeURIComponent(requestId)}/transition`,
      input
    ),
    getRevenueSummary: () => request('GET', '/api/admin/revenue/summary')
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
    getPlans,
    createSubscriptionOrder,
    getSubscriptionPayments,
    getSubscriptionReceipt,
    createSubscriptionRefundRequest,
    cancelSubscriptionRefundRequest,
    getRentPaymentSummaries,
    settleRentInvoice,
    syncRentInvoices,
    migrateLegacyRentPayments,
    getRentPaymentTransactions,
    reverseRentPaymentTransaction,
    getTenantDeposit,
    createDepositTransaction,
    reverseDepositTransaction,
    privacy,
    getConfig,
    admin
  };
})();
