'use strict';

const { inspectEmailConfiguration } = require('./email-config');

const VALID_ENVIRONMENTS = new Set(['development', 'staging', 'production', 'test']);

function resolveAppEnvironment(env = process.env) {
  const explicit = String(env.APP_ENV || '').trim().toLowerCase();
  if (explicit) return explicit;

  const vercelEnvironment = String(env.VERCEL_ENV || '').trim().toLowerCase();
  if (vercelEnvironment === 'production') return 'production';
  if (vercelEnvironment === 'preview') return 'staging';
  if (vercelEnvironment === 'development') return 'development';

  if (env.NODE_ENV === 'test') return 'test';
  if (env.NODE_ENV === 'production') return 'production';
  return 'development';
}

function isHttpsUrl(value) {
  try {
    return new URL(String(value || '')).protocol === 'https:';
  } catch (_) {
    return false;
  }
}

function inspectRuntimeEnvironment(env = process.env) {
  const appEnvironment = resolveAppEnvironment(env);
  const issues = [];
  const warnings = [];
  const addIssue = (code, message) => issues.push({ code, message });
  const addWarning = (code, message) => warnings.push({ code, message });

  if (!VALID_ENVIRONMENTS.has(appEnvironment)) {
    addIssue('INVALID_APP_ENV', 'APP_ENV phải là development, staging, production hoặc test.');
  }

  if (!env.DATABASE_URL) addIssue('DATABASE_URL_MISSING', 'Thiếu DATABASE_URL.');
  if (!env.JWT_SECRET) addIssue('JWT_SECRET_MISSING', 'Thiếu JWT_SECRET.');

  if (['staging', 'production'].includes(appEnvironment)) {
    if (String(env.JWT_SECRET || '').length < 32) {
      addIssue('JWT_SECRET_TOO_SHORT', 'JWT_SECRET phải có ít nhất 32 ký tự.');
    }
    if (!isHttpsUrl(env.APP_URL)) {
      addIssue('APP_URL_NOT_HTTPS', 'APP_URL phải là địa chỉ HTTPS hợp lệ.');
    }
    if (env.COOKIE_SECURE === 'false') {
      addIssue('INSECURE_COOKIE', 'Không được tắt Secure cookie ở staging/production.');
    }

    const databaseEnvironment = String(env.DATABASE_ENVIRONMENT || '').trim().toLowerCase();
    if (!databaseEnvironment) {
      addWarning(
        'DATABASE_ENVIRONMENT_MISSING',
        'Nên đặt DATABASE_ENVIRONMENT để chứng minh staging và production dùng database riêng.'
      );
    } else if (databaseEnvironment !== appEnvironment) {
      addIssue(
        'DATABASE_ENVIRONMENT_MISMATCH',
        `Database dành cho ${databaseEnvironment} không được dùng ở ${appEnvironment}.`
      );
    }
  }

  if (appEnvironment === 'production') {
    const emailConfiguration = inspectEmailConfiguration(env);
    if (!emailConfiguration.valid) {
      addIssue(
        'EMAIL_CONFIGURATION_MISSING',
        `Production phải cấu hình EMAIL_PROVIDER=${emailConfiguration.provider}, ${emailConfiguration.keyName}, EMAIL_FROM và APP_URL.`
      );
    }
    if (!isHttpsUrl(env.OPS_ALERT_WEBHOOK_URL)) {
      addWarning(
        'OPS_ALERT_WEBHOOK_MISSING',
        'Chưa có OPS_ALERT_WEBHOOK_URL HTTPS nên sự cố chỉ được ghi log, chưa gửi cảnh báo.'
      );
    }
    if (String(env.CRON_SECRET || '').length < 32) {
      addIssue(
        'CRON_SECRET_MISSING',
        'Production phải có CRON_SECRET tối thiểu 32 ký tự để bảo vệ tác vụ định kỳ.'
      );
    }
    if (String(env.PAYMENT_WEBHOOK_SECRET || '').length < 32) {
      addIssue(
        'PAYMENT_WEBHOOK_SECRET_MISSING',
        'Production phải có PAYMENT_WEBHOOK_SECRET tối thiểu 32 ký tự.'
      );
    }
  }

  return {
    appEnvironment,
    valid: issues.length === 0,
    issues,
    warnings
  };
}

module.exports = {
  VALID_ENVIRONMENTS,
  inspectRuntimeEnvironment,
  isHttpsUrl,
  resolveAppEnvironment
};
