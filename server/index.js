'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const { inspectRuntimeEnvironment } = require('./environment');
const { live, ready } = require('./health');
const {
  reportOperationalError,
  requestObservability,
  requestRoute,
  writeLog
} = require('./observability');
const { enforceHttps, securityHeaders } = require('./security');
const {
  register,
  login,
  logout,
  logoutAll,
  verifyEmail,
  resendVerification,
  forgotPassword,
  resetPassword,
  requireAuth,
  requireAdmin
} = require('./auth');
const { getState, putState } = require('./state');
const admin = require('./admin');
const privacy = require('./privacy');
const {
  getAdminConfig,
  getConfig,
  setConfig,
  setSubscriptionPaymentConfig
} = require('./config');
const { seedAdmin } = require('./seed-admin');
const subscription = require('./subscription');
const { expiryReminderCron } = require('./subscription-notifications');
const plans = require('./plans');
const { createSubscriptionOrder } = require('./subscription-orders');
const { paymentWebhook } = require('./payment-webhook');
const paymentHistory = require('./subscription-payment-history');
const subscriptionRefunds = require('./subscription-refunds');
const adminRevenue = require('./admin-revenue');
const rentPayments = require('./rent-payments');
const deposits = require('./deposits');
const rentPaymentChannels = require('./rent-payment-channels');
const rentBankReconciliation = require('./rent-bank-reconciliation');
const rentInvoiceLinks = require('./rent-invoice-links');
const rentInvoiceDelivery = require('./rent-invoice-delivery');
const rentInvoiceSchedules = require('./rent-invoice-schedules');
const rentMeterPhotos = require('./rent-meter-photos');
const rentPaymentProofs = require('./rent-payment-proofs');
const rentalContracts = require('./rental-contracts');
const rentalContractNotifications = require('./rental-contract-notifications');

const app = express();
const PORT = process.env.PORT || 3000;

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(requestObservability);
app.use(securityHeaders);
app.use(enforceHttps);
app.use(express.json({
  limit: '5mb',
  verify(req, res, buffer) {
    if (req.originalUrl?.startsWith('/api/webhooks/subscription-payments/')) {
      req.rawBody = Buffer.from(buffer);
    }
  }
}));
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  next();
});

// Cookie tự được trình duyệt gửi kèm request, vì vậy chặn các request ghi dữ
// liệu đến từ website khác để giảm rủi ro CSRF. Client không phải trình duyệt
// có thể không gửi Origin/Sec-Fetch-Site và vẫn dùng được bình thường.
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  if (req.get('sec-fetch-site') === 'cross-site') {
    return res.status(403).json({ error: 'Nguồn yêu cầu không hợp lệ' });
  }

  const origin = req.get('origin');
  if (origin) {
    try {
      if (new URL(origin).host !== req.get('host')) {
        return res.status(403).json({ error: 'Nguồn yêu cầu không hợp lệ' });
      }
    } catch (_) {
      return res.status(403).json({ error: 'Nguồn yêu cầu không hợp lệ' });
    }
  }
  return next();
});

// bọc async handler để lỗi rơi vào middleware xử lý lỗi
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- API ----------
app.get('/api/health/live', live);
app.get('/api/health/ready', wrap(ready));
app.get('/api/cron/subscription-expiry', wrap(expiryReminderCron));
app.get('/api/cron/rent-invoice-deliveries', wrap(rentInvoiceSchedules.invoiceScheduleCron));
app.get(
  '/api/cron/rental-contract-expiry',
  wrap(rentalContractNotifications.rentalContractExpiryReminderCron)
);
app.post('/api/webhooks/subscription-payments/bank-transfer', wrap(paymentWebhook));
app.post('/api/auth/register', wrap(register));
app.post('/api/auth/login', wrap(login));
app.post('/api/auth/logout', logout);
app.post('/api/auth/logout-all', requireAuth, wrap(logoutAll));
app.post('/api/auth/verify-email', wrap(verifyEmail));
app.post('/api/auth/resend-verification', wrap(resendVerification));
app.post('/api/auth/forgot-password', wrap(forgotPassword));
app.post('/api/auth/reset-password', wrap(resetPassword));

