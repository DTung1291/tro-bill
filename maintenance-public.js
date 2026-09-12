'use strict';

(() => {
  const tokenPattern = /^tmrq_[A-Za-z0-9_-]{43}$/;
  let portalToken = '';
  let pendingIdempotencyKey = '';
  let requests = [];

  const categoryLabels = {
    electricity: 'Điện',
    water: 'Nước',
    appliance: 'Thiết bị / nội thất',
    structure: 'Kết cấu phòng',
    security: 'An ninh / khóa cửa',
    other: 'Khác'
  };
  const urgencyLabels = {
    low: 'Có thể chờ',
    normal: 'Bình thường',
    high: 'Cần xử lý sớm',
    emergency: 'Khẩn cấp'
  };
  const urgencyGuidance = {
    low: 'Sự cố nhỏ, chưa ảnh hưởng đến sinh hoạt và có thể sắp xếp xử lý sau.',
    normal: 'Sự cố chưa ảnh hưởng nghiêm trọng đến sinh hoạt hoặc an toàn.',
    high: 'Sự cố đang ảnh hưởng đến sinh hoạt và cần được chủ trọ kiểm tra sớm.',
    emergency: 'Nếu có nguy hiểm tức thời, hãy rời khu vực và gọi chủ trọ hoặc số khẩn cấp trước khi gửi biểu mẫu.'
  };
  const statusLabels = {
    new: 'Mới gửi',
    acknowledged: 'Đã tiếp nhận',
    in_progress: 'Đang xử lý',
    resolved: 'Đã hoàn tất',
    cancelled: 'Đã hủy'
  };

  function setHidden(id, hidden) {
    document.getElementById(id).hidden = hidden;
  }

  function dateTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('vi-VN');
  }

  function showPageError(message) {
    setHidden('maintenance-loading', true);
    setHidden('maintenance-content', true);
    document.getElementById('maintenance-error-message').textContent = message;
    setHidden('maintenance-error', false);
  }

  function requestBadge(text, modifier = '') {
    const badge = document.createElement('span');
    badge.className = `maintenance-badge${modifier ? ` maintenance-badge--${modifier}` : ''}`;
    badge.textContent = text;
    return badge;
  }

  function renderNextStep() {
    const panel = document.getElementById('maintenance-next-step');
    const icon = document.getElementById('maintenance-next-step-icon');
    const openRequests = requests.filter(request => ['new', 'acknowledged', 'in_progress'].includes(request.status));
    const activeRequest = openRequests.find(request => request.status === 'in_progress')
      || openRequests.find(request => request.status === 'acknowledged')
      || openRequests[0];
    let status = 'ready';
    let iconText = '+';
    let title = 'Sẵn sàng tiếp nhận yêu cầu';
    let description = 'Mô tả sự cố bên dưới để chủ trọ có đủ thông tin kiểm tra.';

    if (activeRequest?.status === 'in_progress') {
      status = 'active';
      iconText = '↻';
      title = `${activeRequest.code || 'Yêu cầu'} đang được xử lý`;
      description = openRequests.length > 1
        ? `Chủ trọ đang xử lý yêu cầu này. Bạn còn ${openRequests.length - 1} yêu cầu đang mở.`
        : 'Chủ trọ đang xử lý yêu cầu này. Theo dõi trạng thái trong lịch sử bên dưới.';
    } else if (activeRequest?.status === 'acknowledged') {
      status = 'active';
      iconText = '✓';
      title = `${activeRequest.code || 'Yêu cầu'} đã được tiếp nhận`;
      description = 'Chủ trọ đã tiếp nhận và sẽ cập nhật khi bắt đầu xử lý.';
    } else if (activeRequest) {
      status = 'active';
      iconText = '⌛';
      title = `${activeRequest.code || 'Yêu cầu'} đang chờ tiếp nhận`;
      description = 'Yêu cầu đã gửi thành công. Chủ trọ sẽ cập nhật trạng thái sau khi kiểm tra.';
    } else if (requests.length > 0) {
      status = 'complete';
      iconText = '✓';
      title = 'Không còn yêu cầu đang xử lý';
      description = 'Các yêu cầu trước đã hoàn tất hoặc được đóng. Bạn có thể gửi yêu cầu mới khi cần.';
    }

    panel.dataset.status = status;
    icon.textContent = iconText;
    document.getElementById('maintenance-next-step-title').textContent = title;
    document.getElementById('maintenance-next-step-description').textContent = description;
  }

  function renderUrgencyGuidance() {
    const urgency = document.getElementById('maintenance-urgency').value;
    const guidance = document.getElementById('maintenance-urgency-guidance');
    guidance.dataset.urgency = urgency;
    guidance.textContent = urgencyGuidance[urgency] || urgencyGuidance.normal;
  }

  function renderRequests() {
    const list = document.getElementById('maintenance-request-list');
    const count = document.getElementById('maintenance-request-count');
    list.replaceChildren();
    count.textContent = `${requests.length} yêu cầu`;
    renderNextStep();
    if (!requests.length) {
      const empty = document.createElement('p');
      empty.className = 'maintenance-empty';
      empty.textContent = 'Chưa có yêu cầu nào được gửi.';
      list.appendChild(empty);
      return;
    }
    for (const request of requests) {
      const item = document.createElement('article');
      const head = document.createElement('div');
      const title = document.createElement('strong');
      const submitted = document.createElement('time');
      const badges = document.createElement('div');
      const description = document.createElement('p');
      item.className = 'maintenance-request-item';
      item.dataset.status = request.status || '';
      head.className = 'maintenance-request-head';
      badges.className = 'maintenance-badges';
      title.textContent = request.code || 'Yêu cầu';
      submitted.textContent = dateTime(request.submittedAt);
      description.textContent = request.description || '';
      head.append(title, submitted);
      badges.append(
        requestBadge(categoryLabels[request.category] || request.category),
        requestBadge(urgencyLabels[request.urgency] || request.urgency, request.urgency),
        requestBadge(statusLabels[request.status] || request.status, request.status)
      );
      item.append(head, badges, description);
      if (request.contactPhone || request.availableTime) {
        const contact = document.createElement('p');
        contact.className = 'maintenance-request-contact';
        contact.textContent = [
          request.contactPhone ? `Liên hệ: ${request.contactPhone}` : '',
          request.availableTime ? `Có thể kiểm tra: ${request.availableTime}` : ''
        ].filter(Boolean).join(' · ');
        item.appendChild(contact);
      }
      list.appendChild(item);
    }
  }

  async function apiRequest(url, body) {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // Preserve same-origin platform cookies such as Vercel Preview Protection.
      // The public maintenance API itself does not require a Trọ Bill session.
      credentials: 'same-origin',
      cache: 'no-store',
      body: JSON.stringify(body)
    });
    let data = null;
    try { data = await response.json(); } catch (_) {}
    if (!response.ok) {
      const serverMessage = typeof data?.error === 'string' ? data.error : '';
      const error = new Error(serverMessage || 'Không kết nối được máy chủ');
      error.code = data?.code || '';
      throw error;
    }
    return data;
  }

  function tokenFromFragment() {
    const params = new URLSearchParams(location.hash.slice(1));
    const token = String(params.get('t') || '').trim();
    history.replaceState(null, '', location.pathname);
    return token;
  }

  async function resolvePortal() {
    portalToken = tokenFromFragment();
    if (!tokenPattern.test(portalToken)) {
      showPageError('Liên kết báo sửa không hợp lệ. Vui lòng xin lại liên kết từ chủ trọ.');
      return;
    }
    try {
      const data = await apiRequest('/api/public/maintenance-portals/resolve', {
        token: portalToken
      });
      document.getElementById('maintenance-room').textContent = data.portal?.roomName || 'Phòng thuê';
      document.getElementById('maintenance-contract').textContent = data.portal?.contractCode || '—';
      document.getElementById('maintenance-expiry').textContent = dateTime(data.portal?.expiresAt);
      requests = Array.isArray(data.requests) ? data.requests : [];
      renderRequests();
      renderUrgencyGuidance();
      setHidden('maintenance-loading', true);
      setHidden('maintenance-error', true);
      setHidden('maintenance-content', false);
      document.getElementById('maintenance-description').focus();
    } catch (error) {
      showPageError(error.message || 'Liên kết không còn sử dụng được.');
    }
  }

  function nextIdempotencyKey() {
    if (!pendingIdempotencyKey) pendingIdempotencyKey = crypto.randomUUID();
    return pendingIdempotencyKey;
  }

  async function submitRequest(event) {
    event.preventDefault();
    const form = event.currentTarget;
    const submit = document.getElementById('maintenance-submit');
    const message = document.getElementById('maintenance-form-message');
    const defaultSubmitLabel = submit.textContent;
    message.hidden = true;
    submit.disabled = true;
    submit.textContent = 'Đang gửi yêu cầu…';
    try {
      const data = await apiRequest('/api/public/maintenance-portals/requests', {
        token: portalToken,
        category: document.getElementById('maintenance-category').value,
        urgency: document.getElementById('maintenance-urgency').value,
        description: document.getElementById('maintenance-description').value,
        contactPhone: document.getElementById('maintenance-phone').value,
        availableTime: document.getElementById('maintenance-available-time').value,
        idempotencyKey: nextIdempotencyKey()
      });
      const existingIndex = requests.findIndex(item => item.code === data.request?.code);
      if (existingIndex >= 0) requests[existingIndex] = data.request;
      else if (data.request) requests.unshift(data.request);
      renderRequests();
      pendingIdempotencyKey = '';
      form.reset();
      document.getElementById('maintenance-urgency').value = 'normal';
      renderUrgencyGuidance();
      message.textContent = data.duplicate
        ? `Yêu cầu ${data.request.code} đã được ghi nhận trước đó.`
        : `Đã gửi yêu cầu ${data.request.code} cho chủ trọ.`;
      message.dataset.error = 'false';
      message.hidden = false;
      message.focus({ preventScroll: true });
    } catch (error) {
      message.textContent = error.message || 'Không gửi được yêu cầu. Vui lòng thử lại.';
      message.dataset.error = 'true';
      message.hidden = false;
      message.focus({ preventScroll: true });
    } finally {
      submit.disabled = false;
      submit.textContent = defaultSubmitLabel;
    }
  }

  document.getElementById('maintenance-request-form').addEventListener('submit', submitRequest);
  document.getElementById('maintenance-urgency').addEventListener('change', renderUrgencyGuidance);
  renderUrgencyGuidance();
  void resolvePortal();
})();
