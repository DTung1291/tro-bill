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

function signToken(user) {
  return jwt.sign(
    { uid: user.id, email: user.email, admin: !!user.is_admin },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL }
  );
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

  return res.json({ token: signToken(user), email: user.email });
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
  return res.json({ token: signToken(user), email: user.email, isAdmin: !!user.is_admin });
}

// Middleware: chặn mọi route cần đăng nhập
function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
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

module.exports = { register, login, requireAuth, requireAdmin };
