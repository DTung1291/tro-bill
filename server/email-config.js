'use strict';

const SUPPORTED_EMAIL_PROVIDERS = new Set(['brevo', 'resend']);

function resolveEmailProvider(env = process.env) {
  const configured = String(env.EMAIL_PROVIDER || '').trim().toLowerCase();
  if (configured) return configured;
  if (env.BREVO_API_KEY) return 'brevo';
  return 'resend';
}

function emailProviderApiKey(provider, env = process.env) {
  if (provider === 'brevo') return String(env.BREVO_API_KEY || '').trim();
  if (provider === 'resend') return String(env.RESEND_API_KEY || '').trim();
  return '';
}

function inspectEmailConfiguration(env = process.env) {
  const provider = resolveEmailProvider(env);
  const keyName = provider === 'brevo' ? 'BREVO_API_KEY' : 'RESEND_API_KEY';
  const missing = [];

  if (!SUPPORTED_EMAIL_PROVIDERS.has(provider)) missing.push('EMAIL_PROVIDER');
  if (!emailProviderApiKey(provider, env)) missing.push(keyName);
  if (!String(env.EMAIL_FROM || '').trim()) missing.push('EMAIL_FROM');
  if (!String(env.APP_URL || '').trim()) missing.push('APP_URL');

  return {
    provider,
    keyName,
    missing,
    valid: missing.length === 0
  };
}

module.exports = {
  SUPPORTED_EMAIL_PROVIDERS,
  emailProviderApiKey,
  inspectEmailConfiguration,
  resolveEmailProvider
};
