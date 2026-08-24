'use strict';

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');
const { assertEmailConfigured, sendVerificationEmail } = require('./email');

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error('❌ Thiếu JWT_SECRET trong .env — xem .env.example');
  process.exit(1);
}
const TOKEN_TTL = '30d';
const TOKEN_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const SESSION_COOKIE = 'trobill_session';
const EMAIL_TOKEN_TTL_HOURS = 24;

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

function createEmailToken() {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  return { token, tokenHash };
}

async function saveEmailToken(query, userId) {
  const { token, tokenHash } = createEmailToken();
  await query(
    `INSERT INTO email_verification_tokens (user_id, token_hash, expires_at, created_at)
     VALUES ($1, $2, now() + ($3 * interval '1 hour'), now())
     ON CONFLICT (user_id) DO UPDATE
     SET token_hash=EXCLUDED.token_hash,
         expires_at=EXCLUDED.expires_at,
         created_at=now()`,
    [userId, tokenHash, EMAIL_TOKEN_TTL_HOURS]
  );
  return token;
}

function emailConfigurationResponse(res, error) {
  if (error && error.code === 'EMAIL_NOT_CONFIGURED') {
    return res.status(503).json({
      error: 'Hệ thống gửi email chưa được cấu hình. Vui lòng thử lại sau.',
      code: error.code
    });
  }
  return null;
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

  try {
    assertEmailConfigured();
  } catch (error) {
    const response = emailConfigurationResponse(res, error);
    if (response) return response;
    throw error;
  }

  const exists = await db.query('SELECT 1 FROM users WHERE email=$1', [email]);
  if (exists.rowCount > 0) {
    return res.status(409).json({ error: 'Email đã được đăng ký' });
  }

  const hash = await bcrypt.hash(password, 10);
  const client = await db.getClient();
  let user;
  let emailToken;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id, email',
      [email, hash]
    );
    user = rows[0];
    await client.query('INSERT INTO settings (user_id) VALUES ($1) ON CONFLICT DO NOTHING', [user.id]);
    emailToken = await saveEmailToken(client.query.bind(client), user.id);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    if (error && error.code === '23505') {
      return res.status(409).json({ error: 'Email đã được đăng ký' });
    }
    throw error;
  } finally {
    client.release();
  }

  try {
    const delivery = await sendVerificationEmail({
      email: user.email,
      token: emailToken,
      userId: user.id,
      req
    });
    const body = {
      email: user.email,
      verificationRequired: true,
      emailSent: delivery.delivered
    };
    if (delivery.development) body.verificationUrl = delivery.verificationUrl;
    return res.status(201).json(body);
  } catch (error) {
    console.error(`Không gửi được email xác minh cho ${user.email}:`, error.message);
    return res.status(202).json({
      email: user.email,
      verificationRequired: true,
      emailSent: false,
      warning: 'Tài khoản đã được tạo nhưng chưa gửi được email. Vui lòng bấm gửi lại.'
    });
  }
}

// POST /api/auth/login
async function login(req, res) {
  const email = normalizeEmail(req.body.email);
  const password = String(req.body.password || '');

  const { rows } = await db.query(
    'SELECT id, email, password_hash, is_admin, email_verified_at FROM users WHERE email=$1',
    [email]
  );
  const user = rows[0];
  if (!user || !(await bcrypt.compare(password, user.password_hash))) {
    return res.status(401).json({ error: 'Email hoặc mật khẩu sai' });
  }
  if (!user.email_verified_at) {
    return res.status(403).json({
      error: 'Email chưa được xác minh. Vui lòng kiểm tra hộp thư hoặc gửi lại email.',
      code: 'EMAIL_NOT_VERIFIED'
    });
  }
  setSessionCookie(res, user);
  return res.json({ email: user.email, isAdmin: !!user.is_admin });
}

// POST /api/auth/verify-email
async function verifyEmail(req, res) {
  const token = String(req.body.token || '').trim();
  if (!/^[a-f0-9]{64}$/i.test(token)) {
    return res.status(400).json({ error: 'Liên kết xác minh không hợp lệ hoặc đã hết hạn' });
  }

  const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
  const client = await db.getClient();
  let user;
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `UPDATE users u
       SET email_verified_at=COALESCE(u.email_verified_at, now())
       FROM email_verification_tokens evt
       WHERE evt.user_id=u.id
         AND evt.token_hash=$1
         AND evt.expires_at > now()
       RETURNING u.id, u.email, u.is_admin`,
      [tokenHash]
    );
    user = rows[0];
    if (!user) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Liên kết xác minh không hợp lệ hoặc đã hết hạn' });
    }
    await client.query('DELETE FROM email_verification_tokens WHERE user_id=$1', [user.id]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  setSessionCookie(res, user);
  return res.json({ email: user.email, isAdmin: !!user.is_admin, verified: true });
}

// POST /api/auth/resend-verification
async function resendVerification(req, res) {
  const genericBody = {
    ok: true,
    message: 'Nếu tài khoản tồn tại và chưa xác minh, email mới sẽ được gửi.'
  };
  const email = normalizeEmail(req.body.email);
  if (!email || !email.includes('@')) return res.json(genericBody);

  try {
    assertEmailConfigured();
  } catch (error) {
    const response = emailConfigurationResponse(res, error);
    if (response) return response;
    throw error;
  }

  const { rows } = await db.query(
    `SELECT u.id, u.email, u.email_verified_at, evt.created_at AS token_created_at
     FROM users u
     LEFT JOIN email_verification_tokens evt ON evt.user_id=u.id
     WHERE u.email=$1`,
    [email]
  );
  const user = rows[0];
  if (!user || user.email_verified_at) return res.json(genericBody);

  if (user.token_created_at) {
    const elapsedMs = Date.now() - new Date(user.token_created_at).getTime();
    if (Number.isFinite(elapsedMs) && elapsedMs < 60_000) return res.json(genericBody);
  }

  const token = await saveEmailToken(db.query, user.id);
  try {
    const delivery = await sendVerificationEmail({ email: user.email, token, userId: user.id, req });
    if (delivery.development) genericBody.verificationUrl = delivery.verificationUrl;
  } catch (error) {
    console.error(`Không gửi lại được email xác minh cho ${user.email}:`, error.message);
  }
  return res.json(genericBody);
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

module.exports = {
  register,
  login,
  logout,
  verifyEmail,
  resendVerification,
  requireAuth,
  requireAdmin
};
