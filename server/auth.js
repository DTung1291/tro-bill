'use strict';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ Thiếu JWT_SECRET trong .env — xem .env.example');
  process.exit(1);
}
const TOKEN_TTL = '30d';
const TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'trobill_session';

function signToken(user) {
  return jwt.sign(
    { uid: user.id, email: user.email, admin: !!user.is_admin },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
}

function useSecureCookie() {
  if (process.env.COOKIE_SECURE === 'true') return true;
  if (process.env.COOKIE_SECURE === 'false') return false;
  return process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
}

function baseCookieOptions() {
  return {
    httpOnly: true,
    secure: useSecureCookie(),
    sameSite: 'lax',
    path: '/'
  };
}

function setSessionCookie(res, user) {
  res.cookie(SESSION_COOKIE, signToken(user), {
    ...baseCookieOptions(),
    maxAge: TOKEN_MAX_AGE_MS
  });
  res.set('Cache-Control', 'no-store');
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, baseCookieOptions());
  res.set('Cache-Control', 'no-store');
}

function readCookie(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch (_) {
      return value;
    }
  }
  return '';
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

// POST /api/auth/register
async function register(req, res) {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Email không hợp lệ' });
  }
  if (password.length < 6) {
    return res.status(400).json({ error: 'Mật khẩu tối thiểu 6 ký tự' });
  }

  const exists = await db.query('SELECT 1 FROM users WHERE email=$1', [email]);
  if (exists.rowCount > 0) {
    return res.status(409).json({ error: 'Email đã được đăng ký' });
  }

  const hash = await bcrypt.hash(password, 10);
  const { rows } = await db.query(
    'INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id, email',
    [email, hash]
  );
  const user = rows[0];
  // Tạo dòng settings mặc định cho user mới
  await db.query('INSERT INTO settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);

  setSessionCookie(res, user);
  return res.json({ email: user.email, isAdmin: false });
}

// POST /api/auth/login
async function login(req, res) {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');

  const { rows } = await db.query(
    'SELECT id, email, password_hash, is_admin FROM users WHERE email=$1',
    [email]
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Email hoặc mật khẩu sai' });
  }
  setSessionCookie(res, user);
  return res.json({ email: user.email, isAdmin: !!user.is_admin });
}

// POST /api/auth/logout
function logout(req, res) {
  clearSessionCookie(res);
  return res.json({ ok: true });
}

// Middleware: chặn mọi route cần đăng nhập
function requireAuth(req, res, next) {
  const token = readCookie(req, SESSION_COOKIE);
  if (!token) return res.status(401).json({ error: 'Chưa đăng nhập' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.uid;
    req.userEmail = payload.email;
    req.isAdmin = !!payload.admin;
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Phiên đăng nhập hết hạn' });
  }
}

// Middleware: chỉ cho admin. Dùng SAU requireAuth.
// Kiểm tra lại DB (không tin cờ trong token) để việc thu hồi quyền có hiệu lực ngay.
async function requireAdmin(req, res, next) {
  try {
    const { rows } = await db.query('SELECT is_admin FROM users WHERE id=$1', [req.userId]);
    if (!rows[0] || !rows[0].is_admin) {
      return res.status(403).json({ error: 'Không đủ quyền' });
    }
    next();
  } catch (e) {
    next(e);
  }
}

module.exports = { register, login, logout, requireAuth, requireAdmin };
