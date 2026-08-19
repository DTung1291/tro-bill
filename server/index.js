'use strict';

require('dotenv').config();
const path = require('path');
const express = require('express');
const { register, login, requireAuth, requireAdmin } = require('./auth');
const { getState, putState } = require('./state');
const admin = require('./admin');
const { getConfig, setConfig } = require('./config');
const { seedAdmin } = require('./seed-admin');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));

// bọc async handler để lỗi rơi vào middleware xử lý lỗi
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- API ----------
app.post('/api/auth/register', wrap(register));
app.post('/api/auth/login', wrap(login));

app.get('/api/me', requireAuth, (req, res) => res.json({ email: req.userEmail, isAdmin: !!req.isAdmin }));
app.get('/api/state', requireAuth, wrap(getState));
app.put('/api/state', requireAuth, wrap(putState));

// Cấu hình toàn cục (thông tin ủng hộ): đọc công khai, ghi chỉ admin
app.get('/api/config', requireAuth, wrap(getConfig));

// ---------- API admin (requireAuth + requireAdmin) ----------
const adminGuard = [requireAuth, wrap(requireAdmin)];
app.get('/api/admin/users', adminGuard, wrap(admin.listUsers));
app.get('/api/admin/users/:id/state', adminGuard, wrap(admin.getUserState));
app.delete('/api/admin/users/:id', adminGuard, wrap(admin.deleteUser));
app.post('/api/admin/users/:id/password', adminGuard, wrap(admin.resetPassword));
app.post('/api/admin/users/:id/admin', adminGuard, wrap(admin.setAdmin));
app.put('/api/admin/config', adminGuard, wrap(setConfig));

// ---------- Frontend tĩnh (thư mục cha) ----------
const FRONTEND_DIR = path.join(__dirname, '..');
app.use(express.static(FRONTEND_DIR));

// SPA fallback: mọi route không phải /api -> index.html
app.get(/^\/(?!api\/).*/, (req, res) => {
  res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

// ---------- Xử lý lỗi tập trung ----------
app.use((err, req, res, next) => {
  console.error('Lỗi server:', err);
  res.status(500).json({ error: 'Lỗi máy chủ nội bộ' });
});

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