app.get('/api/me', requireAuth, (req, res) => res.json({
  email: req.userEmail,
  isAdmin: !!req.isAdmin,
  accountContext: req.accountContext
}));
app.get('/api/subscription', requireAuth, wrap(subscription.getSubscription));
app.get('/api/subscription/payments', requireAuth, wrap(paymentHistory.listSubscriptionPayments));
app.get(
  '/api/subscription/payments/:id/receipt',
  requireAuth,
  wrap(paymentHistory.getSubscriptionReceipt)
);
app.post(
  '/api/subscription/payments/:paymentId/refund-requests',
  requireAuth,
  wrap(subscriptionRefunds.createRefundRequest)
);
app.post(
  '/api/subscription/refund-requests/:id/cancel',
  requireAuth,
  wrap(subscriptionRefunds.cancelRefundRequest)
);
app.get('/api/plans', requireAuth, wrap(plans.listPublicPlans));
app.post('/api/subscription/orders', requireAuth, wrap(createSubscriptionOrder));
app.get('/api/rent-payments/summary', requireAuth, wrap(rentPayments.listInvoiceSummaries));
app.post('/api/rent-payments/sync', requireAuth, wrap(rentPayments.syncInvoices));
app.post('/api/rent-payments/settle', requireAuth, wrap(rentPayments.settleInvoice));
app.post('/api/rent-payments/migrate-legacy', requireAuth, wrap(rentPayments.migrateLegacyPaid));
app.get(
  '/api/rent-payments/invoices/:invoiceId/transactions',
  requireAuth,
  wrap(rentPayments.listInvoiceTransactions)
);
app.post(
  '/api/rent-payments/transactions/:id/reverse',
  requireAuth,
  wrap(rentPayments.reverseTransaction)
);
app.post(
  '/api/rent-invoices/:invoiceId/share-links',
  requireAuth,
  wrap(rentInvoiceLinks.createInvoiceLink)
);
app.post(
  '/api/rent-invoices/:invoiceId/deliver-email',
  requireAuth,
  wrap(rentInvoiceDelivery.deliverInvoiceEmail)
);
app.post(
  '/api/rent-invoices/:invoiceId/delivery-schedules',
  requireAuth,
  wrap(rentInvoiceSchedules.createInvoiceSchedule)
);
app.get(
  '/api/rent-invoices/:invoiceId/delivery-schedules',
  requireAuth,
  wrap(rentInvoiceSchedules.listInvoiceSchedules)
);
app.post(
  '/api/rent-invoice-delivery-schedules/:id/cancel',
  requireAuth,
  wrap(rentInvoiceSchedules.cancelInvoiceSchedule)
);
app.post(
  '/api/rent-invoice-delivery-schedules/:id/retry',
  requireAuth,
  wrap(rentInvoiceSchedules.retryInvoiceSchedule)
);
app.get(
  '/api/rent-invoices/:invoiceId/share-links',
  requireAuth,
  wrap(rentInvoiceLinks.listInvoiceLinks)
);
app.post(
  '/api/rent-invoice-share-links/:id/revoke',
  requireAuth,
  wrap(rentInvoiceLinks.revokeInvoiceLink)
);
app.post(
  '/api/public/rent-invoice-links/resolve',
  wrap(rentInvoiceLinks.resolvePublicInvoiceLink)
);
app.post(
  '/api/public/rent-invoice-links/payment-proof',
  wrap(rentPaymentProofs.submitPublicPaymentProof)
);
app.get(
  '/api/rent-invoices/:invoiceId/payment-proofs',
  requireAuth,
  wrap(rentPaymentProofs.listInvoicePaymentProofs)
);
app.post(
  '/api/rent-meter-photos',
  requireAuth,
  wrap(rentMeterPhotos.upsertMeterPhoto)
);
app.get(
  '/api/rent-payment-channels',
  requireAuth,
  wrap(rentPaymentChannels.listChannels)
);
app.post(
  '/api/rent-payment-channels/sepay',
  requireAuth,
  wrap(rentPaymentChannels.createSepayChannel)
);
app.post(
  '/api/rent-payment-channels/:id/rotate-secret',
  requireAuth,
  wrap(rentPaymentChannels.rotateChannelSecret)
);
app.patch(
  '/api/rent-payment-channels/:id/status',
  requireAuth,
  wrap(rentPaymentChannels.setChannelStatus)
);
app.patch(
  '/api/rent-payment-channels/:id/account',
  requireAuth,
  wrap(rentPaymentChannels.updateChannelAccount)
);
app.post(
  '/api/rent-payment-channels/sepay/:publicId/webhook',
  wrap(rentPaymentChannels.sepayWebhook)
);
app.get(
  '/api/rent-bank-transactions',
  requireAuth,
  wrap(rentBankReconciliation.listBankTransactions)
);
app.post(
  '/api/rent-bank-transactions/:id/match',
  requireAuth,
  wrap(rentBankReconciliation.manuallyMatchTransaction)
);
app.post(
  '/api/rent-bank-transactions/:id/ignore',
  requireAuth,
  wrap(rentBankReconciliation.ignoreBankTransaction)
);
app.get(
  '/api/deposits/tenants/:tenantId',
  requireAuth,
  wrap(deposits.getTenantDeposit)
);
app.post(
  '/api/deposits/transactions',
  requireAuth,
  wrap(deposits.createDepositTransaction)
);
app.post(
  '/api/deposits/transactions/:id/reverse',
  requireAuth,
  wrap(deposits.reverseDepositTransaction)
);
app.get('/api/rental-contracts', requireAuth, wrap(rentalContracts.listContracts));
app.post('/api/rental-contracts', requireAuth, wrap(rentalContracts.createContract));
app.post(
  '/api/rental-contracts/:id/status',
  requireAuth,
  wrap(rentalContracts.changeContractStatus)
);
app.post(
  '/api/rental-contracts/:id/amendments',
  requireAuth,
  wrap(rentalContracts.createAmendment)
);
app.post(
  '/api/rental-contracts/:id/document',
  requireAuth,
  wrap(rentalContracts.getContractDocument)
);
app.get('/api/state', requireAuth, wrap(getState));
app.put('/api/state', requireAuth, wrap(putState));
app.get('/api/privacy/status', requireAuth, wrap(privacy.getPrivacyStatus));
app.post('/api/privacy/accept', requireAuth, wrap(privacy.acceptPolicies));
app.post('/api/privacy/tenants/:tenantId/reveal-cccd', requireAuth, wrap(privacy.revealTenantCccd));
app.get('/api/privacy/audit-logs', requireAuth, wrap(privacy.listAuditLogs));
app.post('/api/privacy/export', requireAuth, wrap(privacy.exportAccountData));
app.delete('/api/account', requireAuth, wrap(privacy.deleteAccount));

