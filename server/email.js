'use strict';

const crypto = require('crypto');
const { Resend } = require('resend');
const {
  emailProviderApiKey,
  inspectEmailConfiguration
} = require('./email-config');

function isProduction() {
  return process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
}

function configurationError() {
  const configuration = inspectEmailConfiguration();
  const error = new Error(`Chức năng gửi email chưa được cấu hình cho ${configuration.provider}.`);
  error.code = 'EMAIL_NOT_CONFIGURED';
  return error;
}

function assertEmailConfigured() {
  const configuration = inspectEmailConfiguration();
  if (isProduction() && !configuration.valid) throw configurationError();
  return configuration;
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

function subscriptionExpiryEmailHtml({ planName, daysRemaining, endsOn, appUrl }) {
  const safePlan = escapeHtml(planName);
  const safeEndsOn = escapeHtml(endsOn);
  const safeAppUrl = escapeHtml(appUrl);
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#172033;max-width:560px;margin:0 auto">
      <h1 style="font-size:24px;margin-bottom:12px">Gói TrọBill sắp hết hạn</h1>
      <p>Gói <strong>${safePlan}</strong> của bạn còn ${daysRemaining} ngày và sẽ hết hạn vào <strong>${safeEndsOn}</strong>.</p>
      <p>Hãy gia hạn trước ngày này để tiếp tục cập nhật dữ liệu. Sau thời gian ân hạn, tài khoản vẫn xem và xuất được dữ liệu nhưng không thể chỉnh sửa.</p>
      <p style="margin:28px 0">
        <a href="${safeAppUrl}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#6c63ff;color:#fff;text-decoration:none;font-weight:700">
          Mở TrọBill
        </a>
      </p>
    </div>`;
}

function rentInvoiceEmailHtml({ tenantName, roomName, period, message, invoiceUrl }) {
  const safeTenantName = escapeHtml(tenantName || 'anh/chị');
  const safeRoomName = escapeHtml(roomName || 'Phòng');
  const safePeriod = escapeHtml(period || '');
  const safeMessage = escapeHtml(message || '').replace(/\n/g, '<br>');
  const safeInvoiceUrl = escapeHtml(invoiceUrl);
  return `
    <div style="font-family:Arial,sans-serif;line-height:1.6;color:#172033;max-width:620px;margin:0 auto">
      <h1 style="font-size:24px;margin-bottom:6px">Hóa đơn ${safeRoomName}</h1>
      <p style="margin-top:0;color:#667085">Kỳ ${safePeriod}</p>
      <p>Chào ${safeTenantName},</p>
      <div style="padding:16px;border:1px solid #d9e2f2;border-radius:12px;background:#f8fafc;white-space:normal">${safeMessage}</div>
      <p style="margin:28px 0">
        <a href="${safeInvoiceUrl}" style="display:inline-block;padding:12px 20px;border-radius:10px;background:#6c63ff;color:#fff;text-decoration:none;font-weight:700">
          Xem hóa đơn bảo mật
        </a>
      </p>
      <p style="font-size:12px;color:#667085">Liên kết có thời hạn và có thể được chủ trọ thu hồi.</p>
      <p style="font-size:12px;color:#667085;word-break:break-all">${safeInvoiceUrl}</p>
    </div>`;
}

function parseSender(value) {
  const sender = String(value || '').trim();
  const match = sender.match(/^(.*?)\s*<([^<>]+)>$/);
  if (!match) return { email: sender };

  const name = match[1].trim().replace(/^"|"$/g, '');
  return {
    email: match[2].trim(),
    ...(name ? { name } : {})
  };
}

async function sendWithBrevo({ apiKey, from, to, subject, html, text, idempotencyKey }) {
  let response;
  try {
    response = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'api-key': apiKey,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        sender: parseSender(from),
        to: [{ email: to }],
        subject,
        htmlContent: html,
        textContent: text,
        headers: { 'X-Entity-Ref-ID': idempotencyKey }
      }),
      signal: AbortSignal.timeout(10000)
    });
  } catch (_) {
    const error = new Error('Không kết nối được dịch vụ gửi email Brevo.');
    error.code = 'EMAIL_SEND_FAILED';
    throw error;
  }

  let data = {};
  try {
    data = await response.json();
  } catch (_) {
    // Brevo đôi khi trả body trống ở lỗi gateway; status vẫn đủ để phân loại.
  }

  if (!response.ok) {
    const error = new Error(`Brevo từ chối gửi email (HTTP ${response.status}).`);
    error.code = 'EMAIL_SEND_FAILED';
    throw error;
  }

  return { id: data.messageId };
}

async function sendWithResend({ apiKey, from, to, subject, html, text, idempotencyKey }) {
  const resend = new Resend(apiKey);
  const { data, error } = await resend.emails.send(
    { from, to: [to], subject, html, text },
    { idempotencyKey }
  );

  if (error) {
    const sendError = new Error(error.message || 'Resend từ chối gửi email.');
    sendError.code = 'EMAIL_SEND_FAILED';
    throw sendError;
  }

  return { id: data && data.id };
}

async function sendTransactionalEmail(message) {
  const configuration = assertEmailConfigured();
  const apiKey = emailProviderApiKey(configuration.provider);
  if (!apiKey) return null;

  if (configuration.provider === 'brevo') {
    return sendWithBrevo({ ...message, apiKey });
  }
  if (configuration.provider === 'resend') {
    return sendWithResend({ ...message, apiKey });
  }
  throw configurationError();
}

async function sendVerificationEmail({ email, token, userId, req }) {
  const url = verificationUrl(req, token);
  const configuration = assertEmailConfigured();
  const apiKey = emailProviderApiKey(configuration.provider);
  if (!apiKey) {
    console.info(`✉️  Link xác minh email local cho ${email}: ${url}`);
    return { delivered: false, development: true, verificationUrl: url };
  }

  const from = String(process.env.EMAIL_FROM || 'TrọBill <onboarding@resend.dev>').trim();
  const tokenFingerprint = crypto.createHash('sha256').update(token).digest('hex').slice(0, 24);
  const delivery = await sendTransactionalEmail({
    from,
    to: email,
    subject: 'Xác minh địa chỉ email TrọBill',
    html: verificationEmailHtml(url),
    text: `Xác minh email TrọBill bằng liên kết sau (có hiệu lực 24 giờ):\n\n${url}`,
    idempotencyKey: `verify-email-${userId}-${tokenFingerprint}`
  });

  return { delivered: true, emailId: delivery && delivery.id, verificationUrl: url };
}

async function sendPasswordResetEmail({ email, token, userId, req }) {
  const url = passwordResetUrl(req, token);
  const configuration = assertEmailConfigured();
  const apiKey = emailProviderApiKey(configuration.provider);
  if (!apiKey) {
    console.info(`✉️  Link đặt lại mật khẩu local cho ${email}: ${url}`);
    return { delivered: false, development: true, passwordResetUrl: url };
  }

  const from = String(process.env.EMAIL_FROM || 'TrọBill <onboarding@resend.dev>').trim();
  const tokenFingerprint = crypto.createHash('sha256').update(token).digest('hex').slice(0, 24);
  const delivery = await sendTransactionalEmail({
    from,
    to: email,
    subject: 'Đặt lại mật khẩu TrọBill',
    html: passwordResetEmailHtml(url),
    text: `Đặt lại mật khẩu TrọBill bằng liên kết sau (có hiệu lực 30 phút):\n\n${url}`,
    idempotencyKey: `password-reset-${userId}-${tokenFingerprint}`
  });

  return { delivered: true, emailId: delivery && delivery.id, passwordResetUrl: url };
}

async function sendSubscriptionExpiryEmail({
  email,
  planName,
  daysRemaining,
  endsOn,
  notificationId
}) {
  const appUrl = String(process.env.APP_URL || '').trim().replace(/\/+$/, '');
  const configuration = assertEmailConfigured();
  const apiKey = emailProviderApiKey(configuration.provider);
  if (!apiKey) {
    return { delivered: false, development: true };
  }

  const from = String(process.env.EMAIL_FROM || 'TrọBill <onboarding@resend.dev>').trim();
  const delivery = await sendTransactionalEmail({
    from,
    to: email,
    subject: `Gói TrọBill còn ${daysRemaining} ngày`,
    html: subscriptionExpiryEmailHtml({ planName, daysRemaining, endsOn, appUrl }),
    text: `Gói ${planName} của bạn còn ${daysRemaining} ngày và sẽ hết hạn vào ${endsOn}. Mở TrọBill: ${appUrl}`,
    idempotencyKey: `subscription-expiry-${notificationId}`
  });
  return { delivered: true, emailId: delivery && delivery.id };
}

async function sendRentInvoiceEmail({
  email,
  tenantName,
  roomName,
  period,
  templateType,
  message,
  invoiceUrl,
  idempotencyKey
}) {
  const configuration = assertEmailConfigured();
  const apiKey = emailProviderApiKey(configuration.provider);
  if (!apiKey) {
    return { delivered: false, development: true };
  }

  const reminder = templateType === 'reminder';
  const from = String(process.env.EMAIL_FROM || 'TrọBill <onboarding@resend.dev>').trim();
  const delivery = await sendTransactionalEmail({
    from,
    to: email,
    subject: reminder
      ? `Nhắc thanh toán ${roomName} · ${period}`
      : `Hóa đơn ${roomName} · ${period}`,
    html: rentInvoiceEmailHtml({ tenantName, roomName, period, message, invoiceUrl }),
    text: `${message}\n\nXem hóa đơn bảo mật: ${invoiceUrl}`,
    idempotencyKey
  });
  return { delivered: true, emailId: delivery && delivery.id };
}

module.exports = {
  assertEmailConfigured,
  rentInvoiceEmailHtml,
  sendRentInvoiceEmail,
  sendSubscriptionExpiryEmail,
  sendVerificationEmail,
  sendPasswordResetEmail,
  subscriptionExpiryEmailHtml
};
