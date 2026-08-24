'use strict';

const { resolveAppEnvironment } = require('./environment');

function requestIsHttps(req) {
  const forwardedProtocol = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  return req.secure || forwardedProtocol === 'https';
}

function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Permissions-Policy': 'camera=(self), microphone=(), geolocation=()'
  });
  if (requestIsHttps(req) && ['staging', 'production'].includes(resolveAppEnvironment())) {
    res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

function enforceHttps(req, res, next) {
  if (!['staging', 'production'].includes(resolveAppEnvironment()) || requestIsHttps(req)) {
    return next();
  }

  try {
    const destination = new URL(req.originalUrl || req.url || '/', process.env.APP_URL);
    destination.protocol = 'https:';
    return res.redirect(308, destination.toString());
  } catch (_) {
    return res.status(503).json({
      error: 'Môi trường chưa được cấu hình HTTPS đúng cách',
      code: 'HTTPS_CONFIGURATION_INVALID'
    });
  }
}

module.exports = { enforceHttps, requestIsHttps, securityHeaders };