// Cấu hình toàn cục (thông tin ủng hộ): đọc công khai, ghi chỉ admin
app.get('/api/config', requireAuth, wrap(getConfig));

// ---------- API admin (requireAuth + requireAdmin) ----------
const adminGuard = [requireAuth, wrap(requireAdmin)];
app.get('/api/admin/users', adminGuard, wrap(admin.listUsers));
app.get('/api/admin/users/:id/state', adminGuard, wrap(admin.getUserState));
app.post(
  '/api/admin/users/:id/tenants/:tenantId/reveal-cccd',
  adminGuard,
  wrap(admin.revealTenantCccd)
);
app.get('/api/admin/sensitive-access-logs', adminGuard, wrap(admin.listSensitiveAccessLogs));
app.post(
  '/api/admin/users/:id/subscription/trial',
  adminGuard,
  wrap(subscription.startTrial)
);
app.post(
  '/api/admin/users/:id/subscription/change',
  adminGuard,
  wrap(subscription.changeSubscription)
);
app.get(
  '/api/admin/subscription/manual-change-logs',
  adminGuard,
  wrap(subscription.listAdminManualChangeLogs)
);
app.delete('/api/admin/users/:id', adminGuard, wrap(admin.deleteUser));
app.post('/api/admin/users/:id/password', adminGuard, wrap(admin.resetPassword));
app.post('/api/admin/users/:id/admin', adminGuard, wrap(admin.setAdmin));
app.get('/api/admin/config', adminGuard, wrap(getAdminConfig));
app.put('/api/admin/config', adminGuard, wrap(setConfig));
app.put('/api/admin/config/subscription-payment', adminGuard, wrap(setSubscriptionPaymentConfig));
app.get('/api/admin/plans', adminGuard, wrap(plans.listAdminPlans));
app.put('/api/admin/plans/:code', adminGuard, wrap(plans.updatePlan));
app.get(
  '/api/admin/subscription/refund-requests',
  adminGuard,
  wrap(subscriptionRefunds.listAdminRefundRequests)
);
app.post(
  '/api/admin/subscription/refund-requests/:id/transition',
  adminGuard,
  wrap(subscriptionRefunds.transitionAdminRefundRequest)
);
app.get('/api/admin/revenue/summary', adminGuard, wrap(adminRevenue.getRevenueSummary));

