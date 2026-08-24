'use strict';

const crypto = require('crypto');
const db = require('./db');

const RATE_LIMIT_SECRET = process.env.RATE_LIMIT_SECRET || process.env.JWT_SECRET;
if (!RATE_LIMIT_SECRET) {
  throw new Error('Thiếu RATE_LIMIT_SECRET hoặc JWT_SECRET cho bộ giới hạn xác thực');
}

const RULES = {
  login: [
    { scope: 'ip', maxAttempts: 20, windowSeconds: 15 * 60 },
    { scope: 'account', maxAttempts: 8, windowSeconds: 15 * 60 }
  ],
  register: [
    { scope: 'ip', maxAttempts: 10, windowSeconds: 60 * 60 },
    { scope: 'account', maxAttempts: 5, windowSeconds: 60 * 60 }
  ]
};
let lastCleanupAt = 0;

function requestIp(req) {
  return String(req.ip || (req.socket && req.socket.remoteAddress) || 'unknown').slice(0, 128);
}

function keyHash(action, scope, identifier) {
  return crypto
    .createHmac('sha256', RATE_LIMIT_SECRET)
    .update(`${action}:${scope}:${String(identifier || '').trim().toLowerCase()}`)
    .digest('hex');
}

function rulesFor(req, action, account) {
  const definitions = RULES[action];
  if (!definitions) throw new Error(`Nhóm rate limit không hợp lệ: ${action}`);
  return definitions
    .map((rule) => ({
      ...rule,
      identifier: rule.scope === 'ip' ? requestIp(req) : String(account || '').trim().toLowerCase()
    }))
    .filter((rule) => rule.identifier);
}

function rejectLimited(res, retryAfter) {
  const seconds = Math.max(1, Number(retryAfter) || 1);
  res.set('Retry-After', String(seconds));
  res.status(429).json({
    error: 'Quá nhiều lần thử. Vui lòng chờ rồi thử lại.',
    code: 'RATE_LIMITED',
    retryAfter: seconds
  });
  return false;
}

async function blockedRule(rule, action) {
  const hash = keyHash(action, rule.scope, rule.identifier);
  const { rows } = await db.query(
    `SELECT attempts,
            GREATEST(1, CEIL(EXTRACT(EPOCH FROM
              (window_started_at + ($2 * interval '1 second')) - now()
            )))::int AS retry_after
     FROM auth_rate_limits
     WHERE key_hash=$1
       AND window_started_at > now() - ($2 * interval '1 second')
       AND attempts >= $3`,
    [hash, rule.windowSeconds, rule.maxAttempts]
  );
  return rows[0] || null;
}

async function checkAuthRateLimit(req, res, action, account) {
  const rules = rulesFor(req, action, account);
  for (const rule of rules) {
    const blocked = await blockedRule(rule, action);
    if (blocked) return rejectLimited(res, blocked.retry_after);
  }
  return true;
}

async function recordRule(rule, action) {
  const hash = keyHash(action, rule.scope, rule.identifier);
  const { rows } = await db.query(
    `INSERT INTO auth_rate_limits
       (key_hash, action, scope, attempts, window_started_at, updated_at)
     VALUES ($1,$2,$3,1,now(),now())
     ON CONFLICT (key_hash) DO UPDATE SET
       attempts=CASE
         WHEN auth_rate_limits.window_started_at <= now() - ($4 * interval '1 second') THEN 1
         ELSE auth_rate_limits.attempts + 1
       END,
       window_started_at=CASE
         WHEN auth_rate_limits.window_started_at <= now() - ($4 * interval '1 second') THEN now()
         ELSE auth_rate_limits.window_started_at
       END,
       updated_at=now()
     RETURNING attempts,
       GREATEST(1, CEIL(EXTRACT(EPOCH FROM
         (window_started_at + ($4 * interval '1 second')) - now()
       )))::int AS retry_after`,
    [hash, action, rule.scope, rule.windowSeconds]
  );
  return rows[0] || { attempts: 1, retry_after: rule.windowSeconds };
}

async function recordAuthAttempt(req, res, action, account) {
  const rules = rulesFor(req, action, account);
  const results = await Promise.all(rules.map(async (rule) => ({
    rule,
    result: await recordRule(rule, action)
  })));
  const limited = results.find(({ rule, result }) => Number(result.attempts) > rule.maxAttempts);
  const now = Date.now();
  if (now - lastCleanupAt > 60 * 60 * 1000) {
    lastCleanupAt = now;
    try {
      await db.query(
        `DELETE FROM auth_rate_limits
         WHERE updated_at < now() - interval '2 days'`
      );
    } catch (error) {
      console.warn('Không dọn được bộ đếm rate limit cũ:', error.message);
    }
  }
  if (limited) return rejectLimited(res, limited.result.retry_after);
  return true;
}

async function clearAccountRateLimit(action, account) {
  const normalized = String(account || '').trim().toLowerCase();
  if (!normalized) return;
  await db.query('DELETE FROM auth_rate_limits WHERE key_hash=$1', [
    keyHash(action, 'account', normalized)
  ]);
}

module.exports = {
  RULES,
  checkAuthRateLimit,
  recordAuthAttempt,
  clearAccountRateLimit,
  keyHash,
  requestIp
};
