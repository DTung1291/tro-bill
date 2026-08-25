'use strict';

(() => {
  const loading = document.getElementById('invoice-loading');
  const errorPanel = document.getElementById('invoice-error');
  const content = document.getElementById('invoice-content');
  const money = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' });

  function text(id, value) {
    const element = document.getElementById(id);
    if (element) element.textContent = String(value ?? '—');
  }

  function dateTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime())
      ? '—'
      : date.toLocaleString('vi-VN', { dateStyle: 'short', timeStyle: 'short' });
  }

  function periodLabel(period) {
    const match = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
    return match ? `Tháng ${Number(match[2])}/${match[1]}` : '—';
  }

  function showError(message) {
    loading.hidden = true;
    content.hidden = true;
    errorPanel.hidden = false;
    text('invoice-error-message', message || 'Liên kết không hợp lệ hoặc đã hết hạn.');
  }

  function render(data) {
    const invoice = data.invoice || {};
    const labels = { unpaid: 'Chưa thanh toán', partial: 'Thanh toán một phần', paid: 'Đã thanh toán' };
    text('invoice-room', invoice.roomName || 'Phòng trọ');
    text('invoice-period', periodLabel(invoice.period));
    text('invoice-due-date', invoice.dueDate || '—');
    text('invoice-transfer-content', invoice.transferContent || '—');
    text('invoice-link-expiry', dateTime(data.link?.expiresAt));
    text('invoice-total', money.format(Number(invoice.invoiceTotalVnd) || 0));
    text('invoice-paid', money.format(Number(invoice.paidAmountVnd) || 0));
    text('invoice-remaining', money.format(Number(invoice.remainingVnd) || 0));
    const status = document.getElementById('invoice-status');
    status.textContent = labels[invoice.status] || 'Chưa thanh toán';
    status.dataset.status = invoice.status || 'unpaid';
    loading.hidden = true;
    errorPanel.hidden = true;
    content.hidden = false;
  }

  async function boot() {
    const params = new URLSearchParams(location.hash.replace(/^#/, ''));
    const token = params.get('t') || '';
    history.replaceState(null, '', location.pathname);
    if (!/^tbril_[A-Za-z0-9_-]{43}$/.test(token)) {
      showError('Liên kết không hợp lệ hoặc thiếu token bảo mật.');
      return;
    }
    try {
      const response = await fetch('/api/public/rent-invoice-links/resolve', {
        method: 'POST',
        credentials: 'omit',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token })
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Liên kết không hợp lệ hoặc đã hết hạn.');
      render(data);
    } catch (error) {
      showError(error.message);
    }
  }

  boot();
})();
