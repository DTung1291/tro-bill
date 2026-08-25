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

  function number(value) {
    return new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 3 }).format(Number(value) || 0);
  }

  function appendDetailRow(list, label, formula, amountVnd, options = {}) {
    const row = document.createElement('div');
    row.className = 'public-invoice-detail-row';
    const main = document.createElement('div');
    const title = document.createElement('strong');
    const explanation = document.createElement('span');
    const amount = document.createElement('strong');
    title.textContent = label;
    explanation.textContent = formula;
    amount.textContent = `${options.negative ? '−' : ''}${money.format(Number(amountVnd) || 0)}`;
    if (options.negative) amount.className = 'is-discount';
    main.append(title, explanation);
    row.append(main, amount);
    list.appendChild(row);
  }

  function renderDetails(details) {
    const section = document.getElementById('invoice-details');
    const list = document.getElementById('invoice-detail-list');
    const utilityOnly = document.getElementById('invoice-utility-only');
    list.replaceChildren();
    if (!details || !details.rent || !details.electricity || !details.water) {
      section.hidden = true;
      return;
    }
    const rent = details.rent;
    const electricity = details.electricity;
    const water = details.water;
    const services = details.services || {};
    const adjustments = details.adjustments || {};
    const rentFormula = rent.startsAfterPeriod
      ? 'Chưa bắt đầu thuê trong kỳ này'
      : (rent.prorated
        ? `${money.format(rent.basePriceVnd)} ÷ ${rent.daysInMonth} ngày × ${rent.chargedDays} ngày`
        : 'Cố định theo tháng');
    appendDetailRow(list, 'Tiền phòng', rentFormula, rent.amountVnd);
    appendDetailRow(
      list,
      'Tiền điện',
      `${number(electricity.previousReading)} → ${number(electricity.currentReading)} = ${number(electricity.units)} kWh × ${money.format(electricity.rateVnd)}`,
      electricity.amountVnd
    );
    const waterFormula = water.billingType === 'cubic_meter'
      ? `${number(water.previousReading)} → ${number(water.currentReading)} = ${number(water.units)} m³ × ${money.format(water.rateVnd)}`
      : `${number(water.units)} người × ${money.format(water.rateVnd)}`;
    appendDetailRow(list, 'Tiền nước', waterFormula, water.amountVnd);
    if (Number(services.trashVnd) > 0) {
      appendDetailRow(list, 'Phí rác', 'Dịch vụ trong tháng', services.trashVnd);
    }
    if (Number(services.wifiVnd) > 0) {
      appendDetailRow(list, 'Phí Wifi', 'Dịch vụ trong tháng', services.wifiVnd);
    }
    if (Number(services.managementVnd) > 0) {
      appendDetailRow(list, 'Phí quản lý & dịch vụ', 'Dịch vụ trong tháng', services.managementVnd);
    }
    if (Number(adjustments.surchargeVnd) > 0) {
      appendDetailRow(list, 'Phụ thu', 'Điều chỉnh kỳ này', adjustments.surchargeVnd);
    }
    if (Number(adjustments.lateFeeVnd) > 0) {
      appendDetailRow(list, 'Phí chậm thanh toán', 'Điều chỉnh kỳ này', adjustments.lateFeeVnd);
    }
    if (Number(adjustments.discountVnd) > 0) {
      appendDetailRow(list, 'Giảm giá', 'Điều chỉnh kỳ này', adjustments.discountVnd, { negative: true });
    }
    utilityOnly.hidden = details.utilityOnly !== true;
    section.hidden = false;
  }

  function renderMeterPhotos(meterPhotos) {
    const section = document.getElementById('invoice-meter-photos');
    const entries = [
      ['electricity', 'invoice-electricity-photo', 'invoice-electricity-photo-img'],
      ['water', 'invoice-water-photo', 'invoice-water-photo-img']
    ];
    let visibleCount = 0;
    for (const [type, figureId, imageId] of entries) {
      const figure = document.getElementById(figureId);
      const image = document.getElementById(imageId);
      const dataUrl = String(meterPhotos?.[type] || '');
      const valid = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(dataUrl);
      if (valid) {
        image.src = dataUrl;
        figure.hidden = false;
        visibleCount += 1;
      } else {
        image.removeAttribute('src');
        figure.hidden = true;
      }
    }
    section.hidden = visibleCount === 0;
  }

  function renderPayment(payment) {
    const section = document.getElementById('invoice-payment');
    const image = document.getElementById('invoice-payment-qr');
    const imageUrl = String(payment?.imageUrl || '');
    const valid = payment?.settlementMode === 'direct_to_landlord'
      && Number(payment?.amountVnd) > 0
      && imageUrl.startsWith('https://img.vietqr.io/image/');
    if (!valid) {
      image.removeAttribute('src');
      section.hidden = true;
      return;
    }
    image.src = imageUrl;
    text('invoice-payment-amount', money.format(Number(payment.amountVnd)));
    text('invoice-payment-owner', payment.ownerName || '—');
    text('invoice-payment-account', `${payment.bankId || '—'} · ${payment.accountNumber || '—'}`);
    text('invoice-payment-content', payment.transferContent || '—');
    section.hidden = false;
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
    renderDetails(data.details || {});
    renderMeterPhotos(data.meterPhotos || {});
    renderPayment(data.payment || null);
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
