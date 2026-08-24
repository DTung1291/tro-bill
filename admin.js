/**
 * TrọBill — admin.js
 * Trang quản trị: liệt kê user, xem dữ liệu, xoá, reset mật khẩu, bật/tắt admin.
 * Yêu cầu cookie phiên của một tài khoản có is_admin = true.
 */
'use strict';

(() => {
  const $ = (sel) => document.querySelector(sel);
  const tbody = $('#admin-tbody');
  const table = $('#admin-table');
  const msgEl = $('#admin-msg');

  function showMsg(text, isError) {
    msgEl.textContent = text;
    msgEl.className = 'admin-msg' + (isError ? ' admin-msg-error' : '');
    msgEl.hidden = false;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
    );
  }

  const fmtVND = (n) => (Number(n) || 0).toLocaleString('vi-VN') + '₫';
  const fmtDate = (d) => {
    if (!d) return '';
    try { return new Date(d).toLocaleString('vi-VN'); } catch (_) { return String(d); }
  };

  async function gotoLogin() {
    try {
      await API.logout();
      location.replace('index.html');
    } catch (e) {
      showMsg('Không thể đăng xuất, vui lòng thử lại.', true);
    }
  }

  // ---------- Bảng user ----------
  async function loadUsers() {
    let data;
    try {
      data = await API.admin.listUsers();
    } catch (e) {
      if (e.code === 401) return gotoLogin();
      if (e.code === 403) {
        showMsg('Tài khoản này không có quyền admin.', true);
        return;
      }
      return showMsg(e.message || 'Không tải được danh sách', true);
    }
    renderUsers(data.users || []);
  }

  function renderUsers(users) {
    tbody.innerHTML = '';
    for (const u of users) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${u.id}</td>
        <td>${esc(u.email)}</td>
        <td>${u.roomCount}</td>
        <td>${u.historyCount}</td>
        <td>${u.isAdmin ? '✔' : ''}</td>
        <td>${esc(fmtDate(u.createdAt))}</td>
        <td class="admin-actions"></td>`;
      const cell = tr.querySelector('.admin-actions');
      cell.appendChild(btn('Xem', 'admin-btn', () => viewUser(u)));
      cell.appendChild(btn('Đổi MK', 'admin-btn-ghost', () => resetPw(u)));
      cell.appendChild(
        btn(u.isAdmin ? 'Gỡ admin' : 'Cấp admin', 'admin-btn-ghost', () => toggleAdmin(u))
      );
      cell.appendChild(btn('Xoá', 'admin-btn-danger', () => removeUser(u)));
      tbody.appendChild(tr);
    }
    table.hidden = users.length === 0;
    if (users.length === 0) showMsg('Chưa có người dùng nào.', false);
    else msgEl.hidden = true;
  }

  function btn(label, cls, onClick) {
    const b = document.createElement('button');
    b.textContent = label;
    b.className = cls;
    b.addEventListener('click', onClick);
    return b;
  }

  // ---------- Thao tác ----------
  async function removeUser(u) {
    if (!confirm(`Xoá vĩnh viễn user "${u.email}" và TOÀN BỘ dữ liệu? Không thể hoàn tác.`)) return;
    const reason = prompt('Nhập lý do xóa tài khoản (tối thiểu 10 ký tự):');
    if (reason == null) return;
    try {
      await API.admin.deleteUser(u.id, reason);
      showMsg(`Đã xoá ${u.email}.`, false);
      loadUsers();
    } catch (e) {
      handleErr(e);
    }
  }

  async function resetPw(u) {
    const pw = prompt(`Mật khẩu mới cho "${u.email}" (tối thiểu 6 ký tự):`);
    if (pw == null) return;
    try {
      await API.admin.resetPassword(u.id, pw);
      showMsg(`Đã đổi mật khẩu cho ${u.email}.`, false);
    } catch (e) {
      handleErr(e);
    }
  }

  async function toggleAdmin(u) {
    const next = !u.isAdmin;
    if (!confirm(`${next ? 'Cấp' : 'Gỡ'} quyền admin cho "${u.email}"?`)) return;
    try {
      await API.admin.setAdmin(u.id, next);
      loadUsers();
    } catch (e) {
      handleErr(e);
    }
  }

  function handleErr(e) {
    if (e.code === 401) return gotoLogin();
    showMsg(e.message || 'Lỗi thao tác', true);
  }

  // ---------- Modal xem dữ liệu ----------
  const modal = $('#admin-modal');
  const modalBody = $('#admin-modal-body');
  const modalTitle = $('#admin-modal-title');

  async function viewUser(u) {
    modalTitle.textContent = `Dữ liệu: ${u.email}`;
    modalBody.innerHTML = '<p class="admin-msg">Đang tải…</p>';
    modal.hidden = false;
    let data;
    try {
      data = await API.admin.getUserState(u.id);
    } catch (e) {
      modalBody.innerHTML = `<p class="admin-msg admin-msg-error">${esc(e.message || 'Lỗi tải')}</p>`;
      return;
    }
    renderState(data.state || {}, u);
  }

  function renderState(state, user) {
    const rooms = state.rooms || [];
    const history = state.history || [];
    let html = '';

    html += `<h3>Phòng (${rooms.length})</h3>`;
    if (rooms.length === 0) {
      html += '<p class="admin-muted">Chưa có phòng.</p>';
    } else {
      html += '<table class="admin-subtable"><thead><tr>' +
        '<th>Tên</th><th>Giá thuê</th><th>Người thuê</th></tr></thead><tbody>';
      for (const r of rooms) {
        const tnames = (r.tenants || []).map((t) => esc(t.fullName || '(chưa tên)')).join(', ');
        html += `<tr><td>${esc(r.name)}</td><td>${fmtVND(r.rentPrice)}</td><td>${tnames || '—'}</td></tr>`;
      }
      html += '</tbody></table>';
    }

    const tenants = rooms.flatMap((room) => (room.tenants || []).map((tenant) => ({
      ...tenant,
      roomName: room.name
    })));
    html += `<h3>Khách thuê (${tenants.length})</h3>`;
    if (tenants.length === 0) {
      html += '<p class="admin-muted">Chưa có khách thuê.</p>';
    } else {
      html += '<table class="admin-subtable"><thead><tr>' +
        '<th>Phòng</th><th>Họ tên</th><th>CCCD</th><th>Hỗ trợ</th></tr></thead><tbody>';
      for (const tenant of tenants) {
        html += `<tr>` +
          `<td>${esc(tenant.roomName)}</td>` +
          `<td>${esc(tenant.fullName || '—')}</td>` +
          `<td class="admin-cccd-value">${esc(tenant.cccd || '—')}</td>` +
          `<td><button type="button" class="admin-btn-ghost admin-reveal-cccd" data-tenant-id="${esc(tenant.id)}">Xem đầy đủ</button></td>` +
          `</tr>`;
      }
      html += '</tbody></table>';
    }

    html += `<h3>Lịch sử đã lưu (${history.length})</h3>`;
    if (history.length === 0) {
      html += '<p class="admin-muted">Chưa có lịch sử.</p>';
    } else {
      html += '<table class="admin-subtable"><thead><tr>' +
        '<th>Tháng</th><th>Số bill</th><th>Tổng thu</th></tr></thead><tbody>';
      for (const h of history) {
        const total = (h.bills || []).reduce((s, b) => s + (Number(b.total) || 0), 0);
        html += `<tr><td>${esc(h.period)}</td><td>${(h.bills || []).length}</td><td>${fmtVND(total)}</td></tr>`;
      }
      html += '</tbody></table>';
    }
    modalBody.innerHTML = html;

    modalBody.querySelectorAll('.admin-reveal-cccd').forEach((button) => {
      button.addEventListener('click', async () => {
        const reason = prompt(
          'Nhập lý do hỗ trợ cụ thể để xem CCCD đầy đủ (tối thiểu 10 ký tự):'
        );
        if (reason == null) return;
        const normalizedReason = reason.trim();
        if (normalizedReason.length < 10) {
          alert('Lý do hỗ trợ phải có ít nhất 10 ký tự. Vui lòng mô tả cụ thể hơn.');
          return;
        }
        button.disabled = true;
        try {
          const revealed = await API.admin.revealTenantCccd(
            user.id,
            button.dataset.tenantId,
            normalizedReason
          );
          const valueCell = button.closest('tr').querySelector('.admin-cccd-value');
          valueCell.textContent = revealed.cccd || '—';
          button.textContent = 'Đã ghi nhật ký';
          await loadSensitiveAccessLogs();
        } catch (error) {
          button.disabled = false;
          if (error.code === 401) return gotoLogin();
          alert(error.message || 'Không thể xem CCCD. Vui lòng thử lại.');
        }
      });
    });
  }

  async function loadSensitiveAccessLogs() {
    const tableEl = $('#sensitive-audit-table');
    const bodyEl = $('#sensitive-audit-tbody');
    const emptyEl = $('#sensitive-audit-empty');
    try {
      const result = await API.admin.listSensitiveAccessLogs(100);
      const logs = result.logs || [];
      bodyEl.innerHTML = logs.map((log) => `
        <tr>
          <td>${esc(fmtDate(log.createdAt))}</td>
          <td>${esc(log.adminEmail)}</td>
          <td>${esc(log.targetEmail)}</td>
          <td>${esc(log.tenantName || log.tenantId)}</td>
          <td>${esc(log.reason)}</td>
          <td><code>${esc(log.ipFingerprint || '—')}</code></td>
        </tr>`).join('');
      tableEl.hidden = logs.length === 0;
      emptyEl.hidden = logs.length !== 0;
    } catch (error) {
      tableEl.hidden = true;
      emptyEl.hidden = false;
      emptyEl.textContent = error.message || 'Không tải được nhật ký truy cập';
    }
  }

  // ---------- Cấu hình ủng hộ (toàn cục) ----------
  const PREDEFINED_BANKS = ['MB', 'VCB', 'TCB', 'BIDV', 'ICB', 'VBA', 'ACB', 'TPB', 'VPB', 'STB', 'VIB'];
  const cfgSel = $('#cfg-bank-select');
  const cfgCustomWrap = $('#cfg-custom-wrap');
  const cfgCustom = $('#cfg-bank-custom');
  const cfgAccount = $('#cfg-account');
  const cfgOwner = $('#cfg-owner');
  const cfgMessage = $('#cfg-message');

  function fillBankFields(select, customWrap, customInput, bankId) {
    if (bankId === '') {
      select.value = '';
      customWrap.hidden = true;
    } else if (PREDEFINED_BANKS.includes(bankId)) {
      select.value = bankId;
      customWrap.hidden = true;
    } else {
      select.value = 'custom';
      customInput.value = bankId;
      customWrap.hidden = false;
    }
  }

  function fillConfig(cfg) {
    const bankId = cfg.donateBankId || '';
    fillBankFields(cfgSel, cfgCustomWrap, cfgCustom, bankId);
    cfgAccount.value = cfg.donateAccount || '';
    cfgOwner.value = cfg.donateOwnerName || '';
    cfgMessage.value = cfg.donateMessage || 'Ung ho';
  }

  cfgSel.addEventListener('change', () => {
    cfgCustomWrap.hidden = cfgSel.value !== 'custom';
    if (cfgSel.value === 'custom') { cfgCustom.value = ''; cfgCustom.focus(); }
  });

  async function loadConfig() {
    try {
      const cfg = await API.admin.getConfig();
      fillConfig(cfg);
      fillSubscriptionPaymentConfig(cfg);
    } catch (e) { /* dùng giá trị trống */ }
  }

  $('#cfg-save').addEventListener('click', async () => {
    const selVal = cfgSel.value;
    const bankId = selVal === 'custom' ? cfgCustom.value.trim().toUpperCase() : selVal;
    const account = cfgAccount.value.trim();
    if (account && !bankId) {
      showMsg('Vui lòng chọn hoặc nhập mã ngân hàng.', true);
      return;
    }
    try {
      const saved = await API.admin.setConfig({
        donateBankId: bankId,
        donateAccount: account,
        donateOwnerName: cfgOwner.value.trim(),
        donateMessage: cfgMessage.value.trim() || 'Ung ho'
      });
      fillConfig(saved);
      showMsg('Đã lưu cấu hình ủng hộ.', false);
    } catch (e) {
      handleErr(e);
    }
  });

  // ---------- Tài khoản nhận thanh toán gói TrọBill ----------
  const subscriptionBankSel = $('#subscription-bank-select');
  const subscriptionBankCustomWrap = $('#subscription-bank-custom-wrap');
  const subscriptionBankCustom = $('#subscription-bank-custom');
  const subscriptionBankAccount = $('#subscription-bank-account');
  const subscriptionBankOwner = $('#subscription-bank-owner');

  function fillSubscriptionPaymentConfig(cfg) {
    fillBankFields(
      subscriptionBankSel,
      subscriptionBankCustomWrap,
      subscriptionBankCustom,
      cfg.subscriptionBankId || ''
    );
    subscriptionBankAccount.value = cfg.subscriptionAccount || '';
    subscriptionBankOwner.value = cfg.subscriptionOwnerName || '';
  }

  subscriptionBankSel.addEventListener('change', () => {
    subscriptionBankCustomWrap.hidden = subscriptionBankSel.value !== 'custom';
    if (subscriptionBankSel.value === 'custom') {
      subscriptionBankCustom.value = '';
      subscriptionBankCustom.focus();
    }
  });

  $('#subscription-bank-save').addEventListener('click', async () => {
    const selected = subscriptionBankSel.value;
    const bankId = selected === 'custom'
      ? subscriptionBankCustom.value.trim().toUpperCase()
      : selected;
    try {
      const saved = await API.admin.setSubscriptionPaymentConfig({
        bankId,
        account: subscriptionBankAccount.value.trim(),
        ownerName: subscriptionBankOwner.value.trim()
      });
      fillSubscriptionPaymentConfig(saved);
      showMsg('Đã lưu tài khoản nhận thanh toán gói TrọBill.', false);
    } catch (e) {
      handleErr(e);
    }
  });

  // ---------- Giá và trạng thái gói ----------
  const plansTable = $('#plans-table');
  const plansTbody = $('#plans-tbody');
  const plansEmpty = $('#plans-empty');

  function appendTextCell(row, value) {
    const cell = document.createElement('td');
    cell.textContent = value;
    row.appendChild(cell);
    return cell;
  }

  function appendInputCell(row, input) {
    const cell = document.createElement('td');
    cell.appendChild(input);
    row.appendChild(cell);
    return cell;
  }

  function planPriceInput(value, label) {
    const input = document.createElement('input');
    input.type = 'number';
    input.min = '0';
    input.step = '1000';
    input.className = 'admin-plan-price';
    input.setAttribute('aria-label', label);
    input.value = value == null ? '' : String(value);
    return input;
  }

  function planCheckbox(value, label) {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.className = 'admin-plan-checkbox';
    input.setAttribute('aria-label', label);
    input.checked = value === true;
    return input;
  }

  function renderPlans(plans) {
    plansTbody.textContent = '';
    for (const plan of plans) {
      const row = document.createElement('tr');
      appendTextCell(row, plan.name || plan.code);
      appendTextCell(row, `${plan.roomLimit} phòng · ${plan.staffLimit} nhân viên`);

      if (plan.code === 'free') {
        appendTextCell(row, 'Miễn phí');
        appendTextCell(row, 'Miễn phí');
        appendTextCell(row, plan.isActive ? 'Có' : 'Không');
        appendTextCell(row, plan.isPublic ? 'Có' : 'Không');
        const locked = appendTextCell(row, 'Gói nền tảng được khóa');
        locked.colSpan = 2;
        plansTbody.appendChild(row);
        continue;
      }

      const monthly = planPriceInput(plan.monthlyPriceVnd, `Giá tháng gói ${plan.name}`);
      const yearly = planPriceInput(plan.yearlyPriceVnd, `Giá năm gói ${plan.name}`);
      const active = planCheckbox(plan.isActive, `Kích hoạt gói ${plan.name}`);
      const publicInput = planCheckbox(plan.isPublic, `Công khai gói ${plan.name}`);
      const reason = document.createElement('input');
      reason.type = 'text';
      reason.className = 'admin-plan-reason';
      reason.placeholder = 'Tối thiểu 10 ký tự';
      reason.maxLength = 500;

      publicInput.addEventListener('change', () => {
        if (publicInput.checked) active.checked = true;
      });
      active.addEventListener('change', () => {
        if (!active.checked) publicInput.checked = false;
      });

      appendInputCell(row, monthly);
      appendInputCell(row, yearly);
      appendInputCell(row, active);
      appendInputCell(row, publicInput);
      appendInputCell(row, reason);
      const actionCell = document.createElement('td');
      const saveButton = btn('Lưu', 'admin-btn', async () => {
        if (reason.value.trim().length < 10) {
          showMsg(`Lý do thay đổi gói ${plan.name} phải có ít nhất 10 ký tự.`, true);
          reason.focus();
          return;
        }
        saveButton.disabled = true;
        try {
          await API.admin.updatePlan(plan.code, {
            monthlyPriceVnd: monthly.value,
            yearlyPriceVnd: yearly.value,
            isActive: active.checked,
            isPublic: publicInput.checked,
            reason: reason.value.trim()
          });
          showMsg(`Đã cập nhật gói ${plan.name} và ghi audit log.`, false);
          await loadPlans();
        } catch (e) {
          handleErr(e);
        } finally {
          saveButton.disabled = false;
        }
      });
      actionCell.appendChild(saveButton);
      row.appendChild(actionCell);
      plansTbody.appendChild(row);
    }
    plansTable.hidden = plans.length === 0;
    plansEmpty.hidden = plans.length !== 0;
  }

  async function loadPlans() {
    try {
      const result = await API.admin.listPlans();
      renderPlans(result.plans || []);
    } catch (e) {
      plansTable.hidden = true;
      plansEmpty.hidden = false;
      plansEmpty.textContent = e.message || 'Không tải được danh sách gói.';
    }
  }

  // ---------- Hoàn tiền / đối soát chuyển nhầm ----------
  const refundFilter = $('#subscription-refund-filter');
  const refundTable = $('#subscription-refund-table');
  const refundTbody = $('#subscription-refund-tbody');
  const refundEmpty = $('#subscription-refund-empty');
  const refundStatusLabels = {
    pending: 'Chờ xử lý',
    reviewing: 'Đang xem xét',
    approved: 'Đã duyệt',
    rejected: 'Đã từ chối',
    refunded: 'Đã hoàn tiền',
    canceled: 'Người dùng đã hủy'
  };

  function refundAction(request, label, status, className = 'admin-btn-ghost') {
    return btn(label, className, async (event) => {
      const button = event.currentTarget;
      const note = prompt(`Nhập ghi chú xử lý cho trạng thái “${refundStatusLabels[status]}” (10–500 ký tự):`);
      if (note == null) return;
      const normalizedNote = note.trim();
      if (normalizedNote.length < 10 || normalizedNote.length > 500) {
        showMsg('Ghi chú xử lý phải từ 10 đến 500 ký tự.', true);
        return;
      }
      let refundReference = '';
      if (status === 'refunded') {
        const referenceInput = prompt('Nhập mã giao dịch ngân hàng đã hoàn tiền:');
        if (referenceInput == null) return;
        refundReference = String(referenceInput).trim();
        if (refundReference.length < 3 || refundReference.length > 100) {
          showMsg('Mã giao dịch hoàn tiền phải từ 3 đến 100 ký tự.', true);
          return;
        }
        if (!confirm(`Xác nhận đã thực sự hoàn ${fmtVND(request.requestedAmountVnd)}? TrọBill không thực hiện chuyển tiền thay bạn.`)) {
          return;
        }
      }
      button.disabled = true;
      try {
        await API.admin.transitionSubscriptionRefundRequest(request.id, {
          status,
          note: normalizedNote,
          refundReference
        });
        showMsg(`Đã chuyển yêu cầu #${request.id} sang “${refundStatusLabels[status]}” và ghi audit.`, false);
        await loadSubscriptionRefundRequests();
      } catch (error) {
        handleErr(error);
      } finally {
        button.disabled = false;
      }
    });
  }

  function renderSubscriptionRefundRequests(requests) {
    refundTbody.textContent = '';
    for (const request of requests) {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${esc(fmtDate(request.createdAt))}</td>
        <td>${esc(request.userEmail)}</td>
        <td><code>${esc(request.payment.orderReference || `#${request.payment.id}`)}</code><br><span class="admin-cell-note">${esc(request.plan.name)} · ${esc(request.payment.status)}</span></td>
        <td>${request.requestType === 'mistaken_transfer' ? 'Chuyển nhầm' : 'Hoàn tiền'}</td>
        <td>${fmtVND(request.requestedAmountVnd)}</td>
        <td><span class="admin-refund-status admin-refund-status--${esc(request.status)}">${esc(refundStatusLabels[request.status] || request.status)}</span></td>
        <td><div class="admin-refund-detail">${esc(request.reason)}</div>${request.adminNote ? `<div class="admin-cell-note">Admin: ${esc(request.adminNote)}</div>` : ''}${request.refundReference ? `<div class="admin-cell-note">Mã hoàn: <code>${esc(request.refundReference)}</code></div>` : ''}</td>
        <td class="admin-actions"></td>`;
      const actions = row.querySelector('.admin-actions');
      if (request.status === 'pending') {
        actions.append(
          refundAction(request, 'Đang xem xét', 'reviewing'),
          refundAction(request, 'Duyệt', 'approved', 'admin-btn'),
          refundAction(request, 'Từ chối', 'rejected', 'admin-btn-danger')
        );
      } else if (request.status === 'reviewing') {
        actions.append(
          refundAction(request, 'Duyệt', 'approved', 'admin-btn'),
          refundAction(request, 'Từ chối', 'rejected', 'admin-btn-danger')
        );
      } else if (request.status === 'approved') {
        actions.append(
          refundAction(request, 'Xác nhận đã hoàn', 'refunded', 'admin-btn'),
          refundAction(request, 'Từ chối', 'rejected', 'admin-btn-danger')
        );
      } else {
        actions.textContent = '—';
      }
      refundTbody.appendChild(row);
    }
    refundTable.hidden = requests.length === 0;
    refundEmpty.hidden = requests.length !== 0;
  }

  async function loadSubscriptionRefundRequests() {
    try {
      const result = await API.admin.listSubscriptionRefundRequests(refundFilter.value);
      renderSubscriptionRefundRequests(result.refundRequests || []);
    } catch (error) {
      if (error.code === 401) return gotoLogin();
      refundTable.hidden = true;
      refundEmpty.hidden = false;
      refundEmpty.textContent = error.message || 'Không tải được yêu cầu hoàn tiền.';
    }
  }

  refundFilter.addEventListener('change', loadSubscriptionRefundRequests);

  // ---------- Khởi động ----------
  function closeUserModal() {
    modal.hidden = true;
    modalBody.textContent = '';
  }
  $('#admin-modal-close').addEventListener('click', closeUserModal);
  modal.addEventListener('click', (e) => { if (e.target === modal) closeUserModal(); });
  $('#admin-logout').addEventListener('click', gotoLogin);

  // Cookie HttpOnly không thể được kiểm tra bằng JavaScript. API admin sẽ xác
  // nhận phiên; nếu hết hạn, loadUsers() tự chuyển về trang đăng nhập.
  loadUsers();
  loadConfig();
  loadPlans();
  loadSubscriptionRefundRequests();
  loadSensitiveAccessLogs();
})();
