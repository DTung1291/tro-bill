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
app.post('/api/webhooks/subscription-payments/bank-transfer', wrap(paymentWebhook));
app.post('/api/auth/register', wrap(register));
app.post('/api/auth/login', wrap(login));
app.post('/api/auth/logout', logout);
app.post('/api/auth/logout-all', requireAuth, wrap(logoutAll));
app.post('/api/auth/verify-email', wrap(verifyEmail));
app.post('/api/auth/resend-verification', wrap(resendVerification));
app.post('/api/auth/forgot-password', wrap(forgotPassword));
app.post('/api/auth/reset-password', wrap(resetPassword));

app.get('/api/me', requireAuth, (req, res) => res.json({ email: req.userEmail, isAdmin: !!req.isAdmin }));
app.get('/api/subscription', requireAuth, wrap(subscription.getSubscription));
app.get('/api/subscription/payments', requireAuth, wrap(paymentHistory.listSubscriptionPayments));
app.get(
  '/api/subscription/payments/:id/receipt',
  requireAuth,
  wrap(paymentHistory.getSubscriptionReceipt)
);
app.get('/api/plans', requireAuth, wrap(plans.listPublicPlans));
app.post('/api/subscription/orders', requireAuth, wrap(createSubscriptionOrder));
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
app.delete('/api/admin/users/:id', adminGuard, wrap(admin.deleteUser));
app.post('/api/admin/users/:id/password', adminGuard, wrap(admin.resetPassword));
app.post('/api/admin/users/:id/admin', adminGuard, wrap(admin.setAdmin));
app.get('/api/admin/config', adminGuard, wrap(getAdminConfig));
app.put('/api/admin/config', adminGuard, wrap(setConfig));
app.put('/api/admin/config/subscription-payment', adminGuard, wrap(setSubscriptionPaymentConfig));
app.get('/api/admin/plans', adminGuard, wrap(plans.listAdminPlans));
app.put('/api/admin/plans/:code', adminGuard, wrap(plans.updatePlan));

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
