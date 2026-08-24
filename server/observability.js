'use strict';

const crypto = require('crypto');
const { resolveAppEnvironment, isHttpsUrl } = require('./environment');

const SERVICE_NAME = 'trobill-api';
const ALERT_COOLDOWN_MS = 5 * 60 * 1000;
const lastAlertAt = new Map();

function createId(prefix) {
  return `${prefix}_${crypto.randomUUID()}`;
}

function safeRequestId(value) {
  const candidate = String(value || '').trim();
  return /^[A-Za-z0-9._-]{1,100}$/.test(candidate) ? candidate : createId('req');
}

function requestRoute(req) {
  return String(req.originalUrl || req.url || '').split('?')[0].slice(0, 300);
}

function errorDetails(error) {
  return {
    name: String(error && error.name || 'Error').slice(0, 80),
    code: String(error && error.code || 'UNEXPECTED_ERROR').slice(0, 80)
  };
}

function writeLog(level, event, fields = {}) {
  const entry = {
    timestamp: new Date().toISOString(),
    level,
    service: SERVICE_NAME,
    environment: resolveAppEnvironment(),
    event,
    ...fields
  };
  const output = JSON.stringify(entry);
  if (level === 'error') console.error(output);
  else if (level === 'warn') console.warn(output);
  else console.log(output);
  return entry;
}

async function sendOpsAlert({ event, incidentId, message, requestId, route }) {
  const webhookUrl = String(process.env.OPS_ALERT_WEBHOOK_URL || '').trim();
  if (!isHttpsUrl(webhookUrl)) return { delivered: false, reason: 'not-configured' };

  const alertKey = String(event || 'operational-error');
  const now = Date.now();
  if (now - (lastAlertAt.get(alertKey) || 0) < ALERT_COOLDOWN_MS) {
    return { delivered: false, reason: 'cooldown' };
  }
  lastAlertAt.set(alertKey, now);

  const summary = [
    `[TrọBill/${resolveAppEnvironment()}] ${message || event}`,
    incidentId ? `incident=${incidentId}` : '',
    requestId ? `request=${requestId}` : '',
    route ? `route=${route}` : ''
  ].filter(Boolean).join(' | ');

  try {
    const response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        text: summary,
        content: summary,
        service: SERVICE_NAME,
        environment: resolveAppEnvironment(),
        event,
        incidentId,
        requestId,
        route,
        occurredAt: new Date().toISOString()
      }),
      signal: AbortSignal.timeout(2000)
    });
    if (!response.ok) throw Object.assign(new Error('Webhook rejected alert'), { code: 'ALERT_HTTP_ERROR' });
    return { delivered: true };
  } catch (error) {
    writeLog('warn', 'ops_alert_delivery_failed', {
      eventName: alertKey,
      ...errorDetails(error)
    });
    return { delivered: false, reason: 'delivery-failed' };
  }
}

async function reportOperationalError(error, context = {}) {
  const incidentId = context.incidentId || createId('inc');
  const fields = {
    incidentId,
    requestId: context.requestId,
    method: context.method,
    route: context.route,
    statusCode: context.statusCode || 500,
    ...errorDetails(error)
  };
  writeLog('error', context.event || 'server_error', fields);
  await sendOpsAlert({
    event: context.event || 'server_error',
    incidentId,
    requestId: context.requestId,
    route: context.route,
    message: context.message || 'API hoặc database gặp sự cố'
  });
  return incidentId;
}

function requestObservability(req, res, next) {
  req.requestId = safeRequestId(req.get('x-request-id') || req.get('x-vercel-id'));
  req.requestStartedAt = process.hrtime.bigint();
  res.set('X-Request-Id', req.requestId);

  res.on('finish', () => {
    if (res.statusCode < 500 && process.env.LOG_REQUESTS !== 'true') return;
    const durationMs = Number(process.hrtime.bigint() - req.requestStartedAt) / 1e6;
    writeLog(res.statusCode >= 500 ? 'error' : 'info', 'api_request_completed', {
      requestId: req.requestId,
      method: req.method,
      route: requestRoute(req),
      statusCode: res.statusCode,
      incidentId: res.locals && res.locals.incidentId,
      durationMs: Math.round(durationMs * 10) / 10
    });
  });
  next();
}

module.exports = {
  createId,
  errorDetails,
  reportOperationalError,
  requestObservability,
  requestRoute,
  sendOpsAlert,
  writeLog
};
