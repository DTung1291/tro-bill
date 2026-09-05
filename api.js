/**
 * TrọBill — api.js
 * Lớp giao tiếp với backend: phiên đăng nhập bằng cookie HttpOnly + gọi REST.
 * Cùng origin với server nên dùng đường dẫn tương đối.
 */
'use strict';

const API = (() => {
  const LEGACY_TOKEN_KEY = 'trobill_token';
  let sessionActive = false;
  let accountContext = '';
  let workspaceAccountId = null;
  let sessionMismatchHandler = null;
  let sessionMismatchNotified = false;

  // JWT của phiên bản cũ không còn được sử dụng. Xóa ngay để token không tiếp
  // tục nằm trong vùng JavaScript có thể đọc sau khi người dùng nâng cấp.
  try {
    localStorage.removeItem(LEGACY_TOKEN_KEY);
  } catch (_) {}

  function clearSession() {
    sessionActive = false;
    accountContext = '';
    workspaceAccountId = null;
    sessionMismatchNotified = false;
  }

  function isLoggedIn() {
    return sessionActive;
  }

  function getAccountContext() {
    return accountContext;
  }

  function getWorkspaceAccountId() {
    return workspaceAccountId;
  }

  function setWorkspaceAccountId(value) {
    const id = Number(value);
    workspaceAccountId = Number.isSafeInteger(id) && id > 0 ? id : null;
    return workspaceAccountId;
  }

  function adoptSession(session) {
    const nextContext = String(session && session.accountContext || '');
    if (!/^[a-f0-9]{64}$/i.test(nextContext)) {
      clearSession();
      throw new Error('Máy chủ không trả về định danh phiên hợp lệ');
    }
    accountContext = nextContext;
    workspaceAccountId = null;
    sessionActive = true;
    sessionMismatchNotified = false;
    return session;
  }

  function onSessionMismatch(handler) {
    sessionMismatchHandler = typeof handler === 'function' ? handler : null;
  }

  async function request(method, url, body) {
    const headers = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    // /api/me luôn phải đọc được cookie hiện tại để phát hiện một tab khác đã
    // đổi tài khoản. Mọi API còn lại đều được ràng buộc với accountContext.
    if (url !== '/api/me' && accountContext) {
      headers['X-Trobill-Account-Context'] = accountContext;
    }
    if (workspaceAccountId && url !== '/api/workspaces') {
      headers['X-Trobill-Workspace-Account-Id'] = String(workspaceAccountId);
    }

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
      if (err.errorCode === 'SESSION_ACCOUNT_CHANGED' && !sessionMismatchNotified) {
        sessionActive = false;
        sessionMismatchNotified = true;
        Promise.resolve().then(() => sessionMismatchHandler && sessionMismatchHandler(err));
      }
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
    return adoptSession(await request('POST', '/api/auth/login', { email, password }));
  }
  async function verifyEmail(token) {
    return adoptSession(await request('POST', '/api/auth/verify-email', { token }));
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

  function getProperties() {
    return request('GET', '/api/properties');
  }

  function createProperty(input) {
    return request('POST', '/api/properties', input);
  }

  function updateProperty(id, input) {
    return request('PATCH', `/api/properties/${encodeURIComponent(id)}`, input);
  }

  function deleteProperty(id) {
    return request('DELETE', `/api/properties/${encodeURIComponent(id)}`);
  }

  function getRentBankAccounts() {
    return request('GET', '/api/rent-bank-accounts');
  }

  function createRentBankAccount(input) {
    return request('POST', '/api/rent-bank-accounts', input);
  }

  function updateRentBankAccount(id, input) {
    return request('PATCH', `/api/rent-bank-accounts/${encodeURIComponent(id)}`, input);
  }

  function deleteRentBankAccount(id) {
    return request('DELETE', `/api/rent-bank-accounts/${encodeURIComponent(id)}`);
  }

  function assignPropertyRentBankAccount(propertyId, bankAccountId) {
    return request(
      'PATCH',
      `/api/properties/${encodeURIComponent(propertyId)}/rent-bank-account`,
      { bankAccountId: bankAccountId ?? null }
    );
  }

  function getTeamMembers() {
    return request('GET', '/api/team/members');
  }

  function createTeamMember(input) {
    return request('POST', '/api/team/members', input);
  }

  function updateTeamMember(id, input) {
    return request('PATCH', `/api/team/members/${encodeURIComponent(id)}`, input);
  }

  function deleteTeamMember(id) {
    return request('DELETE', `/api/team/members/${encodeURIComponent(id)}`);
  }

  function updateTeamMemberAccess(id, input) {
    return request('PUT', `/api/team/members/${encodeURIComponent(id)}/access`, input);
  }

  function getWorkspaces() {
    return request('GET', '/api/workspaces');
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

  function getRentPaymentChannels() {
    return request('GET', '/api/rent-payment-channels');
  }

  function createSepayRentPaymentChannel(expectedAccountNumber, bankAccountId = null) {
    return request('POST', '/api/rent-payment-channels/sepay', {
      expectedAccountNumber,
      bankAccountId
    });
  }

  function rotateRentPaymentChannelSecret(channelId) {
    return request(
      'POST',
      `/api/rent-payment-channels/${encodeURIComponent(channelId)}/rotate-secret`,
      {}
    );
  }

  function setRentPaymentChannelStatus(channelId, active) {
    return request(
      'PATCH',
      `/api/rent-payment-channels/${encodeURIComponent(channelId)}/status`,
      { active: !!active }
    );
  }

  function updateRentPaymentChannelAccount(channelId, expectedAccountNumber) {
    return request(
      'PATCH',
      `/api/rent-payment-channels/${encodeURIComponent(channelId)}/account`,
      { expectedAccountNumber }
    );
  }

  function getRentBankTransactions(status = 'pending', limit = 50) {
    return request(
      'GET',
      `/api/rent-bank-transactions?status=${encodeURIComponent(status)}&limit=${encodeURIComponent(limit)}`
    );
  }

  function matchRentBankTransaction(transactionId, invoiceId, note = '') {
    return request(
      'POST',
      `/api/rent-bank-transactions/${encodeURIComponent(transactionId)}/match`,
      { invoiceId, note }
    );
  }

  function ignoreRentBankTransaction(transactionId, reason) {
    return request(
      'POST',
      `/api/rent-bank-transactions/${encodeURIComponent(transactionId)}/ignore`,
      { reason }
    );
  }

  function createRentInvoiceShareLink(invoiceId, expiresInHours) {
    return request(
      'POST',
      `/api/rent-invoices/${encodeURIComponent(invoiceId)}/share-links`,
      { expiresInHours }
    );
  }

  function deliverRentInvoiceEmail(invoiceId, input) {
    return request(
      'POST',
      `/api/rent-invoices/${encodeURIComponent(invoiceId)}/deliver-email`,
      input
    );
  }

  function scheduleRentInvoiceEmail(invoiceId, input) {
    return request(
      'POST',
      `/api/rent-invoices/${encodeURIComponent(invoiceId)}/delivery-schedules`,
      input
    );
  }

  function getRentInvoiceDeliverySchedules(invoiceId) {
    return request(
      'GET',
      `/api/rent-invoices/${encodeURIComponent(invoiceId)}/delivery-schedules`
    );
  }

  function cancelRentInvoiceDeliverySchedule(scheduleId) {
    return request(
      'POST',
      `/api/rent-invoice-delivery-schedules/${encodeURIComponent(scheduleId)}/cancel`
    );
  }

  function retryRentInvoiceDeliverySchedule(scheduleId) {
    return request(
      'POST',
      `/api/rent-invoice-delivery-schedules/${encodeURIComponent(scheduleId)}/retry`
    );
  }

  function getRentInvoiceShareLinks(invoiceId) {
    return request(
      'GET',
      `/api/rent-invoices/${encodeURIComponent(invoiceId)}/share-links`
    );
  }

  function revokeRentInvoiceShareLink(linkId) {
    return request(
      'POST',
      `/api/rent-invoice-share-links/${encodeURIComponent(linkId)}/revoke`
    );
  }

  function getRentInvoicePaymentProofs(invoiceId) {
    return request(
      'GET',
      `/api/rent-invoices/${encodeURIComponent(invoiceId)}/payment-proofs`
    );
  }

  function upsertRentMeterPhoto(input) {
    return request('POST', '/api/rent-meter-photos', input);
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

  function getRentalContracts(roomId = '') {
    const query = roomId ? `?roomId=${encodeURIComponent(roomId)}` : '';
    return request('GET', `/api/rental-contracts${query}`);
  }

  function createRentalContract(input) {
    return request('POST', '/api/rental-contracts', input);
  }

  function changeRentalContractStatus(contractId, input) {
    return request(
      'POST',
      `/api/rental-contracts/${encodeURIComponent(contractId)}/status`,
      input
    );
  }

  function createRentalContractAmendment(contractId, input) {
    return request(
      'POST',
      `/api/rental-contracts/${encodeURIComponent(contractId)}/amendments`,
      input
    );
  }

  function getRentalContractDocument(contractId, purpose) {
    return request(
      'POST',
      `/api/rental-contracts/${encodeURIComponent(contractId)}/document`,
      { purpose }
    );
  }

  function getRentalHandovers(contractId) {
    return request(
      'GET',
      `/api/rental-contracts/${encodeURIComponent(contractId)}/handovers`
    );
  }

  function createRentalHandover(contractId, input) {
    return request(
      'POST',
      `/api/rental-contracts/${encodeURIComponent(contractId)}/handovers`,
      input
    );
  }

  function getRentalLifecycle(roomId) {
    return request('GET', `/api/rental-lifecycle?roomId=${encodeURIComponent(roomId)}`);
  }

  function createRentalReservation(input) {
    return request('POST', '/api/rental-reservations', input);
  }

  function cancelRentalReservation(reservationId, input) {
    return request(
      'POST',
      `/api/rental-reservations/${encodeURIComponent(reservationId)}/cancel`,
      input
    );
  }

  function transferRentalContract(contractId, input) {
    return request(
      'POST',
      `/api/rental-contracts/${encodeURIComponent(contractId)}/transfer`,
      input
    );
  }

  function checkoutRentalContract(contractId, input) {
    return request(
      'POST',
      `/api/rental-contracts/${encodeURIComponent(contractId)}/checkout`,
      input
    );
  }

  function getRentalFinalSettlement(contractId) {
    return request(
      'GET',
      `/api/rental-contracts/${encodeURIComponent(contractId)}/final-settlement`
    );
  }

  function createRentalFinalSettlement(contractId, input) {
    return request(
      'POST',
      `/api/rental-contracts/${encodeURIComponent(contractId)}/final-settlement`,
      input
    );
  }

  function getTenantMaintenancePortals(contractId) {
    return request(
      'GET',
      `/api/rental-contracts/${encodeURIComponent(contractId)}/maintenance-portals`
    );
  }

  function issueTenantMaintenancePortal(contractId, expiresInDays) {
    return request(
      'POST',
      `/api/rental-contracts/${encodeURIComponent(contractId)}/maintenance-portals`,
      { expiresInDays }
    );
  }

  function revokeTenantMaintenancePortal(portalId) {
    return request(
      'POST',
      `/api/tenant-maintenance-portals/${encodeURIComponent(portalId)}/revoke`
    );
  }

  function getTenantMaintenanceRequests(contractId) {
    return request(
      'GET',
      `/api/rental-contracts/${encodeURIComponent(contractId)}/maintenance-requests`
    );
  }

  function getRoomMaintenance() {
    return request('GET', '/api/room-maintenance');
  }

  function createRoomMaintenance(input) {
    return request('POST', '/api/room-maintenance', input);
  }

  function completeRoomMaintenance(maintenanceId, input) {
    return request(
      'POST',
      `/api/room-maintenance/${encodeURIComponent(maintenanceId)}/complete`,
      input
    );
  }

  function getRoomAssets(roomId = '', status = 'active') {
    const params = new URLSearchParams();
    if (roomId) params.set('roomId', roomId);
    if (status) params.set('status', status);
    const query = params.toString();
    return request('GET', `/api/room-assets${query ? `?${query}` : ''}`);
  }

  function createRoomAsset(input) {
    return request('POST', '/api/room-assets', input);
  }

  function updateRoomAsset(assetId, input) {
    return request('PATCH', `/api/room-assets/${encodeURIComponent(assetId)}`, input);
  }

  function archiveRoomAsset(assetId, reason) {
    return request(
      'POST',
      `/api/room-assets/${encodeURIComponent(assetId)}/archive`,
      { reason }
    );
  }

  function restoreRoomAsset(assetId, roomId = '') {
    return request(
      'POST',
      `/api/room-assets/${encodeURIComponent(assetId)}/restore`,
      { roomId: roomId || null }
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
    getAccountContext,
    getWorkspaceAccountId,
    setWorkspaceAccountId,
    adoptSession,
    onSessionMismatch,
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
    getProperties,
    createProperty,
    updateProperty,
    deleteProperty,
    getRentBankAccounts,
    createRentBankAccount,
    updateRentBankAccount,
    deleteRentBankAccount,
    assignPropertyRentBankAccount,
    getTeamMembers,
    createTeamMember,
    updateTeamMember,
    deleteTeamMember,
    updateTeamMemberAccess,
    getWorkspaces,
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
    getRentPaymentChannels,
    createSepayRentPaymentChannel,
    rotateRentPaymentChannelSecret,
    setRentPaymentChannelStatus,
    updateRentPaymentChannelAccount,
    getRentBankTransactions,
    matchRentBankTransaction,
    ignoreRentBankTransaction,
    createRentInvoiceShareLink,
    deliverRentInvoiceEmail,
    scheduleRentInvoiceEmail,
    getRentInvoiceDeliverySchedules,
    cancelRentInvoiceDeliverySchedule,
    retryRentInvoiceDeliverySchedule,
    getRentInvoiceShareLinks,
    revokeRentInvoiceShareLink,
    getRentInvoicePaymentProofs,
    upsertRentMeterPhoto,
    getTenantDeposit,
    createDepositTransaction,
    reverseDepositTransaction,
    getRentalContracts,
    createRentalContract,
    changeRentalContractStatus,
    createRentalContractAmendment,
    getRentalContractDocument,
    getRentalHandovers,
    createRentalHandover,
    getRentalLifecycle,
    createRentalReservation,
    cancelRentalReservation,
    transferRentalContract,
    checkoutRentalContract,
    getRentalFinalSettlement,
    createRentalFinalSettlement,
    getTenantMaintenancePortals,
    issueTenantMaintenancePortal,
    revokeTenantMaintenancePortal,
    getTenantMaintenanceRequests,
    getRoomMaintenance,
    createRoomMaintenance,
    completeRoomMaintenance,
    getRoomAssets,
    createRoomAsset,
    updateRoomAsset,
    archiveRoomAsset,
    restoreRoomAsset,
    privacy,
    getConfig,
    admin
  };
})();
