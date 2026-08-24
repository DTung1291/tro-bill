'use strict';

const crypto = require('crypto');
const { Resend } = require('resend');

function isProduction() {
  return process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
}

function configurationError() {
  const error = new Error(
    'Chức năng gửi email chưa được cấu hình. Thiếu RESEND_API_KEY, EMAIL_FROM hoặc APP_URL.'
  );
  error.code = 'EMAIL_NOT_CONFIGURED';
  return error;
}

function assertEmailConfigured() {
  if (!isProduction()) return;
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM || !process.env.APP_URL) {
    throw configurationError();
  }
}

function appBaseUrl(req) {
  const configured = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  if (configured) return configured;

  const forwardedProto = String(req.get('x-forwarded-proto') || '').split(',')[0].trim();
  const protocol = forwardedProto || req.protocol || 'http';
  return `${protocol}://${req.get('host')}`;
}

function verificationUrl(req, token) {
  return `${appBaseUrl(req)}/?verify=${encodeURIComponent(token)}`;
}

function passwordResetUrl(req, token) {
  return `${appBaseUrl(req)}/?reset=${encodeURIComponent(token)}`;
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  }[char]));
}

function verificationEmailHtml(url) {
  const safeUrl = escapeHtml(url);
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#172033;max-width:560px;margin:0 auto">
      <h1 style="font-size:24px;margin-bottom:12px">Xác minh email TrọBill</h1>
      <p>Cảm ơn bạn đã đăng ký TrọBill. Bấm nút bên dưới để xác minh địa chỉ email.</p>
      <p style="margin:28px 0">
        <a href="${safeUrl}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#6c63ff;color:#fff;text-decoration:none;font-weight:700">
          Xác minh email
        </a>
      </p>
      <p>Liên kết có hiệu lực trong 24 giờ. Nếu bạn không tạo tài khoản này, hãy bỏ qua email.</p>
      <p style="font-size:12px;color:#667085;word-break:break-all">${safeUrl}</p>
    </div>`;
}

function passwordResetEmailHtml(url) {
  const safeUrl = escapeHtml(url);
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#172033;max-width:560px;margin:0 auto">
      <h1 style="font-size:24px;margin-bottom:12px">Đặt lại mật khẩu TrọBill</h1>
      <p>TrọBill nhận được yêu cầu đặt lại mật khẩu cho tài khoản của bạn.</p>
      <p style="margin:28px 0">
        <a href="${safeUrl}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#6c63ff;color:#fff;text-decoration:none;font-weight:700">
          Đặt lại mật khẩu
        </a>
      </p>
      <p>Liên kết có hiệu lực trong 30 phút và chỉ dùng được một lần. Nếu bạn không yêu cầu, hãy bỏ qua email này.</p>
      <p style="font-size:12px;color:#667085;word-break:break-all">${safeUrl}</p>
    </div>`;
}

async function sendVerificationEmail({ email, token, userId, req }) {
  assertEmailConfigured();

  const url = verificationUrl(req, token);
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) {
    console.info(`✉️  Link xác minh email local cho ${email}: ${url}`);
    return { delivered: false, development: true, verificationUrl: url };
  }

  const from = String(process.env.EMAIL_FROM || 'TrọBill <onboarding@resend.dev>').trim();
  const resend = new Resend(apiKey);
  const tokenFingerprint = crypto.createHash('sha256').update(token).digest('hex').slice(0, 24);
  const { data, error } = await resend.emails.send(
    {
      from,
      to: [email],
      subject: 'Xác minh địa chỉ email TrọBill',
      html: verificationEmailHtml(url),
      text: `Xác minh email TrọBill bằng liên kết sau (có hiệu lực 24 giờ):\n\n${url}`
    },
    { idempotencyKey: `verify-email-${userId}-${tokenFingerprint}` }
  );

  if (error) {
    const sendError = new Error(error.message || 'Không gửi được email xác minh');
    sendError.code = 'EMAIL_SEND_FAILED';
    throw sendError;
  }

  return { delivered: true, emailId: data && data.id, verificationUrl: url };
}

async function sendPasswordResetEmail({ email, token, userId, req }) {
  assertEmailConfigured();

  const url = passwordResetUrl(req, token);
  const apiKey = String(process.env.RESEND_API_KEY || '').trim();
  if (!apiKey) {
    console.info(`✉️  Link đặt lại mật khẩu local cho ${email}: ${url}`);
    return { delivered: false, development: true, passwordResetUrl: url };
  }

  const from = String(process.env.EMAIL_FROM || 'TrọBill <onboarding@resend.dev>').trim();
  const resend = new Resend(apiKey);
  const tokenFingerprint = crypto.createHash('sha256').update(token).digest('hex').slice(0, 24);
  const { data, error } = await resend.emails.send(
    {
      from,
      to: [email],
      subject: 'Đặt lại mật khẩu TrọBill',
      html: passwordResetEmailHtml(url),
      text: `Đặt lại mật khẩu TrọBill bằng liên kết sau (có hiệu lực 30 phút):\n\n${url}`
    },
    { idempotencyKey: `password-reset-${userId}-${tokenFingerprint}` }
  );

  if (error) {
    const sendError = new Error(error.message || 'Không gửi được email đặt lại mật khẩu');
    sendError.code = 'EMAIL_SEND_FAILED';
    throw sendError;
  }

  return { delivered: true, emailId: data && data.id, passwordResetUrl: url };
}

module.exports = {
  assertEmailConfigured,
  sendVerificationEmail,
  sendPasswordResetEmail
};
