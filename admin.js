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

  function fillConfig(cfg) {
    const bankId = cfg.donateBankId || '';
    if (bankId === '') {
      cfgSel.value = '';
      cfgCustomWrap.hidden = true;
    } else if (PREDEFINED_BANKS.includes(bankId)) {
      cfgSel.value = bankId;
      cfgCustomWrap.hidden = true;
    } else {
      cfgSel.value = 'custom';
      cfgCustom.value = bankId;
      cfgCustomWrap.hidden = false;
    }
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
      fillConfig(await API.getConfig());
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
  loadSensitiveAccessLogs();
})();