// ---------- Frontend tĩnh (thư mục cha) ----------
const FRONTEND_DIR = path.join(__dirname, '..');
app.use(express.static(FRONTEND_DIR));

// SPA fallback: mọi route không phải /api -> index.html
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

app.use('/api', (req, res) => {
  res.status(404).json({ error: 'API không tồn tại', code: 'API_NOT_FOUND' });
});

// ---------- Xử lý lỗi tập trung ----------
app.use(async (err, req, res, next) => {
  if (res.headersSent) return next(err);
  const incidentId = await reportOperationalError(err, {
    event: err && err.isDatabaseFailure ? 'database_request_failed' : 'api_request_failed',
    requestId: req.requestId,
    method: req.method,
    route: requestRoute(req),
    statusCode: 500,
    message: err && err.isDatabaseFailure
      ? 'Database request thất bại'
      : 'API request thất bại'
  });
  res.locals.incidentId = incidentId;
  return res.status(500).json({
    error: 'Lỗi máy chủ nội bộ',
    code: 'INTERNAL_ERROR',
    incidentId
  });
});

const runtimeConfiguration = inspectRuntimeEnvironment();
if (runtimeConfiguration.appEnvironment !== 'test') {
  const level = runtimeConfiguration.valid ? 'info' : 'error';
  writeLog(level, 'runtime_configuration_checked', {
    valid: runtimeConfiguration.valid,
    issues: runtimeConfiguration.issues.map(issue => issue.code),
    warnings: runtimeConfiguration.warnings.map(warning => warning.code)
  });
}

// Chạy HTTP server khi phát triển/local. Trên Vercel, api/index.js export app
// thành Serverless Function nên không được gọi app.listen().
if (require.main === module) {
  app.listen(PORT, async () => {
    console.log(`✅ TrọBill chạy tại http://localhost:${PORT}`);
    try {
      await seedAdmin();
    } catch (e) {
      console.error('⚠️  Seed admin lỗi:', e.message);
    }
  });
} else if (process.env.VERCEL) {
  // Seed idempotent trên cold start để ADMIN_EMAIL vẫn hoạt động trên Vercel.
  seedAdmin().catch((e) => console.error('⚠️  Seed admin lỗi:', e.message));
}

module.exports = app;
