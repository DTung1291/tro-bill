/**
 * TrọBill — app.js
 * Tự động tính tiền thuê trọ hàng tháng
 * Business logic từ file Excel "Sổ làm việc_1.xlsx"
 */

'use strict';

// ============================================================
//  STATE
// ============================================================
const STATE = {
  rooms: [],            // Room[]
  billingData: {},      // paid chỉ còn là cờ legacy/import; ledger server là nguồn thật
  expenses: {},         // { "YYYY-MM": Expense[] } chi thực tế trả nhà cung cấp
  settings: {
    deduction: 450000,   // Chi phí khấu trừ hàng tháng
    bankId: '',
    bankAccount: '',
    bankOwnerName: '',
    bankTransferPattern: '',
    reminderEnabled: false,
    reminderDay: 30,
    reminderTime: '20:00',
    invoiceReminderEnabled: false,
    invoiceReminderBeforeDays: [3, 1],
    invoiceReminderAfterDays: [1, 3, 7]
  },
  currentPeriod: null,  // "YYYY-MM"
  history: [],          // Record of monthly snapshots: { period, deduction, timestamp, bills: [] }
  theme: 'system'       // 'light' | 'dark' | 'system'
};

const INVOICE_REMINDER_BEFORE_OPTIONS = [14, 7, 5, 3, 2, 1];
const INVOICE_REMINDER_AFTER_OPTIONS = [1, 2, 3, 5, 7, 14, 30];

function normalizeInvoiceReminderDays(value, options, defaults) {
  const selected = new Set((Array.isArray(value) ? value : defaults).map(Number));
  return options.filter(day => selected.has(day));
}

function renderInvoiceReminderSettings() {
  const enabledInput = document.getElementById('invoice-reminder-enabled');
  if (enabledInput) enabledInput.checked = !!STATE.settings.invoiceReminderEnabled;
  const beforeDays = new Set(normalizeInvoiceReminderDays(
    STATE.settings.invoiceReminderBeforeDays,
    INVOICE_REMINDER_BEFORE_OPTIONS,
    [3, 1]
  ));
  const afterDays = new Set(normalizeInvoiceReminderDays(
    STATE.settings.invoiceReminderAfterDays,
    INVOICE_REMINDER_AFTER_OPTIONS,
    [1, 3, 7]
  ));
  document.querySelectorAll('input[name="invoice-reminder-before"]').forEach(input => {
    input.checked = beforeDays.has(Number(input.value));
  });
  document.querySelectorAll('input[name="invoice-reminder-after"]').forEach(input => {
    input.checked = afterDays.has(Number(input.value));
  });
}

function selectedInvoiceReminderDays(name, options) {
  const selected = new Set(
    [...document.querySelectorAll(`input[name="${name}"]:checked`)].map(input => Number(input.value))
  );
  return options.filter(day => selected.has(day));
}

// Chỉ là bản sao read-only phục vụ UX. Quyền ghi thực tế luôn được server
// kiểm tra lại từ subscriptions/plans khi nhận PUT /api/state.
let SERVER_ENTITLEMENTS = {
  accessMode: 'read_only',
  plan: { code: '', name: '', roomLimit: 0, staffLimit: 0 },
  features: {
    roomManagement: { enabled: false, limit: 0 },
    staffManagement: { enabled: false, limit: 0 },
    dataExport: { enabled: true }
  }
};
let SERVER_PLANS = [];
let SERVER_SUBSCRIPTION_PAYMENTS = [];
let CURRENT_SUBSCRIPTION_ORDER = null;
let ACTIVE_SUBSCRIPTION_RECEIPT = null;
let ACTIVE_SUBSCRIPTION_REFUND_PAYMENT = null;
let RENT_INVOICE_SUMMARIES = new Map();
let ACTIVE_RENT_PAYMENT_INVOICE_ID = null;
let ACTIVE_RENT_PAYMENT_ENTRY = null;
let ACTIVE_DEPOSIT_TENANT_ID = null;
let ACTIVE_DEPOSIT_RESULT = null;
let RENT_INVOICE_SYNC_PROMISE = null;
let RENT_PAYMENT_CHANNELS = [];
let ACTIVE_RENT_PAYMENT_CHANNEL_SECRET = null;
let RENT_BANK_TRANSACTIONS = [];
let ACTIVE_RENT_INVOICE_SHARE_ID = null;
let RENT_INVOICE_SHARE_LINKS = [];
let RENT_INVOICE_PAYMENT_PROOFS = [];

function rentInvoiceKey(roomId, period) {
  return `${period}::${roomId}`;
}

function setRentInvoiceSummaries(invoices) {
  RENT_INVOICE_SUMMARIES = new Map(
    (Array.isArray(invoices) ? invoices : []).map((invoice) => [
      rentInvoiceKey(invoice.roomId, invoice.period),
      invoice
    ])
  );
}

function priorDebtFromLoadedInvoices(roomId, period) {
  let total = 0;
  const room = STATE.rooms.find((item) => item.id === roomId);
  const currentTenancyStart = String(room?.rentStartDate || '').slice(0, 7);
  for (const invoice of RENT_INVOICE_SUMMARIES.values()) {
    if (invoice.roomId !== roomId || invoice.period >= period) continue;
    if (currentTenancyStart
        && period >= currentTenancyStart
        && invoice.period < currentTenancyStart) continue;
    total += Math.max(0, Number(invoice.remainingVnd) || 0);
  }
  return total;
}

function oldestPriorDebtPeriodFromLoadedInvoices(roomId, period) {
  const room = STATE.rooms.find((item) => item.id === roomId);
  const currentTenancyStart = String(room?.rentStartDate || '').slice(0, 7);
  let oldest = null;
  for (const invoice of RENT_INVOICE_SUMMARIES.values()) {
    if (invoice.roomId !== roomId || invoice.period >= period) continue;
    if (currentTenancyStart
        && period >= currentTenancyStart
        && invoice.period < currentTenancyStart) continue;
    if (Math.max(0, Number(invoice.remainingVnd) || 0) === 0) continue;
    if (!oldest || invoice.period < oldest) oldest = invoice.period;
  }
  return oldest;
}

function rentInvoicePaymentState(roomId, period, invoiceTotalVnd, legacyPaid = false) {
  const calculatedTotal = Math.max(0, Number(invoiceTotalVnd) || 0);
  const invoice = RENT_INVOICE_SUMMARIES.get(rentInvoiceKey(roomId, period)) || null;
  const hasTransactions = Number(invoice?.transactionCount) > 0;
  const hasLockedTotal = hasTransactions || !!invoice?.finalizedAt;
  const total = hasLockedTotal
    ? Math.max(0, Number(invoice.invoiceTotalVnd) || 0)
    : calculatedTotal;
  const paidAmount = invoice
    ? Math.max(0, Number(invoice.paidAmountVnd) || 0)
    : (legacyPaid ? total : 0);
  const remaining = Math.max(0, total - paidAmount);
  const priorDebtVnd = invoice
    ? Math.max(0, Number(invoice.priorDebtVnd) || 0)
    : priorDebtFromLoadedInvoices(roomId, period);
  const oldestUnpaidPeriod = invoice?.oldestUnpaidPeriod
    || oldestPriorDebtPeriodFromLoadedInvoices(roomId, period);
  const totalDueVnd = priorDebtVnd + remaining;
  const debtAgePeriod = invoice?.debtAgePeriod || oldestUnpaidPeriod || period;
  const calculatedDebtAge = DebtAge.classify(debtAgePeriod, totalDueVnd);
  let status = paidAmount > 0 ? 'partial' : 'unpaid';
  if (remaining === 0) status = paidAmount > total ? 'overpaid' : 'paid';
  return {
    invoice,
    invoiceId: invoice ? Number(invoice.invoiceId) : null,
    invoiceTotalVnd: total,
    calculatedTotalVnd: calculatedTotal,
    totalLocked: hasLockedTotal,
    paidAmountVnd: paidAmount,
    remainingVnd: remaining,
    priorDebtVnd,
    totalDueVnd,
    priorUnpaidInvoiceCount: invoice
      ? Math.max(0, Number(invoice.priorUnpaidInvoiceCount) || 0)
      : 0,
    oldestUnpaidPeriod,
    debtAgePeriod,
    dueDate: calculatedDebtAge.dueDate,
    overdueDays: calculatedDebtAge.overdueDays,
    debtAgeBucket: calculatedDebtAge.bucket,
    status,
    settled: remaining === 0,
    accountSettled: totalDueVnd === 0
  };
}

function isInvoiceSettled(roomId, period, legacyPaid = false) {
  const invoice = RENT_INVOICE_SUMMARIES.get(rentInvoiceKey(roomId, period));
  if (!invoice) return !!legacyPaid;
  return Number(invoice.paidAmountVnd) >= Number(invoice.invoiceTotalVnd);
}

function applyServerEntitlements(value) {
  if (!value || !value.plan || !value.features) {
    throw new Error('Máy chủ trả về trạng thái gói không hợp lệ');
  }
  SERVER_ENTITLEMENTS = value;
}

function renderSubscriptionSummary() {
  const card = document.getElementById('subscription-summary-card');
  if (!card) return;

  const plan = SERVER_ENTITLEMENTS.plan || {};
  const subscription = SERVER_ENTITLEMENTS.subscription || {};
  const roomFeature = SERVER_ENTITLEMENTS.features?.roomManagement || {};
  const used = Math.max(0, Array.isArray(STATE.rooms)
    ? STATE.rooms.length
    : (Number(roomFeature.used) || 0));
  const limit = Math.max(0, Number(roomFeature.limit) || 0);
  const remaining = Math.max(0, limit - used);
  const percent = limit > 0 ? Math.min(100, Math.round((used / limit) * 100)) : 0;

  const planName = document.getElementById('subscription-plan-name');
  const statusText = document.getElementById('subscription-status-text');
  const countText = document.getElementById('subscription-room-count');
  const remainingText = document.getElementById('subscription-room-remaining');
  const bar = document.getElementById('subscription-usage-bar');
  const fill = document.getElementById('subscription-usage-fill');

  if (planName) planName.textContent = `💳 Gói ${plan.name || plan.code || 'chưa xác định'}`;
  const statusMessages = {
    trialing: `Đang dùng thử · còn ${subscription.daysRemaining || 0} ngày`,
    active: subscription.endsAt ? 'Đang hoạt động' : 'Đang hoạt động · không giới hạn thời hạn',
    expiring_soon: `Sắp hết hạn · còn ${subscription.daysRemaining || 0} ngày`,
    grace_period: `Đang trong thời gian ân hạn · còn ${subscription.graceDaysRemaining || 0} ngày`,
    expired: 'Đã hết hạn · tài khoản chỉ có thể xem và xuất dữ liệu',
    canceled: 'Gói đã hủy · tài khoản chỉ có thể xem và xuất dữ liệu'
  };
  if (statusText) statusText.textContent = statusMessages[subscription.status] || 'Chưa xác định trạng thái gói';
  if (countText) countText.textContent = `${used} / ${limit} phòng`;
  if (remainingText) remainingText.textContent = remaining > 0 ? `Còn ${remaining} phòng` : 'Đã dùng hết hạn mức';
  if (fill) fill.style.width = `${percent}%`;
  if (bar) {
    bar.setAttribute('aria-valuemax', String(limit));
    bar.setAttribute('aria-valuenow', String(Math.min(used, limit)));
  }
  card.classList.toggle('subscription-summary-card--warning', ['expiring_soon', 'grace_period'].includes(subscription.status));
  card.classList.toggle('subscription-summary-card--expired', ['expired', 'canceled'].includes(subscription.status));
}

function renderSubscriptionPlans() {
  const list = document.getElementById('subscription-plan-list');
  const empty = document.getElementById('subscription-plans-empty');
  if (!list || !empty) return;

  list.textContent = '';
  const paidPlans = SERVER_PLANS.filter(plan => plan.code !== 'free');
  empty.hidden = paidPlans.length !== 0;
  const currentPlan = SERVER_ENTITLEMENTS.plan || {};

  for (const plan of paidPlans) {
    const card = document.createElement('article');
    card.className = 'subscription-plan-card';
    if (plan.code === currentPlan.code) card.classList.add('subscription-plan-card--current');

    const heading = document.createElement('div');
    heading.className = 'subscription-plan-heading';
    const title = document.createElement('strong');
    title.textContent = plan.name || plan.code;
    const limit = document.createElement('span');
    limit.textContent = `Tối đa ${plan.roomLimit} phòng`;
    heading.append(title, limit);

    const description = document.createElement('p');
    description.textContent = plan.description || `${plan.roomLimit} phòng · ${plan.staffLimit} nhân viên`;

    const cycle = document.createElement('select');
    cycle.className = 'inline-input subscription-cycle-select';
    cycle.setAttribute('aria-label', `Chu kỳ thanh toán gói ${plan.name}`);
    const monthly = document.createElement('option');
    monthly.value = 'monthly';
    monthly.textContent = `${fmt(plan.monthlyPriceVnd)} / tháng`;
    const yearly = document.createElement('option');
    yearly.value = 'yearly';
    yearly.textContent = `${fmt(plan.yearlyPriceVnd)} / năm`;
    cycle.append(monthly, yearly);

    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'btn btn--primary subscription-plan-action';
    const isRenewal = plan.code === currentPlan.code;
    const isDowngrade = !isRenewal && Number(plan.roomLimit) < Number(currentPlan.roomLimit || 0);
    action.textContent = isRenewal ? 'Gia hạn gói này' : 'Chọn gói này';
    action.disabled = isDowngrade;
    if (isDowngrade) action.title = 'Không thể hạ gói trong luồng thanh toán này';

    action.addEventListener('click', async () => {
      const originalLabel = action.textContent;
      action.disabled = true;
      action.textContent = 'Đang tạo đơn…';
      try {
        const result = await API.createSubscriptionOrder(plan.code, cycle.value);
        openSubscriptionOrderModal(result);
        void loadSubscriptionPayments();
        if (result.reused) showToast('Đã mở lại đơn thanh toán còn hiệu lực.', 'info');
      } catch (error) {
        if (error.code === 401) return handleAuthExpired();
        showToast(error.message || 'Không tạo được đơn thanh toán', 'error', 4000);
      } finally {
        action.disabled = isDowngrade;
        action.textContent = originalLabel;
      }
    });

    card.append(heading, description, cycle, action);
    list.appendChild(card);
  }
}

function subscriptionDateTime(value) {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('vi-VN');
}

function activeSepayChannel() {
  return RENT_PAYMENT_CHANNELS.find(channel => channel.provider === 'sepay') || null;
}

function currentBankAccountDigits() {
  return String(STATE.settings.bankAccount || '').replace(/[^0-9]/g, '');
}

function applyRentPaymentChannelResult(result) {
  const channel = result?.channel;
  if (!channel) return;
  const index = RENT_PAYMENT_CHANNELS.findIndex(item => Number(item.id) === Number(channel.id));
  if (index >= 0) RENT_PAYMENT_CHANNELS[index] = channel;
  else RENT_PAYMENT_CHANNELS.push(channel);
  if (result.secret) {
    ACTIVE_RENT_PAYMENT_CHANNEL_SECRET = {
      channelId: Number(channel.id),
      value: result.secret
    };
  }
  renderRentPaymentChannel();
}

function renderRentPaymentChannel() {
  const empty = document.getElementById('sepay-channel-empty');
  const detail = document.getElementById('sepay-channel-detail');
  const status = document.getElementById('sepay-channel-status');
  const secretPanel = document.getElementById('sepay-channel-secret');
  const secretInput = document.getElementById('sepay-secret-value');
  const reconciliation = document.getElementById('bank-reconciliation');
  if (!empty || !detail || !status || !secretPanel || !secretInput) return;

  const channel = activeSepayChannel();
  empty.hidden = !!channel;
  detail.hidden = !channel;
  status.className = 'payment-channel-status';

  if (!channel) {
    status.textContent = 'Chưa kết nối';
    secretPanel.hidden = true;
    secretInput.value = '';
    if (reconciliation) reconciliation.hidden = true;
    const createButton = document.getElementById('sepay-channel-create');
    const hasAccount = /^[0-9]{4,30}$/.test(currentBankAccountDigits());
    if (createButton) {
      createButton.disabled = !hasAccount;
      createButton.title = hasAccount ? '' : 'Hãy lưu số tài khoản VietQR trước';
    }
    return;
  }

  if (reconciliation) reconciliation.hidden = false;

  const isActive = channel.status === 'active';
  status.textContent = isActive ? 'Đang hoạt động' : 'Đã tắt';
  status.classList.add(isActive
    ? 'payment-channel-status--active'
    : 'payment-channel-status--disabled');

  const webhookInput = document.getElementById('sepay-webhook-url');
  const account = document.getElementById('sepay-channel-account');
  const key = document.getElementById('sepay-channel-key');
  const lastReceived = document.getElementById('sepay-channel-last-received');
  const toggle = document.getElementById('sepay-channel-toggle');
  const accountWarning = document.getElementById('sepay-channel-account-warning');
  const syncAccount = document.getElementById('sepay-channel-sync-account');
  const currentAccount = currentBankAccountDigits();
  const accountMismatch = /^[0-9]{4,30}$/.test(currentAccount)
    && currentAccount !== channel.expectedAccountNumber;

  if (webhookInput) webhookInput.value = channel.webhookUrl || '';
  if (account) account.textContent = `Tài khoản nhận: ${channel.expectedAccountNumber || '—'}`;
  if (key) key.textContent = `API key: ••••••••${channel.secretLast4 || ''}`;
  if (lastReceived) {
    lastReceived.textContent = channel.lastReceivedAt
      ? `Nhận gần nhất: ${subscriptionDateTime(channel.lastReceivedAt)}`
      : 'Chưa nhận giao dịch';
  }
  if (toggle) toggle.textContent = isActive ? 'Tắt kết nối' : 'Bật kết nối';
  if (accountWarning) accountWarning.hidden = !accountMismatch;
  if (syncAccount) {
    syncAccount.disabled = !accountMismatch;
    syncAccount.hidden = !accountMismatch;
  }

  const activeSecret = ACTIVE_RENT_PAYMENT_CHANNEL_SECRET;
  const shouldShowSecret = activeSecret
    && Number(activeSecret.channelId) === Number(channel.id);
  secretPanel.hidden = !shouldShowSecret;
  secretInput.value = shouldShowSecret ? activeSecret.value : '';
  renderRentBankReconciliation();
}

function reconciliationReasonLabel(reason) {
  const labels = {
    transfer_reference_missing: 'Không tìm thấy mã hóa đơn',
    multiple_transfer_references: 'Có nhiều mã hóa đơn',
    invoice_not_found: 'Mã không thuộc hóa đơn hiện có',
    invoice_already_settled: 'Hóa đơn đã được thu đủ',
    amount_mismatch: 'Số tiền không khớp công nợ'
  };
  return labels[reason] || 'Cần chủ trọ kiểm tra';
}

function reconciliationInvoiceCandidates() {
  return [...RENT_INVOICE_SUMMARIES.values()]
    .filter(invoice => Number(invoice.totalDueVnd) > 0)
    .sort((a, b) => String(b.period).localeCompare(String(a.period))
      || String(a.roomName).localeCompare(String(b.roomName)));
}

function renderRentBankReconciliation() {
  const list = document.getElementById('bank-reconciliation-list');
  const empty = document.getElementById('bank-reconciliation-empty');
  if (!list || !empty) return;
  list.textContent = '';
  empty.hidden = RENT_BANK_TRANSACTIONS.length !== 0;
  const candidates = reconciliationInvoiceCandidates();

  for (const transaction of RENT_BANK_TRANSACTIONS) {
    const item = document.createElement('article');
    item.className = 'bank-reconciliation-item';
    const content = transaction.content || transaction.transactionCode || '(Không có nội dung)';
    const detectedInvoiceId = candidates.find(invoice => {
      const reference = String(invoice.transferContent || '').trim().toUpperCase();
      return reference && String(content).toUpperCase().includes(reference);
    })?.invoiceId;
    const candidateOptions = candidates.map(invoice => {
      const selected = Number(invoice.invoiceId) === Number(detectedInvoiceId);
      return `<option value="${invoice.invoiceId}" ${selected ? 'selected' : ''}>${escapeHtml(invoice.roomName || invoice.roomId)} · ${escapeHtml(periodLabel(invoice.period))} · còn ${escapeHtml(fmt(invoice.totalDueVnd))} · ${escapeHtml(invoice.transferContent || '')}</option>`;
    }).join('');
    item.innerHTML = `
      <div class="bank-reconciliation-summary">
        <div>
          <strong>${escapeHtml(transaction.gateway || 'Ngân hàng')}</strong>
          <span> · ${escapeHtml(subscriptionDateTime(transaction.occurredAt))}</span>
        </div>
        <span class="bank-reconciliation-amount">${escapeHtml(fmt(transaction.amountVnd))}</span>
      </div>
      <p class="bank-reconciliation-content">${escapeHtml(content)}</p>
      <span class="bank-reconciliation-reason">${escapeHtml(reconciliationReasonLabel(transaction.matchReason))}</span>
      <div class="bank-reconciliation-controls">
        <select class="inline-input bank-reconciliation-invoice" aria-label="Chọn hóa đơn để ghép">
          <option value="">-- Chọn hóa đơn còn nợ --</option>
          ${candidateOptions}
        </select>
        <input class="inline-input bank-reconciliation-note" type="text" maxlength="500" placeholder="Ghi chú xử lý" />
        <button type="button" class="btn btn--sm btn--primary bank-reconciliation-match" ${candidates.length ? '' : 'disabled'}>Ghép hóa đơn</button>
        <button type="button" class="btn btn--sm btn--ghost bank-reconciliation-ignore">Bỏ qua</button>
      </div>`;

    const invoiceSelect = item.querySelector('.bank-reconciliation-invoice');
    const noteInput = item.querySelector('.bank-reconciliation-note');
    item.querySelector('.bank-reconciliation-match')?.addEventListener('click', event => {
      const invoiceId = Number(invoiceSelect.value);
      if (!Number.isSafeInteger(invoiceId) || invoiceId < 1) {
        showToast('Hãy chọn hóa đơn cần ghép.', 'error');
        return;
      }
      const selected = candidates.find(invoice => Number(invoice.invoiceId) === invoiceId);
      showConfirm(
        `Ghi nhận ${fmt(transaction.amountVnd)} vào công nợ ${selected?.roomName || ''} ${selected ? periodLabel(selected.period) : ''}?`,
        async () => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            await API.matchRentBankTransaction(transaction.id, invoiceId, noteInput.value.trim());
            const [bankResult, invoiceResult] = await Promise.all([
              API.getRentBankTransactions('pending', 50),
              API.getRentPaymentSummaries()
            ]);
            RENT_BANK_TRANSACTIONS = bankResult.transactions || [];
            setRentInvoiceSummaries(invoiceResult.invoices || []);
            renderRentBankReconciliation();
            showToast('Đã ghép giao dịch và tạo phiếu thu.', 'success');
          } catch (error) {
            if (error.code === 401) return handleAuthExpired();
            showToast(error.message || 'Không ghép được giao dịch', 'error', 4000);
            button.disabled = false;
          }
        },
        null,
        'Ghép hóa đơn'
      );
    });
    item.querySelector('.bank-reconciliation-ignore')?.addEventListener('click', event => {
      const reason = noteInput.value.trim();
      if (reason.length < 10) {
        showToast('Nhập lý do bỏ qua ít nhất 10 ký tự.', 'error');
        noteInput.focus();
        return;
      }
      showConfirm(
        'Bỏ qua giao dịch này? Giao dịch gốc vẫn được giữ trong lịch sử đối soát.',
        async () => {
          const button = event.currentTarget;
          button.disabled = true;
          try {
            await API.ignoreRentBankTransaction(transaction.id, reason);
            RENT_BANK_TRANSACTIONS = RENT_BANK_TRANSACTIONS.filter(
              item => Number(item.id) !== Number(transaction.id)
            );
            renderRentBankReconciliation();
            showToast('Đã chuyển giao dịch sang danh sách bỏ qua.', 'success');
          } catch (error) {
            if (error.code === 401) return handleAuthExpired();
            showToast(error.message || 'Không bỏ qua được giao dịch', 'error');
            button.disabled = false;
          }
        },
        null,
        'Bỏ qua'
      );
    });
    list.appendChild(item);
  }
}

async function loadRentBankReconciliation() {
  try {
    const result = await API.getRentBankTransactions('pending', 50);
    RENT_BANK_TRANSACTIONS = Array.isArray(result.transactions) ? result.transactions : [];
    renderRentBankReconciliation();
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    console.warn('Không tải được giao dịch cần đối soát:', error.message);
    showToast('Không tải được danh sách cần đối soát.', 'error');
  }
}

document.getElementById('bank-reconciliation-refresh')?.addEventListener(
  'click',
  loadRentBankReconciliation
);

async function loadRentPaymentChannels() {
  try {
    const result = await API.getRentPaymentChannels();
    RENT_PAYMENT_CHANNELS = Array.isArray(result.channels) ? result.channels : [];
    renderRentPaymentChannel();
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    console.warn('Không tải được kênh thanh toán:', error.message);
    showToast('Không tải được trạng thái kết nối SePay.', 'error');
  }
}

document.getElementById('sepay-channel-create')?.addEventListener('click', async event => {
  const button = event.currentTarget;
  const account = currentBankAccountDigits();
  if (!/^[0-9]{4,30}$/.test(account)) {
    showToast('Hãy lưu số tài khoản VietQR trước khi kết nối SePay.', 'error');
    return;
  }
  button.disabled = true;
  try {
    const result = await API.createSepayRentPaymentChannel(account);
    applyRentPaymentChannelResult(result);
    showToast('Đã tạo endpoint và API key SePay.', 'success');
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    showToast(error.message || 'Không tạo được kết nối SePay', 'error', 4000);
  } finally {
    button.disabled = false;
  }
});

document.getElementById('sepay-copy-webhook')?.addEventListener('click', () => {
  copySubscriptionOrderValue(activeSepayChannel()?.webhookUrl, 'Đã sao chép Webhook URL.');
});

document.getElementById('sepay-copy-secret')?.addEventListener('click', () => {
  copySubscriptionOrderValue(
    ACTIVE_RENT_PAYMENT_CHANNEL_SECRET?.value,
    'Đã sao chép API key SePay.'
  );
});

document.getElementById('sepay-hide-secret')?.addEventListener('click', () => {
  ACTIVE_RENT_PAYMENT_CHANNEL_SECRET = null;
  renderRentPaymentChannel();
});

document.getElementById('sepay-channel-rotate')?.addEventListener('click', () => {
  const channel = activeSepayChannel();
  if (!channel) return;
  showConfirm(
    'API key cũ sẽ ngừng hoạt động ngay. Sau khi xoay key, bạn phải cập nhật key mới trên SePay.',
    async () => {
      try {
        const result = await API.rotateRentPaymentChannelSecret(channel.id);
        applyRentPaymentChannelResult(result);
        showToast('Đã xoay API key. Hãy cập nhật key mới trên SePay.', 'success', 4500);
      } catch (error) {
        if (error.code === 401) return handleAuthExpired();
        showToast(error.message || 'Không xoay được API key', 'error');
      }
    },
    null,
    'Xoay key'
  );
});

document.getElementById('sepay-channel-toggle')?.addEventListener('click', async event => {
  const channel = activeSepayChannel();
  if (!channel) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await API.setRentPaymentChannelStatus(channel.id, channel.status !== 'active');
    applyRentPaymentChannelResult(result);
    showToast(result.channel.status === 'active' ? 'Đã bật kết nối SePay.' : 'Đã tắt kết nối SePay.', 'success');
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    showToast(error.message || 'Không cập nhật được kết nối', 'error');
  } finally {
    button.disabled = false;
  }
});

document.getElementById('sepay-channel-sync-account')?.addEventListener('click', async event => {
  const channel = activeSepayChannel();
  const account = currentBankAccountDigits();
  if (!channel || !/^[0-9]{4,30}$/.test(account)) return;
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const result = await API.updateRentPaymentChannelAccount(channel.id, account);
    applyRentPaymentChannelResult(result);
    showToast('Đã đồng bộ tài khoản nhận tiền cho webhook.', 'success');
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    showToast(error.message || 'Không đồng bộ được tài khoản', 'error');
  } finally {
    button.disabled = false;
  }
});

function renderSubscriptionPaymentHistory() {
  const list = document.getElementById('subscription-payment-list');
  const empty = document.getElementById('subscription-payment-empty');
  if (!list || !empty) return;
  list.textContent = '';
  empty.hidden = SERVER_SUBSCRIPTION_PAYMENTS.length !== 0;

  const statusLabels = {
    pending: 'Chờ thanh toán',
    paid: 'Đã thanh toán',
    failed: 'Cần kiểm tra',
    refunded: 'Đã hoàn tiền',
    canceled: 'Đã hủy'
  };
  const refundStatusLabels = {
    pending: 'Chờ xử lý',
    reviewing: 'Đang xem xét',
    approved: 'Đã duyệt hoàn',
    rejected: 'Đã từ chối',
    refunded: 'Đã hoàn tiền',
    canceled: 'Đã hủy'
  };

  for (const payment of SERVER_SUBSCRIPTION_PAYMENTS) {
    const item = document.createElement('article');
    item.className = 'subscription-payment-item';

    const main = document.createElement('div');
    main.className = 'subscription-payment-main';
    const title = document.createElement('strong');
    title.textContent = `${payment.planName} · ${payment.billingCycle === 'yearly' ? '12 tháng' : '1 tháng'}`;
    const meta = document.createElement('span');
    meta.textContent = `Tạo lúc ${subscriptionDateTime(payment.createdAt)} · ${payment.orderReference}`;
    main.append(title, meta);

    const summary = document.createElement('div');
    summary.className = 'subscription-payment-summary';
    const amount = document.createElement('strong');
    amount.textContent = fmt(payment.amountVnd);
    const status = document.createElement('span');
    status.className = `subscription-payment-status subscription-payment-status--${payment.status}`;
    status.textContent = statusLabels[payment.status] || payment.status;
    summary.append(amount, status);

    const detail = document.createElement('div');
    detail.className = 'subscription-payment-detail';
    const detailText = document.createElement('span');
    const detailActions = document.createElement('div');
    detailActions.className = 'subscription-payment-actions';
    if (payment.status === 'paid') {
      detailText.textContent = `Xác nhận lúc ${subscriptionDateTime(payment.paidAt)}`;
      const receiptButton = document.createElement('button');
      receiptButton.type = 'button';
      receiptButton.className = 'btn btn--sm btn--ghost';
      receiptButton.textContent = 'Xem biên nhận';
      receiptButton.addEventListener('click', async () => {
        receiptButton.disabled = true;
        try {
          const result = await API.getSubscriptionReceipt(payment.id);
          openSubscriptionReceipt(result.receipt);
        } catch (error) {
          if (error.code === 401) return handleAuthExpired();
          showToast(error.message || 'Không tải được biên nhận', 'error');
        } finally {
          receiptButton.disabled = false;
        }
      });
      detailActions.appendChild(receiptButton);
    } else if (payment.status === 'pending') {
      detailText.textContent = `Hết hạn ${subscriptionDateTime(payment.expiresAt)}`;
    } else {
      detailText.textContent = payment.transferContent
        ? `Mã chuyển khoản ${payment.transferContent}`
        : 'Không có thông tin bổ sung';
    }
    const refundRequest = payment.refundRequest;
    const canCreateRequest = payment.status !== 'refunded'
      && (!refundRequest || ['rejected', 'canceled'].includes(refundRequest.status));
    if (canCreateRequest) {
      const supportButton = document.createElement('button');
      supportButton.type = 'button';
      supportButton.className = 'btn btn--sm btn--ghost';
      supportButton.textContent = 'Báo chuyển nhầm / hoàn tiền';
      supportButton.addEventListener('click', () => openSubscriptionRefundModal(payment));
      detailActions.appendChild(supportButton);
    }
    detail.appendChild(detailText);
    if (detailActions.childElementCount > 0) detail.appendChild(detailActions);

    item.append(main, summary, detail);
    if (refundRequest) {
      const refundPanel = document.createElement('div');
      refundPanel.className = `subscription-refund-summary subscription-refund-summary--${refundRequest.status}`;
      const refundMain = document.createElement('div');
      const refundTitle = document.createElement('strong');
      refundTitle.textContent = refundRequest.requestType === 'mistaken_transfer'
        ? 'Yêu cầu đối soát chuyển nhầm'
        : 'Yêu cầu hoàn tiền';
      const refundMeta = document.createElement('span');
      refundMeta.textContent = `${fmt(refundRequest.requestedAmountVnd)} · ${refundStatusLabels[refundRequest.status] || refundRequest.status}`;
      refundMain.append(refundTitle, refundMeta);

      const refundDetail = document.createElement('p');
      refundDetail.textContent = refundRequest.refundReference
        ? `Mã giao dịch hoàn: ${refundRequest.refundReference}`
        : (refundRequest.adminNote || refundRequest.reason || 'Đang chờ xử lý');
      refundPanel.append(refundMain, refundDetail);

      if (refundRequest.status === 'pending') {
        const cancelButton = document.createElement('button');
        cancelButton.type = 'button';
        cancelButton.className = 'btn btn--sm btn--ghost';
        cancelButton.textContent = 'Hủy yêu cầu';
        cancelButton.addEventListener('click', () => cancelSubscriptionRefund(refundRequest));
        refundPanel.appendChild(cancelButton);
      }
      item.appendChild(refundPanel);
    }
    list.appendChild(item);
  }
}

function openSubscriptionRefundModal(payment) {
  const modal = document.getElementById('subscription-refund-modal');
  const typeInput = document.getElementById('subscription-refund-type');
  const amountInput = document.getElementById('subscription-refund-amount');
  const reasonInput = document.getElementById('subscription-refund-reason');
  const paymentText = document.getElementById('subscription-refund-payment');
  if (!modal || !typeInput || !amountInput || !reasonInput || !paymentText) return;

  ACTIVE_SUBSCRIPTION_REFUND_PAYMENT = payment;
  const refundOption = typeInput.querySelector('option[value="refund"]');
  refundOption.disabled = payment.status !== 'paid';
  typeInput.value = payment.status === 'paid' ? 'refund' : 'mistaken_transfer';
  amountInput.value = String(payment.amountVnd || '');
  amountInput.max = typeInput.value === 'refund' ? String(payment.amountVnd) : '';
  reasonInput.value = '';
  paymentText.textContent = `${payment.planName} · ${payment.orderReference}`;
  modal.hidden = false;
  syncModalScrollLock();
  reasonInput.focus();
}

function closeSubscriptionRefundModal() {
  const modal = document.getElementById('subscription-refund-modal');
  if (modal) modal.hidden = true;
  ACTIVE_SUBSCRIPTION_REFUND_PAYMENT = null;
  syncModalScrollLock();
}

async function submitSubscriptionRefund(event) {
  event.preventDefault();
  const payment = ACTIVE_SUBSCRIPTION_REFUND_PAYMENT;
  if (!payment) return;
  const submitButton = document.getElementById('subscription-refund-submit');
  const requestType = document.getElementById('subscription-refund-type').value;
  const requestedAmountVnd = Number(document.getElementById('subscription-refund-amount').value);
  const reason = document.getElementById('subscription-refund-reason').value.trim();
  submitButton.disabled = true;
  try {
    await API.createSubscriptionRefundRequest(payment.id, {
      requestType,
      requestedAmountVnd,
      reason
    });
    closeSubscriptionRefundModal();
    await loadSubscriptionPayments();
    showToast('Đã gửi yêu cầu để đối soát.', 'success');
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    showToast(error.message || 'Không gửi được yêu cầu', 'error', 4000);
  } finally {
    submitButton.disabled = false;
  }
}

function cancelSubscriptionRefund(refundRequest) {
  showConfirm(
    'Hủy yêu cầu hỗ trợ thanh toán này?',
    async () => {
      try {
        await API.cancelSubscriptionRefundRequest(refundRequest.id);
        await loadSubscriptionPayments();
        showToast('Đã hủy yêu cầu.', 'success');
      } catch (error) {
        if (error.code === 401) return handleAuthExpired();
        showToast(error.message || 'Không hủy được yêu cầu', 'error', 4000);
      }
    },
    null,
    'Hủy yêu cầu'
  );
}

document.getElementById('subscription-refund-type')?.addEventListener('change', event => {
  const payment = ACTIVE_SUBSCRIPTION_REFUND_PAYMENT;
  const amountInput = document.getElementById('subscription-refund-amount');
  if (!payment || !amountInput) return;
  amountInput.max = event.target.value === 'refund' ? String(payment.amountVnd) : '';
});
document.getElementById('subscription-refund-form')?.addEventListener('submit', submitSubscriptionRefund);
document.getElementById('subscription-refund-close')?.addEventListener('click', closeSubscriptionRefundModal);
document.getElementById('subscription-refund-close-footer')?.addEventListener('click', closeSubscriptionRefundModal);
document.getElementById('subscription-refund-modal')?.addEventListener('click', event => {
  if (event.target === event.currentTarget) closeSubscriptionRefundModal();
});

async function loadSubscriptionPayments() {
  const refresh = document.getElementById('subscription-history-refresh');
  if (refresh) refresh.disabled = true;
  try {
    const result = await API.getSubscriptionPayments(30);
    SERVER_SUBSCRIPTION_PAYMENTS = Array.isArray(result.payments) ? result.payments : [];
    renderSubscriptionPaymentHistory();
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    showToast(error.message || 'Không tải được lịch sử thanh toán', 'error');
  } finally {
    if (refresh) refresh.disabled = false;
  }
}

function receiptRow(label, value, emphasized = false) {
  const row = document.createElement('div');
  row.className = 'subscription-receipt-row';
  const labelElement = document.createElement('span');
  labelElement.textContent = label;
  const valueElement = document.createElement(emphasized ? 'strong' : 'span');
  valueElement.textContent = value || '—';
  row.append(labelElement, valueElement);
  return row;
}

function openSubscriptionReceipt(receipt) {
  const modal = document.getElementById('subscription-receipt-modal');
  const content = document.getElementById('subscription-receipt-content');
  if (!modal || !content || !receipt) return;
  ACTIVE_SUBSCRIPTION_RECEIPT = receipt;
  document.getElementById('subscription-receipt-code').textContent = receipt.code;
  content.textContent = '';

  const brand = document.createElement('div');
  brand.className = 'subscription-receipt-brand';
  const heading = document.createElement('strong');
  heading.textContent = '🏠 TrọBill';
  const note = document.createElement('span');
  note.textContent = 'Biên nhận thanh toán gói dịch vụ';
  brand.append(heading, note);

  const rows = document.createElement('div');
  rows.className = 'subscription-receipt-rows';
  rows.append(
    receiptRow('Mã biên nhận', receipt.code),
    receiptRow('Tài khoản', receipt.customerEmail),
    receiptRow('Gói dịch vụ', receipt.plan?.name),
    receiptRow('Chu kỳ', receipt.billingCycle === 'yearly' ? '12 tháng' : '1 tháng'),
    receiptRow('Số tiền', fmt(receipt.amountVnd), true),
    receiptRow('Thanh toán lúc', subscriptionDateTime(receipt.paidAt)),
    receiptRow('Mã đơn', receipt.orderReference),
    receiptRow('Mã giao dịch', receipt.settlement?.reference),
    receiptRow('Tài khoản nhận', `${receipt.receiver?.bankId || ''} · ${receipt.receiver?.account || ''}`),
    receiptRow('Chủ tài khoản', receipt.receiver?.ownerName)
  );
  content.append(brand, rows);
  modal.hidden = false;
  syncModalScrollLock();
}

function closeSubscriptionReceipt() {
  const modal = document.getElementById('subscription-receipt-modal');
  if (modal) modal.hidden = true;
  ACTIVE_SUBSCRIPTION_RECEIPT = null;
  syncModalScrollLock();
}

function subscriptionReceiptPrintHtml(receipt) {
  const row = (label, value) => `
    <div class="subscription-receipt-print-row">
      <span>${escapeHtml(label)}</span><strong>${escapeHtml(value || '—')}</strong>
    </div>`;
  return `
    <article class="subscription-receipt-print">
      <header><h1>TrọBill</h1><p>Biên nhận thanh toán gói dịch vụ</p></header>
      <h2>${escapeHtml(receipt.code)}</h2>
      ${row('Tài khoản', receipt.customerEmail)}
      ${row('Gói dịch vụ', receipt.plan?.name)}
      ${row('Chu kỳ', receipt.billingCycle === 'yearly' ? '12 tháng' : '1 tháng')}
      ${row('Số tiền', fmt(receipt.amountVnd))}
      ${row('Thanh toán lúc', subscriptionDateTime(receipt.paidAt))}
      ${row('Mã đơn', receipt.orderReference)}
      ${row('Mã giao dịch', receipt.settlement?.reference)}
      ${row('Tài khoản nhận', `${receipt.receiver?.bankId || ''} · ${receipt.receiver?.account || ''}`)}
      ${row('Chủ tài khoản', receipt.receiver?.ownerName)}
      <footer>Biên nhận được tạo tự động từ giao dịch đã xác nhận trên TrọBill.</footer>
    </article>`;
}

function printSubscriptionReceipt() {
  if (!ACTIVE_SUBSCRIPTION_RECEIPT) return;
  const receipt = ACTIVE_SUBSCRIPTION_RECEIPT;
  const printArea = document.getElementById('print-area');
  printArea.innerHTML = subscriptionReceiptPrintHtml(receipt);
  closeSubscriptionReceipt();
  syncModalScrollLock();
  triggerPrint(`bien-nhan-${receipt.code.toLowerCase()}.pdf`);
}

document.getElementById('subscription-history-refresh')?.addEventListener(
  'click',
  loadSubscriptionPayments
);
document.getElementById('subscription-receipt-close')?.addEventListener(
  'click',
  closeSubscriptionReceipt
);
document.getElementById('subscription-receipt-close-footer')?.addEventListener(
  'click',
  closeSubscriptionReceipt
);
document.getElementById('subscription-receipt-print')?.addEventListener(
  'click',
  printSubscriptionReceipt
);
document.getElementById('subscription-receipt-modal')?.addEventListener('click', event => {
  if (event.target === event.currentTarget) closeSubscriptionReceipt();
});

function closeSubscriptionOrderModal() {
  const modal = document.getElementById('subscription-order-modal');
  const image = document.getElementById('subscription-order-qr');
  if (modal) modal.hidden = true;
  if (image) image.removeAttribute('src');
  CURRENT_SUBSCRIPTION_ORDER = null;
}

function openSubscriptionOrderModal(result) {
  const modal = document.getElementById('subscription-order-modal');
  const image = document.getElementById('subscription-order-qr');
  if (!modal || !image || !result?.order || !result?.vietQr) return;

  const order = result.order;
  const vietQr = result.vietQr;
  CURRENT_SUBSCRIPTION_ORDER = result;
  const setText = (id, value) => {
    const element = document.getElementById(id);
    if (element) element.textContent = value;
  };
  setText('subscription-order-reference', `Mã đơn: ${order.reference}`);
  setText(
    'subscription-order-plan',
    `${order.planName} · ${order.billingCycle === 'yearly' ? '12 tháng' : '1 tháng'}`
  );
  setText('subscription-order-amount', fmt(order.amountVnd));
  setText('subscription-order-bank', vietQr.bankId);
  setText('subscription-order-account', vietQr.account);
  setText('subscription-order-transfer', vietQr.transferContent);
  setText('subscription-order-owner', vietQr.ownerName);
  setText(
    'subscription-order-expiry',
    new Date(order.expiresAt).toLocaleString('vi-VN')
  );

  if (String(vietQr.imageUrl).startsWith('https://img.vietqr.io/image/')) {
    image.src = vietQr.imageUrl;
  }
  modal.hidden = false;
}

async function copySubscriptionOrderValue(value, successMessage) {
  if (!value) return;
  try {
    await navigator.clipboard.writeText(value);
    showToast(successMessage, 'success');
  } catch (_) {
    showToast('Không sao chép được. Vui lòng sao chép thủ công.', 'error');
  }
}

document.getElementById('subscription-order-close')?.addEventListener(
  'click',
  closeSubscriptionOrderModal
);
document.getElementById('subscription-order-modal')?.addEventListener('click', event => {
  if (event.target === event.currentTarget) closeSubscriptionOrderModal();
});
document.getElementById('subscription-copy-account')?.addEventListener('click', () => {
  copySubscriptionOrderValue(
    CURRENT_SUBSCRIPTION_ORDER?.vietQr?.account,
    'Đã sao chép số tài khoản.'
  );
});
document.getElementById('subscription-copy-transfer')?.addEventListener('click', () => {
  copySubscriptionOrderValue(
    CURRENT_SUBSCRIPTION_ORDER?.vietQr?.transferContent,
    'Đã sao chép nội dung chuyển khoản.'
  );
});

// ============================================================
//  PERSISTENCE (backend API — Neon Postgres)
//  saveState() giữ chữ ký đồng bộ như cũ, nhưng bên trong
//  debounce rồi PUT toàn bộ state lên server. Mọi điểm gọi
//  saveState() trong app không cần đổi.
// ============================================================
const STORAGE_KEY = 'trobill_v1'; // giữ lại cho import/export JSON tương thích

let _saveTimer = null;
let _savePending = false;
let _saveInFlight = null;
let _saveRevision = 0;

function cancelPendingStateSave() {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = null;
  _savePending = false;
}

function _serializeState() {
  return {
    rooms: STATE.rooms,
    billingData: STATE.billingData,
    expenses: STATE.expenses,
    settings: STATE.settings,
    history: STATE.history,
    theme: STATE.theme
  };
}

// Đẩy lên server ngay (dùng khi cần chắc chắn đã lưu, ví dụ trước khi thoát)
async function flushState(options = {}) {
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  const expectedAccountContext = API.getAccountContext();
  const expectedGeneration = _sessionGeneration;
  if (!API.isLoggedIn() || !expectedAccountContext) return;

  // Mỗi PUT chứa toàn bộ state. Xếp request thành hàng đợi để snapshot cũ
  // không thể hoàn tất sau và ghi đè snapshot mới; server vẫn có advisory lock
  // làm lớp bảo vệ khi nhiều tab/thiết bị cùng ghi.
  const revision = _saveRevision;
  const snapshot = _serializeState();
  const previousSave = _saveInFlight;
  const currentSave = (async () => {
    if (previousSave) {
      try { await previousSave; } catch (_) {}
    }
    if (expectedGeneration !== _sessionGeneration
        || expectedAccountContext !== API.getAccountContext()
        || !API.isLoggedIn()) {
      return { skipped: true };
    }
    await API.putState(snapshot);
    return { skipped: false };
  })();
  _saveInFlight = currentSave;
  try {
    const result = await currentSave;
    if (!result.skipped
        && revision === _saveRevision
        && expectedGeneration === _sessionGeneration
        && expectedAccountContext === API.getAccountContext()) {
      _savePending = false;
    }
  } catch (e) {
    if (e.errorCode === 'SESSION_ACCOUNT_CHANGED') return;
    if (e.code === 401) return handleAuthExpired();
    console.warn('Lưu lên server thất bại:', e.message);
    if (typeof showToast === 'function') {
      const entitlementError = ['ROOM_LIMIT_EXCEEDED', 'SUBSCRIPTION_READ_ONLY'].includes(e.errorCode);
      showToast(entitlementError ? e.message : '⚠️ Chưa lưu được, sẽ thử lại', 'error', 3000);
    }
    if (options.throwOnError) throw e;
  } finally {
    if (_saveInFlight === currentSave) _saveInFlight = null;
  }
}

function clearSensitiveStateFromMemory() {
  STATE.rooms = [];
  STATE.billingData = {};
  STATE.expenses = {};
  STATE.settings = {
    deduction: 450000,
    bankId: '',
    bankAccount: '',
    bankOwnerName: '',
    bankTransferPattern: '',
    reminderEnabled: false,
    reminderDay: 30,
    reminderTime: '20:00',
    invoiceReminderEnabled: false,
    invoiceReminderBeforeDays: [3, 1],
    invoiceReminderAfterDays: [1, 3, 7]
  };
  STATE.currentPeriod = null;
  STATE.history = [];
  RENT_INVOICE_SUMMARIES = new Map();
  ACTIVE_RENT_PAYMENT_INVOICE_ID = null;
  ACTIVE_RENT_PAYMENT_ENTRY = null;
  ACTIVE_DEPOSIT_TENANT_ID = null;
  ACTIVE_DEPOSIT_RESULT = null;
  RENT_INVOICE_SYNC_PROMISE = null;
  RENT_PAYMENT_CHANNELS = [];
  ACTIVE_RENT_PAYMENT_CHANNEL_SECRET = null;
  RENT_BANK_TRANSACTIONS = [];
  ACTIVE_RENT_INVOICE_SHARE_ID = null;
  RENT_INVOICE_SHARE_LINKS = [];
  RENT_INVOICE_PAYMENT_PROOFS = [];
  SERVER_PLANS = [];
  SERVER_SUBSCRIPTION_PAYMENTS = [];
  CURRENT_SUBSCRIPTION_ORDER = null;
  ACTIVE_SUBSCRIPTION_RECEIPT = null;
  ACTIVE_SUBSCRIPTION_REFUND_PAYMENT = null;
}

function saveState() {
  if (!API.isLoggedIn() || !API.getAccountContext()) return;
  _savePending = true;
  _saveRevision += 1;
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    flushState();
  }, 600);
}

// Lưu nốt khi rời trang
window.addEventListener('beforeunload', (e) => {
  if (_savePending && API.isLoggedIn()) {
    // Cookie được trình duyệt tự gửi; vẫn dùng flush thường vì endpoint lưu
    // state là PUT trong khi sendBeacon chỉ gửi POST.
    flushState();
  }
});

// Nạp state từ server (mặc định) hoặc từ 1 object cho sẵn (đường import JSON).
// Trả về true nếu nạp thành công.
function loadState(savedObj) {
  let saved = savedObj;
  if (saved === undefined) {
    // Tương thích ngược: đường import cũ ghi vào localStorage rồi gọi loadState()
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return false;
    try { saved = JSON.parse(raw); } catch (e) { console.warn('parse localStorage lỗi', e); return false; }
  }
  try {

    // Normalize rooms
    STATE.rooms = (saved.rooms || []).map(r => {
      const room = {
        id: r.id || uuid(),
        name: r.name || 'Phòng không tên',
        rentStartDate: r.rentStartDate || '',
        rentPrice: r.rentPrice !== undefined ? Number(r.rentPrice) : 0,
        electricRate: r.electricRate !== undefined ? Number(r.electricRate) : 3200,
        waterRate: r.waterRate !== undefined ? Number(r.waterRate) : 50000,
        waterType: r.waterType || 'người',
        peopleCount: r.peopleCount !== undefined ? Number(r.peopleCount) : 1,
        trashFee: r.trashFee !== undefined ? Number(r.trashFee) : 50000,
        wifiFee: r.wifiFee !== undefined ? Number(r.wifiFee) : 0,
        manageFee: r.manageFee !== undefined ? Number(r.manageFee) : 0,
        electricPrev: r.electricPrev !== undefined ? Number(r.electricPrev) : 0,
        waterPrev: r.waterPrev !== undefined ? Number(r.waterPrev) : 0,
        notes: r.notes || '',
        tenants: Array.isArray(r.tenants) ? r.tenants.map(t => ({
          id: t.id || uuid(),
          fullName: t.fullName || '',
          phone: t.phone || '',
          email: t.email || '',
          cccd: t.cccd || '',
          issueDate: t.issueDate || '',
          dob: t.dob || '',
          gender: t.gender || 'Nam',
          address: t.address || '',
          dataNoticeAcknowledged: !!t.dataNoticeAcknowledged,
          dataNoticeVersion: t.dataNoticeVersion || ''
        })) : [],
        rateHistory: Array.isArray(r.rateHistory) ? r.rateHistory : []
      };
      room.rateHistory = RoomRates.normalizeHistory(room);
      return room;
    });

    STATE.billingData = saved.billingData || {};
    STATE.expenses = Object.fromEntries(Object.entries(saved.expenses || {}).map(([period, items]) => [
      period,
      (Array.isArray(items) ? items : []).map(item => ({
        id: item.id || uuid(),
        category: item.category || 'other',
        name: item.name || '',
        amount: item.amount !== undefined ? Number(item.amount) : 0,
        paidDate: item.paidDate || '',
        note: item.note || ''
      }))
    ]));
    STATE.settings = { ...STATE.settings, ...(saved.settings || {}) };
    STATE.settings.invoiceReminderBeforeDays = normalizeInvoiceReminderDays(
      STATE.settings.invoiceReminderBeforeDays,
      INVOICE_REMINDER_BEFORE_OPTIONS,
      [3, 1]
    );
    STATE.settings.invoiceReminderAfterDays = normalizeInvoiceReminderDays(
      STATE.settings.invoiceReminderAfterDays,
      INVOICE_REMINDER_AFTER_OPTIONS,
      [1, 3, 7]
    );
    
    // Normalize history snapshots
    STATE.history = (saved.history || []).map(h => ({
      period: h.period,
      deduction: h.deduction !== undefined ? Number(h.deduction) : 450000,
      timestamp: h.timestamp || Date.now(),
      bills: (h.bills || []).map(b => ({
        roomId: b.roomId,
        roomName: b.roomName,
        rentPrice: b.rentPrice !== undefined ? Number(b.rentPrice) : 0,
        rentBasePrice: b.rentBasePrice !== undefined ? Number(b.rentBasePrice) : (b.rentPrice !== undefined ? Number(b.rentPrice) : 0),
        rentDays: b.rentDays !== undefined && b.rentDays !== null ? Number(b.rentDays) : null,
        rentDaysInMonth: b.rentDaysInMonth !== undefined && b.rentDaysInMonth !== null ? Number(b.rentDaysInMonth) : null,
        rentProrated: !!b.rentProrated,
        rentStartsAfterPeriod: !!b.rentStartsAfterPeriod,
        electricOld: b.electricOld !== undefined ? Number(b.electricOld) : 0,
        electricNew: b.electricNew !== undefined && b.electricNew !== null ? Number(b.electricNew) : null,
        electricRate: b.electricRate !== undefined ? Number(b.electricRate) : 0,
        kwh: b.kwh !== undefined ? Number(b.kwh) : 0,
        electricAmt: b.electricAmt !== undefined ? Number(b.electricAmt) : 0,
        waterType: b.waterType || 'người',
        waterRate: b.waterRate !== undefined ? Number(b.waterRate) : 0,
        waterUnits: b.waterUnits !== undefined ? Number(b.waterUnits) : 0,
        waterAmt: b.waterAmt !== undefined ? Number(b.waterAmt) : 0,
        waterPrev: b.waterPrev !== undefined && b.waterPrev !== null ? Number(b.waterPrev) : null,
        waterNew: b.waterNew !== undefined && b.waterNew !== null ? Number(b.waterNew) : null,
        trashFee: b.trashFee !== undefined ? Number(b.trashFee) : 0,
        wifiFee: b.wifiFee !== undefined ? Number(b.wifiFee) : 0,
        manageFee: b.manageFee !== undefined ? Number(b.manageFee) : 0,
        discountAmount: b.discountAmount !== undefined ? Number(b.discountAmount) : 0,
        surchargeAmount: b.surchargeAmount !== undefined ? Number(b.surchargeAmount) : 0,
        lateFeeAmount: b.lateFeeAmount !== undefined ? Number(b.lateFeeAmount) : 0,
        total: b.total !== undefined ? Number(b.total) : 0,
        utilityOnly: !!b.utilityOnly,
        paid: !!b.paid
      }))
    }));

    STATE.theme = saved.theme || 'system';
    return true;
  } catch (e) {
    console.warn('Could not load saved state', e);
    return false;
  }
}

function syncLegacyPaidFlagsFromLedger() {
  for (const [period, byRoom] of Object.entries(STATE.billingData || {})) {
    for (const [roomId, rec] of Object.entries(byRoom || {})) {
      const invoice = RENT_INVOICE_SUMMARIES.get(rentInvoiceKey(roomId, period));
      if (!invoice) continue;
      const room = STATE.rooms.find((item) => item.id === roomId);
      const bill = room ? calcBill(room, rec, period) : null;
      const total = bill ? bill.total : Number(invoice.invoiceTotalVnd) || 0;
      rec.paid = rentInvoicePaymentState(roomId, period, total, false).settled;
    }
  }
  for (const history of STATE.history || []) {
    for (const bill of history.bills || []) {
      const invoice = RENT_INVOICE_SUMMARIES.get(rentInvoiceKey(bill.roomId, history.period));
      if (!invoice) continue;
      bill.paid = rentInvoicePaymentState(
        bill.roomId,
        history.period,
        bill.total,
        false
      ).settled;
    }
  }
}

function invoiceDetailSnapshot(values = {}) {
  const electricOld = Number(values.electricOld) || 0;
  const electricNew = values.electricNew === null || values.electricNew === undefined
    ? electricOld
    : Number(values.electricNew);
  const cubicWater = values.waterType === 'khối';
  const waterOld = cubicWater ? (Number(values.waterOld) || 0) : null;
  const waterNew = cubicWater
    ? (values.waterNew === null || values.waterNew === undefined
      ? waterOld
      : Number(values.waterNew))
    : null;
  return {
    rent: {
      amountVnd: Number(values.rentAmountVnd) || 0,
      basePriceVnd: Number(values.rentBasePriceVnd) || 0,
      chargedDays: Number(values.rentDays) || 0,
      daysInMonth: Number(values.rentDaysInMonth) || RoomRates.daysInPeriod(values.period),
      prorated: values.rentProrated === true,
      startsAfterPeriod: values.rentStartsAfterPeriod === true
    },
    electricity: {
      previousReading: electricOld,
      currentReading: electricNew,
      units: Number(values.electricUnits) || 0,
      rateVnd: Number(values.electricRateVnd) || 0,
      amountVnd: Number(values.electricAmountVnd) || 0
    },
    water: {
      billingType: cubicWater ? 'cubic_meter' : 'person',
      previousReading: waterOld,
      currentReading: waterNew,
      units: Number(values.waterUnits) || 0,
      rateVnd: Number(values.waterRateVnd) || 0,
      amountVnd: Number(values.waterAmountVnd) || 0
    },
    services: {
      trashVnd: Number(values.trashVnd) || 0,
      wifiVnd: Number(values.wifiVnd) || 0,
      managementVnd: Number(values.managementVnd) || 0
    },
    adjustments: {
      discountVnd: Number(values.discountVnd) || 0,
      surchargeVnd: Number(values.surchargeVnd) || 0,
      lateFeeVnd: Number(values.lateFeeVnd) || 0
    },
    utilityOnly: values.utilityOnly === true
  };
}

function historicalInvoiceDetail(bill, period) {
  return invoiceDetailSnapshot({
    period,
    rentAmountVnd: bill.rentPrice,
    rentBasePriceVnd: bill.rentBasePrice,
    rentDays: bill.rentDays,
    rentDaysInMonth: bill.rentDaysInMonth,
    rentProrated: bill.rentProrated,
    rentStartsAfterPeriod: bill.rentStartsAfterPeriod,
    electricOld: bill.electricOld,
    electricNew: bill.electricNew,
    electricUnits: bill.kwh,
    electricRateVnd: bill.electricRate,
    electricAmountVnd: bill.electricAmt,
    waterType: bill.waterType,
    waterOld: bill.waterPrev,
    waterNew: bill.waterNew,
    waterUnits: bill.waterUnits,
    waterRateVnd: bill.waterRate,
    waterAmountVnd: bill.waterAmt,
    trashVnd: bill.trashFee,
    wifiVnd: bill.wifiFee,
    managementVnd: bill.manageFee,
    discountVnd: bill.discountAmount,
    surchargeVnd: bill.surchargeAmount,
    lateFeeVnd: bill.lateFeeAmount,
    utilityOnly: bill.utilityOnly
  });
}

function currentInvoiceDetail(room, record, bill, period) {
  const electricOld = getElectricOld(room, period);
  const electricNew = record.electricNew !== undefined && record.electricNew !== ''
    ? Number(record.electricNew)
    : electricOld;
  const cubicWater = room.waterType === 'khối';
  const waterOld = cubicWater ? getWaterOld(room, period) : null;
  const waterNew = cubicWater
    ? (record.waterNew !== undefined && record.waterNew !== '' && record.waterNew !== null
      ? Number(record.waterNew)
      : waterOld)
    : null;
  return invoiceDetailSnapshot({
    period,
    rentAmountVnd: bill.rentAmt,
    rentBasePriceVnd: bill.rentBasePrice,
    rentDays: bill.rentDays,
    rentDaysInMonth: bill.rentDaysInMonth,
    rentProrated: bill.rentProrated,
    rentStartsAfterPeriod: bill.rentStartsAfterPeriod,
    electricOld,
    electricNew,
    electricUnits: bill.kwh,
    electricRateVnd: bill.electricRate,
    electricAmountVnd: bill.electricAmt,
    waterType: room.waterType,
    waterOld,
    waterNew,
    waterUnits: bill.waterUnits,
    waterRateVnd: bill.waterRate,
    waterAmountVnd: bill.waterAmt,
    trashVnd: bill.trashAmt,
    wifiVnd: bill.wifiAmt,
    managementVnd: bill.manageAmt,
    discountVnd: bill.discountAmt,
    surchargeVnd: bill.surchargeAmt,
    lateFeeVnd: bill.lateFeeAmt,
    utilityOnly: isUtilityOnlyRecord(record)
  });
}

function rentInvoicesForSync() {
  const entries = new Map();
  for (const history of STATE.history || []) {
    for (const bill of history.bills || []) {
      const key = rentInvoiceKey(bill.roomId, history.period);
      if (!(Number(bill.total) > 0)) continue;
      entries.set(key, {
        roomId: bill.roomId,
        roomName: bill.roomName || '',
        period: history.period,
        invoiceTotalVnd: Math.round(Number(bill.total)),
        detail: historicalInvoiceDetail(bill, history.period)
      });
    }
  }
  for (const [period, byRoom] of Object.entries(STATE.billingData || {})) {
    for (const [roomId, rec] of Object.entries(byRoom || {})) {
      const key = rentInvoiceKey(roomId, period);
      if (!rec || entries.has(key)) continue;
      const room = STATE.rooms.find((item) => item.id === roomId);
      const bill = room ? calcBill(room, rec, period) : null;
      if (!room || !bill || !(Number(bill.total) > 0)) continue;
      entries.set(key, {
        roomId,
        roomName: room.name || '',
        period,
        invoiceTotalVnd: Math.round(Number(bill.total)),
        detail: currentInvoiceDetail(room, rec, bill, period)
      });
    }
  }
  return [...entries.values()];
}

async function refreshRentInvoiceSummaries() {
  const result = await API.getRentPaymentSummaries();
  setRentInvoiceSummaries(result.invoices || []);
  syncLegacyPaidFlagsFromLedger();
  return result.invoices || [];
}

async function syncRentInvoicesWithLedger() {
  const entries = rentInvoicesForSync();
  if (entries.length === 0) {
    syncLegacyPaidFlagsFromLedger();
    return;
  }
  for (let index = 0; index < entries.length; index += 250) {
    await API.syncRentInvoices(entries.slice(index, index + 250));
  }
  await refreshRentInvoiceSummaries();
}

function rentInvoiceSyncNeeded() {
  return rentInvoicesForSync().some((entry) => {
    const invoice = RENT_INVOICE_SUMMARIES.get(rentInvoiceKey(entry.roomId, entry.period));
    if (!invoice) return true;
    if (invoice.finalizedAt) return false;
    return Number(invoice.transactionCount) === 0
      && Number(invoice.invoiceTotalVnd) !== Number(entry.invoiceTotalVnd);
  });
}

async function ensureRentInvoicesSynced() {
  if (!rentInvoiceSyncNeeded()) return;
  if (!RENT_INVOICE_SYNC_PROMISE) {
    RENT_INVOICE_SYNC_PROMISE = (async () => {
      if (_savePending) await flushState({ throwOnError: true });
      await syncRentInvoicesWithLedger();
    })().finally(() => { RENT_INVOICE_SYNC_PROMISE = null; });
  }
  await RENT_INVOICE_SYNC_PROMISE;
}

function paymentStatusLabel(payment) {
  if (payment.accountSettled) return 'Đã thu đủ';
  if (payment.priorDebtVnd > 0) return `Còn tổng ${fmt(payment.totalDueVnd)}`;
  if (payment.paidAmountVnd > 0) return `Còn ${fmt(payment.remainingVnd)}`;
  return 'Chưa thu';
}

function debtAgeLabel(payment) {
  return DebtAge.label(payment?.debtAgeBucket);
}

function debtAgeDetails(payment) {
  if (!payment || payment.accountSettled) return 'Không còn công nợ';
  if (payment.overdueDays > 0) {
    return `Quá hạn ${payment.overdueDays} ngày · Hạn ${payment.dueDate}`;
  }
  return `Hạn ${payment.dueDate}`;
}

function debtAgeBadge(payment) {
  if (!payment) return '';
  const bucket = String(payment.debtAgeBucket || 'not_due').replaceAll('_', '-');
  return `<span class="debt-age-badge debt-age-badge--${bucket}" title="${escapeHtml(debtAgeDetails(payment))}">${escapeHtml(debtAgeLabel(payment))}</span>`;
}

function debtAgeMessageLine(payment) {
  if (!payment || payment.accountSettled) return '';
  const exact = payment.overdueDays > 0 ? ` · quá hạn ${payment.overdueDays} ngày` : '';
  return `📅 Hạn thanh toán: ${payment.dueDate} · ${debtAgeLabel(payment)}${exact}`;
}

function renderRentPaymentViews() {
  renderDashboard();
  renderReport();
  renderHistory();
  if (activeBillPreview && !document.getElementById('bill-preview-modal')?.hidden) {
    const { room, rec, bill, period } = activeBillPreview;
    document.getElementById('bill-preview-content').innerHTML = buildBillPreviewContent(
      room,
      rec,
      bill,
      period
    );
  }
}

function closeRentPaymentEntry() {
  const modal = document.getElementById('rent-payment-entry-modal');
  const form = document.getElementById('rent-payment-entry-form');
  if (modal) modal.hidden = true;
  if (form) form.reset();
  ACTIVE_RENT_PAYMENT_ENTRY = null;
}

function openRentPaymentEntry({ roomId, roomName, period, total }) {
  const payment = rentInvoicePaymentState(roomId, period, total, false);
  if (payment.accountSettled) {
    if (payment.invoiceId) openRentPaymentLedger(payment.invoiceId);
    return;
  }
  ACTIVE_RENT_PAYMENT_ENTRY = {
    roomId,
    roomName,
    period,
    total: Math.round(Number(total) || 0),
    payment
  };
  const modal = document.getElementById('rent-payment-entry-modal');
  const title = document.getElementById('rent-payment-entry-title');
  const summary = document.getElementById('rent-payment-entry-summary');
  const amount = document.getElementById('rent-payment-entry-amount');
  const method = document.getElementById('rent-payment-entry-method');
  const note = document.getElementById('rent-payment-entry-note');
  const hint = document.getElementById('rent-payment-entry-hint');
  const error = document.getElementById('rent-payment-entry-error');
  if (!modal || !title || !summary || !amount || !method || !note || !hint || !error) return;

  title.textContent = `Ghi nhận thu tiền ${roomName} – ${period}`;
  summary.innerHTML = `
    <div><span>Tổng hóa đơn tháng này</span><strong>${fmt(total)}</strong></div>
    <div><span>Đã thu tháng này</span><strong>${fmt(payment.paidAmountVnd)}</strong></div>
    <div><span>Nợ cũ chuyển sang</span><strong>${fmt(payment.priorDebtVnd)}</strong></div>
    <div><span>Tổng còn phải thu</span><strong>${fmt(payment.totalDueVnd)}</strong></div>`;
  amount.max = String(payment.totalDueVnd);
  amount.value = String(payment.totalDueVnd);
  method.value = 'bank_transfer';
  note.value = '';
  hint.textContent = payment.priorDebtVnd > 0
    ? 'Khoản thu được phân bổ cho nợ cũ nhất trước, sau đó mới đến hóa đơn tháng này.'
    : 'Có thể nhập số nhỏ hơn công nợ để ghi nhận thanh toán một phần.';
  error.hidden = true;
  error.textContent = '';
  modal.hidden = false;
  requestAnimationFrame(() => {
    amount.focus();
    amount.select();
  });
}

async function submitRentPaymentEntry(event) {
  event.preventDefault();
  const entry = ACTIVE_RENT_PAYMENT_ENTRY;
  if (!entry) return;
  const amountInput = document.getElementById('rent-payment-entry-amount');
  const methodInput = document.getElementById('rent-payment-entry-method');
  const noteInput = document.getElementById('rent-payment-entry-note');
  const error = document.getElementById('rent-payment-entry-error');
  const submit = document.getElementById('rent-payment-entry-submit');
  const amountVnd = Number(amountInput?.value);
  if (!Number.isSafeInteger(amountVnd) || amountVnd <= 0 || amountVnd > entry.payment.totalDueVnd) {
    error.textContent = `Số tiền phải từ 1 đến ${fmt(entry.payment.totalDueVnd)}.`;
    error.hidden = false;
    return;
  }
  submit.disabled = true;
  error.hidden = true;
  try {
    const result = await API.settleRentInvoice({
      roomId: entry.roomId,
      roomName: entry.roomName,
      period: entry.period,
      invoiceTotalVnd: entry.total,
      amountVnd,
      includePriorDebt: entry.payment.priorDebtVnd > 0,
      paymentMethod: methodInput?.value || 'manual',
      note: noteInput?.value.trim() || '',
      idempotencyKey: `manual:${uuid()}`,
      occurredAt: new Date().toISOString()
    });
    closeRentPaymentEntry();
    await refreshRentInvoiceSummaries();
    renderRentPaymentViews();
    triggerHaptic('success');
    const remaining = result.invoice?.totalDueVnd || 0;
    const receiptLabel = result.receipt?.code ? ` · ${result.receipt.code}` : '';
    showToast(
      remaining > 0
        ? `Đã thu ${fmt(amountVnd)}${receiptLabel} · còn ${fmt(remaining)}`
        : `Đã thu đủ ${fmt(amountVnd)}${receiptLabel}`,
      'success',
      4000
    );
  } catch (requestError) {
    if (requestError.code === 401) return handleAuthExpired();
    error.textContent = requestError.message || 'Không ghi nhận được giao dịch';
    error.hidden = false;
  } finally {
    submit.disabled = false;
  }
}

function rentPaymentSourceLabel(source) {
  const labels = {
    manual_full: 'Chủ trọ ghi nhận',
    manual_partial: 'Thanh toán một phần',
    manual_prior_debt: 'Phân bổ nợ cũ',
    manual_reversal: 'Hoàn tác thủ công',
    legacy_paid: 'Chuyển từ dữ liệu cũ'
  };
  return labels[source] || source || 'Không xác định';
}

function rentPaymentMethodLabel(method) {
  const labels = {
    bank_transfer: 'Chuyển khoản',
    cash: 'Tiền mặt',
    manual: 'Thủ công',
    other: 'Khác'
  };
  return labels[method] || method || 'Không xác định';
}

function closeRentPaymentLedger() {
  const modal = document.getElementById('rent-payment-modal');
  if (modal) modal.hidden = true;
  ACTIVE_RENT_PAYMENT_INVOICE_ID = null;
}

function renderRentPaymentLedgerContent(result) {
  const body = document.getElementById('rent-payment-modal-body');
  const title = document.getElementById('rent-payment-modal-title');
  if (!body || !title) return;
  const invoice = result.invoice;
  const transactions = Array.isArray(result.transactions) ? result.transactions : [];
  title.textContent = `Giao dịch ${invoice.roomName || invoice.roomId} – ${invoice.period}`;
  body.innerHTML = `
    <div class="rent-payment-summary-grid">
      <div><span>Tổng hóa đơn</span><strong>${fmt(invoice.invoiceTotalVnd)}</strong></div>
      <div><span>Đã thu</span><strong>${fmt(invoice.paidAmountVnd)}</strong></div>
      <div><span>Còn lại tháng này</span><strong>${fmt(invoice.remainingVnd)}</strong></div>
      <div><span>Nợ cũ trước kỳ</span><strong>${fmt(invoice.priorDebtVnd)}</strong></div>
      <div><span>Nội dung chuyển khoản</span><strong class="rent-payment-transfer-content">${escapeHtml(invoice.transferContent || '—')}</strong></div>
    </div>
    <div class="rent-payment-ledger-note">
      Sổ giao dịch chỉ thêm dòng mới. Hoàn tác sẽ tạo một dòng âm và giữ nguyên giao dịch gốc để đối soát.
    </div>
    <div class="rent-payment-transaction-list">
      ${transactions.length === 0 ? '<p class="rent-payment-empty">Chưa có giao dịch.</p>' : transactions.map(transaction => {
        const isReversal = transaction.entryType === 'reversal';
        const amountClass = Number(transaction.amountVnd) < 0 ? 'is-negative' : 'is-positive';
        const canReverse = transaction.entryType === 'payment' && !transaction.isReversed;
        return `
          <article class="rent-payment-transaction ${transaction.isReversed ? 'is-reversed' : ''}">
            <div class="rent-payment-transaction-main">
              <div>
                <strong>${isReversal ? 'Hoàn tác giao dịch' : 'Thu tiền'}</strong>
                ${transaction.isReversed ? '<span class="badge badge--empty">Đã hoàn tác</span>' : ''}
              </div>
              <span>${escapeHtml(rentPaymentMethodLabel(transaction.paymentMethod))} · ${escapeHtml(rentPaymentSourceLabel(transaction.source))} · ${new Date(transaction.occurredAt).toLocaleString('vi-VN')}</span>
              ${transaction.receiptCode ? `<span>Phiếu thu: <strong>${escapeHtml(transaction.receiptCode)}</strong></span>` : ''}
              ${transaction.note ? `<p>${escapeHtml(transaction.note)}</p>` : ''}
            </div>
            <div class="rent-payment-transaction-side">
              <strong class="${amountClass}">${Number(transaction.amountVnd) > 0 ? '+' : ''}${fmt(transaction.amountVnd)}</strong>
              ${canReverse ? `<button type="button" class="btn btn--danger btn--sm" data-reverse-rent-payment="${transaction.id}">Hoàn tác</button>` : ''}
            </div>
          </article>`;
      }).join('')}
    </div>`;

  body.querySelectorAll('[data-reverse-rent-payment]').forEach(button => {
    button.addEventListener('click', async () => {
      const reason = window.prompt('Nhập lý do hoàn tác (từ 10 đến 500 ký tự):', '');
      if (reason === null) return;
      const normalizedReason = reason.trim();
      if (normalizedReason.length < 10 || normalizedReason.length > 500) {
        showToast('Lý do hoàn tác phải từ 10 đến 500 ký tự', 'error');
        return;
      }
      button.disabled = true;
      try {
        await API.reverseRentPaymentTransaction(button.dataset.reverseRentPayment, normalizedReason);
        await refreshRentInvoiceSummaries();
        renderRentPaymentViews();
        showToast('Đã hoàn tác bằng một giao dịch âm', 'success');
        await openRentPaymentLedger(invoice.invoiceId);
      } catch (error) {
        if (error.code === 401) return handleAuthExpired();
        button.disabled = false;
        showToast(error.message || 'Không hoàn tác được giao dịch', 'error', 4000);
      }
    });
  });

  const addButton = document.getElementById('rent-payment-modal-add');
  if (addButton) {
    addButton.hidden = !(Number(invoice.remainingVnd) > 0);
    addButton.onclick = () => {
      closeRentPaymentLedger();
      openRentPaymentEntry({
        roomId: invoice.roomId,
        roomName: invoice.roomName,
        period: invoice.period,
        total: invoice.invoiceTotalVnd
      });
    };
  }
}

async function openRentPaymentLedger(invoiceId) {
  const parsedInvoiceId = Number(invoiceId);
  if (!Number.isInteger(parsedInvoiceId) || parsedInvoiceId <= 0) return;
  const modal = document.getElementById('rent-payment-modal');
  const body = document.getElementById('rent-payment-modal-body');
  if (!modal || !body) return;
  ACTIVE_RENT_PAYMENT_INVOICE_ID = parsedInvoiceId;
  body.innerHTML = '<p class="rent-payment-empty">Đang tải giao dịch…</p>';
  const addButton = document.getElementById('rent-payment-modal-add');
  if (addButton) addButton.hidden = true;
  modal.hidden = false;
  try {
    const result = await API.getRentPaymentTransactions(parsedInvoiceId);
    if (ACTIVE_RENT_PAYMENT_INVOICE_ID !== parsedInvoiceId) return;
    renderRentPaymentLedgerContent(result);
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    body.innerHTML = `<p class="rent-payment-empty rent-payment-error">${escapeHtml(error.message || 'Không tải được giao dịch')}</p>`;
  }
}

// ============================================================
//  THEME SYSTEM
// ============================================================
function getAppliedTheme() {
  if (STATE.theme === 'system') {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  return STATE.theme;
}

function initTheme() {
  const theme = getAppliedTheme();
  document.documentElement.setAttribute('data-theme', theme);
  const toggleBtn = document.getElementById('theme-toggle');
  if (toggleBtn) {
    // Icon shows what clicking WILL DO (next state), not current state
    // Cycle: system→light(☀️)  light→dark(🌙)  dark→auto(🌓)
    toggleBtn.textContent = STATE.theme === 'system' ? '☀️' : (STATE.theme === 'light' ? '🌙' : '🌓');
  }
}

function toggleTheme() {
  let nextTheme = 'light';
  if (STATE.theme === 'system') {
    nextTheme = 'light';
  } else if (STATE.theme === 'light') {
    nextTheme = 'dark';
  } else if (STATE.theme === 'dark') {
    nextTheme = 'system';
  }
  STATE.theme = nextTheme;
  initTheme();
  saveState();
}

// ============================================================
//  HELPERS
// ============================================================
function fmt(n) {
  if (n === null || n === undefined || isNaN(n)) return '—';
  return Number(n).toLocaleString('vi-VN') + ' đ';
}

function fmtNum(n) {
  if (n === null || n === undefined || isNaN(n)) return '0';
  return Number(n).toLocaleString('vi-VN');
}

function fmtShorthand(val) {
  if (val === 0 || val === null || val === undefined || isNaN(val)) return '0';
  if (val >= 1000000) {
    const m = val / 1000000;
    return m.toLocaleString('vi-VN', { maximumFractionDigits: 2 }) + 'M';
  }
  if (val >= 1000) {
    const k = val / 1000;
    return k.toLocaleString('vi-VN', { maximumFractionDigits: 2 }) + 'k';
  }
  return val.toLocaleString('vi-VN');
}

function periodKey(year, month) {
  return `${year}-${String(month).padStart(2, '0')}`;
}

function parsePeriod(key) {
  const [y, m] = key.split('-');
  return { year: parseInt(y), month: parseInt(m) };
}

function periodLabel(key) {
  if (!key) return '--/----';
  const { year, month } = parsePeriod(key);
  return `Tháng ${month}/${year}`;
}

function periodInputValue(key) {
  if (!key) return '';
  return /^\d{4}-\d{2}$/.test(key) ? key : '';
}

function getRoomRates(room, period = STATE.currentPeriod) {
  return RoomRates.resolve(room, period);
}

function ratePeriodLabel(period) {
  return period === RoomRates.BASE_PERIOD ? 'Giá ban đầu' : `Từ ${periodLabel(period).toLowerCase()}`;
}

function dateLabel(value) {
  if (!RoomRates.isIsoDate(value)) return '';
  const [year, month, day] = value.split('-');
  return `${day}/${month}/${year}`;
}

function rentFormulaText(bill) {
  if (bill.rentStartsAfterPeriod) return 'Chưa đến ngày bắt đầu thuê';
  if (!bill.rentProrated) return 'Cố định hàng tháng';
  return `${fmt(bill.rentBasePrice)} ÷ ${bill.rentDaysInMonth} ngày × ${bill.rentDays} ngày`;
}

function rentMessageLine(bill) {
  if (bill.rentStartsAfterPeriod) return '🏠 Tiền thuê: 0 đ (chưa bắt đầu thuê)';
  if (bill.rentAmt <= 0) return '';
  if (!bill.rentProrated) return `🏠 Tiền thuê: ${fmt(bill.rentAmt)}`;
  return `🏠 Tiền thuê: ${fmt(bill.rentBasePrice)} ÷ ${bill.rentDaysInMonth} ngày × ${bill.rentDays} ngày = ${fmt(bill.rentAmt)}`;
}

function clonePeriodRecords(records) {
  return JSON.parse(JSON.stringify(records || {}));
}

function cloneExpenseRecords(records, regenerateIds = false) {
  return (records || []).map(record => ({
    ...record,
    id: regenerateIds ? uuid() : record.id
  }));
}

let ROOM_MAINTENANCE_PERIODS = [];
let ROOM_OPERATIONAL_STATUS_BY_ROOM = new Map();
let ROOM_OPERATIONAL_STATUS_LOADED = false;
let ACTIVE_ROOM_LIFECYCLE_ROOM_ID = '';

function applyRoomOperationalStatusPayload(payload = {}) {
  ROOM_MAINTENANCE_PERIODS = Array.isArray(payload.maintenancePeriods)
    ? payload.maintenancePeriods
    : [];
  ROOM_OPERATIONAL_STATUS_LOADED = Array.isArray(payload.roomStatuses);
  ROOM_OPERATIONAL_STATUS_BY_ROOM = new Map(
    (Array.isArray(payload.roomStatuses) ? payload.roomStatuses : [])
      .map(status => [status.roomId, status])
  );
}

function getRoomOperationalStatus(roomId) {
  const source = ROOM_OPERATIONAL_STATUS_BY_ROOM.get(roomId)
    || { status: ROOM_OPERATIONAL_STATUS_LOADED ? 'vacant' : 'unknown' };
  const labels = {
    vacant: 'Trống',
    reserved: 'Giữ chỗ',
    occupied: 'Đang thuê',
    maintenance: 'Đang sửa',
    unknown: 'Chưa tải'
  };
  return {
    ...source,
    status: labels[source.status] ? source.status : 'unknown',
    label: source.conflict ? 'Cần kiểm tra' : (labels[source.status] || labels.unknown)
  };
}

function isUtilityOnlyRecord(record) {
  return !!record?.utilityOnly;
}

function uuid() {
  return crypto.randomUUID ? crypto.randomUUID()
    : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function removeVietnameseTones(str) {
  if (!str) return '';
  str = str.replace(/à|á|ạ|ả|ã|â|ầ|ấ|ậ|ẩ|ẫ|ă|ằ|ắ|ặ|ẳ|ẵ/g, "a");
  str = str.replace(/è|é|ẹ|ẻ|ẽ|ê|ề|ế|ệ|ể|ễ/g, "e");
  str = str.replace(/ì|í|ị|ỉ|ĩ/g, "i");
  str = str.replace(/ò|ó|ọ|ỏ|õ|ô|ồ|ố|ộ|ổ|ỗ|ơ|ờ|ớ|ợ|ở|ỡ/g, "o");
  str = str.replace(/ù|ú|ụ|ủ|ũ|ư|ừ|ứ|ự|ử|ữ/g, "u");
  str = str.replace(/ỳ|ý|ỵ|ỷ|ỹ/g, "y");
  str = str.replace(/đ/g, "d");
  str = str.replace(/À|Á|Ạ|Ả|Ã|Â|Ầ|Ấ|Ậ|Ẩ|Ẫ|Ă|Ằ|Ắ|Ặ|Ẳ|Ẵ/g, "A");
  str = str.replace(/È|É|Ẹ|Ẻ|Ẽ|Ê|Ề|Ế|Ệ|Ể|Ễ/g, "E");
  str = str.replace(/Ì|Í|Ị|Ỉ|Ĩ/g, "I");
  str = str.replace(/Ò|Ó|Ọ|Ỏ|Õ|Ô|Ồ|Ố|Ộ|Ổ|Ỗ|Ơ|Ờ|Ớ|Ợ|Ở|Ỡ/g, "O");
  str = str.replace(/Ù|Ú|Ụ|Ủ|Ũ|Ư|Ừ|Ứ|Ự|Ử|Ữ/g, "U");
  str = str.replace(/Ỳ|Ý|Ỵ|Ỷ|Ỹ/g, "Y");
  str = str.replace(/Đ/g, "D");
  str = str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return str;
}

function getVietQrDescription(room, period) {
  const invoice = RENT_INVOICE_SUMMARIES.get(rentInvoiceKey(room.id, period));
  const uniqueReference = invoice?.transferContent
    || InvoiceReference.fromInvoiceId(invoice?.invoiceId);
  if (uniqueReference) return uniqueReference;
  return '';
}

function genVietQrUrl(room, bill, period, amountOverride = null) {
  const bankId = String(STATE.settings.bankId || '').trim().toUpperCase();
  const account = currentBankAccountDigits();
  const owner = STATE.settings.bankOwnerName || '';

  if (!bankId || !account) return null;

  const payment = rentInvoicePaymentState(room.id, period, bill.total, bill.paid);
  const amount = amountOverride === null
    ? payment.remainingVnd
    : Math.max(0, Number(amountOverride) || 0);
  if (amount <= 0) return null;
  const desc = getVietQrDescription(room, period);
  if (!desc) return null;
  const encodedDesc = encodeURIComponent(desc);
  const encodedOwner = encodeURIComponent(owner);

  return `https://img.vietqr.io/image/${encodeURIComponent(bankId)}-${encodeURIComponent(account)}-compact.png?amount=${amount}&addInfo=${encodedDesc}&accountName=${encodedOwner}`;
}

function rentBankRecipientText() {
  const bankId = String(STATE.settings.bankId || '').trim().toUpperCase();
  const account = currentBankAccountDigits();
  const owner = String(STATE.settings.bankOwnerName || '').trim().toUpperCase();
  if (!bankId || !account) return '';
  return [owner, bankId, account].filter(Boolean).join(' · ');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function maskCccdForDisplay(value) {
  const cccd = String(value || '').trim();
  if (!cccd) return '—';
  if (/[•*]/.test(cccd)) return cccd;
  const visible = cccd.slice(-4);
  return `${'•'.repeat(Math.max(0, cccd.length - visible.length))}${visible}`;
}

function billCode(room, period) {
  const roomPart = String(room.id || removeVietnameseTones(room.name) || 'ROOM')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(0, 8)
    .toUpperCase();
  return `TB-${period.replace('-', '')}-${roomPart || 'ROOM'}`;
}

function billDueDate(period) {
  return DebtAge.dueDate(period) || period;
}

function triggerHaptic(type = 'light') {
  if (typeof AndroidApp !== 'undefined' && AndroidApp.vibrate) {
    AndroidApp.vibrate(type);
  } else if (navigator.vibrate) {
    if (type === 'light') {
      navigator.vibrate(20);
    } else if (type === 'warning') {
      navigator.vibrate([40, 40, 40]);
    } else if (type === 'success') {
      navigator.vibrate([60, 40, 80]);
    }
  }
}

function shareBillNative(title, text, fallbackCopyFn) {
  if (typeof AndroidApp !== 'undefined' && AndroidApp.share) {
    triggerHaptic('light');
    AndroidApp.share(title, text);
  } else if (navigator.share) {
    triggerHaptic('light');
    navigator.share({
      title: title,
      text: text
    }).catch(err => {
      console.warn('Native share failed', err);
      fallbackCopyFn();
    });
  } else {
    fallbackCopyFn();
  }
}

function showToast(msg, type = 'info', duration = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `toast toast toast--${type}`;
  el.hidden = false;
  clearTimeout(el._timer);
  el._timer = setTimeout(() => { el.hidden = true; }, duration);
}

let modalScrollPosition = 0;
let modalScrollLocked = false;

function syncModalScrollLock() {
  const hasOpenModal = Array.from(document.querySelectorAll('.modal-overlay'))
    .some(modal => !modal.hidden);

  if (hasOpenModal === modalScrollLocked) return;

  if (hasOpenModal) {
    modalScrollPosition = window.scrollY;
    document.documentElement.classList.add('modal-open');
    document.body.classList.add('modal-open');
    document.body.style.top = `-${modalScrollPosition}px`;
    modalScrollLocked = true;
    return;
  }

  document.documentElement.classList.remove('modal-open');
  document.body.classList.remove('modal-open');
  document.body.style.removeProperty('top');
  const previousScrollBehavior = document.documentElement.style.scrollBehavior;
  document.documentElement.style.scrollBehavior = 'auto';
  window.scrollTo(0, modalScrollPosition);
  document.documentElement.style.scrollBehavior = previousScrollBehavior;
  modalScrollLocked = false;
}

const modalScrollObserver = new MutationObserver(syncModalScrollLock);
document.querySelectorAll('.modal-overlay').forEach(modal => {
  modalScrollObserver.observe(modal, { attributes: true, attributeFilter: ['hidden'] });
});
syncModalScrollLock();

// Custom confirm dialog (replaces window.confirm which Chrome blocks on file://)
function showConfirm(message, onOk, onCancel = null, okText = 'Xóa') {
  triggerHaptic('warning');
  const overlay  = document.getElementById('confirm-modal');
  const bodyEl   = document.getElementById('confirm-modal-body');
  const okBtn    = document.getElementById('confirm-modal-ok');
  const cancelBtn= document.getElementById('confirm-modal-cancel');
  const closeBtn = document.getElementById('confirm-modal-close');

  bodyEl.textContent = message;
  okBtn.textContent = okText;
  
  if (okText === 'Xóa') {
    okBtn.style.background = 'var(--red)';
    okBtn.style.borderColor = 'var(--red)';
  } else {
    okBtn.style.background = 'var(--primary)';
    okBtn.style.borderColor = 'var(--primary)';
  }

  overlay.hidden = false;

  const cleanup = () => { overlay.hidden = true; };

  // Remove old listeners by cloning the buttons
  const newOk     = okBtn.cloneNode(true);
  const newCancel = cancelBtn.cloneNode(true);
  const newClose  = closeBtn.cloneNode(true);
  okBtn.replaceWith(newOk);
  cancelBtn.replaceWith(newCancel);
  closeBtn.replaceWith(newClose);

  newOk.addEventListener('click', () => { cleanup(); onOk(); });
  newCancel.addEventListener('click', () => { cleanup(); if (onCancel) onCancel(); });
  newClose.addEventListener('click', () => { cleanup(); if (onCancel) onCancel(); });
  overlay.onclick = (e) => { if (e.target === overlay) { cleanup(); if (onCancel) onCancel(); } };
}

function getPreviousPeriodKey(period) {
  const { year, month } = parsePeriod(period);
  let prevMonth = month - 1;
  let prevYear = year;
  if (prevMonth === 0) {
    prevMonth = 12;
    prevYear = year - 1;
  }
  return periodKey(prevYear, prevMonth);
}

function getElectricOld(room, period) {
  const curRec = getPeriodRecord(room.id, period);
  if (curRec && curRec.electricOldOverride !== undefined && curRec.electricOldOverride !== '' && curRec.electricOldOverride !== null) {
    return Number(curRec.electricOldOverride);
  }
  const prevPeriod = getPreviousPeriodKey(period);
  const prevRec = getPeriodRecord(room.id, prevPeriod);
  if (prevRec && isInvoiceSettled(room.id, prevPeriod, prevRec.paid)
      && prevRec.electricNew !== undefined && prevRec.electricNew !== '') {
    return Number(prevRec.electricNew);
  }
  return room.electricPrev || 0;
}

function getLatestPaidElectric(room) {
  let latestVal = null;
  let latestPeriod = '';
  for (const period in STATE.billingData) {
    const rec = STATE.billingData[period]?.[room.id];
    if (rec && isInvoiceSettled(room.id, period, rec.paid)
        && rec.electricNew !== undefined && rec.electricNew !== '') {
      if (!latestPeriod || period.localeCompare(latestPeriod) > 0) {
        latestPeriod = period;
        latestVal = Number(rec.electricNew);
      }
    }
  }
  return latestVal;
}

function getWaterOld(room, period) {
  const curRec = getPeriodRecord(room.id, period);
  if (curRec && curRec.waterOldOverride !== undefined && curRec.waterOldOverride !== '' && curRec.waterOldOverride !== null) {
    return Number(curRec.waterOldOverride);
  }
  const prevPeriod = getPreviousPeriodKey(period);
  const prevRec = getPeriodRecord(room.id, prevPeriod);
  if (prevRec && isInvoiceSettled(room.id, prevPeriod, prevRec.paid)
      && prevRec.waterNew !== undefined && prevRec.waterNew !== '' && prevRec.waterNew !== null) {
    return Number(prevRec.waterNew);
  }
  return room.waterPrev || 0;
}

function getLatestPaidWater(room) {
  let latestVal = null;
  let latestPeriod = '';
  for (const period in STATE.billingData) {
    const rec = STATE.billingData[period]?.[room.id];
    if (rec && isInvoiceSettled(room.id, period, rec.paid)
        && rec.waterNew !== undefined && rec.waterNew !== '' && rec.waterNew !== null) {
      if (!latestPeriod || period.localeCompare(latestPeriod) > 0) {
        latestPeriod = period;
        latestVal = Number(rec.waterNew);
      }
    }
  }
  return latestVal;
}

function openEditOldModal(roomId, targetType = 'elec') {
  const room = STATE.rooms.find(r => r.id === roomId);
  if (!room) return;

  const period = STATE.currentPeriod;
  const rec = getPeriodRecord(roomId, period);
  const isElec = targetType === 'elec';

  const prevPeriod = getPreviousPeriodKey(period);
  const prevRec = getPeriodRecord(roomId, prevPeriod);
  let autoVal = 0;
  if (isElec) {
    autoVal = (prevRec && isInvoiceSettled(room.id, prevPeriod, prevRec.paid)
      && prevRec.electricNew !== undefined && prevRec.electricNew !== '')
      ? Number(prevRec.electricNew) : (room.electricPrev || 0);
  } else {
    autoVal = (prevRec && isInvoiceSettled(room.id, prevPeriod, prevRec.paid)
      && prevRec.waterNew !== undefined && prevRec.waterNew !== '' && prevRec.waterNew !== null)
      ? Number(prevRec.waterNew) : (room.waterPrev || 0);
  }

  const currentOverride = isElec ? rec?.electricOldOverride : rec?.waterOldOverride;
  const hasOverride = currentOverride !== undefined && currentOverride !== '' && currentOverride !== null;
  const currentVal = isElec ? getElectricOld(room, period) : getWaterOld(room, period);

  const modal = document.getElementById('edit-old-modal');
  const title = document.getElementById('edit-old-modal-title');
  const desc = document.getElementById('edit-old-modal-desc');
  const input = document.getElementById('edit-old-modal-input');
  const label = document.getElementById('edit-old-modal-label');
  const resetBtn = document.getElementById('edit-old-modal-reset');
  const okBtn = document.getElementById('edit-old-modal-ok');
  const cancelBtn = document.getElementById('edit-old-modal-cancel');
  const closeBtn = document.getElementById('edit-old-modal-close');

  const unitName = isElec ? 'điện' : 'nước';
  title.textContent = `Sửa số ${unitName} cũ — ${room.name}`;
  desc.innerHTML = `Số ${unitName} cũ tự động từ tháng trước là: <strong>${fmtNum(autoVal)}</strong>.<br>Bạn có thể thay đổi số cũ áp dụng riêng cho <strong>${periodLabel(period)}</strong> (ví dụ: do thay công tơ/reset).`;
  label.textContent = `Số ${unitName} cũ mới (áp dụng ${periodLabel(period)})`;
  input.value = currentVal;
  resetBtn.style.display = hasOverride ? 'inline-block' : 'none';

  modal.hidden = false;

  const cleanup = () => { modal.hidden = true; };

  const newOk = okBtn.cloneNode(true);
  const newReset = resetBtn.cloneNode(true);
  const newCancel = cancelBtn.cloneNode(true);
  const newClose = closeBtn.cloneNode(true);

  okBtn.replaceWith(newOk);
  resetBtn.replaceWith(newReset);
  cancelBtn.replaceWith(newCancel);
  closeBtn.replaceWith(newClose);

  newOk.addEventListener('click', () => {
    const val = parseFloat(input.value);
    if (isNaN(val) || val < 0) {
      showToast('Vui lòng nhập chỉ số hợp lệ', 'error');
      return;
    }
    if (!STATE.billingData[period]) STATE.billingData[period] = {};
    if (!STATE.billingData[period][roomId]) STATE.billingData[period][roomId] = {};

    if (isElec) {
      STATE.billingData[period][roomId].electricOldOverride = val;
    } else {
      STATE.billingData[period][roomId].waterOldOverride = val;
    }
    saveState();
    cleanup();
    renderBilling();
    renderReport();
    showToast(`Đã cập nhật số ${unitName} cũ ✓`, 'success');
  });

  newReset.addEventListener('click', () => {
    if (STATE.billingData[period]?.[roomId]) {
      if (isElec) {
        delete STATE.billingData[period][roomId].electricOldOverride;
      } else {
        delete STATE.billingData[period][roomId].waterOldOverride;
      }
      saveState();
    }
    cleanup();
    renderBilling();
    renderReport();
    showToast(`Đã khôi phục số ${unitName} cũ tự động ✓`, 'info');
  });

  newCancel.addEventListener('click', cleanup);
  newClose.addEventListener('click', cleanup);
  modal.onclick = (e) => { if (e.target === modal) cleanup(); };
}

function closeTransferPeriodModal() {
  document.getElementById('transfer-period-modal').hidden = true;
}

function executeTransferPeriod(sourcePeriod, targetPeriod, mode) {
  STATE.billingData[targetPeriod] = clonePeriodRecords(STATE.billingData[sourcePeriod]);
  if (mode === 'move') {
    delete STATE.billingData[sourcePeriod];
  }
  STATE.currentPeriod = targetPeriod;
  saveState();
  closeTransferPeriodModal();
  renderPage(activePage);
  const actionText = mode === 'move' ? 'chuyển' : 'sao chép';
  showToast(`Đã ${actionText} dữ liệu sang ${periodLabel(targetPeriod)} ✓`, 'success');
}

function openTransferPeriodModal() {
  const sourcePeriod = STATE.currentPeriod;
  const sourceData = STATE.billingData[sourcePeriod];
  if (!sourceData || Object.keys(sourceData).length === 0) {
    showToast('Tháng này chưa có dữ liệu để chuyển', 'error');
    return;
  }

  const modal = document.getElementById('transfer-period-modal');
  const sourceInput = document.getElementById('transfer-source-period');
  const targetInput = document.getElementById('transfer-target-period');
  const submitBtn = document.getElementById('transfer-period-submit');
  const cancelBtn = document.getElementById('transfer-period-cancel');
  const closeBtn = document.getElementById('transfer-period-close');

  sourceInput.value = periodLabel(sourcePeriod);
  targetInput.value = '';
  modal.hidden = false;

  const cleanup = () => { modal.hidden = true; };

  const newSubmit = submitBtn.cloneNode(true);
  const newCancel = cancelBtn.cloneNode(true);
  const newClose = closeBtn.cloneNode(true);
  submitBtn.replaceWith(newSubmit);
  cancelBtn.replaceWith(newCancel);
  closeBtn.replaceWith(newClose);

  newSubmit.addEventListener('click', () => {
    const targetPeriod = targetInput.value;
    const mode = document.querySelector('input[name="transfer-mode"]:checked')?.value || 'move';

    if (!targetPeriod) {
      showToast('Vui lòng chọn tháng đích', 'error');
      return;
    }
    if (targetPeriod === sourcePeriod) {
      showToast('Tháng đích phải khác tháng nguồn', 'error');
      return;
    }

    const doTransfer = () => executeTransferPeriod(sourcePeriod, targetPeriod, mode);
    if (STATE.billingData[targetPeriod] && Object.keys(STATE.billingData[targetPeriod]).length > 0) {
      const actionLabel = mode === 'move' ? 'chuyển' : 'sao chép';
      showConfirm(
        `${periodLabel(targetPeriod)} đã có dữ liệu. Bạn có muốn ghi đè bằng dữ liệu từ ${periodLabel(sourcePeriod)} không?`,
        doTransfer,
        null,
        `Ghi đè & ${actionLabel}`
      );
      return;
    }

    doTransfer();
  });

  newCancel.addEventListener('click', cleanup);
  newClose.addEventListener('click', cleanup);
  modal.onclick = (e) => { if (e.target === modal) cleanup(); };
}

function closeTransferExpensesModal() {
  document.getElementById('transfer-expenses-modal').hidden = true;
}

function executeTransferExpenses(sourcePeriod, targetPeriod, mode) {
  // Bản sao cần mã mới vì id khoản chi là khóa duy nhất trong cơ sở dữ liệu.
  STATE.expenses[targetPeriod] = cloneExpenseRecords(STATE.expenses[sourcePeriod], mode === 'copy');
  if (mode === 'move') delete STATE.expenses[sourcePeriod];
  STATE.currentPeriod = targetPeriod;
  saveState();
  closeTransferExpensesModal();
  resetExpenseForm();
  renderPage(activePage);
  renderDashboard();
  showToast(`Đã ${mode === 'move' ? 'chuyển' : 'sao chép'} chi phí sang ${periodLabel(targetPeriod)} ✓`, 'success');
}

function openTransferExpensesModal() {
  const sourcePeriod = STATE.currentPeriod;
  const sourceData = getPeriodExpenses(sourcePeriod);
  if (sourceData.length === 0) {
    showToast('Tháng này chưa có chi phí để chuyển', 'error');
    return;
  }

  const modal = document.getElementById('transfer-expenses-modal');
  const sourceInput = document.getElementById('transfer-expenses-source-period');
  const targetInput = document.getElementById('transfer-expenses-target-period');
  const submitBtn = document.getElementById('transfer-expenses-submit');
  const cancelBtn = document.getElementById('transfer-expenses-cancel');
  const closeBtn = document.getElementById('transfer-expenses-close');

  sourceInput.value = periodLabel(sourcePeriod);
  targetInput.value = '';
  modal.hidden = false;

  const cleanup = () => { modal.hidden = true; };
  const newSubmit = submitBtn.cloneNode(true);
  const newCancel = cancelBtn.cloneNode(true);
  const newClose = closeBtn.cloneNode(true);
  submitBtn.replaceWith(newSubmit);
  cancelBtn.replaceWith(newCancel);
  closeBtn.replaceWith(newClose);

  newSubmit.addEventListener('click', () => {
    const targetPeriod = targetInput.value;
    const mode = document.querySelector('input[name="transfer-expenses-mode"]:checked')?.value || 'move';
    if (!targetPeriod) {
      showToast('Vui lòng chọn tháng đích', 'error');
      return;
    }
    if (targetPeriod === sourcePeriod) {
      showToast('Tháng đích phải khác tháng nguồn', 'error');
      return;
    }

    const transfer = () => executeTransferExpenses(sourcePeriod, targetPeriod, mode);
    if (getPeriodExpenses(targetPeriod).length > 0) {
      const action = mode === 'move' ? 'chuyển' : 'sao chép';
      showConfirm(
        `${periodLabel(targetPeriod)} đã có chi phí. Bạn có muốn ghi đè bằng dữ liệu từ ${periodLabel(sourcePeriod)} không?`,
        transfer,
        null,
        `Ghi đè & ${action}`
      );
      return;
    }
    transfer();
  });

  newCancel.addEventListener('click', cleanup);
  newClose.addEventListener('click', cleanup);
  modal.onclick = (e) => { if (e.target === modal) cleanup(); };
}


// ============================================================
//  BILLING CALCULATIONS
// ============================================================
function calcBill(room, record, period = null) {
  if (!record) return null;

  const rates = getRoomRates(room, period || STATE.currentPeriod);
  const electricOld = period ? getElectricOld(room, period) : (room.electricPrev || 0);
  const electricNew = record.electricNew !== undefined && record.electricNew !== '' ? Number(record.electricNew) : electricOld;
  const kwh = electricNew - electricOld;
  const safeKwh = Math.max(0, kwh);
  const electricAmt = safeKwh * rates.electricRate;
  const utilityOnly = isUtilityOnlyRecord(record);
  
  // Calculate water based on unit type (default: người)
  let waterUnits = 0;
  if (room.waterType === 'khối') {
    if (record.waterUnits !== undefined && record.waterUnits !== '' && record.waterUnits !== null && record.waterNew === undefined) {
      waterUnits = Number(record.waterUnits);
    } else {
      const waterOld = period ? getWaterOld(room, period) : (room.waterPrev || 0);
      const waterNew = record.waterNew !== undefined && record.waterNew !== '' && record.waterNew !== null ? Number(record.waterNew) : waterOld;
      waterUnits = Math.max(0, waterNew - waterOld);
    }
  } else {
    const isWaterByPerson = (room.waterType || 'người') === 'người';
    waterUnits = record.waterUnits !== undefined && record.waterUnits !== '' ? Number(record.waterUnits) : (isWaterByPerson ? (room.peopleCount || 1) : 0);
  }
  const waterAmt = waterUnits * rates.waterRate;

  const trashAmt = utilityOnly ? 0 : rates.trashFee;
  const wifiAmt = utilityOnly ? 0 : rates.wifiFee;
  const manageAmt = utilityOnly ? 0 : rates.manageFee;
  const rent = RoomRates.calculateRent(rates.rentPrice, period || STATE.currentPeriod, room.rentStartDate);
  const rentAmt = utilityOnly ? 0 : rent.amount;
  const baseSubtotal = electricAmt + waterAmt + trashAmt + wifiAmt + manageAmt + rentAmt;
  const adjustments = InvoiceAdjustments.calculate(baseSubtotal, record);

  return {
    kwh: safeKwh,
    electricRate: rates.electricRate,
    electricAmt,
    waterUnits,
    waterRate: rates.waterRate,
    waterAmt,
    trashAmt,
    wifiAmt,
    manageAmt,
    rentAmt,
    rentBasePrice: rent.basePrice,
    rentDays: rent.chargedDays,
    rentDaysInMonth: rent.daysInMonth,
    rentProrated: !utilityOnly && rent.prorated,
    rentStartsAfterPeriod: !utilityOnly && rent.startsAfterPeriod,
    subtotal: adjustments.subtotalVnd,
    discountAmt: adjustments.discountAmount,
    surchargeAmt: adjustments.surchargeAmount,
    lateFeeAmt: adjustments.lateFeeAmount,
    adjustmentNet: adjustments.adjustmentNetVnd,
    total: adjustments.totalVnd,
    rateEffectiveFrom: rates.effectiveFrom
  };
}

function billingBreakdownText(bill) {
  const parts = [];
  if (bill.electricAmt > 0) parts.push(fmtShorthand(bill.electricAmt));
  if (bill.waterAmt > 0) parts.push(fmtShorthand(bill.waterAmt));
  if (bill.trashAmt > 0) parts.push(fmtShorthand(bill.trashAmt));
  if (bill.wifiAmt > 0) parts.push(fmtShorthand(bill.wifiAmt));
  if (bill.manageAmt > 0) parts.push(fmtShorthand(bill.manageAmt));
  if (bill.rentAmt > 0) parts.push(fmtShorthand(bill.rentAmt));
  let text = parts.join(' + ');
  if (bill.surchargeAmt > 0) text += `${text ? ' + ' : ''}${fmtShorthand(bill.surchargeAmt)}`;
  if (bill.lateFeeAmt > 0) text += `${text ? ' + ' : ''}${fmtShorthand(bill.lateFeeAmt)}`;
  if (bill.discountAmt > 0) text += `${text ? ' − ' : '−'}${fmtShorthand(bill.discountAmt)}`;
  return text;
}

function getPeriodRecord(roomId, period) {
  return STATE.billingData[period]?.[roomId] || null;
}

const EXPENSE_CATEGORIES = {
  electric: { icon: '⚡', label: 'Tiền điện nhà nước' },
  water: { icon: '💧', label: 'Tiền nước nhà nước' },
  trash: { icon: '🗑️', label: 'Phí rác' },
  internet: { icon: '📶', label: 'Tiền Internet' },
  other: { icon: '➕', label: 'Chi phí khác' }
};

function getPeriodExpenses(period = STATE.currentPeriod) {
  return Array.isArray(STATE.expenses[period]) ? STATE.expenses[period] : [];
}

function getExpenseTotal(period = STATE.currentPeriod) {
  return getPeriodExpenses(period).reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
}

function getExpenseMeta(category) {
  return EXPENSE_CATEGORIES[category] || EXPENSE_CATEGORIES.other;
}

// ============================================================
//  NAVIGATION
// ============================================================
let activePage = 'dashboard';

function navigate(page) {
  triggerHaptic('light');
  activePage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  const pageEl  = document.getElementById(`page-${page}`);
  const tabEl   = document.getElementById(`tab-${page}`);
  const btabEl  = document.getElementById(`btab-${page}`);
  if (pageEl)  pageEl.classList.add('active');
  if (tabEl)   tabEl.classList.add('active');
  if (btabEl)  btabEl.classList.add('active');
  renderPage(page);
  if (page === 'report' || page === 'history') {
    ensureRentInvoicesSynced().then(() => {
      if (activePage === page) renderPage(page);
    }).catch((error) => {
      console.warn('Không tạo được mã chuyển khoản riêng:', error.message);
      showToast('Chưa tạo được mã chuyển khoản. Vui lòng thử lại.', 'error', 3000);
    });
  }
}

function renderPage(page) {
  switch (page) {
    case 'dashboard': renderDashboard(); break;
    case 'rooms':     renderRooms();     break;
    case 'billing':   renderBilling();   break;
    case 'expenses':  renderExpenses();  break;
    case 'report':    renderReport();    break;
    case 'history':   renderHistory();   break;
    case 'settings':
      renderSubscriptionSummary();
      renderSubscriptionPlans();
      renderSubscriptionPaymentHistory();
      renderRentPaymentChannel();
      break;
  }
}

function setBillingRowCompletion(tr, isComplete, shouldAnimate = false) {
  tr.classList.toggle('billing-row--complete', isComplete);
  const badge = tr.querySelector('.billing-status-badge');
  if (badge) {
    badge.textContent = isComplete ? 'Hoàn thành' : 'Chưa xong';
    badge.className = `billing-status-badge ${isComplete ? 'billing-status-badge--done' : 'billing-status-badge--pending'}`;
  }

  if (shouldAnimate) {
    tr.classList.remove('billing-row--celebrate');
    void tr.offsetWidth;
    tr.classList.add('billing-row--celebrate');
    clearTimeout(tr._celebrateTimer);
    tr._celebrateTimer = setTimeout(() => tr.classList.remove('billing-row--celebrate'), 800);
  }
}

function refreshBillingProgress() {
  const metaEl = document.getElementById('billing-progress-meta');
  const fillEl = document.getElementById('billing-progress-fill');
  if (!metaEl || !fillEl) return;

  const total = STATE.rooms.length;
  const done = document.querySelectorAll('#billing-tbody .billing-row--complete').length;
  const percent = total > 0 ? Math.round((done / total) * 100) : 0;

  metaEl.textContent = `${done}/${total} phòng hoàn thành`;
  fillEl.style.width = `${percent}%`;
}

// ============================================================
//  DASHBOARD
// ============================================================
function renderDashboard() {
  const period = STATE.currentPeriod;
  document.getElementById('dashboard-period').textContent = periodLabel(period);
  document.getElementById('period-display').textContent = periodLabel(period);
  document.getElementById('deduction-input').value = STATE.settings.deduction ?? 450000;

  const bankSelect = document.getElementById('bank-select');
  const bankCustomInput = document.getElementById('bank-custom-input');
  const bankAccountInput = document.getElementById('bank-account-input');
  const bankOwnerInput = document.getElementById('bank-owner-input');

  if (bankSelect) {
    const bankId = STATE.settings.bankId || '';
    const isPredefined = ['MB', 'VCB', 'TCB', 'BIDV', 'ICB', 'VBA', 'ACB', 'TPB', 'VPB', 'STB', 'VIB'].includes(bankId);
    if (bankId === '') {
      bankSelect.value = '';
      if (bankCustomInput) bankCustomInput.style.display = 'none';
    } else if (isPredefined) {
      bankSelect.value = bankId;
      if (bankCustomInput) bankCustomInput.style.display = 'none';
    } else {
      bankSelect.value = 'custom';
      if (bankCustomInput) {
        bankCustomInput.value = bankId;
        bankCustomInput.style.display = 'inline-block';
      }
    }
  }
  if (bankAccountInput) bankAccountInput.value = STATE.settings.bankAccount || '';
  if (bankOwnerInput) bankOwnerInput.value = STATE.settings.bankOwnerName || '';
  // Ẩn/hiện gợi ý ủng hộ theo cấu hình chung do admin thiết lập
  renderDonateInfo();

  const reminderEnabledInput = document.getElementById('reminder-enabled-input');
  const reminderDaySelect = document.getElementById('reminder-day-select');
  const reminderTimeInput = document.getElementById('reminder-time-input');
  
  if (reminderEnabledInput) reminderEnabledInput.checked = !!STATE.settings.reminderEnabled;
  if (reminderDaySelect) reminderDaySelect.value = STATE.settings.reminderDay || 30;
  if (reminderTimeInput) reminderTimeInput.value = STATE.settings.reminderTime || '20:00';
  renderInvoiceReminderSettings();

  let totalAmt = 0, totalPaid = 0, totalElec = 0, totalWater = 0;
  let entered = 0;

  const listEl = document.getElementById('room-status-list');
  listEl.innerHTML = '';

  if (STATE.rooms.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><div class="empty-icon">🏠</div>
      <p>Chưa có phòng nào. <button class="link-btn" data-goto="rooms">Thêm phòng ngay</button></p></div>`;
    listEl.querySelector('[data-goto]')?.addEventListener('click', () => navigate('rooms'));
  }

  for (const room of STATE.rooms) {
    const rec = getPeriodRecord(room.id, period);
    const bill = rec ? calcBill(room, rec, period) : null;
    const payment = bill
      ? rentInvoicePaymentState(room.id, period, bill.total, rec?.paid)
      : null;

    if (bill) {
      totalAmt   += bill.total;
      totalElec  += bill.electricAmt;
      totalWater += bill.waterAmt;
      totalPaid += Math.min(bill.total, payment.paidAmountVnd);
      entered++;
    }

    const item = document.createElement('div');
    item.className = 'room-status-item';
    const waterUnit = room.waterType === 'người' ? 'người' : 'khối';
    item.innerHTML = `
      <div>
        <div class="room-status-name">${room.name}</div>
        <div class="room-status-detail">
          ${bill ? `⚡ ${fmtNum(bill.kwh)} kWh &nbsp;|&nbsp; 💧 ${bill.waterUnits} ${waterUnit}` : 'Chưa nhập chỉ số'}
        </div>
      </div>
      <div class="room-status-payment">
        <div class="room-status-total">${bill ? fmt(bill.total) : '—'}</div>
        <div class="room-status-badges">
          <span class="badge ${payment?.settled ? 'badge--paid' : payment?.paidAmountVnd > 0 ? 'badge--partial' : bill ? 'badge--ok' : 'badge--empty'}">
            ${payment ? paymentStatusLabel(payment) : 'Chờ nhập'}
          </span>
          ${payment ? debtAgeBadge(payment) : ''}
        </div>
      </div>
    `;
    listEl.appendChild(item);
  }

  const totalExpenses = getExpenseTotal(period);
  document.getElementById('total-amount').textContent = fmt(totalAmt);
  document.getElementById('total-net').textContent     = `Đã thu: ${fmt(totalPaid)}`;
  document.getElementById('total-electric').textContent = fmt(totalElec);
  document.getElementById('total-water').textContent    = fmt(totalWater);
  document.getElementById('total-expenses').textContent = fmt(totalExpenses);
  document.getElementById('total-profit').textContent   = fmt(totalPaid - totalExpenses);
  document.getElementById('rooms-entered').textContent  = entered;
  document.getElementById('rooms-total').textContent    = STATE.rooms.length;
}

// ============================================================
//  EXPENSES — Chi phí chủ trọ thanh toán thực tế
// ============================================================
function resetExpenseForm() {
  const form = document.getElementById('expense-form');
  form.reset();
  document.getElementById('expense-id').value = '';
  document.getElementById('expense-name-row').hidden = true;
  document.getElementById('expense-form-cancel').hidden = true;
  document.getElementById('expense-form-submit').textContent = '+ Lưu chi phí';
}

function renderExpenses() {
  const period = STATE.currentPeriod;
  const expenses = getPeriodExpenses(period);
  const listEl = document.getElementById('expense-list');
  const summaryEl = document.getElementById('expense-summary');

  document.getElementById('expenses-period-label').textContent = periodLabel(period);
  document.getElementById('expenses-month-input').value = periodInputValue(period);
  document.getElementById('expense-total').textContent = fmt(getExpenseTotal(period));

  summaryEl.innerHTML = Object.entries(EXPENSE_CATEGORIES)
    .filter(([category]) => category !== 'other')
    .map(([category, meta]) => {
      const total = expenses
        .filter(item => item.category === category)
        .reduce((sum, item) => sum + (Number(item.amount) || 0), 0);
      return `<div class="expense-summary-item"><div class="expense-summary-label">${meta.icon} ${meta.label}</div><div class="expense-summary-value">${fmt(total)}</div></div>`;
    }).join('');

  if (expenses.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><div class="empty-icon">💸</div><p>Chưa ghi nhận chi phí nào trong tháng này.</p></div>`;
    return;
  }

  listEl.innerHTML = expenses.map(item => {
    const meta = getExpenseMeta(item.category);
    const name = item.category === 'other' && item.name ? item.name : meta.label;
    const details = [item.paidDate ? `Ngày trả: ${new Date(`${item.paidDate}T00:00:00`).toLocaleDateString('vi-VN')}` : '', item.note]
      .filter(Boolean).join(' | ') || 'Chưa có ghi chú';
    return `
      <div class="expense-item">
        <div class="expense-item-icon">${meta.icon}</div>
        <div class="expense-item-main">
          <div class="expense-item-name">${name}</div>
          <div class="expense-item-meta">${details}</div>
        </div>
        <div class="expense-item-amount">${fmt(item.amount)}</div>
        <div class="expense-item-actions">
          <button class="btn btn--ghost btn--sm" data-edit-expense="${item.id}" title="Sửa">✏️</button>
          <button class="btn btn--danger btn--sm" data-delete-expense="${item.id}" title="Xóa">🗑️</button>
        </div>
      </div>`;
  }).join('');

  listEl.querySelectorAll('[data-edit-expense]').forEach(button => {
    button.addEventListener('click', () => editExpense(button.dataset.editExpense));
  });
  listEl.querySelectorAll('[data-delete-expense]').forEach(button => {
    button.addEventListener('click', () => deleteExpense(button.dataset.deleteExpense));
  });
}

function editExpense(id) {
  const item = getPeriodExpenses().find(expense => expense.id === id);
  if (!item) return;
  document.getElementById('expense-id').value = item.id;
  document.getElementById('expense-category').value = item.category;
  document.getElementById('expense-name').value = item.name || '';
  document.getElementById('expense-amount').value = item.amount;
  document.getElementById('expense-date').value = item.paidDate || '';
  document.getElementById('expense-note').value = item.note || '';
  document.getElementById('expense-name-row').hidden = item.category !== 'other';
  document.getElementById('expense-form-cancel').hidden = false;
  document.getElementById('expense-form-submit').textContent = 'Lưu thay đổi';
  document.getElementById('expense-amount').focus();
}

function deleteExpense(id) {
  const item = getPeriodExpenses().find(expense => expense.id === id);
  if (!item) return;
  const meta = getExpenseMeta(item.category);
  showConfirm(`Xóa khoản “${item.name || meta.label}” của ${periodLabel(STATE.currentPeriod)}?`, () => {
    STATE.expenses[STATE.currentPeriod] = getPeriodExpenses().filter(expense => expense.id !== id);
    if (STATE.expenses[STATE.currentPeriod].length === 0) delete STATE.expenses[STATE.currentPeriod];
    saveState();
    renderExpenses();
    renderDashboard();
    showToast('Đã xóa khoản chi', 'info');
  });
}

// ============================================================
//  ROOMS
// ============================================================
let rentalContractRoomId = '';
let rentalContracts = [];
let activeRentalContractDocumentId = null;
let activeRentalContractDocumentData = null;
let activeRentalHandoverContractId = null;
let activeRentalHandover = null;
let rentalHandovers = [];
let rentalReservations = [];
let rentalLifecycleEvents = [];
let activeRentalLifecycleContract = null;
let activeRentalFinalSettlementContract = null;
let activeRentalFinalSettlementPreview = null;
let activeRentalFinalSettlement = null;

function rentalContractStatusLabel(status) {
  return ({
    draft: 'Bản nháp',
    active: 'Đang hoạt động',
    ended: 'Đã kết thúc',
    cancelled: 'Đã hủy'
  })[status] || status;
}

function rentalReservationStatusLabel(status) {
  return ({
    active: 'Đang giữ chỗ',
    converted: 'Đã thành hợp đồng',
    cancelled: 'Đã hủy',
    expired: 'Đã hết hạn'
  })[status] || status;
}

function rentalLifecycleEventLabel(type) {
  return ({
    reservation_created: 'Tạo giữ chỗ',
    reservation_cancelled: 'Hủy giữ chỗ',
    reservation_converted: 'Chuyển thành hợp đồng',
    room_transferred: 'Chuyển phòng',
    checked_out: 'Trả phòng',
    maintenance_started: 'Bắt đầu sửa phòng',
    maintenance_completed: 'Hoàn thành sửa phòng'
  })[type] || type;
}

function isoDateAfter(date, days) {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

function renderRentalReservations() {
  const list = document.getElementById('rental-reservation-list');
  const form = document.getElementById('rental-reservation-form');
  const reservationRow = document.getElementById('rental-contract-reservation-row');
  const reservationSelect = document.getElementById('rental-contract-reservation');
  if (!list || !form || !reservationRow || !reservationSelect) return;
  const activeReservation = rentalReservations.find(item => item.status === 'active') || null;
  const activeContract = rentalContracts.some(item => item.status === 'active');
  const contractStatus = document.getElementById('rental-contract-status');
  const draftOption = contractStatus?.querySelector('option[value="draft"]');
  if (draftOption) draftOption.disabled = !!activeReservation;
  if (activeReservation && contractStatus) contractStatus.value = 'active';
  form.hidden = !!activeReservation || activeContract;
  list.innerHTML = '';
  if (rentalReservations.length === 0 && rentalLifecycleEvents.length === 0) {
    list.innerHTML = '<p class="rental-contract-empty">Chưa có lượt giữ chỗ hoặc sự kiện vòng đời.</p>';
  }
  for (const reservation of rentalReservations) {
    const item = document.createElement('article');
    item.className = `rental-reservation-card rental-reservation-card--${reservation.status}`;
    item.dataset.reservationId = String(reservation.id);
    item.innerHTML = `
      <div>
        <strong>${escapeHtml(reservation.code)} · ${escapeHtml(reservation.guestName)}</strong>
        <span>${escapeHtml(rentalReservationStatusLabel(reservation.status))} · nhận phòng ${escapeHtml(dateLabel(reservation.expectedMoveInOn) || reservation.expectedMoveInOn)} · hết hạn ${escapeHtml(dateLabel(reservation.expiresOn) || reservation.expiresOn)}</span>
        <span>Cọc dự kiến ${fmt(reservation.expectedDepositVnd)}${reservation.guestPhone ? ` · ${escapeHtml(reservation.guestPhone)}` : ''}</span>
      </div>
      ${reservation.status === 'active' ? `
        <div class="rental-reservation-cancel">
          <input class="form-input" type="text" minlength="10" maxlength="500" data-reservation-cancel-reason placeholder="Lý do hủy từ 10 ký tự" />
          <button type="button" class="btn btn--danger btn--sm" data-reservation-cancel>Hủy giữ chỗ</button>
        </div>` : ''}`;
    list.appendChild(item);
  }
  const recentEvents = rentalLifecycleEvents.slice(0, 5);
  if (recentEvents.length > 0) {
    const history = document.createElement('div');
    history.className = 'rental-lifecycle-history';
    history.innerHTML = `<strong>Lịch sử gần đây</strong>${recentEvents.map(event => `
      <span>${escapeHtml(dateLabel(event.occurredOn) || event.occurredOn)} · ${escapeHtml(rentalLifecycleEventLabel(event.eventType))} · ${escapeHtml(event.code)}</span>`).join('')}`;
    list.appendChild(history);
  }
  reservationRow.hidden = !activeReservation;
  reservationSelect.replaceChildren();
  if (activeReservation) {
    const option = document.createElement('option');
    option.value = String(activeReservation.id);
    option.textContent = `${activeReservation.code} · ${activeReservation.guestName}`;
    reservationSelect.appendChild(option);
  }
}

async function submitRentalReservation(event) {
  event.preventDefault();
  const button = document.getElementById('rental-reservation-submit');
  button.disabled = true;
  try {
    await API.createRentalReservation({
      roomId: rentalContractRoomId,
      guestName: document.getElementById('rental-reservation-guest').value,
      guestPhone: document.getElementById('rental-reservation-phone').value,
      reservedOn: document.getElementById('rental-reservation-date').value,
      expectedMoveInOn: document.getElementById('rental-reservation-move-in').value,
      expiresOn: document.getElementById('rental-reservation-expiry').value,
      expectedDepositVnd: Number(document.getElementById('rental-reservation-deposit').value || 0),
      note: document.getElementById('rental-reservation-note').value
    });
    await refreshRoomOperationalStatuses();
    showToast('Đã tạo giữ chỗ ✓', 'success');
    document.getElementById('rental-reservation-form').reset();
    await loadRentalContracts();
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    showToast(error.message || 'Không tạo được lượt giữ chỗ', 'error', 4500);
  } finally {
    button.disabled = false;
  }
}

async function cancelRentalReservation(card, button) {
  const reason = card.querySelector('[data-reservation-cancel-reason]')?.value.trim() || '';
  if (reason.length < 10) {
    showToast('Vui lòng nhập lý do hủy ít nhất 10 ký tự', 'error');
    return;
  }
  button.disabled = true;
  try {
    await API.cancelRentalReservation(Number(card.dataset.reservationId), {
      reason,
      occurredOn: vietnamCalendarDate()
    });
    await refreshRoomOperationalStatuses();
    showToast('Đã hủy lượt giữ chỗ', 'success');
    await loadRentalContracts();
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    showToast(error.message || 'Không hủy được lượt giữ chỗ', 'error', 4500);
  } finally {
    button.disabled = false;
  }
}

function applyContractRateToRoom(rate) {
  if (!rate || !rate.roomId || !RoomRates.isPeriod(rate.effectiveFrom)) return;
  const room = STATE.rooms.find(item => item.id === rate.roomId);
  if (!room) return;
  const entry = {
    effectiveFrom: rate.effectiveFrom,
    rentPrice: Number(rate.rentPrice) || 0,
    electricRate: Number(rate.electricRate) || 0,
    waterRate: Number(rate.waterRate) || 0,
    trashFee: Number(rate.trashFee) || 0,
    wifiFee: Number(rate.wifiFee) || 0,
    manageFee: Number(rate.manageFee) || 0
  };
  const history = RoomRates.normalizeHistory(room).filter(
    item => item.effectiveFrom !== entry.effectiveFrom
  );
  history.push(entry);
  room.rateHistory = RoomRates.normalizeHistory({ ...room, rateHistory: history });
  Object.assign(room, RoomRates.snapshot(RoomRates.latest(room)));
  if (rate.rentStartDate) room.rentStartDate = rate.rentStartDate;
}

function rentalContractDateRange(contract) {
  const start = dateLabel(contract.startsOn) || contract.startsOn;
  const end = contract.endsOn ? (dateLabel(contract.endsOn) || contract.endsOn) : 'Không thời hạn';
  return `${start} → ${end}`;
}

function rentalContractCycleSummary(contract) {
  return `${RentalContractCycle.cycleLabel(contract.billingCycleMonths)} · hạn ngày ${Number(contract.paymentDueDay) || 5}`;
}

function rentalContractNextPaymentLabel(contract) {
  const nextDue = RentalContractCycle.nextPaymentDueOn(contract, {
    fromDate: vietnamCalendarDate()
  });
  return nextDue ? (dateLabel(nextDue) || nextDue) : 'Không còn kỳ thanh toán';
}

function rentalContractExpiryStatus(contract) {
  return RentalContractCycle.expiryStatus(contract, {
    fromDate: vietnamCalendarDate()
  });
}

function renderRentalContracts() {
  const list = document.getElementById('rental-contract-list');
  const empty = document.getElementById('rental-contract-empty');
  list.innerHTML = '';
  empty.hidden = rentalContracts.length > 0;
  const hasActive = rentalContracts.some(contract => contract.status === 'active');
  const statusInput = document.getElementById('rental-contract-status');
  if (statusInput && hasActive && statusInput.value === 'active') statusInput.value = 'draft';

  for (const contract of rentalContracts) {
    const card = document.createElement('article');
    card.className = `rental-contract-card rental-contract-card--${contract.status}`;
    card.dataset.contractId = String(contract.id);
    const amendments = Array.isArray(contract.amendments) ? contract.amendments : [];
    const expiry = rentalContractExpiryStatus(contract);
    const canFinalizeCheckout = contract.status === 'ended'
      && rentalLifecycleEvents.some(event => event.eventType === 'checked_out'
        && Number(event.contractId) === Number(contract.id));
    const amendmentItems = amendments.length > 0
      ? amendments.map(amendment => `
          <li>
            <strong>${escapeHtml(amendment.code)}</strong>
            <span>${escapeHtml(periodLabel(amendment.effectiveFrom))}: ${fmt(amendment.previousMonthlyRentVnd)} → ${fmt(amendment.newMonthlyRentVnd)}</span>
            <small>${escapeHtml(amendment.reason)}</small>
          </li>`).join('')
      : '<li class="rental-contract-amendment-empty">Chưa có phụ lục giá.</li>';
    const statusActions = contract.status === 'draft'
      ? `
          <button type="button" class="btn btn--primary btn--sm" data-contract-status="active">Kích hoạt</button>
          <button type="button" class="btn btn--danger btn--sm" data-contract-status="cancelled">Hủy hợp đồng</button>`
      : contract.status === 'active'
        ? '<button type="button" class="btn btn--danger btn--sm" data-contract-status="cancelled">Hủy hợp đồng</button>'
        : '';
    const statusPanel = statusActions
      ? `
        <div class="rental-contract-status-panel">
          <input class="form-input" type="text" maxlength="500" data-contract-status-reason placeholder="Lý do từ 10 ký tự khi kết thúc hoặc hủy" />
          <div class="rental-contract-card-actions">${statusActions}</div>
        </div>`
      : '';
    const amendmentForm = contract.status === 'active'
      ? `
        <form class="rental-contract-amendment-form" data-contract-amendment-form="${contract.id}">
          <strong>Tạo phụ lục thay đổi giá</strong>
          <div class="rental-contract-amendment-grid">
            <label class="form-label">Áp dụng từ tháng *
              <input class="form-input" type="month" name="effectiveFrom" min="${escapeHtml(contract.startsOn.slice(0, 7))}" ${contract.endsOn ? `max="${escapeHtml(contract.endsOn.slice(0, 7))}"` : ''} required />
            </label>
            <label class="form-label">Giá thuê mới *
              <input class="form-input" type="number" name="newMonthlyRentVnd" min="0" step="1" value="${Number(contract.currentMonthlyRentVnd) || 0}" required />
            </label>
          </div>
          <label class="form-label">Lý do phụ lục *
            <input class="form-input" type="text" name="reason" minlength="10" maxlength="500" placeholder="Ví dụ: Điều chỉnh giá theo thỏa thuận ngày…" required />
          </label>
          <button type="submit" class="btn btn--primary btn--sm">Tạo phụ lục</button>
        </form>`
      : '';
    card.innerHTML = `
      <div class="rental-contract-card-head">
        <div>
          <strong>${escapeHtml(contract.code)}</strong>
          <span>${escapeHtml(contract.tenantName)}</span>
        </div>
        <span class="rental-contract-status rental-contract-status--${escapeHtml(contract.status)}">${escapeHtml(rentalContractStatusLabel(contract.status))}</span>
      </div>
      <dl class="rental-contract-meta">
        <div><dt>Thời hạn</dt><dd>${escapeHtml(rentalContractDateRange(contract))}</dd></div>
        <div><dt>Giá ban đầu</dt><dd>${fmt(contract.monthlyRentVnd)}/tháng</dd></div>
        <div><dt>Giá mới nhất</dt><dd>${fmt(contract.currentMonthlyRentVnd)}/tháng</dd></div>
        <div><dt>Tiền cọc</dt><dd>${fmt(contract.depositVnd)}</dd></div>
        <div><dt>Chu kỳ thanh toán</dt><dd>${escapeHtml(rentalContractCycleSummary(contract))}</dd></div>
        <div><dt>Kỳ đến hạn tiếp theo</dt><dd>${escapeHtml(rentalContractNextPaymentLabel(contract))}</dd></div>
        <div><dt>Nhắc hết hạn</dt><dd class="rental-contract-expiry rental-contract-expiry--${escapeHtml(expiry.level)}">${escapeHtml(expiry.label)}</dd></div>
      </dl>
      ${contract.terms ? `<p class="rental-contract-terms-view">${escapeHtml(contract.terms)}</p>` : ''}
      ${contract.statusReason ? `<p class="rental-contract-status-reason"><strong>Lý do:</strong> ${escapeHtml(contract.statusReason)}</p>` : ''}
      <div class="rental-contract-amendments">
        <strong>Phụ lục giá</strong>
        <ul>${amendmentItems}</ul>
      </div>
      <div class="rental-contract-card-actions">
        <button type="button" class="btn btn--ghost btn--sm" data-contract-deposit>💰 Sổ cọc</button>
        ${contract.status !== 'cancelled' ? '<button type="button" class="btn btn--ghost btn--sm" data-contract-handover>📦 Bàn giao tài sản</button>' : ''}
        ${contract.status === 'active' ? '<button type="button" class="btn btn--ghost btn--sm" data-contract-lifecycle="transfer">🔁 Chuyển phòng</button><button type="button" class="btn btn--ghost btn--sm" data-contract-lifecycle="checkout">🚪 Trả phòng</button>' : ''}
        ${canFinalizeCheckout ? '<button type="button" class="btn btn--primary btn--sm" data-contract-final-settlement>🧾 Quyết toán cuối</button>' : ''}
        <button type="button" class="btn btn--ghost btn--sm" data-contract-document>📄 Xem / In hợp đồng</button>
      </div>
      ${amendmentForm}
      ${statusPanel}`;
    list.appendChild(card);
  }
}

function rentalContractEquipmentText() {
  return ContractTemplate.DEFAULT_EQUIPMENT
    .map(([name, quantity, condition]) => [name, quantity, condition].join(' | '))
    .join('\n');
}

function parseRentalContractEquipmentInput(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .slice(0, 10)
    .map(line => {
      const [name = '', quantity = '', ...conditionParts] = line.split('|');
      return [name.trim(), quantity.trim(), conditionParts.join('|').trim()];
    });
}

function rentalContractBankPaymentText() {
  return [STATE.settings.bankOwnerName, STATE.settings.bankId, STATE.settings.bankAccount]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .join(' · ');
}

function clearRentalContractDocumentSensitiveData() {
  activeRentalContractDocumentId = null;
  activeRentalContractDocumentData = null;
  const sensitiveInputIds = [
    'rental-contract-document-purpose',
    'contract-lessor-name',
    'contract-lessor-cccd',
    'contract-lessor-issue-date',
    'contract-lessor-issue-place',
    'contract-lessor-phone',
    'contract-lessor-address'
  ];
  for (const id of sensitiveInputIds) {
    const input = document.getElementById(id);
    if (input) input.value = '';
  }
  const paper = document.getElementById('rental-contract-document-paper');
  if (paper) paper.replaceChildren();
  const printArea = document.getElementById('print-area');
  if (printArea?.querySelector('[data-contract-document]')) printArea.replaceChildren();
  printArea?.classList.remove('print-area--rental-contract');
}

function closeRentalContractDocumentModal() {
  document.getElementById('rental-contract-document-modal').hidden = true;
  document.getElementById('rental-contract-document-preview').hidden = true;
  document.getElementById('rental-contract-document-form').hidden = false;
  document.getElementById('rental-contract-document-error').hidden = true;
  clearRentalContractDocumentSensitiveData();
}

function openRentalContractDocumentModal(contract) {
  if (!contract || !ContractTemplate) return;
  const room = STATE.rooms.find(item => item.id === contract.roomId);
  if (!room) {
    showToast('Không tìm thấy phòng của hợp đồng', 'error');
    return;
  }
  clearRentalContractDocumentSensitiveData();
  activeRentalContractDocumentId = Number(contract.id);
  const form = document.getElementById('rental-contract-document-form');
  form.reset();
  form.hidden = false;
  document.getElementById('rental-contract-document-preview').hidden = true;
  document.getElementById('rental-contract-document-code').textContent = `${contract.code} · ${contract.tenantName}`;
  document.getElementById('contract-property-address').value = '40 Vũ Hữu, Quận Hải Châu, TP Đà Nẵng';
  document.getElementById('contract-rental-purpose').value = 'Để ở';
  document.getElementById('contract-maximum-occupants').value = Math.max(
    1,
    Number(room.peopleCount) || room.tenants?.length || 1
  );
  document.getElementById('contract-bank-payment').value = rentalContractBankPaymentText();
  document.getElementById('contract-equipment').value = rentalContractEquipmentText();
  document.getElementById('rental-contract-document-modal').hidden = false;
  document.getElementById('rental-contract-document-purpose').focus();
}

function rentalContractDocumentOptions(contract) {
  const room = STATE.rooms.find(item => item.id === contract.roomId);
  const rates = room
    ? getRoomRates(room, String(contract.startsOn || STATE.currentPeriod).slice(0, 7))
    : {};
  return {
    lessor: {
      fullName: document.getElementById('contract-lessor-name').value,
      cccd: document.getElementById('contract-lessor-cccd').value,
      issueDate: document.getElementById('contract-lessor-issue-date').value,
      issuePlace: document.getElementById('contract-lessor-issue-place').value,
      phone: document.getElementById('contract-lessor-phone').value,
      address: document.getElementById('contract-lessor-address').value
    },
    propertyAddress: document.getElementById('contract-property-address').value,
    floor: document.getElementById('contract-room-floor').value,
    rentalPurpose: document.getElementById('contract-rental-purpose').value,
    maximumOccupants: document.getElementById('contract-maximum-occupants').value,
    bankPayment: document.getElementById('contract-bank-payment').value,
    equipment: parseRentalContractEquipmentInput(document.getElementById('contract-equipment').value),
    electricRate: Number(rates.electricRate) || 0,
    waterRate: Number(rates.waterRate) || 0,
    waterUnit: room?.waterType === 'người' ? 'người/tháng' : 'm³',
    wifiFee: Number(rates.wifiFee) || 0
  };
}

async function submitRentalContractDocument(event) {
  event.preventDefault();
  const contract = rentalContracts.find(item => Number(item.id) === activeRentalContractDocumentId);
  if (!contract) return closeRentalContractDocumentModal();
  const purpose = document.getElementById('rental-contract-document-purpose').value.trim();
  const button = document.getElementById('rental-contract-document-generate');
  const errorElement = document.getElementById('rental-contract-document-error');
  button.disabled = true;
  errorElement.hidden = true;
  try {
    if (!activeRentalContractDocumentData) {
      activeRentalContractDocumentData = await API.getRentalContractDocument(contract.id, purpose);
    }
    const html = ContractTemplate.build(
      activeRentalContractDocumentData,
      rentalContractDocumentOptions(contract)
    );
    document.getElementById('rental-contract-document-paper').innerHTML = html;
    document.getElementById('rental-contract-document-form').hidden = true;
    document.getElementById('rental-contract-document-preview').hidden = false;
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    errorElement.textContent = error.message || 'Không tạo được bản hợp đồng';
    errorElement.hidden = false;
  } finally {
    button.disabled = false;
  }
}

function backToRentalContractDocumentForm() {
  document.getElementById('rental-contract-document-preview').hidden = true;
  document.getElementById('rental-contract-document-form').hidden = false;
}

function printRentalContractDocument() {
  const paper = document.getElementById('rental-contract-document-paper');
  const printArea = document.getElementById('print-area');
  const contract = activeRentalContractDocumentData?.contract;
  if (!paper.firstElementChild || !contract) return;
  printArea.innerHTML = paper.innerHTML;
  printArea.classList.add('print-area--rental-contract');
  const safeCode = removeVietnameseTones(contract.code || 'hop-dong')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .toLowerCase();
  try {
    triggerPrint(`${safeCode}.pdf`);
  } finally {
    window.setTimeout(closeRentalContractDocumentModal, 0);
  }
}

function rentalHandoverTypeLabel(type) {
  return type === 'check_out' ? 'Trả phòng' : 'Nhận phòng';
}

function rentalHandoverItemsText() {
  return ContractTemplate.DEFAULT_EQUIPMENT
    .map(([name, quantity, condition]) => [name, quantity, 'cái', condition || 'Tốt', ''].join(' | '))
    .join('\n');
}

function parseRentalHandoverItems(value) {
  const lines = String(value || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (lines.length < 1 || lines.length > 50) {
    throw new Error('Biên bản phải có từ 1 đến 50 dòng tài sản.');
  }
  return lines.map((line, index) => {
    const [name = '', quantity = '', unit = '', condition = '', ...noteParts] = line.split('|');
    const amount = Number(quantity.trim());
    if (!name.trim() || !Number.isFinite(amount) || amount <= 0 || !unit.trim() || !condition.trim()) {
      throw new Error(`Dòng tài sản ${index + 1} phải đủ Tên | Số lượng | Đơn vị | Tình trạng.`);
    }
    return {
      name: name.trim(),
      quantity: amount,
      unit: unit.trim(),
      condition: condition.trim(),
      note: noteParts.join('|').trim()
    };
  });
}

function renderRentalHandovers() {
  const list = document.getElementById('rental-handover-list');
  const empty = document.getElementById('rental-handover-empty');
  const form = document.getElementById('rental-handover-form');
  const typeInput = document.getElementById('rental-handover-type');
  if (!list || !empty || !form || !typeInput) return;
  list.innerHTML = '';
  empty.hidden = rentalHandovers.length > 0;
  const usedTypes = new Set(rentalHandovers.map(item => item.handoverType));
  for (const option of typeInput.options) option.disabled = usedTypes.has(option.value);
  const available = ['check_in', 'check_out'].find(type => !usedTypes.has(type));
  form.hidden = !available;
  if (available) {
    typeInput.value = available;
    updateRentalHandoverDate();
  }

  for (const handover of rentalHandovers) {
    const matchesDeposit = Number(handover.expectedDepositVnd) === Number(handover.depositBalanceSnapshotVnd);
    const card = document.createElement('article');
    card.className = 'rental-handover-card';
    card.dataset.handoverId = String(handover.id);
    card.innerHTML = `
      <div>
        <strong>${escapeHtml(handover.code)} · ${escapeHtml(rentalHandoverTypeLabel(handover.handoverType))}</strong>
        <span>${escapeHtml(dateLabel(handover.occurredOn) || handover.occurredOn)} · ${handover.items.length} tài sản · ${handover.keyCount} chìa khóa</span>
        <span class="${matchesDeposit ? '' : 'rental-handover-deposit-warning'}">Cọc hợp đồng ${fmt(handover.expectedDepositVnd)} · Sổ cọc ${fmt(handover.depositBalanceSnapshotVnd)}</span>
      </div>
      <button type="button" class="btn btn--ghost btn--sm" data-handover-preview>Xem / In biên bản</button>`;
    list.appendChild(card);
  }
}

function updateRentalHandoverDate() {
  const contract = rentalContracts.find(item => Number(item.id) === activeRentalHandoverContractId);
  const type = document.getElementById('rental-handover-type')?.value;
  const input = document.getElementById('rental-handover-date');
  if (!contract || !input) return;
  input.min = contract.startsOn;
  if (type === 'check_in') {
    input.max = contract.endsOn || '';
    input.value = contract.startsOn;
  } else {
    input.removeAttribute('max');
    input.value = contract.endsOn || vietnamCalendarDate();
  }
}

function closeRentalHandoverModal() {
  document.getElementById('rental-handover-modal').hidden = true;
  document.getElementById('rental-handover-preview').hidden = true;
  document.getElementById('rental-handover-editor').hidden = false;
  document.getElementById('rental-handover-paper').replaceChildren();
  const printArea = document.getElementById('print-area');
  if (printArea?.querySelector('[data-handover-document]')) printArea.replaceChildren();
  printArea?.classList.remove('print-area--rental-handover');
  activeRentalHandoverContractId = null;
  activeRentalHandover = null;
  rentalHandovers = [];
}

async function openRentalHandoverModal(contract) {
  if (!contract || !RentalHandoverTemplate) return;
  activeRentalHandoverContractId = Number(contract.id);
  activeRentalHandover = null;
  rentalHandovers = [];
  const form = document.getElementById('rental-handover-form');
  form.reset();
  form.hidden = false;
  document.getElementById('rental-handover-contract-code').textContent = `${contract.code} · ${contract.roomName} · ${contract.tenantName}`;
  document.getElementById('rental-handover-address').value = '40 Vũ Hữu, Quận Hải Châu, TP Đà Nẵng';
  document.getElementById('rental-handover-items').value = rentalHandoverItemsText();
  document.getElementById('rental-handover-condition').value = 'Phòng sạch, tường và các thiết bị hoạt động bình thường.';
  document.getElementById('rental-handover-type').value = 'check_in';
  document.getElementById('rental-handover-keys').value = '1';
  updateRentalHandoverDate();
  document.getElementById('rental-handover-error').hidden = true;
  document.getElementById('rental-handover-list').innerHTML = '<p class="rental-contract-empty">Đang tải biên bản…</p>';
  document.getElementById('rental-handover-empty').hidden = true;
  document.getElementById('rental-handover-editor').hidden = false;
  document.getElementById('rental-handover-preview').hidden = true;
  document.getElementById('rental-handover-modal').hidden = false;
  try {
    const result = await API.getRentalHandovers(contract.id);
    if (activeRentalHandoverContractId !== Number(contract.id)) return;
    rentalHandovers = Array.isArray(result.handovers) ? result.handovers : [];
    renderRentalHandovers();
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    document.getElementById('rental-handover-list').innerHTML = `<p class="rental-contract-empty rental-contract-document-error">${escapeHtml(error.message || 'Không tải được biên bản')}</p>`;
  }
}

function nullableHandoverReading(id) {
  const value = document.getElementById(id).value.trim();
  return value === '' ? null : Number(value);
}

async function createRentalHandoverFromForm() {
  const contractId = activeRentalHandoverContractId;
  const contract = rentalContracts.find(item => Number(item.id) === contractId);
  if (!contract) return;
  const errorElement = document.getElementById('rental-handover-error');
  const button = document.getElementById('rental-handover-submit');
  errorElement.hidden = true;
  button.disabled = true;
  try {
    const result = await API.createRentalHandover(contractId, {
      handoverType: document.getElementById('rental-handover-type').value,
      occurredOn: document.getElementById('rental-handover-date').value,
      lessorName: document.getElementById('rental-handover-lessor').value,
      propertyAddress: document.getElementById('rental-handover-address').value,
      electricityReading: nullableHandoverReading('rental-handover-electricity'),
      waterReading: nullableHandoverReading('rental-handover-water'),
      keyCount: Number(document.getElementById('rental-handover-keys').value),
      generalCondition: document.getElementById('rental-handover-condition').value,
      notes: document.getElementById('rental-handover-notes').value,
      items: parseRentalHandoverItems(document.getElementById('rental-handover-items').value)
    });
    rentalHandovers.push(result.handover);
    rentalHandovers.sort((a, b) => a.occurredOn.localeCompare(b.occurredOn) || a.id - b.id);
    renderRentalHandovers();
    showToast(`Đã khóa biên bản ${result.handover.code} ✓`, 'success');
    openRentalHandoverPreview(result.handover);
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    errorElement.textContent = error.message || 'Không tạo được biên bản bàn giao';
    errorElement.hidden = false;
  } finally {
    button.disabled = false;
  }
}

function submitRentalHandover(event) {
  event.preventDefault();
  try {
    parseRentalHandoverItems(document.getElementById('rental-handover-items').value);
  } catch (error) {
    const errorElement = document.getElementById('rental-handover-error');
    errorElement.textContent = error.message;
    errorElement.hidden = false;
    return;
  }
  showConfirm(
    'Xác nhận lưu và khóa biên bản? Sau thao tác này nội dung không thể sửa hoặc xóa.',
    () => { void createRentalHandoverFromForm(); },
    null,
    'Xác nhận & khóa'
  );
}

function openRentalHandoverPreview(handover) {
  activeRentalHandover = handover;
  document.getElementById('rental-handover-paper').innerHTML = RentalHandoverTemplate.build(handover);
  document.getElementById('rental-handover-editor').hidden = true;
  document.getElementById('rental-handover-preview').hidden = false;
}

function closeRentalHandoverPreview() {
  activeRentalHandover = null;
  document.getElementById('rental-handover-paper').replaceChildren();
  document.getElementById('rental-handover-preview').hidden = true;
  document.getElementById('rental-handover-editor').hidden = false;
}

function printRentalHandover() {
  const paper = document.getElementById('rental-handover-paper');
  const printArea = document.getElementById('print-area');
  if (!paper.firstElementChild || !activeRentalHandover) return;
  printArea.innerHTML = paper.innerHTML;
  printArea.classList.add('print-area--rental-handover');
  const safeCode = removeVietnameseTones(activeRentalHandover.code || 'bien-ban-ban-giao')
    .replace(/[^a-zA-Z0-9-]+/g, '-')
    .toLowerCase();
  try {
    triggerPrint(`${safeCode}.pdf`);
  } finally {
    window.setTimeout(closeRentalHandoverModal, 0);
  }
}

function updateRentalLifecycleForm() {
  const type = document.getElementById('rental-lifecycle-type').value;
  const isTransfer = type === 'transfer';
  document.querySelectorAll('.rental-lifecycle-transfer-field').forEach(element => {
    element.hidden = !isTransfer;
  });
  document.getElementById('rental-lifecycle-target-room').required = isTransfer;
  document.getElementById('rental-lifecycle-rent').required = isTransfer;
  document.getElementById('rental-lifecycle-submit').textContent = isTransfer
    ? 'Xác nhận chuyển phòng'
    : 'Xác nhận trả phòng';
}

function updateRentalLifecycleTargetRate() {
  const roomId = document.getElementById('rental-lifecycle-target-room').value;
  const room = STATE.rooms.find(item => item.id === roomId);
  if (!room) return;
  const date = document.getElementById('rental-lifecycle-date').value;
  const period = date && date.length >= 7 ? date.slice(0, 7) : STATE.currentPeriod;
  document.getElementById('rental-lifecycle-rent').value = getRoomRates(room, period).rentPrice;
}

function openRentalLifecycleModal(contract, type = 'transfer') {
  activeRentalLifecycleContract = contract;
  const form = document.getElementById('rental-lifecycle-form');
  form.reset();
  document.getElementById('rental-lifecycle-contract').textContent = `${contract.code} · ${contract.roomName} · ${contract.tenantName}`;
  document.getElementById('rental-lifecycle-type').value = type;
  document.getElementById('rental-lifecycle-date').value = vietnamCalendarDate();
  document.getElementById('rental-lifecycle-deposit').value = Number(contract.depositVnd) || 0;
  document.getElementById('rental-lifecycle-end').value = contract.endsOn || '';
  document.getElementById('rental-lifecycle-reason').value = type === 'checkout'
    ? 'Khách hoàn tất trả phòng theo thỏa thuận.'
    : 'Khách chuyển sang phòng khác theo thỏa thuận.';
  const target = document.getElementById('rental-lifecycle-target-room');
  target.replaceChildren();
  for (const room of STATE.rooms.filter(item => item.id !== contract.roomId)) {
    const option = document.createElement('option');
    option.value = room.id;
    option.textContent = room.name;
    target.appendChild(option);
  }
  document.getElementById('rental-lifecycle-error').hidden = true;
  updateRentalLifecycleForm();
  updateRentalLifecycleTargetRate();
  document.getElementById('rental-lifecycle-modal').hidden = false;
}

function closeRentalLifecycleModal() {
  activeRentalLifecycleContract = null;
  document.getElementById('rental-lifecycle-modal').hidden = true;
}

function rentalFinalSettlementMethodLabel(method) {
  return ({
    bank_transfer: 'Chuyển khoản',
    cash: 'Tiền mặt',
    manual: 'Ghi nhận thủ công',
    other: 'Khác'
  })[method] || method || '';
}

function rentalFinalSettlementDocument(settlement) {
  const detail = settlement?.detail || {};
  const contract = detail.contract || {};
  const calculation = detail.calculation || {};
  return `
    <article class="rental-final-settlement-document">
      <h1>BIÊN BẢN QUYẾT TOÁN TRẢ PHÒNG</h1>
      <p>Số: <strong>${escapeHtml(settlement.code || '')}</strong></p>
      <p>Hợp đồng <strong>${escapeHtml(contract.code || '')}</strong> · Phòng <strong>${escapeHtml(contract.roomName || '')}</strong><br />
        Khách thuê: <strong>${escapeHtml(contract.tenantName || '')}</strong><br />
        Thời gian thuê: ${escapeHtml(dateLabel(contract.startsOn) || contract.startsOn || '')} đến hết ${escapeHtml(dateLabel(contract.checkoutOn) || contract.checkoutOn || '')}
      </p>
      <table>
        <tbody>
          <tr><th>Hóa đơn tháng ${escapeHtml(settlement.period || '')} trước khi chốt</th><td>${fmt(settlement.invoiceOriginalTotalVnd)}</td></tr>
          <tr><th>Tiền phòng thực tế (${Number(calculation.chargedDays) || 0}/${Number(calculation.daysInMonth) || 0} ngày)</th><td>${fmt(calculation.finalRentVnd)}</td></tr>
          <tr><th>Hóa đơn sau khi chốt</th><td>${fmt(settlement.invoiceFinalTotalVnd)}</td></tr>
          <tr><th>Công nợ kỳ trước</th><td>${fmt(settlement.priorDebtVnd)}</td></tr>
          <tr><th>Tiền cọc bù công nợ</th><td>− ${fmt(settlement.depositAppliedVnd)}</td></tr>
          <tr><th>Còn phải thu</th><td>${fmt(settlement.remainingDueVnd)}</td></tr>
          <tr><th>Tiền cọc hoàn lại</th><td>${fmt(settlement.depositRefundedVnd)}</td></tr>
          <tr><th>Tiền phòng đã trả dư hoàn lại</th><td>${fmt(settlement.rentOverpaymentVnd)}</td></tr>
          <tr><th>Tổng tiền hoàn khách</th><td>${fmt(settlement.totalRefundVnd)}</td></tr>
        </tbody>
      </table>
      <p><strong>Phương thức hoàn:</strong> ${escapeHtml(rentalFinalSettlementMethodLabel(settlement.refundMethod))}</p>
      <p><strong>Nội dung xác nhận:</strong> ${escapeHtml(settlement.reason || '')}</p>
      <p>Biên bản được chốt lúc ${escapeHtml(subscriptionDateTime(settlement.createdAt))}. Các số liệu hóa đơn, công nợ và tiền cọc được lưu dưới dạng snapshot bất biến.</p>
      <div class="rental-final-settlement-signatures">
        <div><strong>BÊN CHO THUÊ</strong><br /><small>(Ký và ghi rõ họ tên)</small></div>
        <div><strong>BÊN THUÊ</strong><br /><small>(Ký và ghi rõ họ tên)</small></div>
      </div>
    </article>`;
}

function renderRentalFinalSettlementResult(settlement) {
  activeRentalFinalSettlement = settlement;
  activeRentalFinalSettlementPreview = null;
  document.getElementById('rental-final-settlement-loading').hidden = true;
  document.getElementById('rental-final-settlement-form').hidden = true;
  document.getElementById('rental-final-settlement-result').hidden = false;
  document.getElementById('rental-final-settlement-contract').textContent =
    `${settlement.code} · ${periodLabel(settlement.period)}`;
  document.getElementById('rental-final-settlement-paper').innerHTML =
    rentalFinalSettlementDocument(settlement);
}

function updateRentalFinalSettlementBalance() {
  const preview = activeRentalFinalSettlementPreview;
  if (!preview) return;
  const input = document.getElementById('rental-final-settlement-applied');
  const refunded = document.getElementById('rental-final-settlement-refunded');
  const balance = Number(preview.deposit?.balanceVnd) || 0;
  const outstanding = Number(preview.outstandingBeforeDepositVnd) || 0;
  const applied = Number(input.value);
  const valid = Number.isSafeInteger(applied) && applied >= 0
    && applied <= balance && applied <= outstanding;
  refunded.value = valid ? String(balance - applied) : '';
  const remaining = valid ? Math.max(0, outstanding - applied) : outstanding;
  const totalRefund = valid
    ? balance - applied + (Number(preview.rentOverpaymentVnd) || 0)
    : Number(preview.rentOverpaymentVnd) || 0;
  document.getElementById('rental-final-settlement-balance').textContent = valid
    ? `Sau đối trừ: còn phải thu ${fmt(remaining)} · tổng hoàn khách ${fmt(totalRefund)}.`
    : `Tiền cọc bù công nợ phải từ 0 đến ${fmt(Math.min(balance, outstanding))}.`;
}

function renderRentalFinalSettlementPreview(preview) {
  activeRentalFinalSettlementPreview = preview;
  activeRentalFinalSettlement = null;
  document.getElementById('rental-final-settlement-loading').hidden = true;
  document.getElementById('rental-final-settlement-result').hidden = true;
  document.getElementById('rental-final-settlement-form').hidden = false;
  document.getElementById('rental-final-settlement-contract').textContent =
    `${preview.contract.code} · ${preview.contract.roomName} · ${preview.contract.tenantName}`;
  document.getElementById('rental-final-settlement-summary').innerHTML = `
    <div><span>Tiền phòng thực tế</span><strong>${fmt(preview.invoice.finalRentVnd)} · ${preview.invoice.chargedDays}/${preview.invoice.daysInMonth} ngày</strong></div>
    <div><span>Hóa đơn sau chốt</span><strong>${fmt(preview.invoice.finalTotalVnd)}</strong></div>
    <div><span>Công nợ trước bù cọc</span><strong>${fmt(preview.outstandingBeforeDepositVnd)}</strong></div>
    <div><span>Đã thu trong kỳ thuê</span><strong>${fmt(preview.paidBeforeVnd)}</strong></div>
    <div><span>Số dư cọc</span><strong>${fmt(preview.deposit.balanceVnd)}</strong></div>
    <div><span>Tiền phòng đã trả dư</span><strong>${fmt(preview.rentOverpaymentVnd)}</strong></div>`;
  const applied = document.getElementById('rental-final-settlement-applied');
  applied.max = String(Math.min(
    Number(preview.deposit.balanceVnd) || 0,
    Number(preview.outstandingBeforeDepositVnd) || 0
  ));
  applied.value = String(preview.deposit.suggestedAppliedVnd || 0);
  document.getElementById('rental-final-settlement-refunded').value =
    String(preview.deposit.suggestedRefundedVnd || 0);
  document.getElementById('rental-final-settlement-method').value = 'bank_transfer';
  document.getElementById('rental-final-settlement-error').hidden = true;
  updateRentalFinalSettlementBalance();
}

async function openRentalFinalSettlement(contract) {
  activeRentalFinalSettlementContract = contract;
  activeRentalFinalSettlementPreview = null;
  activeRentalFinalSettlement = null;
  const modal = document.getElementById('rental-final-settlement-modal');
  const loading = document.getElementById('rental-final-settlement-loading');
  document.getElementById('rental-final-settlement-contract').textContent =
    `${contract.code} · ${contract.roomName} · ${contract.tenantName}`;
  loading.textContent = 'Đang đối chiếu hóa đơn, công nợ và tiền cọc…';
  loading.hidden = false;
  document.getElementById('rental-final-settlement-form').hidden = true;
  document.getElementById('rental-final-settlement-result').hidden = true;
  modal.hidden = false;
  try {
    await ensureRentInvoicesSynced();
    const result = await API.getRentalFinalSettlement(contract.id);
    if (result.finalized) renderRentalFinalSettlementResult(result.settlement);
    else renderRentalFinalSettlementPreview(result.preview);
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    loading.textContent = error.message || 'Không tải được dữ liệu quyết toán';
  }
}

function closeRentalFinalSettlement() {
  activeRentalFinalSettlementContract = null;
  activeRentalFinalSettlementPreview = null;
  activeRentalFinalSettlement = null;
  document.getElementById('rental-final-settlement-modal').hidden = true;
  const printArea = document.getElementById('print-area');
  printArea?.classList.remove('print-area--rental-final-settlement');
}

async function submitRentalFinalSettlement(event) {
  event.preventDefault();
  const contract = activeRentalFinalSettlementContract;
  const preview = activeRentalFinalSettlementPreview;
  if (!contract || !preview) return;
  const button = document.getElementById('rental-final-settlement-submit');
  const errorElement = document.getElementById('rental-final-settlement-error');
  button.disabled = true;
  errorElement.hidden = true;
  try {
    const applied = Number(document.getElementById('rental-final-settlement-applied').value);
    const refunded = Number(document.getElementById('rental-final-settlement-refunded').value);
    const result = await API.createRentalFinalSettlement(contract.id, {
      depositAppliedVnd: applied,
      depositRefundedVnd: refunded,
      refundMethod: document.getElementById('rental-final-settlement-method').value,
      reason: document.getElementById('rental-final-settlement-reason').value
    });
    renderRentalFinalSettlementResult(result.settlement);
    await refreshRentInvoiceSummaries();
    renderBills();
    showToast(result.reused ? 'Đã mở biên quyết toán hiện có' : 'Đã chốt quyết toán trả phòng ✓', 'success');
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    errorElement.textContent = error.message || 'Không chốt được quyết toán';
    errorElement.hidden = false;
  } finally {
    button.disabled = false;
  }
}

function printRentalFinalSettlement() {
  const paper = document.getElementById('rental-final-settlement-paper');
  const printArea = document.getElementById('print-area');
  if (!paper.firstElementChild || !activeRentalFinalSettlement || !printArea) return;
  printArea.innerHTML = paper.innerHTML;
  printArea.classList.add('print-area--rental-final-settlement');
  const filename = `${removeVietnameseTones(activeRentalFinalSettlement.code || 'quyet-toan-tra-phong')
    .replace(/[^a-zA-Z0-9-]+/g, '-').toLowerCase()}.pdf`;
  try {
    triggerPrint(filename);
  } finally {
    window.setTimeout(closeRentalFinalSettlement, 0);
  }
}

async function refreshRentalStateAfterLifecycle() {
  const serverState = await API.getState();
  loadState(serverState);
  renderRooms();
  renderDashboard();
}

async function submitRentalLifecycle(event) {
  event.preventDefault();
  const contract = activeRentalLifecycleContract;
  if (!contract) return;
  const type = document.getElementById('rental-lifecycle-type').value;
  const errorElement = document.getElementById('rental-lifecycle-error');
  const button = document.getElementById('rental-lifecycle-submit');
  errorElement.hidden = true;
  button.disabled = true;
  try {
    if (type === 'transfer') {
      const targetRoomId = document.getElementById('rental-lifecycle-target-room').value;
      if (!targetRoomId) throw new Error('Không còn phòng khác để chuyển đến.');
      await API.transferRentalContract(contract.id, {
        targetRoomId,
        occurredOn: document.getElementById('rental-lifecycle-date').value,
        endsOn: document.getElementById('rental-lifecycle-end').value,
        monthlyRentVnd: Number(document.getElementById('rental-lifecycle-rent').value),
        depositVnd: Number(document.getElementById('rental-lifecycle-deposit').value || 0),
        reason: document.getElementById('rental-lifecycle-reason').value
      });
      await refreshRentalStateAfterLifecycle();
      await refreshRoomOperationalStatuses();
      closeRentalLifecycleModal();
      closeRentalContractModal();
      showToast('Đã chuyển phòng và tạo hợp đồng mới ✓', 'success');
      return;
    }
    await ensureRentInvoicesSynced();
    await API.checkoutRentalContract(contract.id, {
      occurredOn: document.getElementById('rental-lifecycle-date').value,
      reason: document.getElementById('rental-lifecycle-reason').value
    });
    await refreshRoomOperationalStatuses();
    closeRentalLifecycleModal();
    showToast('Đã ghi nhận trả phòng ✓', 'success');
    await loadRentalContracts();
    const endedContract = rentalContracts.find(item => Number(item.id) === Number(contract.id));
    if (endedContract) void openRentalFinalSettlement(endedContract);
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    errorElement.textContent = error.message || 'Không xử lý được vòng đời thuê';
    errorElement.hidden = false;
  } finally {
    button.disabled = false;
  }
}

async function loadRentalContracts() {
  if (!rentalContractRoomId) return;
  const list = document.getElementById('rental-contract-list');
  document.getElementById('rental-contract-empty').hidden = true;
  list.innerHTML = '<p class="rental-contract-empty">Đang tải hợp đồng…</p>';
  try {
    const [data, lifecycle] = await Promise.all([
      API.getRentalContracts(rentalContractRoomId),
      API.getRentalLifecycle(rentalContractRoomId)
    ]);
    rentalContracts = Array.isArray(data.contracts) ? data.contracts : [];
    rentalReservations = Array.isArray(lifecycle.reservations) ? lifecycle.reservations : [];
    rentalLifecycleEvents = Array.isArray(lifecycle.events) ? lifecycle.events : [];
    renderRentalContracts();
    renderRentalReservations();
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    list.innerHTML = `<p class="rental-contract-empty">${escapeHtml(error.message || 'Không tải được hợp đồng')}</p>`;
  }
}

function openRentalContractModal(roomId) {
  const room = STATE.rooms.find(item => item.id === roomId);
  if (!room) return;
  rentalContractRoomId = roomId;
  rentalContracts = [];
  rentalReservations = [];
  rentalLifecycleEvents = [];
  const form = document.getElementById('rental-contract-form');
  form.reset();
  document.getElementById('rental-contract-room').textContent = room.name;
  const tenantSelect = document.getElementById('rental-contract-tenant');
  tenantSelect.innerHTML = '';
  for (const tenant of room.tenants || []) {
    const option = document.createElement('option');
    option.value = tenant.id;
    option.textContent = tenant.fullName || 'Khách chưa đặt tên';
    tenantSelect.appendChild(option);
  }
  form.hidden = tenantSelect.options.length === 0;
  if (tenantSelect.options.length === 0) {
    showToast('Bạn vẫn có thể giữ chỗ; hãy thêm khách trước khi tạo hợp đồng', 'info', 3500);
  }
  const today = vietnamCalendarDate();
  document.getElementById('rental-reservation-date').value = today;
  document.getElementById('rental-reservation-move-in').value = isoDateAfter(today, 7);
  document.getElementById('rental-reservation-expiry').value = isoDateAfter(today, 7);
  document.getElementById('rental-contract-status').value = 'active';
  document.getElementById('rental-contract-start').value = room.rentStartDate || vietnamCalendarDate();
  document.getElementById('rental-contract-billing-cycle').value = '1';
  document.getElementById('rental-contract-payment-due-day').value = '5';
  document.getElementById('rental-contract-rent').value = getRoomRates(room, STATE.currentPeriod).rentPrice;
  document.getElementById('rental-contract-deposit').value = 0;
  document.getElementById('rental-contract-modal').hidden = false;
  void loadRentalContracts();
}

function closeRentalContractModal() {
  rentalContractRoomId = '';
  rentalContracts = [];
  rentalReservations = [];
  rentalLifecycleEvents = [];
  document.getElementById('rental-contract-modal').hidden = true;
}

async function submitRentalContract(event) {
  event.preventDefault();
  const room = STATE.rooms.find(item => item.id === rentalContractRoomId);
  if (!room) return;
  const button = document.getElementById('rental-contract-submit');
  button.disabled = true;
  try {
    const result = await API.createRentalContract({
      roomId: room.id,
      tenantId: document.getElementById('rental-contract-tenant').value,
      status: document.getElementById('rental-contract-status').value,
      startsOn: document.getElementById('rental-contract-start').value,
      endsOn: document.getElementById('rental-contract-end').value,
      billingCycleMonths: Number(document.getElementById('rental-contract-billing-cycle').value),
      paymentDueDay: Number(document.getElementById('rental-contract-payment-due-day').value),
      monthlyRentVnd: Number(document.getElementById('rental-contract-rent').value),
      depositVnd: Number(document.getElementById('rental-contract-deposit').value || 0),
      terms: document.getElementById('rental-contract-terms').value,
      reservationId: document.getElementById('rental-contract-reservation-row').hidden
        ? null
        : Number(document.getElementById('rental-contract-reservation').value)
    });
    applyContractRateToRoom(result.rate);
    await refreshRoomOperationalStatuses();
    showToast(`Đã tạo hợp đồng ${result.contract.code} ✓`, 'success');
    await loadRentalContracts();
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    showToast(error.message || 'Không tạo được hợp đồng', 'error', 4500);
  } finally {
    button.disabled = false;
  }
}

async function changeRentalContractStatus(contractId, status, button) {
  const card = button.closest('.rental-contract-card');
  const reason = card?.querySelector('[data-contract-status-reason]')?.value.trim() || '';
  if (['ended', 'cancelled'].includes(status) && reason.length < 10) {
    showToast('Vui lòng nhập lý do ít nhất 10 ký tự', 'error');
    return;
  }
  button.disabled = true;
  try {
    const result = await API.changeRentalContractStatus(contractId, { status, reason });
    applyContractRateToRoom(result.rate);
    await refreshRoomOperationalStatuses();
    showToast(`Đã chuyển hợp đồng sang “${rentalContractStatusLabel(status)}”`, 'success');
    await loadRentalContracts();
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    showToast(error.message || 'Không cập nhật được hợp đồng', 'error', 4500);
  } finally {
    button.disabled = false;
  }
}

async function submitRentalContractAmendment(form) {
  const contractId = Number(form.dataset.contractAmendmentForm);
  const button = form.querySelector('[type="submit"]');
  button.disabled = true;
  try {
    const result = await API.createRentalContractAmendment(contractId, {
      effectiveFrom: form.elements.effectiveFrom.value,
      newMonthlyRentVnd: Number(form.elements.newMonthlyRentVnd.value),
      reason: form.elements.reason.value
    });
    applyContractRateToRoom(result.rate);
    renderRooms();
    showToast(`Đã tạo phụ lục ${result.amendment.code} ✓`, 'success');
    await loadRentalContracts();
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    showToast(error.message || 'Không tạo được phụ lục', 'error', 4500);
  } finally {
    button.disabled = false;
  }
}

function renderRooms() {
  const listEl = document.getElementById('rooms-list');
  listEl.innerHTML = '';

  if (STATE.rooms.length === 0) {
    listEl.innerHTML = `<div class="empty-state"><div class="empty-icon">🏡</div><p>Chưa có phòng nào.</p></div>`;
    return;
  }

  for (const room of STATE.rooms) {
    const card = document.createElement('div');
    card.className = 'room-card';
    const rates = getRoomRates(room, STATE.currentPeriod);
    const hasWifi = rates.wifiFee > 0;
    const rentStartLabel = dateLabel(room.rentStartDate);
    const waterUnitText = room.waterType === 'người' ? 'người' : 'khối';
    const latestPaid = getLatestPaidElectric(room);
    const latestText = latestPaid !== null
      ? `Số điện hiện tại (đã thu): <strong>${fmtNum(latestPaid)}</strong> <span style="font-size:0.7rem;color:var(--wifi)">*(Tự động)*</span>`
      : `Số điện hiện tại: <strong>${fmtNum(room.electricPrev || 0)}</strong>`;

    const latestWaterPaid = getLatestPaidWater(room);
    const latestWaterText = latestWaterPaid !== null
      ? `Số nước hiện tại (đã thu): <strong>${fmtNum(latestWaterPaid)}</strong> <span style="font-size:0.7rem;color:var(--wifi)">*(Tự động)*</span>`
      : `Số nước hiện tại: <strong>${fmtNum(room.waterPrev || 0)}</strong>`;

    const waterPrevHtml = room.waterType === 'khối'
      ? `<div>Số nước khởi đầu: <strong>${fmtNum(room.waterPrev || 0)}</strong></div><div>${latestWaterText}</div>`
      : '';

    const roomStatus = getRoomOperationalStatus(room.id);
    const statusBadge = `<span class="room-operational-status room-operational-status--${roomStatus.conflict ? 'conflict' : roomStatus.status}">${escapeHtml(roomStatus.label)}</span>`;

    card.innerHTML = `
      <div class="room-card-info">
        <div class="room-card-name">${room.name} ${statusBadge}</div>
        <div class="room-card-details">
          <span class="room-detail-chip room-detail-chip--rate-period">🗓️ ${ratePeriodLabel(rates.effectiveFrom)}</span>
          ${rentStartLabel ? `<span class="room-detail-chip">🔑 Bắt đầu thuê: ${rentStartLabel}</span>` : ''}
          <span class="room-detail-chip">🏷️ Thuê: ${fmt(rates.rentPrice)}/tháng</span>
          <span class="room-detail-chip">⚡ Điện: ${fmtNum(rates.electricRate)}đ/kWh</span>
          <span class="room-detail-chip">💧 Nước: ${fmtNum(rates.waterRate)}đ/${waterUnitText}</span>
          <span class="room-detail-chip">👥 Số người: ${room.peopleCount || 1}</span>
          <span class="room-detail-chip">🗑️ Rác: ${fmt(rates.trashFee)}</span>
          ${hasWifi ? `<span class="room-detail-chip">📶 Wifi: ${fmt(rates.wifiFee)}</span>` : ''}
          ${rates.manageFee > 0 ? `<span class="room-detail-chip">💼 QL & DV: ${fmt(rates.manageFee)}</span>` : ''}
          ${room.notes ? `<span class="room-detail-chip">📝 ${room.notes}</span>` : ''}
        </div>
        <div style="font-size:.75rem;color:var(--text-muted);margin-top:6px;display:flex;flex-direction:column;gap:2px">
          <div>Số điện khởi đầu: <strong>${fmtNum(room.electricPrev || 0)}</strong></div>
          <div>${latestText}</div>
          ${waterPrevHtml}
        </div>
      </div>
      <div class="room-card-actions">
        <button class="btn btn--ghost btn--sm" data-tenants="${room.id}">👥 Khách (${room.tenants ? room.tenants.length : 0})</button>
        <button class="btn btn--ghost btn--sm" data-contracts="${room.id}">📄 Hợp đồng</button>
        <button class="btn btn--ghost btn--sm" data-lifecycle="${room.id}">🔄 Trạng thái</button>
        <button class="btn btn--ghost btn--sm" data-edit="${room.id}">✏️ Sửa</button>
        <button class="btn btn--danger btn--sm" data-delete="${room.id}">🗑️</button>
      </div>
    `;
    const tenantsBtn = card.querySelector('[data-tenants]');
    const contractsBtn = card.querySelector('[data-contracts]');
    const lifecycleBtn = card.querySelector('[data-lifecycle]');
    const editBtn = card.querySelector('[data-edit]');
    const deleteBtn = card.querySelector('[data-delete]');
    if (tenantsBtn) tenantsBtn.addEventListener('click', (e) => { e.stopPropagation(); openTenantsModal(room.id); });
    if (contractsBtn) contractsBtn.addEventListener('click', (e) => { e.stopPropagation(); openRentalContractModal(room.id); });
    if (lifecycleBtn) lifecycleBtn.addEventListener('click', (e) => { e.stopPropagation(); openRoomLifecycleModal(room.id); });
    if (editBtn) editBtn.addEventListener('click', (e) => { e.stopPropagation(); openRoomModal(room.id); });
    if (deleteBtn) deleteBtn.addEventListener('click', (e) => { e.stopPropagation(); deleteRoom(room.id); });
    listEl.appendChild(card);
  }
}

function deleteRoom(id) {
  const room = STATE.rooms.find(r => r.id === id);
  if (!room) return;
  showConfirm(
    `Xóa phòng “${room.name}”? Dữ liệu tháng liên quan sẽ không bị xóa.`,
    async () => {
      const previousRooms = STATE.rooms;
      STATE.rooms = STATE.rooms.filter(r => r.id !== id);
      try {
        saveState();
        await flushState({ throwOnError: true });
      } catch (_) {
        STATE.rooms = previousRooms;
        renderRooms();
        renderDashboard();
        return;
      }
      renderRooms();
      renderDashboard();
      showToast(`Đã xóa phòng ${room.name}`, 'info');
    }
  );
}

// ============================================================
//  ROOM MODAL (CRUD Form)
// ============================================================
let roomRateHistoryDraft = [];

function readRoomRateInputs() {
  const hasWifi = document.getElementById('room-has-wifi').checked;
  return {
    rentPrice: parseFloat(document.getElementById('room-rent').value) || 0,
    electricRate: parseFloat(document.getElementById('room-elec-rate').value) || 0,
    waterRate: parseFloat(document.getElementById('room-water-rate').value) || 0,
    trashFee: parseFloat(document.getElementById('room-trash').value) || 0,
    wifiFee: hasWifi ? (parseFloat(document.getElementById('room-wifi-fee').value) || 0) : 0,
    manageFee: parseFloat(document.getElementById('room-manage-fee').value) || 0
  };
}

function fillRoomRateInputs(rates) {
  document.getElementById('room-rent').value = rates.rentPrice;
  document.getElementById('room-elec-rate').value = rates.electricRate;
  document.getElementById('room-water-rate').value = rates.waterRate;
  document.getElementById('room-trash').value = rates.trashFee;
  document.getElementById('room-has-wifi').checked = rates.wifiFee > 0;
  document.getElementById('room-wifi-fee').value = rates.wifiFee > 0 ? rates.wifiFee : 40000;
  document.getElementById('room-manage-fee').value = rates.manageFee;
}

function updateRoomRateEffectiveHint() {
  const hint = document.getElementById('room-rate-effective-hint');
  const period = document.getElementById('room-rate-effective-from').value;
  const exactEntry = roomRateHistoryDraft.find(entry => entry.effectiveFrom === period);
  hint.textContent = exactEntry
    ? `Bạn đang chỉnh sửa mốc ${periodLabel(period).toLowerCase()}.`
    : `Biểu phí mới sẽ áp dụng từ ${periodLabel(period).toLowerCase()}; các tháng trước không đổi.`;
}

function loadRoomRatesForPeriod(period) {
  const roomId = document.getElementById('room-id').value;
  const room = STATE.rooms.find(item => item.id === roomId);
  if (!room || !RoomRates.isPeriod(period)) return;
  fillRoomRateInputs(RoomRates.resolve({ ...room, rateHistory: roomRateHistoryDraft }, period));
  updateRoomRateEffectiveHint();
}

function renderRoomRateHistoryDraft() {
  const section = document.getElementById('room-rate-history-section');
  const list = document.getElementById('room-rate-history-list');
  const isEditing = !!document.getElementById('room-id').value;
  section.hidden = !isEditing;
  list.innerHTML = '';
  if (!isEditing) return;

  roomRateHistoryDraft.forEach((entry, index) => {
    const item = document.createElement('div');
    item.className = 'room-rate-history__item';
    item.innerHTML = `
      <button type="button" class="room-rate-history__load" data-rate-load="${entry.effectiveFrom}">
        <span class="room-rate-history__period">${ratePeriodLabel(entry.effectiveFrom)}</span>
        <span class="room-rate-history__summary">
          Thuê ${fmt(entry.rentPrice)} · Điện ${fmtNum(entry.electricRate)}đ · Nước ${fmtNum(entry.waterRate)}đ
        </span>
      </button>
      ${index > 0 ? `<button type="button" class="btn btn--danger btn--sm" data-rate-delete="${entry.effectiveFrom}" title="Xóa mốc biểu phí">🗑️</button>` : ''}
    `;
    list.appendChild(item);
  });

  list.querySelectorAll('[data-rate-load]').forEach(button => {
    button.addEventListener('click', () => {
      const period = button.dataset.rateLoad;
      const entry = roomRateHistoryDraft.find(item => item.effectiveFrom === period);
      if (!entry) return;
      document.getElementById('room-rate-effective-from').value = period;
      fillRoomRateInputs(entry);
      updateRoomRateEffectiveHint();
    });
  });

  list.querySelectorAll('[data-rate-delete]').forEach(button => {
    button.addEventListener('click', () => {
      const period = button.dataset.rateDelete;
      showConfirm(`Xóa mốc biểu phí từ ${periodLabel(period).toLowerCase()}?`, () => {
        roomRateHistoryDraft = roomRateHistoryDraft.filter(entry => entry.effectiveFrom !== period);
        const selectedPeriod = document.getElementById('room-rate-effective-from').value;
        if (selectedPeriod === period) {
          document.getElementById('room-rate-effective-from').value = STATE.currentPeriod;
          loadRoomRatesForPeriod(STATE.currentPeriod);
        }
        renderRoomRateHistoryDraft();
      }, null, 'Xóa mốc giá');
    });
  });
}

function openRoomModal(roomId = null) {
  const modal = document.getElementById('room-modal');
  const title = document.getElementById('room-modal-title');
  const form  = document.getElementById('room-form');
  form.reset();
  const effectiveFrom = STATE.currentPeriod || periodKey(new Date().getFullYear(), new Date().getMonth() + 1);
  document.getElementById('room-rate-effective-from').value = effectiveFrom;

  if (roomId) {
    const room = STATE.rooms.find(r => r.id === roomId);
    if (!room) return;
    roomRateHistoryDraft = RoomRates.normalizeHistory(room).map(entry => ({ ...entry }));
    const activeRates = RoomRates.resolve(room, effectiveFrom);
    title.textContent = 'Sửa phòng';
    document.getElementById('room-id').value          = room.id;
    document.getElementById('room-name').value        = room.name;
    document.getElementById('room-rent-start-date').value = room.rentStartDate || '';
    fillRoomRateInputs(activeRates);
    document.getElementById('room-water-type').value  = room.waterType || 'người';
    document.getElementById('room-people-count').value= room.peopleCount ?? 1;
    document.getElementById('room-elec-prev').value   = room.electricPrev || 0;
    document.getElementById('room-water-prev').value  = room.waterPrev || 0;
    document.getElementById('room-notes').value       = room.notes || '';
    
    const isWaterByKhối = (room.waterType || 'người') === 'khối';
    document.getElementById('room-water-prev-container').style.display = isWaterByKhối ? 'flex' : 'none';
    document.getElementById('room-people-count-container').style.display = isWaterByKhối ? 'none' : 'flex';
  } else {
    roomRateHistoryDraft = [];
    title.textContent = 'Thêm phòng';
    document.getElementById('room-id').value = '';
    document.getElementById('room-rent-start-date').value = '';
    document.getElementById('room-elec-rate').value = 3200;
    document.getElementById('room-water-type').value = 'người';
    document.getElementById('room-water-rate').value = 50000;
    document.getElementById('room-people-count').value = 1;
    document.getElementById('room-trash').value = 50000;
    document.getElementById('room-has-wifi').checked = true;
    document.getElementById('room-wifi-fee').value = 40000;
    document.getElementById('room-manage-fee').value = 0;
    document.getElementById('room-elec-prev').value = 0;
    document.getElementById('room-water-prev').value = 0;
    document.getElementById('room-water-prev-container').style.display = 'none';
    document.getElementById('room-people-count-container').style.display = 'flex';
  }
  updateRoomRateEffectiveHint();
  renderRoomRateHistoryDraft();
  modal.hidden = false;
}

function closeRoomModal() {
  roomRateHistoryDraft = [];
  document.getElementById('room-modal').hidden = true;
}

document.getElementById('room-form').addEventListener('submit', e => {
  e.preventDefault();
  const id        = document.getElementById('room-id').value;
  const name      = document.getElementById('room-name').value.trim();
  const rentStartDate = document.getElementById('room-rent-start-date').value;
  const effectiveFrom = document.getElementById('room-rate-effective-from').value;
  const rates = readRoomRateInputs();
  const waterType    = document.getElementById('room-water-type').value;
  const peopleCount  = parseInt(document.getElementById('room-people-count').value) || 1;
  const electricPrev = parseFloat(document.getElementById('room-elec-prev').value) || 0;
  const waterPrev    = parseFloat(document.getElementById('room-water-prev').value) || 0;
  const notes        = document.getElementById('room-notes').value.trim();

  if (!name || !RoomRates.isPeriod(effectiveFrom) || (rentStartDate && !RoomRates.isIsoDate(rentStartDate))) {
    showToast('Vui lòng điền đủ thông tin bắt buộc', 'error');
    return;
  }

  const existingRoom = id ? STATE.rooms.find(room => room.id === id) : null;
  const exactRateIndex = roomRateHistoryDraft.findIndex(entry => entry.effectiveFrom === effectiveFrom);
  const activeRates = existingRoom
    ? RoomRates.resolve({ ...existingRoom, rateHistory: roomRateHistoryDraft }, effectiveFrom)
    : null;
  if (!existingRoom || exactRateIndex >= 0 || !RoomRates.sameRates(activeRates, rates)) {
    const rateEntry = { effectiveFrom, ...RoomRates.snapshot(rates) };
    if (exactRateIndex >= 0) roomRateHistoryDraft[exactRateIndex] = rateEntry;
    else roomRateHistoryDraft.push(rateEntry);
  }
  roomRateHistoryDraft.sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));

  const roomData = {
    id: id || uuid(),
    name,
    rentStartDate,
    ...rates,
    waterType,
    peopleCount,
    electricPrev,
    waterPrev,
    notes,
    rateHistory: roomRateHistoryDraft.map(entry => ({ ...entry }))
  };
  roomData.rateHistory = RoomRates.normalizeHistory(roomData);
  Object.assign(roomData, RoomRates.snapshot(RoomRates.latest(roomData)));

  if (id) {
    const idx = STATE.rooms.findIndex(r => r.id === id);
    if (idx > -1) {
      roomData.tenants = STATE.rooms[idx].tenants || [];
      STATE.rooms[idx] = roomData;
    }
    showToast('Đã cập nhật phòng ✓', 'success');
  } else {
    roomData.tenants = [];
    STATE.rooms.push(roomData);
    showToast('Đã thêm phòng ✓', 'success');
  }

  saveState();
  closeRoomModal();
  renderRooms();
  renderDashboard();
});

document.getElementById('room-modal-close').addEventListener('click', closeRoomModal);
document.getElementById('room-modal-cancel').addEventListener('click', closeRoomModal);
document.getElementById('room-modal').addEventListener('click', e => {
  if (e.target === document.getElementById('room-modal')) closeRoomModal();
});
document.getElementById('room-rate-effective-from').addEventListener('change', e => {
  loadRoomRatesForPeriod(e.target.value);
  updateRoomRateEffectiveHint();
});
document.getElementById('btn-add-room').addEventListener('click', () => {
  const roomFeature = SERVER_ENTITLEMENTS.features.roomManagement;
  if (!roomFeature.enabled) {
    showToast('Gói hiện tại chỉ cho phép xem dữ liệu.', 'error', 3000);
    return;
  }
  if (STATE.rooms.length >= roomFeature.limit) {
    showToast(
      `Gói ${SERVER_ENTITLEMENTS.plan.name} hỗ trợ tối đa ${roomFeature.limit} phòng.`,
      'error',
      3500
    );
    return;
  }
  openRoomModal();
});

document.getElementById('room-water-type').addEventListener('change', (e) => {
  const isKhối = e.target.value === 'khối';
  const prevContainer   = document.getElementById('room-water-prev-container');
  const peopleContainer = document.getElementById('room-people-count-container');
  if (prevContainer)   prevContainer.style.display   = isKhối ? 'flex' : 'none';
  if (peopleContainer) peopleContainer.style.display = isKhối ? 'none' : 'flex';
});

document.getElementById('rental-contract-form').addEventListener('submit', event => {
  void submitRentalContract(event);
});
document.getElementById('rental-reservation-form').addEventListener('submit', event => {
  void submitRentalReservation(event);
});
document.getElementById('rental-reservation-list').addEventListener('click', event => {
  const button = event.target?.closest?.('[data-reservation-cancel]');
  if (!button) return;
  const card = button.closest('.rental-reservation-card');
  if (card) void cancelRentalReservation(card, button);
});
document.getElementById('rental-contract-close').addEventListener('click', closeRentalContractModal);
document.getElementById('rental-contract-close-footer').addEventListener('click', closeRentalContractModal);
document.getElementById('rental-contract-refresh').addEventListener('click', () => {
  void loadRentalContracts();
});
document.getElementById('rental-contract-modal').addEventListener('click', event => {
  if (event.target === event.currentTarget) closeRentalContractModal();
});
document.getElementById('rental-contract-list').addEventListener('click', event => {
  const depositButton = event.target?.closest?.('[data-contract-deposit]');
  if (depositButton) {
    const depositCard = depositButton.closest('.rental-contract-card');
    const depositContract = rentalContracts.find(
      item => Number(item.id) === Number(depositCard?.dataset.contractId)
    );
    if (depositContract) openTenantDeposit(depositContract.tenantId);
    return;
  }
  const handoverButton = event.target?.closest?.('[data-contract-handover]');
  if (handoverButton) {
    const handoverCard = handoverButton.closest('.rental-contract-card');
    const handoverContract = rentalContracts.find(
      item => Number(item.id) === Number(handoverCard?.dataset.contractId)
    );
    if (handoverContract) void openRentalHandoverModal(handoverContract);
    return;
  }
  const lifecycleButton = event.target?.closest?.('[data-contract-lifecycle]');
  if (lifecycleButton) {
    const lifecycleCard = lifecycleButton.closest('.rental-contract-card');
    const lifecycleContract = rentalContracts.find(
      item => Number(item.id) === Number(lifecycleCard?.dataset.contractId)
    );
    if (lifecycleContract) {
      openRentalLifecycleModal(lifecycleContract, lifecycleButton.dataset.contractLifecycle);
    }
    return;
  }
  const finalSettlementButton = event.target?.closest?.('[data-contract-final-settlement]');
  if (finalSettlementButton) {
    const finalSettlementCard = finalSettlementButton.closest('.rental-contract-card');
    const finalSettlementContract = rentalContracts.find(
      item => Number(item.id) === Number(finalSettlementCard?.dataset.contractId)
    );
    if (finalSettlementContract) void openRentalFinalSettlement(finalSettlementContract);
    return;
  }
  const documentButton = event.target?.closest?.('[data-contract-document]');
  if (documentButton) {
    const documentCard = documentButton.closest('.rental-contract-card');
    const documentContract = rentalContracts.find(
      item => Number(item.id) === Number(documentCard?.dataset.contractId)
    );
    if (documentContract) openRentalContractDocumentModal(documentContract);
    return;
  }
  const button = event.target?.closest?.('[data-contract-status]');
  if (!button) return;
  const card = button.closest('.rental-contract-card');
  const contract = rentalContracts.find(item => Number(item.id) === Number(card?.dataset.contractId));
  if (!contract) return;
  void changeRentalContractStatus(contract.id, button.dataset.contractStatus, button);
});
document.getElementById('rental-lifecycle-form').addEventListener('submit', event => {
  void submitRentalLifecycle(event);
});
document.getElementById('rental-lifecycle-type').addEventListener('change', updateRentalLifecycleForm);
document.getElementById('rental-lifecycle-target-room').addEventListener('change', updateRentalLifecycleTargetRate);
document.getElementById('rental-lifecycle-date').addEventListener('change', updateRentalLifecycleTargetRate);
document.getElementById('rental-lifecycle-close').addEventListener('click', closeRentalLifecycleModal);
document.getElementById('rental-lifecycle-cancel').addEventListener('click', closeRentalLifecycleModal);
document.getElementById('rental-lifecycle-modal').addEventListener('click', event => {
  if (event.target === event.currentTarget) closeRentalLifecycleModal();
});
document.getElementById('rental-final-settlement-form').addEventListener('submit', event => {
  void submitRentalFinalSettlement(event);
});
document.getElementById('rental-final-settlement-applied').addEventListener('input', updateRentalFinalSettlementBalance);
document.getElementById('rental-final-settlement-close').addEventListener('click', closeRentalFinalSettlement);
document.getElementById('rental-final-settlement-cancel').addEventListener('click', closeRentalFinalSettlement);
document.getElementById('rental-final-settlement-close-footer').addEventListener('click', closeRentalFinalSettlement);
document.getElementById('rental-final-settlement-print').addEventListener('click', printRentalFinalSettlement);
document.getElementById('rental-final-settlement-modal').addEventListener('click', event => {
  if (event.target === event.currentTarget) closeRentalFinalSettlement();
});
document.getElementById('rental-contract-document-form').addEventListener('submit', event => {
  void submitRentalContractDocument(event);
});
document.getElementById('rental-contract-document-close').addEventListener('click', closeRentalContractDocumentModal);
document.getElementById('rental-contract-document-cancel').addEventListener('click', closeRentalContractDocumentModal);
document.getElementById('rental-contract-document-back').addEventListener('click', backToRentalContractDocumentForm);
document.getElementById('rental-contract-document-print').addEventListener('click', printRentalContractDocument);
document.getElementById('rental-contract-document-modal').addEventListener('click', event => {
  if (event.target === event.currentTarget) closeRentalContractDocumentModal();
});
document.getElementById('rental-contract-list').addEventListener('submit', event => {
  const form = event.target.closest('[data-contract-amendment-form]');
  if (!form) return;
  event.preventDefault();
  void submitRentalContractAmendment(form);
});
document.getElementById('rental-handover-form').addEventListener('submit', submitRentalHandover);
document.getElementById('rental-handover-type').addEventListener('change', updateRentalHandoverDate);
document.getElementById('rental-handover-close').addEventListener('click', closeRentalHandoverModal);
document.getElementById('rental-handover-close-footer').addEventListener('click', closeRentalHandoverModal);
document.getElementById('rental-handover-back').addEventListener('click', closeRentalHandoverPreview);
document.getElementById('rental-handover-print').addEventListener('click', printRentalHandover);
document.getElementById('rental-handover-list').addEventListener('click', event => {
  const button = event.target?.closest?.('[data-handover-preview]');
  if (!button) return;
  const card = button.closest('.rental-handover-card');
  const handover = rentalHandovers.find(item => Number(item.id) === Number(card?.dataset.handoverId));
  if (handover) openRentalHandoverPreview(handover);
});
document.getElementById('rental-handover-modal').addEventListener('click', event => {
  if (event.target === event.currentTarget) closeRentalHandoverModal();
});

// ============================================================
//  BILLING SHEET (Nhập chỉ số)
// ============================================================
function renderBilling() {
  const period = STATE.currentPeriod;
  document.getElementById('billing-period-label').textContent = periodLabel(period);
  document.getElementById('billing-month-input').value = periodInputValue(period);

  const tbody = document.getElementById('billing-tbody');
  tbody.innerHTML = '';
  refreshBillingProgress();

  if (STATE.rooms.length === 0) {
    tbody.innerHTML = `<tr class="billing-empty-row"><td colspan="11" class="empty-cell">Chưa có phòng. Vào tab Phòng để thêm.</td></tr>`;
    refreshBillingProgress();
    return;
  }

  for (const room of STATE.rooms) {
    const periodRec = STATE.billingData[period] || {};
    const rec = periodRec[room.id] || {};
    const rates = getRoomRates(room, period);
    const utilityOnly = isUtilityOnlyRecord(rec);
    const electricOld = getElectricOld(room, period);
    const electricNew = rec.electricNew ?? '';
    
    let waterUnits = rec.waterUnits;
    let waterNew = rec.waterNew ?? '';
    let waterOld = 0;
    
    if (room.waterType === 'khối') {
      waterOld = getWaterOld(room, period);
      if (waterNew === '') {
        waterUnits = '';
      } else {
        waterUnits = waterNew - waterOld;
      }
    } else {
      if (waterUnits === undefined || waterUnits === null || waterUnits === '') {
        waterUnits = room.waterType === 'người' ? (room.peopleCount || 1) : '';
      }
    }

    const kwh  = electricNew !== '' ? Math.max(0, electricNew - electricOld) : '—';
    
    const hasValidElec = electricNew !== '';
    const hasValidWater = room.waterType === 'khối' ? waterNew !== '' : waterUnits !== '';
    
    const bill = hasValidElec && hasValidWater
      ? calcBill(room, {
          ...rec,
          electricNew: +electricNew,
          waterNew: waterNew !== '' ? +waterNew : undefined,
          waterUnits: waterUnits !== '' ? +waterUnits : undefined
        }, period)
      : null;
    const paymentSummary = RENT_INVOICE_SUMMARIES.get(rentInvoiceKey(room.id, period));
    const adjustmentsLocked = Number(paymentSummary?.transactionCount) > 0;

    let kwhHtml = '—';
    if (electricNew !== '') {
      kwhHtml = `<strong>${fmtNum(kwh)} kWh</strong><div class="billing-calculation">${fmtNum(electricNew)} − ${fmtNum(electricOld)}</div>`;
    }

    let totalHtml = '—';
    if (bill) {
      const breakdown = billingBreakdownText(bill);
      totalHtml = `<strong>${fmt(bill.total)}</strong><div class="billing-breakdown">${breakdown}</div>`;
    }

    const tr = document.createElement('tr');
    
    const waterPlaceholder = room.waterType === 'người' ? 'Số người' : 'Số khối';
    const waterUnitText = room.waterType === 'người' ? 'người' : 'khối';
    
    const wifiText = rates.wifiFee > 0 ? `📶 ${fmtShorthand(rates.wifiFee)}` : '—';
    const wifiBadgeClass = rates.wifiFee > 0 ? 'badge badge--paid' : 'badge badge--empty';

    // Check if electricOld is auto-rolled, overridden, or static
    const prevPeriod = getPreviousPeriodKey(period);
    const prevRec = getPeriodRecord(room.id, prevPeriod);
    const isAutoRolled = prevRec
      && isInvoiceSettled(room.id, prevPeriod, prevRec.paid)
      && prevRec.electricNew !== undefined
      && prevRec.electricNew !== '';
    const isElecOverridden = rec && rec.electricOldOverride !== undefined && rec.electricOldOverride !== '' && rec.electricOldOverride !== null;
    
    let electricOldSubText = isAutoRolled ? '↑ tự động' : '';
    if (isElecOverridden) electricOldSubText = '✏️ tùy chỉnh';

    const electricOldHtml = `
      <div class="billing-previous-reading">
        <strong>${fmtNum(electricOld)}</strong>
        <button class="btn-edit-old" data-room="${room.id}" data-type="elec" title="Sửa số điện cũ tháng này">✏️</button>
      </div>
      ${electricOldSubText ? `<div class="billing-reading-source ${isElecOverridden ? 'billing-reading-source--custom' : ''}">${electricOldSubText}</div>` : ''}
    `;

    let waterCellHtml = '';
    if (room.waterType === 'khối') {
      const isWaterAutoRolled = prevRec
        && isInvoiceSettled(room.id, prevPeriod, prevRec.paid)
        && prevRec.waterNew !== undefined
        && prevRec.waterNew !== ''
        && prevRec.waterNew !== null;
      const isWaterOverridden = rec && rec.waterOldOverride !== undefined && rec.waterOldOverride !== '' && rec.waterOldOverride !== null;
      
      let waterOldSubText = isWaterAutoRolled ? '↑ tự động' : '';
      if (isWaterOverridden) waterOldSubText = '✏️ tùy chỉnh';

      const waterOldHtml = `
        <span>${fmtNum(waterOld)}</span>
        <button class="btn-edit-old" data-room="${room.id}" data-type="water" title="Sửa số nước cũ tháng này">✏️</button>
        ${waterOldSubText ? `<span class="billing-reading-source ${isWaterOverridden ? 'billing-reading-source--custom' : ''}">${waterOldSubText}</span>` : ''}
      `;

      waterCellHtml = `
        <div class="billing-water-reading">
          <div class="billing-water-previous">Cũ: <strong>${waterOldHtml}</strong></div>
          <div class="ocr-input-wrap">
            <input type="number" class="water-new-input" data-room="${room.id}"
              value="${waterNew}" placeholder="Số mới" min="${waterOld}" aria-label="Số nước mới" />
            <button class="btn-ocr" data-room="${room.id}" data-target="water"
              title="Chụp ảnh công tơ nước">📷</button>
          </div>
          <div class="water-units-display" id="water-units-${room.id}">
            ${waterNew !== '' ? `${fmtNum(Math.max(0, waterNew - waterOld))} khối` : '—'}
          </div>
        </div>
      `;
    } else {
      waterCellHtml = `
        <div class="billing-water-flat">
          <input type="number" class="water-input" data-room="${room.id}"
            value="${waterUnits}" placeholder="${waterPlaceholder}" min="0" aria-label="Số lượng nước" />
          <span>${waterUnitText}</span>
        </div>
      `;
    }

    tr.innerHTML = `
      <td class="billing-room-summary">
        <div class="billing-room-cell">
          <div class="billing-room-heading">
            <strong class="billing-room-name">${room.name}</strong>
            <span class="billing-status-badge ${bill ? 'billing-status-badge--done' : 'billing-status-badge--pending'}">
              ${bill ? 'Hoàn thành' : 'Chưa xong'}
            </span>
          </div>
          <label class="billing-inline-toggle">
            <input type="checkbox" class="billing-utility-toggle" data-room="${room.id}" ${utilityOnly ? 'checked' : ''} />
            <span>Chỉ thu điện nước</span>
          </label>
        </div>
      </td>
      <td class="billing-field billing-electric-old" data-label="Số điện cũ">${electricOldHtml}</td>
      <td class="billing-field billing-electric-new" data-label="Số điện mới">
        <div class="ocr-input-wrap">
          <input type="number" class="elec-new-input" data-room="${room.id}"
            value="${electricNew}" placeholder="Số mới" min="${electricOld}" aria-label="Số điện mới" />
          <button class="btn-ocr" data-room="${room.id}" data-target="elec"
            title="Chụp ảnh công tơ điện">📷</button>
        </div>
      </td>
      <td class="billing-field billing-electric-used kwh-cell" data-label="Điện tiêu thụ" id="kwh-${room.id}">${kwhHtml}</td>
      <td class="billing-field billing-water" data-label="Chỉ số nước">${waterCellHtml}</td>
      <td class="billing-field billing-fee billing-trash" data-label="Rác">${utilityOnly ? '<span class="billing-fee-muted">Đã thu trước</span>' : `<span class="billing-fee-value">${fmt(rates.trashFee)}</span>`}</td>
      <td class="billing-field billing-fee billing-wifi" data-label="Wifi">${utilityOnly ? '<span class="billing-fee-muted">Đã thu trước</span>' : `<span class="${wifiBadgeClass}">${wifiText}</span>`}</td>
      <td class="billing-field billing-fee billing-manage" data-label="Phí QL & DV">${utilityOnly ? '<span class="billing-fee-muted">Đã thu trước</span>' : `<span class="billing-fee-value">${fmt(rates.manageFee)}</span>`}</td>
      <td class="billing-field billing-adjustments" data-label="Điều chỉnh hóa đơn">
        <div class="billing-adjustment-grid">
          <label>
            <span>Giảm giá</span>
            <input type="number" class="bill-adjustment-input" data-adjustment-field="discountAmount"
              value="${Number(rec.discountAmount) || 0}" min="0" max="${InvoiceAdjustments.MAX_VND}" step="1"
              aria-label="Giảm giá ${escapeHtml(room.name)}" ${adjustmentsLocked ? 'disabled' : ''} />
          </label>
          <label>
            <span>Phụ thu</span>
            <input type="number" class="bill-adjustment-input" data-adjustment-field="surchargeAmount"
              value="${Number(rec.surchargeAmount) || 0}" min="0" max="${InvoiceAdjustments.MAX_VND}" step="1"
              aria-label="Phụ thu ${escapeHtml(room.name)}" ${adjustmentsLocked ? 'disabled' : ''} />
          </label>
          <label>
            <span>Phí chậm</span>
            <input type="number" class="bill-adjustment-input" data-adjustment-field="lateFeeAmount"
              value="${Number(rec.lateFeeAmount) || 0}" min="0" max="${InvoiceAdjustments.MAX_VND}" step="1"
              aria-label="Phí chậm thanh toán ${escapeHtml(room.name)}" ${adjustmentsLocked ? 'disabled' : ''} />
          </label>
        </div>
        ${adjustmentsLocked ? '<p class="billing-adjustment-lock">Đã phát sinh giao dịch nên các khoản điều chỉnh được khóa.</p>' : ''}
      </td>
      <td class="billing-field billing-note" data-label="Ghi chú">
        <input type="text" class="bill-note-input" data-room="${room.id}"
          value="${rec.note || ''}" placeholder="Ghi chú tháng..." aria-label="Ghi chú tháng" />
      </td>
      <td class="billing-field billing-total total-cell" data-label="Thành tiền" id="total-${room.id}">${totalHtml}</td>
    `;

    // Live calculation
    const elecInput  = tr.querySelector('.elec-new-input');
    const waterInput = tr.querySelector('.water-input');
    const waterNewInput = tr.querySelector('.water-new-input');
    setBillingRowCompletion(tr, !!bill);

    const recalc = () => {
      const wasComplete = tr.classList.contains('billing-row--complete');
      const eNew = parseFloat(elecInput.value);
      
      let wUnits = 0;
      let wNew = '';
      if (room.waterType === 'khối') {
        wNew = waterNewInput ? parseFloat(waterNewInput.value) : NaN;
        
        const hasWaterVal = !isNaN(wNew) && waterNewInput.value !== '';
        const isWaterInvalid = hasWaterVal && wNew < waterOld;
        
        if (isWaterInvalid) {
          waterNewInput.style.outline = '2px solid var(--red)';
          waterNewInput.style.borderColor = 'var(--red)';
          document.getElementById(`water-units-${room.id}`).innerHTML =
            `<span style="color:var(--red);font-size:0.75rem;font-weight:600">⚠ Phải ≥ ${fmtNum(waterOld)}</span>`;
          document.getElementById(`total-${room.id}`).innerHTML = '—';
          
          if (STATE.billingData[period]?.[room.id]) {
            STATE.billingData[period][room.id].waterNew = '';
            saveState();
          }
          setBillingRowCompletion(tr, false);
          refreshBillingProgress();
          return;
        }
        
        waterNewInput.style.outline = '';
        waterNewInput.style.borderColor = '';
        
        wUnits = hasWaterVal ? Math.max(0, wNew - waterOld) : null;
        if (wUnits !== null) {
          document.getElementById(`water-units-${room.id}`).innerHTML = `<strong>${fmtNum(wUnits)}</strong> khối`;
        } else {
          document.getElementById(`water-units-${room.id}`).innerHTML = '—';
        }
      } else {
        wUnits = waterInput ? parseFloat(waterInput.value) : NaN;
      }

      // --- Validation: số điện mới phải >= số điện cũ ---
      const hasValue = !isNaN(eNew) && elecInput.value !== '';
      const isInvalid = hasValue && eNew < electricOld;

      if (isInvalid) {
        elecInput.style.outline = '2px solid var(--red)';
        elecInput.style.borderColor = 'var(--red)';
        document.getElementById(`kwh-${room.id}`).innerHTML =
          `<span style="color:var(--red);font-size:0.75rem;font-weight:600">⚠ Phải ≥ ${fmtNum(electricOld)}</span>`;
        document.getElementById(`total-${room.id}`).innerHTML = '—';
        // Xoá giá trị lỗi khỏi state (không lưu số sai)
        if (STATE.billingData[period]?.[room.id]) {
          STATE.billingData[period][room.id].electricNew = '';
          saveState();
        }
        setBillingRowCompletion(tr, false);
        refreshBillingProgress();
        return;
      }

      // Reset validation style
      elecInput.style.outline = '';
      elecInput.style.borderColor = '';

      const kwhVal = hasValue ? Math.max(0, eNew - electricOld) : null;

      if (kwhVal !== null) {
        document.getElementById(`kwh-${room.id}`).innerHTML = `<strong>${fmtNum(kwhVal)} kWh</strong><div class="billing-calculation">${fmtNum(eNew)} − ${fmtNum(electricOld)}</div>`;
      } else {
        document.getElementById(`kwh-${room.id}`).innerHTML = '—';
      }

      const isValidWater = room.waterType === 'khối' ? !isNaN(wNew) && waterNewInput.value !== '' : !isNaN(wUnits);
      const isNowComplete = kwhVal !== null && isValidWater;

      if (isNowComplete) {
        const storedRecord = STATE.billingData[period]?.[room.id] || rec;
        const b = calcBill(room, {
          ...storedRecord,
          electricNew: eNew,
          waterNew: wNew,
          waterUnits: wUnits
        }, period);
        const breakdown = billingBreakdownText(b);
        document.getElementById(`total-${room.id}`).innerHTML = `<strong>${fmt(b.total)}</strong><div class="billing-breakdown">${breakdown}</div>`;
      } else {
        document.getElementById(`total-${room.id}`).innerHTML = '—';
      }

      // Save valid data
      if (!STATE.billingData[period]) STATE.billingData[period] = {};
      if (!STATE.billingData[period][room.id]) STATE.billingData[period][room.id] = {};
      STATE.billingData[period][room.id].electricNew = hasValue ? eNew : '';
      if (room.waterType === 'khối') {
        STATE.billingData[period][room.id].waterNew = !isNaN(wNew) ? wNew : '';
        STATE.billingData[period][room.id].waterUnits = wUnits !== null && !isNaN(wUnits) ? wUnits : '';
      } else {
        STATE.billingData[period][room.id].waterUnits = !isNaN(wUnits) ? wUnits : '';
        delete STATE.billingData[period][room.id].waterNew;
      }
      setBillingRowCompletion(tr, isNowComplete, !wasComplete && isNowComplete);
      refreshBillingProgress();
      saveState();
    };

    // Validate existing saved value on initial render
    if (electricNew !== '' && !isNaN(Number(electricNew)) && Number(electricNew) < electricOld) {
      elecInput.style.outline = '2px solid var(--red)';
      elecInput.style.borderColor = 'var(--red)';
    }
    if (room.waterType === 'khối' && waterNew !== '' && !isNaN(Number(waterNew)) && Number(waterNew) < waterOld) {
      if (waterNewInput) {
        waterNewInput.style.outline = '2px solid var(--red)';
        waterNewInput.style.borderColor = 'var(--red)';
      }
    }

    elecInput.addEventListener('input', recalc);
    if (room.waterType === 'khối') {
      if (waterNewInput) waterNewInput.addEventListener('input', recalc);
    } else {
      if (waterInput) waterInput.addEventListener('input', recalc);
    }

    tr.querySelectorAll('.bill-adjustment-input').forEach(input => {
      input.addEventListener('input', () => {
        const raw = input.value === '' ? 0 : Number(input.value);
        const valid = Number.isSafeInteger(raw)
          && raw >= 0
          && raw <= InvoiceAdjustments.MAX_VND;
        input.classList.toggle('billing-input-invalid', !valid);
        if (!valid) {
          document.getElementById(`total-${room.id}`).innerHTML = '—';
          return;
        }
        if (!STATE.billingData[period]) STATE.billingData[period] = {};
        if (!STATE.billingData[period][room.id]) STATE.billingData[period][room.id] = {};
        STATE.billingData[period][room.id][input.dataset.adjustmentField] = raw;
        recalc();
      });
    });

    const saveMeterPhoto = (meterType, capture) => {
      const dataUrl = String(capture?.photoDataUrl || '');
      if (!dataUrl) return;
      API.upsertRentMeterPhoto({
        roomId: room.id,
        period,
        meterType,
        dataUrl
      }).then(() => {
        showToast(`Đã lưu ảnh chỉ số ${meterType === 'electricity' ? 'điện' : 'nước'} ✓`, 'success');
      }).catch((error) => {
        if (error.code === 401) return handleAuthExpired();
        showToast(`Đã lưu chỉ số nhưng chưa lưu được ảnh: ${error.message}`, 'error', 4000);
      });
    };

    // OCR camera button for electric meter
    const ocrBtn = tr.querySelector('.btn-ocr[data-target="elec"]');
    if (ocrBtn) {
      ocrBtn.addEventListener('click', () => {
        openOcrModal(room.id, 'elec', (val, capture) => {
          elecInput.value = val;
          elecInput.dispatchEvent(new Event('input'));
          saveMeterPhoto('electricity', capture);
        });
      });
    }

    // OCR camera button for water meter
    const ocrWaterBtn = tr.querySelector('.btn-ocr[data-target="water"]');
    if (ocrWaterBtn) {
      ocrWaterBtn.addEventListener('click', () => {
        openOcrModal(room.id, 'water', (val, capture) => {
          if (waterNewInput) {
            waterNewInput.value = val;
            waterNewInput.dispatchEvent(new Event('input'));
            saveMeterPhoto('water', capture);
          }
        });
      });
    }

    // Edit old reading buttons
    tr.querySelectorAll('.btn-edit-old').forEach(btn => {
      btn.addEventListener('click', (e) => {
        e.stopPropagation();
        const rId = btn.dataset.room;
        const targetType = btn.dataset.type;
        openEditOldModal(rId, targetType);
      });
    });

    // Bill note input
    const billNoteInput = tr.querySelector('.bill-note-input');
    if (billNoteInput) {
      billNoteInput.addEventListener('input', (e) => {
        const val = e.target.value;
        if (!STATE.billingData[period]) STATE.billingData[period] = {};
        if (!STATE.billingData[period][room.id]) STATE.billingData[period][room.id] = {};
        STATE.billingData[period][room.id].note = val;
        saveState();
      });
    }

    const utilityToggle = tr.querySelector('.billing-utility-toggle');
    if (utilityToggle) {
      utilityToggle.addEventListener('change', (e) => {
        if (!STATE.billingData[period]) STATE.billingData[period] = {};
        if (!STATE.billingData[period][room.id]) STATE.billingData[period][room.id] = {};
        if (e.target.checked) {
          STATE.billingData[period][room.id].utilityOnly = true;
        } else {
          delete STATE.billingData[period][room.id].utilityOnly;
        }
        recalc();
        renderReport();
        renderDashboard();
      });
    }

    tbody.appendChild(tr);
  }

  refreshBillingProgress();
  renderBillingLegend();
}

// Dynamic legend: only show rates that are uniform across all rooms
function renderBillingLegend() {
  const legendEl = document.getElementById('billing-legend');
  if (!legendEl) return;

  if (STATE.rooms.length === 0) {
    legendEl.innerHTML = '';
    return;
  }

  const items = [];
  const roomRates = STATE.rooms.map(room => getRoomRates(room, STATE.currentPeriod));

  // Nước: show only if rate AND type are uniform across all rooms
  const waterRates = [...new Set(roomRates.map(rates => rates.waterRate))];
  const waterTypes = [...new Set(STATE.rooms.map(r => r.waterType || 'người'))];
  if (waterRates.length === 1 && waterTypes.length === 1) {
    items.push(`💧 Nước: <strong>${fmtNum(waterRates[0])}đ/${waterTypes[0]}</strong>`);
  }

  // Rác: show only if uniform across ALL rooms
  const trashFees = [...new Set(roomRates.map(rates => rates.trashFee))];
  if (trashFees.length === 1 && trashFees[0] > 0) {
    items.push(`🗑️ Rác: <strong>${fmtNum(trashFees[0])}đ/tháng</strong>`);
  }

  // Wifi: only mention if ≥1 room has wifi; show rate if uniform among wifi rooms
  const wifiRates = roomRates.filter(rates => rates.wifiFee > 0);
  if (wifiRates.length > 0) {
    const wifiFees = [...new Set(wifiRates.map(rates => rates.wifiFee))];
    if (wifiFees.length === 1) {
      items.push(`📶 Wifi: <strong>${fmtNum(wifiFees[0])}đ/nhà</strong> (nếu có)`);
    } else {
      items.push(`📶 Wifi: <strong>theo phòng</strong> (nếu có)`);
    }
  }

  // Phí QL & DV: only mention if ≥1 room has it; show rate if uniform
  const manageRates = roomRates.filter(rates => rates.manageFee > 0);
  if (manageRates.length > 0) {
    const manageFees = [...new Set(manageRates.map(rates => rates.manageFee))];
    if (manageFees.length === 1) {
      items.push(`💼 QL & DV: <strong>${fmtNum(manageFees[0])}đ/tháng</strong> (nếu có)`);
    } else {
      items.push(`💼 QL & DV: <strong>theo phòng</strong> (nếu có)`);
    }
  }

  legendEl.innerHTML = items.map(i => `<span>${i}</span>`).join('');
}

// ============================================================
//  REPORTS (Hóa đơn chi tiết)
// ============================================================
let activeBillPreview = null;

function billPreviewDetailRows(room, rec, bill, period) {
  const electricOld = getElectricOld(room, period);
  const waterOld = room.waterType === 'khối' ? getWaterOld(room, period) : 0;
  const rows = [];

  if (bill.rentAmt > 0 || bill.rentStartsAfterPeriod) {
    rows.push({
      label: 'Tiền phòng',
      formula: rentFormulaText(bill),
      amount: bill.rentAmt
    });
  }

  rows.push({
    label: 'Tiền điện',
    formula: `${fmtNum(electricOld)} → ${fmtNum(rec.electricNew)} = ${fmtNum(bill.kwh)} kWh × ${fmtNum(bill.electricRate)}đ`,
    amount: bill.electricAmt
  });

  rows.push({
    label: 'Tiền nước',
    formula: room.waterType === 'khối'
      ? `${fmtNum(waterOld)} → ${fmtNum(rec.waterNew)} = ${fmtNum(bill.waterUnits)} khối × ${fmtNum(bill.waterRate)}đ`
      : `${fmtNum(bill.waterUnits)} người × ${fmtNum(bill.waterRate)}đ`,
    amount: bill.waterAmt
  });

  if (bill.trashAmt > 0) rows.push({ label: 'Phí rác', formula: 'Cố định hàng tháng', amount: bill.trashAmt });
  if (bill.wifiAmt > 0) rows.push({ label: 'Mạng Wifi', formula: 'Cố định hàng tháng', amount: bill.wifiAmt });
  if (bill.manageAmt > 0) rows.push({ label: 'Phí quản lý & DV khác', formula: 'Cố định hàng tháng', amount: bill.manageAmt });
  if (bill.surchargeAmt > 0) rows.push({ label: 'Phụ thu', formula: 'Điều chỉnh kỳ này', amount: bill.surchargeAmt });
  if (bill.lateFeeAmt > 0) rows.push({ label: 'Phí chậm thanh toán', formula: 'Điều chỉnh kỳ này', amount: bill.lateFeeAmt });
  if (bill.discountAmt > 0) rows.push({ label: 'Giảm giá', formula: 'Điều chỉnh kỳ này', amount: -bill.discountAmt });

  return rows.map(row => `
    <div class="bill-preview-detail-row">
      <div class="bill-preview-detail-main">
        <strong>${escapeHtml(row.label)}</strong>
        <span>${escapeHtml(row.formula)}</span>
      </div>
      <strong class="bill-preview-detail-amount">${fmt(row.amount)}</strong>
    </div>
  `).join('');
}

function buildBillPreviewContent(room, rec, bill, period) {
  const payment = rentInvoicePaymentState(room.id, period, bill.total, rec.paid);
  const paidAmount = Math.min(bill.total, payment.paidAmountVnd);
  const currentRemaining = payment.remainingVnd;
  const remaining = payment.totalDueVnd;
  const transferContent = getVietQrDescription(room, period);
  const qrUrl = remaining > 0 ? genVietQrUrl(room, bill, period, remaining) : null;
  const hasBankConfig = !!(STATE.settings.bankId && STATE.settings.bankAccount);
  const waterUsage = room.waterType === 'khối'
    ? `${fmtNum(bill.waterUnits)} m³`
    : `${fmtNum(bill.waterUnits)} người`;

  let qrContent = '';
  if (remaining === 0) {
    qrContent = `
      <div class="bill-preview-qr-empty bill-preview-qr-empty--paid">
        <span>✓</span>
        <strong>Hóa đơn đã thu đủ</strong>
        <p>Không còn số tiền cần thanh toán.</p>
      </div>`;
  } else if (!transferContent) {
    qrContent = `
      <div class="bill-preview-qr-empty">
        <span>🧾</span>
        <strong>Chưa tạo được mã chuyển khoản</strong>
        <p>Đóng bill và thử mở lại sau khi dữ liệu được đồng bộ.</p>
      </div>`;
  } else if (!hasBankConfig || !qrUrl) {
    qrContent = `
      <div class="bill-preview-qr-empty">
        <span>🏦</span>
        <strong>Chưa cấu hình VietQR</strong>
        <p>Vào Cài đặt để thêm ngân hàng và số tài khoản nhận tiền.</p>
      </div>`;
  } else {
    const recipient = rentBankRecipientText();
    qrContent = `
      <div class="bill-preview-qr-frame">
        <img src="${escapeHtml(qrUrl)}" alt="VietQR thanh toán ${escapeHtml(room.name)}" />
      </div>
      <p class="bill-preview-qr-amount">Số tiền trên mã: <strong>${fmt(remaining)}</strong></p>
      <div class="bill-preview-direct-settlement">
        <strong>Người nhận: ${escapeHtml(recipient)}</strong>
        <span>Tiền vào thẳng tài khoản chủ trọ; TrọBill không giữ hộ tiền thuê.</span>
      </div>`;
  }

  return `
    <div class="bill-preview-layout">
      <div class="bill-preview-info">
        <div class="bill-preview-meta">
          <div class="bill-preview-meta-item">
            <strong>Mã hóa đơn:</strong>
            <span>${escapeHtml(billCode(room, period))}</span>
          </div>
          <div class="bill-preview-meta-item">
            <strong>Hạn thanh toán:</strong>
            <span>${escapeHtml(payment.dueDate || billDueDate(period))}</span>
          </div>
          <div class="bill-preview-meta-item">
            <strong>Tuổi nợ:</strong>
            <span class="bill-preview-debt-age">
              ${debtAgeBadge(payment)}
              <small>${escapeHtml(debtAgeDetails(payment))}</small>
            </span>
          </div>
          <div class="bill-preview-meta-item">
            <strong>Điện sử dụng:</strong>
            <span>${fmtNum(bill.kwh)} kWh</span>
          </div>
          <div class="bill-preview-meta-item">
            <strong>Nước sử dụng:</strong>
            <span>${waterUsage}</span>
          </div>
          <div class="bill-preview-meta-item bill-preview-meta-item--wide">
            <strong>Nội dung chuyển khoản:</strong>
            <span class="bill-preview-transfer-reference">
              <code>${escapeHtml(transferContent || '—')}</code>
              ${transferContent ? `<button type="button" class="btn btn--ghost btn--sm" data-copy-transfer-reference="${escapeHtml(transferContent)}">Sao chép</button>` : ''}
            </span>
          </div>
        </div>

        <section class="bill-preview-details">
          <h3>Chi tiết hóa đơn</h3>
          <div class="bill-preview-detail-list">
            ${billPreviewDetailRows(room, rec, bill, period)}
            ${payment.priorDebtVnd > 0 ? `
              <div class="bill-preview-detail-row">
                <div class="bill-preview-detail-main">
                  <strong>Nợ cũ chuyển sang</strong>
                  <span>${payment.oldestUnpaidPeriod ? `Từ kỳ ${escapeHtml(payment.oldestUnpaidPeriod)}` : 'Các kỳ trước chưa thu đủ'}</span>
                </div>
                <strong class="bill-preview-detail-amount">${fmt(payment.priorDebtVnd)}</strong>
              </div>` : ''}
          </div>
          ${isUtilityOnlyRecord(rec) ? '<p class="bill-preview-note bill-preview-note--warning">Tháng này chỉ thu điện, nước. Các khoản cố định đã thu trước.</p>' : ''}
          ${rec.note ? `<p class="bill-preview-note">Ghi chú: ${escapeHtml(rec.note)}</p>` : ''}
        </section>

        <div class="bill-preview-summary">
          <div><span>Tháng này</span><strong>${fmt(bill.total)}</strong></div>
          <div><span>Đã thu tháng này</span><strong>${fmt(paidAmount)}</strong></div>
          <div><span>Còn tháng này</span><strong>${fmt(currentRemaining)}</strong></div>
          <div><span>Tổng cần trả</span><strong>${fmt(remaining)}</strong></div>
        </div>
      </div>

      <aside class="bill-preview-qr-panel">
        <h3>VietQR thanh toán</h3>
        ${qrContent}
      </aside>
    </div>
  `;
}

async function openBillPreview(room, rec, bill, period) {
  if (!getVietQrDescription(room, period)) {
    try {
      await ensureRentInvoicesSynced();
    } catch (error) {
      console.warn('Không tạo được mã chuyển khoản riêng:', error.message);
    }
  }
  activeBillPreview = { room, rec, bill, period };
  document.getElementById('bill-preview-title').textContent = `Hóa đơn ${room.name} – ${period}`;
  document.getElementById('bill-preview-content').innerHTML = buildBillPreviewContent(room, rec, bill, period);
  document.getElementById('bill-preview-modal').hidden = false;
}

function closeBillPreview() {
  document.getElementById('bill-preview-modal').hidden = true;
}

let ACTIVE_BILL_MESSAGE_SHARE_LINK = null;
let BILL_MESSAGE_LINK_PROMISE = null;
let BILL_MESSAGE_SCHEDULES = [];

function selectedBillMessageTenant() {
  if (!activeBillPreview) return null;
  const tenantId = document.getElementById('bill-message-tenant')?.value || '';
  return (activeBillPreview.room.tenants || []).find(tenant => tenant.id === tenantId) || null;
}

function populateBillMessageTenants() {
  const selector = document.getElementById('bill-message-tenant');
  if (!selector || !activeBillPreview) return;
  selector.replaceChildren();
  const tenants = Array.isArray(activeBillPreview.room.tenants)
    ? activeBillPreview.room.tenants
    : [];
  if (tenants.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'Chưa có khách thuê trong phòng';
    selector.appendChild(option);
    selector.disabled = true;
    return;
  }
  selector.disabled = false;
  for (const tenant of tenants) {
    const option = document.createElement('option');
    option.value = tenant.id;
    const contact = tenant.email || tenant.phone || 'chưa có thông tin liên hệ';
    option.textContent = `${tenant.fullName || 'Khách thuê'} · ${contact}`;
    selector.appendChild(option);
  }
  const preferredTenant = tenants.find(tenant => tenant.email) || tenants[0];
  selector.value = preferredTenant.id;
}

function billMessageContext() {
  if (!activeBillPreview) return null;
  const { room, rec, bill, period } = activeBillPreview;
  const payment = rentInvoicePaymentState(room.id, period, bill.total, rec.paid);
  return {
    roomName: room.name,
    periodLabel: periodLabel(period),
    invoiceTotalVnd: payment.invoiceTotalVnd,
    paidAmountVnd: payment.paidAmountVnd,
    priorDebtVnd: payment.priorDebtVnd,
    totalDueVnd: payment.totalDueVnd,
    dueDate: payment.dueDate || billDueDate(period),
    overdueDays: payment.overdueDays,
    transferContent: getVietQrDescription(room, period),
    bankRecipient: rentBankRecipientText(),
    invoiceUrl: ACTIVE_BILL_MESSAGE_SHARE_LINK?.publicUrl || ''
  };
}

function renderBillMessageTemplate() {
  const context = billMessageContext();
  const selector = document.getElementById('bill-message-template-type');
  const content = document.getElementById('bill-message-content');
  const copyButton = document.getElementById('bill-message-copy');
  const shareButton = document.getElementById('bill-message-share');
  const emailButton = document.getElementById('bill-message-email');
  const scheduleButton = document.getElementById('bill-message-schedule');
  const contactNote = document.getElementById('bill-message-contact-note');
  if (!context || !selector || !content || !window.BillMessageTemplates) return '';
  const template = selector.value === 'reminder'
    ? window.BillMessageTemplates.reminder(context)
    : window.BillMessageTemplates.invoice(context);
  content.value = template;
  if (copyButton) copyButton.disabled = !template;
  if (shareButton) shareButton.disabled = !template;
  const tenant = selectedBillMessageTenant();
  if (emailButton) emailButton.disabled = !template || !tenant?.email;
  if (scheduleButton) scheduleButton.disabled = !template || !tenant?.email;
  if (contactNote) {
    if (!tenant) contactNote.textContent = 'Thêm khách thuê để chọn người nhận email.';
    else if (tenant.email) contactNote.textContent = `Email sẽ gửi đến ${tenant.email}.`;
    else contactNote.textContent = 'Khách này chưa có email. Có thể dùng Zalo/ứng dụng hoặc bổ sung email trong Quản lý phòng.';
  }
  return template;
}

function openBillMessageModal() {
  const context = billMessageContext();
  if (!context || !window.BillMessageTemplates) {
    showToast('Chưa tải được mẫu tin nhắn. Vui lòng tải lại trang.', 'error');
    return;
  }
  const modal = document.getElementById('bill-message-modal');
  const selector = document.getElementById('bill-message-template-type');
  const reminderOption = selector?.querySelector('option[value="reminder"]');
  if (!modal || !selector) return;
  ACTIVE_BILL_MESSAGE_SHARE_LINK = null;
  BILL_MESSAGE_LINK_PROMISE = null;
  BILL_MESSAGE_SCHEDULES = [];
  document.getElementById('bill-message-link-result').hidden = true;
  document.getElementById('bill-message-link-url').value = '';
  if (reminderOption) reminderOption.disabled = context.totalDueVnd <= 0;
  if (context.totalDueVnd <= 0 && selector.value === 'reminder') selector.value = 'invoice';
  document.getElementById('bill-message-subtitle').textContent =
    `${context.roomName} · ${context.periodLabel}`;
  populateBillMessageTenants();
  prepareBillMessageScheduleDate();
  renderBillMessageSchedules({ loading: true });
  renderBillMessageTemplate();
  closeBillPreview();
  modal.hidden = false;
  syncModalScrollLock();
  document.getElementById('bill-message-content')?.focus();
  void loadBillMessageSchedules();
}

function closeBillMessageModal() {
  const modal = document.getElementById('bill-message-modal');
  if (modal) modal.hidden = true;
  ACTIVE_BILL_MESSAGE_SHARE_LINK = null;
  BILL_MESSAGE_LINK_PROMISE = null;
  BILL_MESSAGE_SCHEDULES = [];
  syncModalScrollLock();
}

function copyBillMessageTemplate() {
  const template = document.getElementById('bill-message-content')?.value || '';
  return copySubscriptionOrderValue(template, 'Đã sao chép mẫu tin nhắn.');
}

async function activeBillMessageInvoiceId() {
  if (!activeBillPreview) return null;
  const { room, period } = activeBillPreview;
  let invoice = RENT_INVOICE_SUMMARIES.get(rentInvoiceKey(room.id, period));
  if (!invoice?.invoiceId) {
    await ensureRentInvoicesSynced();
    invoice = RENT_INVOICE_SUMMARIES.get(rentInvoiceKey(room.id, period));
  }
  return invoice?.invoiceId ? Number(invoice.invoiceId) : null;
}

async function ensureBillMessageSystemLink() {
  if (ACTIVE_BILL_MESSAGE_SHARE_LINK?.publicUrl) return ACTIVE_BILL_MESSAGE_SHARE_LINK;
  if (BILL_MESSAGE_LINK_PROMISE) return BILL_MESSAGE_LINK_PROMISE;
  BILL_MESSAGE_LINK_PROMISE = (async () => {
    const invoiceId = await activeBillMessageInvoiceId();
    if (!invoiceId) throw new Error('Chưa tạo được hóa đơn để chia sẻ');
    const result = await API.createRentInvoiceShareLink(invoiceId, 72);
    if (!result?.publicUrl) throw new Error('Máy chủ không trả về liên kết hóa đơn');
    ACTIVE_BILL_MESSAGE_SHARE_LINK = result;
    document.getElementById('bill-message-link-url').value = result.publicUrl;
    document.getElementById('bill-message-link-result').hidden = false;
    renderBillMessageTemplate();
    return result;
  })();
  try {
    return await BILL_MESSAGE_LINK_PROMISE;
  } finally {
    BILL_MESSAGE_LINK_PROMISE = null;
  }
}

async function createBillMessageSystemLink(event) {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await ensureBillMessageSystemLink();
    showToast('Đã tạo link hóa đơn bảo mật và chèn vào mẫu.', 'success', 3500);
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    showToast(error.message || 'Không tạo được link hóa đơn', 'error', 4000);
  } finally {
    button.disabled = false;
  }
}

async function shareBillMessageTemplate(event) {
  const button = event.currentTarget;
  button.disabled = true;
  try {
    await ensureBillMessageSystemLink();
    const template = renderBillMessageTemplate();
    if (!template) return;
    const context = billMessageContext();
    shareBillNative(
      `Hóa đơn ${context?.roomName || ''}`.trim(),
      template,
      copyBillMessageTemplate
    );
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    showToast(error.message || 'Không chia sẻ được hóa đơn', 'error', 4000);
  } finally {
    button.disabled = false;
  }
}

async function sendBillMessageEmail(event) {
  const tenant = selectedBillMessageTenant();
  if (!tenant?.email) {
    showToast('Khách thuê chưa có email nhận hóa đơn.', 'error');
    return;
  }
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const invoiceId = await activeBillMessageInvoiceId();
    if (!invoiceId) throw new Error('Chưa tạo được hóa đơn để gửi');
    const result = await API.deliverRentInvoiceEmail(invoiceId, {
      tenantId: tenant.id,
      templateType: document.getElementById('bill-message-template-type').value,
      expiresInHours: 72,
      deliveryKey: uuid()
    });
    if (result.publicUrl) {
      ACTIVE_BILL_MESSAGE_SHARE_LINK = result;
      document.getElementById('bill-message-link-url').value = result.publicUrl;
      document.getElementById('bill-message-link-result').hidden = false;
      renderBillMessageTemplate();
    }
    if (result.development) {
      showToast('Môi trường local: đã tạo link nhưng chưa gửi email thật.', 'info', 4500);
    } else {
      showToast(`Đã gửi email hóa đơn đến ${result.recipient || tenant.email}.`, 'success', 4000);
    }
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    showToast(error.message || 'Không gửi được email hóa đơn', 'error', 4500);
  } finally {
    button.disabled = !selectedBillMessageTenant()?.email;
  }
}

function vietnamCalendarDate(daysFromToday = 0) {
  const vietnamNow = new Date(Date.now() + (7 * 60 * 60 * 1000));
  vietnamNow.setUTCDate(vietnamNow.getUTCDate() + daysFromToday);
  return vietnamNow.toISOString().slice(0, 10);
}

function prepareBillMessageScheduleDate() {
  const input = document.getElementById('bill-message-schedule-date');
  if (!input) return;
  input.min = vietnamCalendarDate(1);
  input.max = vietnamCalendarDate(90);
  if (!input.value || input.value < input.min || input.value > input.max) {
    input.value = input.min;
  }
}

function billMessageScheduleStatusLabel(status) {
  return ({
    scheduled: 'Đã hẹn',
    sending: 'Đang gửi',
    sent: 'Đã gửi',
    failed: 'Gửi lỗi',
    skipped: 'Đã bỏ qua',
    cancelled: 'Đã hủy'
  })[status] || 'Không xác định';
}

function billMessageScheduleDateLabel(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
  return match ? `${match[3]}/${match[2]}/${match[1]}` : String(value || '');
}

function billMessageScheduleTriggerLabel(schedule) {
  if (schedule.triggerSource !== 'automatic') return 'Hẹn thủ công';
  const offset = Number(schedule.reminderOffsetDays) || 0;
  if (offset > 0) return `Tự động · trước hạn ${offset} ngày`;
  if (offset < 0) return `Tự động · sau hạn ${Math.abs(offset)} ngày`;
  return 'Tự động';
}

function renderBillMessageSchedules({ loading = false } = {}) {
  const container = document.getElementById('bill-message-schedule-list');
  if (!container) return;
  container.replaceChildren();
  if (loading) {
    const note = document.createElement('span');
    note.className = 'bill-message-schedule-empty';
    note.textContent = 'Đang tải lịch gửi…';
    container.appendChild(note);
    return;
  }
  if (BILL_MESSAGE_SCHEDULES.length === 0) {
    const note = document.createElement('span');
    note.className = 'bill-message-schedule-empty';
    note.textContent = 'Chưa có lịch gửi cho hóa đơn này.';
    container.appendChild(note);
    return;
  }
  for (const schedule of BILL_MESSAGE_SCHEDULES) {
    const item = document.createElement('div');
    item.className = 'bill-message-schedule-item';
    const info = document.createElement('div');
    info.className = 'bill-message-schedule-info';
    const title = document.createElement('strong');
    const templateLabel = schedule.templateType === 'reminder' ? 'Nhắc thanh toán' : 'Thông báo hóa đơn';
    title.textContent = `${billMessageScheduleDateLabel(schedule.scheduledFor)} · ${templateLabel}`;
    const meta = document.createElement('span');
    meta.textContent = `${billMessageScheduleStatusLabel(schedule.status)} · ${billMessageScheduleTriggerLabel(schedule)} · ${schedule.recipient || 'email khách thuê'}`;
    info.append(title, meta);
    item.appendChild(info);
    const actions = document.createElement('div');
    actions.className = 'bill-message-schedule-actions';
    if (schedule.status === 'failed' && Number(schedule.attemptCount) < 5) {
      const retryButton = document.createElement('button');
      retryButton.type = 'button';
      retryButton.className = 'btn btn--primary btn--sm';
      retryButton.dataset.retryInvoiceSchedule = String(schedule.id);
      retryButton.textContent = 'Gửi lại';
      actions.appendChild(retryButton);
    }
    if (['scheduled', 'failed'].includes(schedule.status)) {
      const cancelButton = document.createElement('button');
      cancelButton.type = 'button';
      cancelButton.className = 'btn btn--ghost btn--sm';
      cancelButton.dataset.cancelInvoiceSchedule = String(schedule.id);
      cancelButton.textContent = 'Hủy lịch';
      actions.appendChild(cancelButton);
    }
    if (actions.childElementCount > 0) item.appendChild(actions);
    container.appendChild(item);
  }
}

async function loadBillMessageSchedules() {
  try {
    const invoiceId = await activeBillMessageInvoiceId();
    if (!invoiceId) throw new Error('Chưa tạo được hóa đơn để xem lịch gửi');
    const result = await API.getRentInvoiceDeliverySchedules(invoiceId);
    BILL_MESSAGE_SCHEDULES = Array.isArray(result.schedules) ? result.schedules : [];
    renderBillMessageSchedules();
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    BILL_MESSAGE_SCHEDULES = [];
    renderBillMessageSchedules();
    showToast(error.message || 'Không tải được lịch gửi hóa đơn', 'error', 4000);
  }
}

async function scheduleBillMessageEmail(event) {
  const tenant = selectedBillMessageTenant();
  const scheduledFor = document.getElementById('bill-message-schedule-date')?.value || '';
  if (!tenant?.email) {
    showToast('Khách thuê chưa có email nhận hóa đơn.', 'error');
    return;
  }
  if (!scheduledFor) {
    showToast('Hãy chọn ngày gửi hóa đơn.', 'error');
    return;
  }
  const button = event.currentTarget;
  button.disabled = true;
  try {
    const invoiceId = await activeBillMessageInvoiceId();
    if (!invoiceId) throw new Error('Chưa tạo được hóa đơn để hẹn gửi');
    const result = await API.scheduleRentInvoiceEmail(invoiceId, {
      tenantId: tenant.id,
      templateType: document.getElementById('bill-message-template-type').value,
      scheduledFor
    });
    await loadBillMessageSchedules();
    showToast(
      result.created ? 'Đã hẹn ngày gửi email hóa đơn.' : 'Lịch gửi này đã tồn tại.',
      result.created ? 'success' : 'info',
      4000
    );
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    showToast(error.message || 'Không hẹn được ngày gửi hóa đơn', 'error', 4500);
  } finally {
    button.disabled = !selectedBillMessageTenant()?.email;
  }
}

async function cancelBillMessageSchedule(scheduleId, button) {
  button.disabled = true;
  try {
    await API.cancelRentInvoiceDeliverySchedule(scheduleId);
    await loadBillMessageSchedules();
    showToast('Đã hủy lịch gửi hóa đơn.', 'success');
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    showToast(error.message || 'Không hủy được lịch gửi', 'error', 4000);
    button.disabled = false;
  }
}

async function retryBillMessageSchedule(scheduleId, button) {
  if (!Number.isSafeInteger(scheduleId) || scheduleId < 1) return;
  button.disabled = true;
  try {
    await API.retryRentInvoiceDeliverySchedule(scheduleId);
    showToast('Đã gửi lại email hóa đơn ✓', 'success');
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    showToast(error.message || 'Không gửi lại được email hóa đơn', 'error', 4500);
  } finally {
    await loadBillMessageSchedules();
    button.disabled = false;
  }
}

async function waitForBillPreviewImages(container) {
  const images = Array.from(container.querySelectorAll('img'));
  await Promise.all(images.map(image => {
    if (image.complete) return Promise.resolve();
    return new Promise(resolve => {
      const finish = () => resolve();
      image.addEventListener('load', finish, { once: true });
      image.addEventListener('error', finish, { once: true });
      setTimeout(finish, 2500);
    });
  }));
}

async function printBillPreview() {
  if (!activeBillPreview) return;
  const { room, rec, bill, period } = activeBillPreview;
  const printArea = document.getElementById('print-area');
  printArea.innerHTML = `
    <article class="single-bill-print">
      <h1>Hóa đơn ${escapeHtml(room.name)} – ${escapeHtml(period)}</h1>
      ${buildBillPreviewContent(room, rec, bill, period)}
    </article>`;
  await waitForBillPreviewImages(printArea);
  closeBillPreview();
  syncModalScrollLock();
  const filenameRoom = removeVietnameseTones(room.name).replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'phong';
  triggerPrint(`hoa-don-${filenameRoom}-${period}.pdf`);
}

function closeInvoiceShareModal() {
  const modal = document.getElementById('invoice-share-modal');
  if (modal) modal.hidden = true;
  ACTIVE_RENT_INVOICE_SHARE_ID = null;
  RENT_INVOICE_SHARE_LINKS = [];
  RENT_INVOICE_PAYMENT_PROOFS = [];
  const result = document.getElementById('invoice-share-result');
  const url = document.getElementById('invoice-share-url');
  if (result) result.hidden = true;
  if (url) url.value = '';
  syncModalScrollLock();
}

function invoiceShareStatusLabel(status) {
  return ({ active: 'Đang hoạt động', expired: 'Đã hết hạn', revoked: 'Đã thu hồi' })[status]
    || 'Không xác định';
}

function renderInvoiceShareLinks() {
  const list = document.getElementById('invoice-share-list');
  const empty = document.getElementById('invoice-share-empty');
  if (!list || !empty) return;
  list.textContent = '';
  empty.hidden = RENT_INVOICE_SHARE_LINKS.length > 0;
  for (const link of RENT_INVOICE_SHARE_LINKS) {
    const item = document.createElement('article');
    item.className = 'invoice-share-item';
    item.innerHTML = `
      <div class="invoice-share-item-main">
        <div>
          <strong>Link ••••${escapeHtml(link.tokenLast4 || '')}</strong>
          <span class="invoice-share-status invoice-share-status--${escapeHtml(link.status)}">${escapeHtml(invoiceShareStatusLabel(link.status))}</span>
        </div>
        <p>Hết hạn: ${escapeHtml(subscriptionDateTime(link.expiresAt))} · ${Number(link.viewCount) || 0} lượt mở</p>
        ${link.lastViewedAt ? `<p>Mở gần nhất: ${escapeHtml(subscriptionDateTime(link.lastViewedAt))}</p>` : ''}
      </div>
      ${link.status === 'active'
        ? `<button type="button" class="btn btn--ghost btn--sm invoice-share-revoke" data-link-id="${Number(link.id)}">Thu hồi</button>`
        : ''}`;
    item.querySelector('.invoice-share-revoke')?.addEventListener('click', event => {
      const linkId = Number(event.currentTarget.dataset.linkId);
      showConfirm(
        'Thu hồi liên kết này? Khách thuê sẽ không thể mở lại dù liên kết chưa hết hạn.',
        async () => {
          try {
            await API.revokeRentInvoiceShareLink(linkId);
            await loadInvoiceShareLinks();
            showToast('Đã thu hồi liên kết hóa đơn.', 'success');
          } catch (error) {
            if (error.code === 401) return handleAuthExpired();
            showToast(error.message || 'Không thu hồi được liên kết', 'error');
          }
        },
        null,
        'Thu hồi'
      );
    });
    list.appendChild(item);
  }
}

function renderInvoicePaymentProofs() {
  const list = document.getElementById('invoice-payment-proof-list');
  const empty = document.getElementById('invoice-payment-proof-empty');
  if (!list || !empty) return;
  list.replaceChildren();
  empty.hidden = RENT_INVOICE_PAYMENT_PROOFS.length > 0;
  for (const proof of RENT_INVOICE_PAYMENT_PROOFS) {
    const item = document.createElement('article');
    item.className = 'invoice-payment-proof-item';

    const image = document.createElement('img');
    const imageDataUrl = String(proof.imageDataUrl || '');
    if (/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(imageDataUrl)) {
      image.src = imageDataUrl;
    }
    image.alt = `Minh chứng chuyển khoản gửi lúc ${subscriptionDateTime(proof.submittedAt)}`;

    const details = document.createElement('div');
    const heading = document.createElement('div');
    const title = document.createElement('strong');
    const badge = document.createElement('span');
    const submitted = document.createElement('p');
    const note = document.createElement('p');
    title.textContent = `Link ••••${proof.linkTokenLast4 || ''}`;
    badge.className = 'invoice-share-status invoice-payment-proof-status';
    badge.textContent = proof.status === 'accepted'
      ? 'Đã xác nhận'
      : (proof.status === 'rejected' ? 'Không hợp lệ' : 'Chờ đối chiếu');
    submitted.textContent = `Gửi lúc: ${subscriptionDateTime(proof.submittedAt)}`;
    note.textContent = 'Ảnh này không tự động ghi nhận đã thu tiền.';
    heading.append(title, badge);
    details.append(heading, submitted, note);
    item.append(image, details);
    list.appendChild(item);
  }
}

async function loadInvoiceShareLinks() {
  if (!ACTIVE_RENT_INVOICE_SHARE_ID) return;
  try {
    const result = await API.getRentInvoiceShareLinks(ACTIVE_RENT_INVOICE_SHARE_ID);
    RENT_INVOICE_SHARE_LINKS = Array.isArray(result.links) ? result.links : [];
    renderInvoiceShareLinks();
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    showToast(error.message || 'Không tải được liên kết hóa đơn', 'error');
  }
}

async function loadInvoicePaymentProofs() {
  if (!ACTIVE_RENT_INVOICE_SHARE_ID) return;
  try {
    const result = await API.getRentInvoicePaymentProofs(ACTIVE_RENT_INVOICE_SHARE_ID);
    RENT_INVOICE_PAYMENT_PROOFS = Array.isArray(result.proofs) ? result.proofs : [];
    renderInvoicePaymentProofs();
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    showToast(error.message || 'Không tải được minh chứng chuyển khoản', 'error');
  }
}

async function loadInvoiceShareData() {
  await Promise.all([loadInvoiceShareLinks(), loadInvoicePaymentProofs()]);
}

async function openInvoiceShareModal() {
  if (!activeBillPreview) return;
  const { room, period } = activeBillPreview;
  let invoice = RENT_INVOICE_SUMMARIES.get(rentInvoiceKey(room.id, period));
  if (!invoice?.invoiceId) {
    try {
      await ensureRentInvoicesSynced();
      invoice = RENT_INVOICE_SUMMARIES.get(rentInvoiceKey(room.id, period));
    } catch (error) {
      showToast(error.message || 'Chưa tạo được hóa đơn để chia sẻ', 'error');
      return;
    }
  }
  if (!invoice?.invoiceId) {
    showToast('Chưa tạo được hóa đơn để chia sẻ.', 'error');
    return;
  }
  ACTIVE_RENT_INVOICE_SHARE_ID = Number(invoice.invoiceId);
  RENT_INVOICE_SHARE_LINKS = [];
  RENT_INVOICE_PAYMENT_PROOFS = [];
  document.getElementById('invoice-share-subtitle').textContent = `${room.name} · ${periodLabel(period)}`;
  document.getElementById('invoice-share-result').hidden = true;
  document.getElementById('invoice-share-url').value = '';
  closeBillPreview();
  document.getElementById('invoice-share-modal').hidden = false;
  syncModalScrollLock();
  await loadInvoiceShareData();
}

async function createInvoiceShareLink(event) {
  if (!ACTIVE_RENT_INVOICE_SHARE_ID) return;
  const button = event.currentTarget;
  const expiresInHours = Number(document.getElementById('invoice-share-expiry').value);
  button.disabled = true;
  try {
    const result = await API.createRentInvoiceShareLink(
      ACTIVE_RENT_INVOICE_SHARE_ID,
      expiresInHours
    );
    document.getElementById('invoice-share-url').value = result.publicUrl || '';
    document.getElementById('invoice-share-result').hidden = false;
    await loadInvoiceShareLinks();
    showToast('Đã tạo liên kết bảo mật. Hãy sao chép ngay.', 'success', 3500);
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    showToast(error.message || 'Không tạo được liên kết hóa đơn', 'error', 4000);
  } finally {
    button.disabled = false;
  }
}

document.getElementById('bill-preview-close-header').addEventListener('click', closeBillPreview);
document.getElementById('bill-preview-close-footer').addEventListener('click', closeBillPreview);
document.getElementById('bill-preview-print').addEventListener('click', printBillPreview);
document.getElementById('bill-preview-share-link')?.addEventListener('click', openInvoiceShareModal);
document.getElementById('bill-preview-message-template')?.addEventListener('click', openBillMessageModal);
document.getElementById('bill-message-template-type')?.addEventListener('change', renderBillMessageTemplate);
document.getElementById('bill-message-tenant')?.addEventListener('change', renderBillMessageTemplate);
document.getElementById('bill-message-copy')?.addEventListener('click', copyBillMessageTemplate);
document.getElementById('bill-message-share')?.addEventListener('click', shareBillMessageTemplate);
document.getElementById('bill-message-email')?.addEventListener('click', sendBillMessageEmail);
document.getElementById('bill-message-schedule')?.addEventListener('click', scheduleBillMessageEmail);
document.getElementById('bill-message-create-link')?.addEventListener('click', createBillMessageSystemLink);
document.getElementById('bill-message-link-copy')?.addEventListener('click', () => {
  copySubscriptionOrderValue(
    document.getElementById('bill-message-link-url')?.value,
    'Đã sao chép link hóa đơn.'
  );
});
document.getElementById('bill-message-close-header')?.addEventListener('click', closeBillMessageModal);
document.getElementById('bill-message-close-footer')?.addEventListener('click', closeBillMessageModal);
document.getElementById('bill-message-modal')?.addEventListener('click', event => {
  if (event.target === event.currentTarget) closeBillMessageModal();
});
document.getElementById('bill-message-schedule-list')?.addEventListener('click', event => {
  const retryButton = event.target?.closest?.('[data-retry-invoice-schedule]');
  if (retryButton) {
    void retryBillMessageSchedule(Number(retryButton.dataset.retryInvoiceSchedule), retryButton);
    return;
  }
  const button = event.target?.closest?.('[data-cancel-invoice-schedule]');
  if (!button) return;
  void cancelBillMessageSchedule(Number(button.dataset.cancelInvoiceSchedule), button);
});
document.getElementById('invoice-share-create')?.addEventListener('click', createInvoiceShareLink);
document.getElementById('invoice-share-refresh')?.addEventListener('click', loadInvoiceShareData);
document.getElementById('invoice-share-copy')?.addEventListener('click', () => {
  copySubscriptionOrderValue(
    document.getElementById('invoice-share-url')?.value,
    'Đã sao chép liên kết hóa đơn.'
  );
});
document.getElementById('invoice-share-close-header')?.addEventListener('click', closeInvoiceShareModal);
document.getElementById('invoice-share-close-footer')?.addEventListener('click', closeInvoiceShareModal);
document.getElementById('invoice-share-modal')?.addEventListener('click', event => {
  if (event.target === event.currentTarget) closeInvoiceShareModal();
});
document.getElementById('bill-preview-modal').addEventListener('click', event => {
  const copyReferenceButton = event.target instanceof Element
    ? event.target.closest('[data-copy-transfer-reference]')
    : null;
  if (copyReferenceButton) {
    navigator.clipboard.writeText(copyReferenceButton.dataset.copyTransferReference || '').then(() => {
      showToast('Đã sao chép nội dung chuyển khoản ✓', 'success');
    }).catch(() => {
      showToast('Không sao chép được nội dung chuyển khoản', 'error');
    });
    return;
  }
  if (event.target === document.getElementById('bill-preview-modal')) closeBillPreview();
});
document.getElementById('rent-payment-entry-form')?.addEventListener('submit', submitRentPaymentEntry);
document.getElementById('rent-payment-entry-close')?.addEventListener('click', closeRentPaymentEntry);
document.getElementById('rent-payment-entry-cancel')?.addEventListener('click', closeRentPaymentEntry);
document.getElementById('rent-payment-entry-modal')?.addEventListener('click', event => {
  if (event.target === event.currentTarget) closeRentPaymentEntry();
});
document.getElementById('rent-payment-modal-close-header')?.addEventListener('click', closeRentPaymentLedger);
document.getElementById('rent-payment-modal-close-footer')?.addEventListener('click', closeRentPaymentLedger);
document.getElementById('rent-payment-modal')?.addEventListener('click', event => {
  if (event.target === event.currentTarget) closeRentPaymentLedger();
});

function renderReport() {
  const period = STATE.currentPeriod;
  const listEl = document.getElementById('report-list');
  const summaryEl = document.getElementById('report-summary-bar');
  document.getElementById('report-period-label').textContent = periodLabel(period);
  document.getElementById('report-month-input').value = periodInputValue(period);
  listEl.innerHTML = '';
  if (summaryEl) summaryEl.innerHTML = '';

  const billsWithData = STATE.rooms.filter(r => getPeriodRecord(r.id, period));
  if (billsWithData.length === 0) {
    if (summaryEl) summaryEl.style.display = 'none';
    listEl.innerHTML = `<div class="empty-state"><div class="empty-icon">🧾</div>
      <p>Nhập chỉ số điện/nước để xem hóa đơn.<br>
      <button class="link-btn" data-goto="billing">Nhập chỉ số ngay →</button></p></div>`;
    listEl.querySelector('[data-goto]')?.addEventListener('click', () => navigate('billing'));
    return;
  }

  if (summaryEl) summaryEl.style.display = 'flex';

  let totalRevenue = 0;
  let totalPaid = 0;
  let paidCount = 0;
  const activeBills = [];

  for (const room of STATE.rooms) {
    const rec  = getPeriodRecord(room.id, period);
    if (!rec) continue;
    const bill = calcBill(room, rec, period);
    if (!bill) continue;
    const payment = rentInvoicePaymentState(room.id, period, bill.total, rec.paid);
    totalRevenue += bill.total;
    totalPaid += Math.min(bill.total, payment.paidAmountVnd);
    if (payment.accountSettled) paidCount++;
    activeBills.push({ room, rec, bill, payment });
  }

  const deduction = STATE.settings.deduction ?? 450000;
  const netRevenue = totalPaid - deduction;

  if (summaryEl) {
    summaryEl.innerHTML = `
      <div class="report-summary-item">
        <span>💰 Tổng cộng hóa đơn:</span>
        <span class="report-summary-val">${fmt(totalRevenue)}</span>
      </div>
      <div class="report-summary-item">
        <span>📈 Thực thu (đã trừ khấu hao):</span>
        <span class="report-summary-val" style="color: var(--green)">${fmt(netRevenue)}</span>
      </div>
      <div class="report-summary-item">
        <span>🧾 Trạng thái:</span>
        <span class="report-summary-val" style="color: var(--wifi)">Đã thu ${paidCount}/${activeBills.length} phòng</span>
      </div>
    `;
  }

  for (const { room, rec, bill, payment } of activeBills) {
    const paid = payment.accountSettled;
    const paymentButtonLabel = paid
      ? payment.invoiceId ? '🧾 Đã thu · Xem giao dịch' : '💰 Chuyển trạng thái cũ vào sổ'
      : payment.paidAmountVnd > 0 || payment.priorDebtVnd > 0
        ? `💰 Ghi nhận thêm · còn ${fmt(payment.totalDueVnd)}`
        : '💰 Ghi nhận thu tiền';
    const utilityOnly = isUtilityOnlyRecord(rec);
    const waterUnit = room.waterType === 'người' ? 'người' : 'khối';
    const electricOld = getElectricOld(room, period);
    const waterOld = room.waterType === 'khối' ? getWaterOld(room, period) : 0;

    const billPreviewBtnHtml = `<button class="btn btn--ghost btn--sm bill-preview-trigger" data-bill-preview-room="${room.id}">Xem bill + VietQR</button>`;

    const card = document.createElement('div');
    card.className = 'bill-card';
    card.innerHTML = `
      <div class="bill-header">
        <div>
          <div class="bill-room-name">${room.name}</div>
          <div style="font-size:.75rem;color:var(--text-muted)">${periodLabel(period)}</div>
          <div class="bill-transfer-reference">🧾 ${escapeHtml(getVietQrDescription(room, period) || 'Đang tạo mã...')}</div>
        </div>
        <div class="bill-header-payment">
          <div class="bill-total-big">${fmt(bill.total)}</div>
          ${debtAgeBadge(payment)}
        </div>
      </div>
      <div class="bill-body">
        <div class="bill-rows">
          <div class="bill-row">
            <div>
              <div class="bill-row-label">⚡ Chỉ số điện</div>
              <div class="bill-row-formula">Cũ: ${fmtNum(electricOld)} &nbsp;|&nbsp; Mới: ${fmtNum(rec.electricNew)}</div>
            </div>
            <div class="bill-row-val">${fmtNum(bill.kwh)} kWh</div>
          </div>
          <div class="bill-row">
            <div>
              <div class="bill-row-label">⚡ Tiền điện</div>
              <div class="bill-row-formula">${fmtNum(bill.kwh)} kWh × ${fmtNum(bill.electricRate)}đ</div>
            </div>
            <div class="bill-row-val">${fmt(bill.electricAmt)}</div>
          </div>
          ${room.waterType === 'khối' ? `
          <div class="bill-row">
            <div>
              <div class="bill-row-label">💧 Chỉ số nước</div>
              <div class="bill-row-formula">Cũ: ${fmtNum(waterOld)} &nbsp;|&nbsp; Mới: ${fmtNum(rec.waterNew)}</div>
            </div>
            <div class="bill-row-val">${fmtNum(bill.waterUnits)} khối</div>
          </div>
          <div class="bill-row">
            <div>
              <div class="bill-row-label">💧 Tiền nước</div>
              <div class="bill-row-formula">${fmtNum(bill.waterUnits)} khối × ${fmtNum(bill.waterRate)}đ</div>
            </div>
            <div class="bill-row-val">${fmt(bill.waterAmt)}</div>
          </div>
          ` : `
          <div class="bill-row">
            <div>
              <div class="bill-row-label">💧 Tiền nước</div>
              <div class="bill-row-formula">${bill.waterUnits} ${waterUnit} × ${fmtNum(bill.waterRate)}đ</div>
            </div>
            <div class="bill-row-val">${fmt(bill.waterAmt)}</div>
          </div>
          `}
          <div class="bill-row">
            <div>
              <div class="bill-row-label">🗑️ Tiền rác</div>
              <div class="bill-row-formula">Cố định hàng tháng</div>
            </div>
            <div class="bill-row-val">${fmt(bill.trashAmt)}</div>
          </div>
          ${bill.wifiAmt > 0 ? `
          <div class="bill-row">
            <div>
              <div class="bill-row-label">📶 Mạng Wifi</div>
              <div class="bill-row-formula">Cố định hàng tháng</div>
            </div>
            <div class="bill-row-val">${fmt(bill.wifiAmt)}</div>
          </div>
          ` : ''}
          ${bill.manageAmt > 0 ? `
          <div class="bill-row">
            <div>
              <div class="bill-row-label">💼 Phí quản lý & DV khác</div>
              <div class="bill-row-formula">Cố định hàng tháng</div>
            </div>
            <div class="bill-row-val">${fmt(bill.manageAmt)}</div>
          </div>
          ` : ''}
          ${bill.rentAmt > 0 || bill.rentStartsAfterPeriod ? `<div class="bill-row">
            <div>
              <div class="bill-row-label">🏠 Tiền thuê</div>
              <div class="bill-row-formula">${rentFormulaText(bill)}</div>
            </div>
            <div class="bill-row-val">${fmt(bill.rentAmt)}</div>
          </div>` : ''}
          ${InvoiceAdjustments.hasAdjustments(rec) ? `
          <div class="bill-row">
            <div class="bill-row-label">Tạm tính trước điều chỉnh</div>
            <div class="bill-row-val">${fmt(bill.subtotal)}</div>
          </div>` : ''}
          ${bill.surchargeAmt > 0 ? `<div class="bill-row">
            <div class="bill-row-label">➕ Phụ thu</div>
            <div class="bill-row-val">${fmt(bill.surchargeAmt)}</div>
          </div>` : ''}
          ${bill.lateFeeAmt > 0 ? `<div class="bill-row">
            <div class="bill-row-label">⏱️ Phí chậm thanh toán</div>
            <div class="bill-row-val">${fmt(bill.lateFeeAmt)}</div>
          </div>` : ''}
          ${bill.discountAmt > 0 ? `<div class="bill-row">
            <div class="bill-row-label">🏷️ Giảm giá</div>
            <div class="bill-row-val" style="color:var(--green)">−${fmt(bill.discountAmt)}</div>
          </div>` : ''}
        </div>
        ${utilityOnly ? `<div class="report-bill-note report-bill-note--warning">🏁 Tháng này chỉ thu điện, nước. Các khoản cố định đã thu trước.</div>` : ''}
        ${rec.note ? `<div class="report-bill-note">📝 Ghi chú: ${rec.note}</div>` : ''}
        <hr class="bill-divider" />
        <div class="bill-row" style="font-size:1rem;font-weight:800">
          <div>TỔNG CỘNG</div>
          <div style="color:var(--primary)">${fmt(bill.total)}</div>
        </div>
        <div class="bill-footer">
          <button class="btn ${paid ? 'btn--paid is-paid' : 'btn--ghost'} btn--sm" data-paid-room="${room.id}" ${bill.total <= 0 ? 'disabled' : ''}>
            ${bill.total <= 0 ? 'Không có khoản phải thu' : paymentButtonLabel}
          </button>
          ${billPreviewBtnHtml}
          <button class="btn btn--ghost btn--sm" data-copy-room="${room.id}">📋 Copy</button>
          <button class="btn btn--ghost btn--sm" data-share-room="${room.id}">📤 Gửi</button>
        </div>
      </div>
    `;

    card.querySelector(`[data-paid-room]`).addEventListener('click', async e => {
      triggerHaptic('light');
      if (payment.accountSettled && payment.invoiceId) {
        await openRentPaymentLedger(payment.invoiceId);
        return;
      }
      openRentPaymentEntry({
        roomId: room.id,
        roomName: room.name,
        period,
        total: bill.total
      });
    });

    card.querySelector(`[data-bill-preview-room="${room.id}"]`).addEventListener('click', () => {
      triggerHaptic('light');
      openBillPreview(room, rec, bill, period);
    });

    card.querySelector(`[data-copy-room]`).addEventListener('click', () => {
      triggerHaptic('light');
      copyBillText(room, rec, bill, period);
    });

    card.querySelector(`[data-share-room]`).addEventListener('click', async () => {
      if (!getVietQrDescription(room, period)) {
        try {
          await ensureRentInvoicesSynced();
        } catch (error) {
          showToast('Chưa tạo được mã chuyển khoản. Vui lòng thử lại.', 'error', 3000);
          return;
        }
      }
      const pLabel = periodLabel(period);
      const waterUnitText = room.waterType === 'người' ? 'người' : 'khối';
      const utilityOnlyLine = utilityOnly ? `🏁 Tháng này chỉ thu điện, nước. Các khoản cố định đã thu trước.` : '';
      const trashLine = bill.trashAmt > 0 ? `🗑️ Tiền rác: ${fmt(bill.trashAmt)}` : '';
      const wifiLine = bill.wifiAmt > 0 ? `📶 Mạng Wifi: ${fmt(bill.wifiAmt)}` : '';
      const manageLine = bill.manageAmt > 0 ? `💼 Phí quản lý & DV khác: ${fmt(bill.manageAmt)}` : '';
      const rentLine = rentMessageLine(bill);
      const surchargeLine = bill.surchargeAmt > 0 ? `➕ Phụ thu: ${fmt(bill.surchargeAmt)}` : '';
      const lateFeeLine = bill.lateFeeAmt > 0 ? `⏱️ Phí chậm thanh toán: ${fmt(bill.lateFeeAmt)}` : '';
      const discountLine = bill.discountAmt > 0 ? `🏷️ Giảm giá: −${fmt(bill.discountAmt)}` : '';
      const noteLine = rec.note ? `📝 Ghi chú: ${rec.note}` : '';
      const qrUrl = genVietQrUrl(room, bill, period, payment.totalDueVnd);
      const qrPart = qrUrl ? `\n🔗 Link quét mã QR thanh toán nhanh:\n${qrUrl}` : '';
      const paymentLine = payment.paidAmountVnd > 0
        ? `✅ Đã thu tháng này: ${fmt(payment.paidAmountVnd)} | Còn tháng này: ${fmt(payment.remainingVnd)}`
        : '';
      const priorDebtLine = payment.priorDebtVnd > 0
        ? `⚠️ Nợ cũ chuyển sang: ${fmt(payment.priorDebtVnd)}`
        : '';
      const totalDueLine = `💳 TỔNG CẦN THANH TOÁN: ${fmt(payment.totalDueVnd)}`;
      const debtAgeLine = debtAgeMessageLine(payment);
      const transferLine = `🧾 NỘI DUNG CHUYỂN KHOẢN: ${getVietQrDescription(room, period)}`;
      const recipientLine = rentBankRecipientText()
        ? `🏦 NGƯỜI NHẬN: ${rentBankRecipientText()}`
        : '';

      const waterLine = room.waterType === 'khối'
        ? `💧 Tiền nước: (Cũ: ${fmtNum(waterOld)} - Mới: ${fmtNum(rec.waterNew)}) = ${bill.waterUnits} khối × ${fmtNum(bill.waterRate)}đ = ${fmt(bill.waterAmt)}`
        : `💧 Tiền nước: ${bill.waterUnits} ${waterUnitText} × ${fmtNum(bill.waterRate)}đ = ${fmt(bill.waterAmt)}`;

      const lines = [
        `🏠 HÓA ĐƠN THÁNG ${pLabel.replace('Tháng ', '').toUpperCase()} — ${room.name.toUpperCase()}`,
        ``,
        `⚡ Tiền điện: (Cũ: ${fmtNum(electricOld)} - Mới: ${fmtNum(rec.electricNew)}) = ${fmtNum(bill.kwh)} kWh × ${fmtNum(bill.electricRate)}đ = ${fmt(bill.electricAmt)}`,
        waterLine,
        utilityOnlyLine,
        trashLine,
        wifiLine,
        manageLine,
        rentLine,
        surchargeLine,
        lateFeeLine,
        discountLine,
        noteLine,
        `${'─'.repeat(32)}`,
        `💰 TỔNG CỘNG: ${fmt(bill.total)}`,
        paymentLine,
        priorDebtLine,
        totalDueLine,
        debtAgeLine,
        transferLine,
        recipientLine,
        qrPart
      ].filter(Boolean).join('\n');

      shareBillNative(`Hóa đơn ${room.name} ${pLabel}`, lines, () => {
        copyBillText(room, rec, bill, period);
      });
    });

    listEl.appendChild(card);
  }
}


// Copy Bill for Zalo
async function copyBillText(room, rec, bill, period) {
  if (!getVietQrDescription(room, period)) {
    try {
      await ensureRentInvoicesSynced();
    } catch (error) {
      showToast('Chưa tạo được mã chuyển khoản. Vui lòng thử lại.', 'error', 3000);
      return;
    }
  }
  const pLabel = periodLabel(period);
  const utilityOnlyLine = isUtilityOnlyRecord(rec) ? `🏁 Tháng này chỉ thu điện, nước. Các khoản cố định đã thu trước.` : '';
  const waterUnitText = room.waterType === 'người' ? 'người' : 'khối';
  const trashLine = bill.trashAmt > 0 ? `🗑️ Tiền rác: ${fmt(bill.trashAmt)}` : '';
  const wifiLine = bill.wifiAmt > 0 ? `📶 Mạng Wifi: ${fmt(bill.wifiAmt)}` : '';
  const manageLine = bill.manageAmt > 0 ? `💼 Phí quản lý & DV khác: ${fmt(bill.manageAmt)}` : '';
  const rentLine = rentMessageLine(bill);
  const surchargeLine = bill.surchargeAmt > 0 ? `➕ Phụ thu: ${fmt(bill.surchargeAmt)}` : '';
  const lateFeeLine = bill.lateFeeAmt > 0 ? `⏱️ Phí chậm thanh toán: ${fmt(bill.lateFeeAmt)}` : '';
  const discountLine = bill.discountAmt > 0 ? `🏷️ Giảm giá: −${fmt(bill.discountAmt)}` : '';
  const noteLine = rec.note ? `📝 Ghi chú: ${rec.note}` : '';
  const payment = rentInvoicePaymentState(room.id, period, bill.total, rec.paid);
  const paymentLine = payment.paidAmountVnd > 0
    ? `✅ Đã thu tháng này: ${fmt(payment.paidAmountVnd)} | Còn tháng này: ${fmt(payment.remainingVnd)}`
    : '';
  const priorDebtLine = payment.priorDebtVnd > 0
    ? `⚠️ Nợ cũ chuyển sang: ${fmt(payment.priorDebtVnd)}`
    : '';
  const debtAgeLine = debtAgeMessageLine(payment);
  const transferLine = `🧾 NỘI DUNG CHUYỂN KHOẢN: ${getVietQrDescription(room, period)}`;
  const recipientLine = rentBankRecipientText()
    ? `🏦 NGƯỜI NHẬN: ${rentBankRecipientText()}`
    : '';

  const electricOld = getElectricOld(room, period);
  const waterOld = room.waterType === 'khối' ? getWaterOld(room, period) : 0;
  
  const waterLine = room.waterType === 'khối'
    ? `💧 Tiền nước: (Cũ: ${fmtNum(waterOld)} - Mới: ${fmtNum(rec.waterNew)}) = ${bill.waterUnits} khối × ${fmtNum(bill.waterRate)}đ = ${fmt(bill.waterAmt)}`
    : `💧 Tiền nước: ${bill.waterUnits} ${waterUnitText} × ${fmtNum(bill.waterRate)}đ = ${fmt(bill.waterAmt)}`;

  const qrUrl = genVietQrUrl(room, bill, period, payment.totalDueVnd);
  const qrPart = qrUrl ? `\n🔗 Link quét mã QR thanh toán nhanh:\n${qrUrl}` : '';

  const lines = [
    `🏠 HÓA ĐƠN THÁNG ${pLabel.replace('Tháng ', '').toUpperCase()} — ${room.name.toUpperCase()}`,
    ``,
    `⚡ Tiền điện: (Cũ: ${fmtNum(electricOld)} - Mới: ${fmtNum(rec.electricNew)}) = ${fmtNum(bill.kwh)} kWh × ${fmtNum(bill.electricRate)}đ = ${fmt(bill.electricAmt)}`,
    waterLine,
    utilityOnlyLine,
    trashLine,
    wifiLine,
    manageLine,
    rentLine,
    surchargeLine,
    lateFeeLine,
    discountLine,
    noteLine,
    `${'─'.repeat(32)}`,
    `💰 TỔNG CỘNG: ${fmt(bill.total)}`,
    paymentLine,
    priorDebtLine,
    `💳 TỔNG CẦN THANH TOÁN: ${fmt(payment.totalDueVnd)}`,
    debtAgeLine,
    transferLine,
    recipientLine,
    qrPart
  ].filter(Boolean).join('\n');

  navigator.clipboard.writeText(lines).then(() => {
    showToast('Đã copy hóa đơn ✓', 'success');
  }).catch(() => {
    // Fallback
    const ta = document.createElement('textarea');
    ta.value = lines; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    document.execCommand('copy'); document.body.removeChild(ta);
    showToast('Đã copy hóa đơn ✓', 'success');
  });
}

// Copy all bills summary
document.getElementById('btn-copy-all').addEventListener('click', () => {
  const period = STATE.currentPeriod;
  const allTexts = [];
  for (const room of STATE.rooms) {
    const rec  = getPeriodRecord(room.id, period);
    if (!rec) continue;
    const bill = calcBill(room, rec, period);
    if (!bill) continue;
    const utilityOnlyLine = isUtilityOnlyRecord(rec) ? ' | Chỉ thu điện nước' : '';
    const adjustmentText = `${bill.surchargeAmt > 0 ? ` | Phụ thu: ${fmt(bill.surchargeAmt)}` : ''}${bill.lateFeeAmt > 0 ? ` | Phí chậm: ${fmt(bill.lateFeeAmt)}` : ''}${bill.discountAmt > 0 ? ` | Giảm: -${fmt(bill.discountAmt)}` : ''}`;
    allTexts.push(
      `=== ${room.name} ===\nTiền điện: ${fmt(bill.electricAmt)} | Nước: ${fmt(bill.waterAmt)}${bill.trashAmt > 0 ? ` | Rác: ${fmt(bill.trashAmt)}` : ''}${bill.wifiAmt > 0 ? ` | Wifi: ${fmt(bill.wifiAmt)}` : ''}${bill.manageAmt > 0 ? ` | QL & DV: ${fmt(bill.manageAmt)}` : ''}${bill.rentAmt > 0 ? ` | Thuê: ${fmt(bill.rentAmt)}` : ''}${adjustmentText}${utilityOnlyLine}\nTỔNG: ${fmt(bill.total)}`
    );
  }
  if (allTexts.length === 0) { showToast('Chưa có dữ liệu', 'error'); return; }
  navigator.clipboard.writeText(allTexts.join('\n\n')).then(() => showToast('Đã copy tổng hóa đơn ✓', 'success'));
});

// ============================================================
//  MONTHLY LOGS & LOCKING (Lưu tháng này)
// ============================================================
function saveMonth() {
  const period = STATE.currentPeriod;
  const billsWithData = STATE.rooms.filter(r => getPeriodRecord(r.id, period));
  if (billsWithData.length === 0) {
    showToast('Chưa có dữ liệu nhập của tháng này để lưu', 'error');
    return;
  }

  // Create snapshot
  const snapshot = {
    period: period,
    deduction: STATE.settings.deduction ?? 450000,
    timestamp: Date.now(),
    bills: STATE.rooms.map(room => {
      const rec = getPeriodRecord(room.id, period) || {};
      const bill = calcBill(room, rec, period);
      return {
        roomId: room.id,
        roomName: room.name,
        rentPrice: bill.rentAmt || 0,
        rentBasePrice: bill.rentBasePrice,
        rentDays: bill.rentDays,
        rentDaysInMonth: bill.rentDaysInMonth,
        rentProrated: bill.rentProrated,
        rentStartsAfterPeriod: bill.rentStartsAfterPeriod,
        electricOld: getElectricOld(room, period),
        electricNew: rec.electricNew ?? null,
        electricRate: bill.electricRate,
        kwh: bill.kwh,
        electricAmt: bill.electricAmt,
        waterType: room.waterType || 'người',
        waterRate: bill.waterRate,
        waterUnits: bill.waterUnits,
        waterAmt: bill.waterAmt,
        waterPrev: room.waterType === 'khối' ? getWaterOld(room, period) : null,
        waterNew: room.waterType === 'khối' ? (rec.waterNew !== undefined && rec.waterNew !== '' && rec.waterNew !== null ? Number(rec.waterNew) : null) : null,
        trashFee: bill.trashAmt || 0,
        wifiFee: bill.wifiAmt || 0,
        manageFee: bill.manageAmt || 0,
        discountAmount: bill.discountAmt || 0,
        surchargeAmount: bill.surchargeAmt || 0,
        lateFeeAmount: bill.lateFeeAmt || 0,
        total: bill.total,
        utilityOnly: isUtilityOnlyRecord(rec),
        paid: rentInvoicePaymentState(room.id, period, bill.total, rec.paid).settled
      };
    })
  };

  if (!STATE.history) STATE.history = [];
  
  // Check if already exists
  const existingIdx = STATE.history.findIndex(h => h.period === period);
  if (existingIdx > -1) {
    showConfirm(
      `Dữ liệu lịch sử ${periodLabel(period)} đã tồn tại. Ghi đè sẽ mất dữ liệu cũ. Bạn có muốn tiếp tục?`,
      () => {
        STATE.history[existingIdx] = snapshot;
        saveState();
        triggerHaptic('success');
        showToast(`Đã lưu lịch sử tháng ${periodLabel(period)} ✓`, 'success');
        navigate('history');
      },
      null,
      'Tiếp tục'
    );
  } else {
    STATE.history.push(snapshot);
    saveState();
    triggerHaptic('success');
    showToast(`Đã lưu lịch sử tháng ${periodLabel(period)} ✓`, 'success');
    navigate('history');
  }
}

document.getElementById('btn-save-month').addEventListener('click', saveMonth);

// ============================================================
//  HISTORY PAGE
// ============================================================
function renderHistory() {
  const listEl = document.getElementById('history-list');
  listEl.innerHTML = '';

  if (!STATE.history || STATE.history.length === 0) {
    listEl.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📅</div>
        <p>Chưa có tháng nào được lưu.<br>Hãy dùng nút <strong>Lưu tháng này</strong> trên tab Hóa đơn.</p>
      </div>
    `;
    return;
  }

  // Sort history newest first
  const sortedHistory = [...STATE.history].sort((a, b) => b.period.localeCompare(a.period));

  for (const record of sortedHistory) {
    const card = document.createElement('div');
    card.className = 'history-month-card';
    
    const totalRevenue = record.bills.reduce((sum, b) => sum + (b.total || 0), 0);
    const paymentStates = new Map(record.bills.map(b => [
      b.roomId,
      rentInvoicePaymentState(b.roomId, record.period, b.total, b.paid)
    ]));
    const collectedRevenue = record.bills.reduce((sum, b) => {
      const payment = paymentStates.get(b.roomId);
      return sum + Math.min(Number(b.total) || 0, payment?.paidAmountVnd || 0);
    }, 0);
    const netRevenue = collectedRevenue - (record.deduction || 0);
    const paidCount = record.bills.filter(b => paymentStates.get(b.roomId)?.settled).length;
    const totalRooms = record.bills.length;

    card.innerHTML = `
      <div class="history-month-header" data-toggle-history="${record.period}">
        <div>
          <div class="history-month-title">${periodLabel(record.period)}</div>
          <div class="history-month-meta">
            Đã thu: ${paidCount}/${totalRooms} phòng &nbsp;|&nbsp; Thực thu: ${fmt(netRevenue)}
          </div>
        </div>
        <div style="display:flex;align-items:center;gap:12px">
          <div class="history-month-total">${fmt(totalRevenue)}</div>
          <span style="font-size: 1rem; color: var(--text-muted); transition: transform 0.2s">▼</span>
        </div>
      </div>
      <div class="history-month-body" id="history-body-${record.period}">
        <div style="margin-bottom:12px; font-size:0.85rem; color:var(--text-muted)">
          Chi phí khấu trừ: ${fmt(record.deduction || 0)}
        </div>
        <div class="history-rooms-list">
          ${record.bills.map(b => {
            const payment = paymentStates.get(b.roomId);
            const waterUnit = b.waterType === 'người' ? 'người' : 'khối';
            const waterDesc = b.waterType === 'khối' && b.waterNew !== undefined && b.waterNew !== null && b.waterPrev !== undefined && b.waterPrev !== null
              ? `💧 ${fmtNum(b.waterUnits)} khối (${fmtNum(b.waterNew)} - ${fmtNum(b.waterPrev)})`
              : `💧 ${b.waterUnits} ${waterUnit}`;
            const rentDesc = b.rentStartsAfterPeriod
              ? ' | 🏠 0 đ (chưa bắt đầu thuê)'
              : b.rentPrice > 0
                ? ` | 🏠 ${fmt(b.rentPrice)}${b.rentProrated ? ` (${b.rentDays}/${b.rentDaysInMonth} ngày)` : ''}`
                : '';
            const adjustmentDesc = `${b.surchargeAmount > 0 ? ` | ➕ ${fmt(b.surchargeAmount)}` : ''}${b.lateFeeAmount > 0 ? ` | ⏱️ ${fmt(b.lateFeeAmount)}` : ''}${b.discountAmount > 0 ? ` | 🏷️ -${fmt(b.discountAmount)}` : ''}`;
            return `
            <div class="history-room-row">
              <div>
                <span class="history-room-name">${b.roomName}</span>
                <div class="history-room-debt-age">${debtAgeBadge(payment)}</div>
                <div style="font-size:0.75rem;color:var(--text-muted)">
                  ⚡ ${fmtNum(b.kwh)} kWh | ${waterDesc}${b.trashFee > 0 ? ` | 🗑️ ${fmt(b.trashFee)}` : ''}${b.wifiFee > 0 ? ` | 📶 ${fmt(b.wifiFee)}` : ''}${b.manageFee > 0 ? ` | 💼 ${fmt(b.manageFee)}` : ''}${rentDesc}${adjustmentDesc}${b.utilityOnly ? ' | 🏁 Chỉ thu điện nước' : ''}
                </div>
              </div>
              <div style="display:flex;align-items:center;gap:10px">
                <span class="history-room-total">${fmt(b.total)}</span>
                <button class="btn ${payment.settled ? 'btn--paid is-paid' : 'btn--ghost'} btn--sm" data-history-paid data-history-period="${record.period}" data-history-room="${escapeHtml(b.roomId)}" ${Number(b.total) <= 0 ? 'disabled' : ''}>
                  ${Number(b.total) <= 0 ? 'Không phải thu' : payment.invoiceId ? (payment.settled ? 'Xem giao dịch' : paymentStatusLabel(payment)) : payment.settled ? 'Chuyển vào sổ' : 'Ghi nhận đã thu'}
                </button>
              </div>
            </div>
            `;
          }).join('')}
        </div>
        <div class="history-actions">
          <button class="btn btn--ghost btn--sm" data-history-print="${record.period}">🖨️ In báo cáo</button>
          <button class="btn btn--danger btn--sm" data-history-delete="${record.period}">🗑️ Xóa lịch sử</button>
        </div>
      </div>
    `;

    const header = card.querySelector(`[data-toggle-history="${record.period}"]`);
    const body = card.querySelector(`#history-body-${record.period}`);
    const arrow = header.querySelector('span');
    
    header.addEventListener('click', () => {
      const isOpen = body.classList.toggle('open');
      arrow.style.transform = isOpen ? 'rotate(180deg)' : 'rotate(0deg)';
    });

    card.querySelectorAll('[data-history-paid]').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const periodVal = e.currentTarget.dataset.historyPeriod;
        const roomIdVal = e.currentTarget.dataset.historyRoom;
        const historyRecord = STATE.history.find(item => item.period === periodVal);
        const historyBill = historyRecord?.bills.find(item => item.roomId === roomIdVal);
        if (!historyBill) return;
        const payment = rentInvoicePaymentState(
          roomIdVal,
          periodVal,
          historyBill.total,
          historyBill.paid
        );
        if (payment.settled && payment.invoiceId) {
          await openRentPaymentLedger(payment.invoiceId);
          return;
        }
        openRentPaymentEntry({
          roomId: roomIdVal,
          roomName: historyBill.roomName,
          period: periodVal,
          total: historyBill.total
        });
      });
    });

    card.querySelector('[data-history-print]').addEventListener('click', e => {
      e.stopPropagation();
      printHistoryReport(record);
    });

    card.querySelector('[data-history-delete]').addEventListener('click', e => {
      e.stopPropagation();
      showConfirm(
        `Xóa lịch sử ${periodLabel(record.period)}? Hành động này không thể hoàn tác.`,
        () => {
          STATE.history = STATE.history.filter(h => h.period !== record.period);
          saveState();
          renderHistory();
          showToast(`Đã xóa lịch sử ${periodLabel(record.period)}`, 'info');
        }
      );
    });

    listEl.appendChild(card);
  }
}

// ============================================================
//  PRINT SYSTEM – Platform-agnostic bridge
// ============================================================
// Delegates to the right print mechanism depending on the host environment:
//   Android WebView  → AndroidApp.printDocument()  (native PrintManager)
//   iOS WKWebView    → webkit.messageHandlers.print  (future)
//   Web / desktop    → window.print()
function triggerPrint(filename) {
  if (window.AndroidApp && typeof window.AndroidApp.printDocument === 'function') {
    window.AndroidApp.printDocument(filename);
  } else if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.print) {
    window.webkit.messageHandlers.print.postMessage({ filename });
  } else {
    window.print();
  }
}

function generatePrintHTML(period, deduction, bills) {
  const totalRevenue = bills.reduce((sum, b) => sum + (b.total || 0), 0);
  const netRevenue = totalRevenue - (deduction || 0);

  return `
    <div class="print-header">
      <h1>BÁO CÁO THU TIỀN NHÀ TRỌ</h1>
      <p>${periodLabel(period).toUpperCase()}</p>
    </div>
    <div class="print-summary">
      <div class="print-summary-item">
        <div class="print-summary-label">Tổng thu</div>
        <div class="print-summary-val">${fmt(totalRevenue)}</div>
      </div>
      <div class="print-summary-item">
        <div class="print-summary-label">Khấu trừ</div>
        <div class="print-summary-val">${fmt(deduction)}</div>
      </div>
      <div class="print-summary-item">
        <div class="print-summary-label">Thực thu</div>
        <div class="print-summary-val">${fmt(netRevenue)}</div>
      </div>
    </div>
    <div class="print-bills-container">
      ${bills.map(b => {
        const waterUnit = b.waterType === 'người' ? 'người' : 'khối';
        const roomObj = STATE.rooms.find(r => r.id === b.roomId)
          || STATE.rooms.find(r => r.name === b.roomName);
        const payment = roomObj
          ? rentInvoicePaymentState(roomObj.id, period, b.total, b.paid)
          : null;
        let qrImgHtml = '';
        if (roomObj) {
          const qrUrl = genVietQrUrl(roomObj, b, period, payment.totalDueVnd);
          if (qrUrl) {
            qrImgHtml = '<div style="text-align:center; padding:5px; flex-shrink:0;">' +
                        '<img src="' + qrUrl + '" alt="VietQR" style="max-height:130px; width:auto; border:1px solid #ccc; border-radius:4px; display:block" />' +
                        '</div>';
          }
        }

        return `
        <div class="print-bill" style="margin-bottom:20px; border:1px solid #ccc; border-radius:6px; page-break-inside:avoid">
          <div class="print-bill-header" style="background:#f5f5f5; padding:10px; display:flex; justify-content:space-between; font-weight:bold">
            <span class="room">${b.roomName}</span>
            <span class="total">Tổng cần trả: ${fmt(payment?.totalDueVnd ?? b.total)}</span>
          </div>
          <div class="print-bill-body" style="padding:10px; display:flex; gap:15px; align-items:center; justify-content:space-between">
            <table class="print-bill-table" style="flex:1; border-collapse:collapse; font-size:13px">
              ${b.rentPrice > 0 || b.rentStartsAfterPeriod ? `<tr style="border-bottom:1px solid #eee">
                <td style="padding:6px 0">Tiền thuê phòng${b.rentStartsAfterPeriod
                  ? ' (chưa bắt đầu thuê)'
                  : b.rentProrated
                    ? ` (${fmt(b.rentBasePrice)} ÷ ${b.rentDaysInMonth} ngày × ${b.rentDays} ngày)`
                    : ''}</td>
                <td style="text-align:right">${fmt(b.rentPrice)}</td>
              </tr>` : ''}
              ${b.utilityOnly ? `
              <tr style="border-bottom:1px solid #eee">
                <td colspan="2" style="padding:6px 0; color:#b45309; font-style:italic">Chỉ thu điện, nước. Các khoản cố định đã thu trước.</td>
              </tr>
              ` : ''}
              <tr style="border-bottom:1px solid #eee">
                <td style="padding:6px 0">Chỉ số điện (Cũ: ${fmtNum(b.electricOld)} - Mới: ${fmtNum(b.electricNew)})</td>
                <td style="text-align:right">${fmtNum(b.kwh)} kWh</td>
              </tr>
              <tr style="border-bottom:1px solid #eee">
                <td style="padding:6px 0">Tiền điện (${fmtNum(b.kwh)} kWh × ${fmtNum(b.electricRate)}đ)</td>
                <td style="text-align:right">${fmt(b.electricAmt)}</td>
              </tr>
              ${b.waterType === 'khối' && b.waterNew !== null && b.waterPrev !== null ? `
              <tr style="border-bottom:1px solid #eee">
                <td style="padding:6px 0">Chỉ số nước (Cũ: ${fmtNum(b.waterPrev)} - Mới: ${fmtNum(b.waterNew)})</td>
                <td style="text-align:right">${fmtNum(b.waterUnits)} khối</td>
              </tr>
              <tr style="border-bottom:1px solid #eee">
                <td style="padding:6px 0">Tiền nước (${fmtNum(b.waterUnits)} khối × ${fmtNum(b.waterRate)}đ)</td>
                <td style="text-align:right">${fmt(b.waterAmt)}</td>
              </tr>
              ` : `
              <tr style="border-bottom:1px solid #eee">
                <td style="padding:6px 0">Tiền nước (${b.waterUnits} ${waterUnit} × ${fmtNum(b.waterRate)}đ)</td>
                <td style="text-align:right">${fmt(b.waterAmt)}</td>
              </tr>
              `}
              ${b.trashFee > 0 ? `<tr style="border-bottom:1px solid #eee">
                <td style="padding:6px 0">Tiền rác</td>
                <td style="text-align:right">${fmt(b.trashFee)}</td>
              </tr>` : ''}
              ${payment?.priorDebtVnd > 0 ? `
              <tr style="border-bottom:1px solid #eee">
                <td style="padding:6px 0">Nợ cũ chuyển sang</td>
                <td style="text-align:right">${fmt(payment.priorDebtVnd)}</td>
              </tr>` : ''}
              ${b.wifiFee > 0 ? `
              <tr style="border-bottom:1px solid #eee">
                <td style="padding:6px 0">Mạng Wifi</td>
                <td style="text-align:right">${fmt(b.wifiFee)}</td>
              </tr>
              ` : ''}
              ${b.manageFee > 0 ? `
              <tr style="border-bottom:1px solid #eee">
                <td style="padding:6px 0">Phí quản lý & DV khác</td>
                <td style="text-align:right">${fmt(b.manageFee)}</td>
              </tr>
              ` : ''}
              ${b.surchargeAmount > 0 ? `
              <tr style="border-bottom:1px solid #eee">
                <td style="padding:6px 0">Phụ thu</td>
                <td style="text-align:right">${fmt(b.surchargeAmount)}</td>
              </tr>` : ''}
              ${b.lateFeeAmount > 0 ? `
              <tr style="border-bottom:1px solid #eee">
                <td style="padding:6px 0">Phí chậm thanh toán</td>
                <td style="text-align:right">${fmt(b.lateFeeAmount)}</td>
              </tr>` : ''}
              ${b.discountAmount > 0 ? `
              <tr style="border-bottom:1px solid #eee">
                <td style="padding:6px 0">Giảm giá</td>
                <td style="text-align:right">−${fmt(b.discountAmount)}</td>
              </tr>` : ''}
            </table>
            ${qrImgHtml}
          </div>
        </div>
        `;
      }).join('')}
    </div>
    <div class="print-footer" style="text-align:center; font-size:11px; color:#888; margin-top:20px; border-top:1px solid #ccc; padding-top:10px">
      <p>Xuất tự động từ TrọBill lúc ${new Date().toLocaleString('vi-VN')}</p>
    </div>
  `;
}

function printActiveReport() {
  const period = STATE.currentPeriod;
  const billsWithData = STATE.rooms.filter(r => getPeriodRecord(r.id, period));
  if (billsWithData.length === 0) {
    showToast('Chưa có dữ liệu để in báo cáo', 'error');
    return;
  }

  const bills = STATE.rooms.map(room => {
    const rec = getPeriodRecord(room.id, period) || {};
    const bill = calcBill(room, rec, period);
    return {
      roomId: room.id,
      roomName: room.name,
      rentPrice: bill.rentAmt || 0,
      rentBasePrice: bill.rentBasePrice,
      rentDays: bill.rentDays,
      rentDaysInMonth: bill.rentDaysInMonth,
      rentProrated: bill.rentProrated,
      rentStartsAfterPeriod: bill.rentStartsAfterPeriod,
      electricOld: getElectricOld(room, period),
      electricNew: rec.electricNew !== undefined && rec.electricNew !== '' ? Number(rec.electricNew) : (getElectricOld(room, period) || 0),
      electricRate: bill.electricRate,
      kwh: bill.kwh,
      electricAmt: bill.electricAmt,
      waterType: room.waterType || 'người',
      waterRate: bill.waterRate,
      waterUnits: bill.waterUnits,
      waterAmt: bill.waterAmt,
      waterPrev: room.waterType === 'khối' ? getWaterOld(room, period) : null,
      waterNew: room.waterType === 'khối' ? (rec.waterNew !== undefined && rec.waterNew !== '' && rec.waterNew !== null ? Number(rec.waterNew) : (getWaterOld(room, period) || 0)) : null,
      trashFee: bill.trashAmt || 0,
      wifiFee: bill.wifiAmt || 0,
      manageFee: bill.manageAmt || 0,
      discountAmount: bill.discountAmt || 0,
      surchargeAmount: bill.surchargeAmt || 0,
      lateFeeAmount: bill.lateFeeAmt || 0,
      total: bill.total,
      utilityOnly: isUtilityOnlyRecord(rec)
    };
  });

  const printArea = document.getElementById('print-area');
  printArea.innerHTML = generatePrintHTML(period, STATE.settings.deduction ?? 450000, bills);
  triggerPrint(`bao-cao-trobill-${period}.pdf`);
}

function printHistoryReport(record) {
  const printArea = document.getElementById('print-area');
  printArea.innerHTML = generatePrintHTML(record.period, record.deduction ?? 450000, record.bills);
  triggerPrint(`bao-cao-trobill-${record.period}.pdf`);
}

document.getElementById('btn-print').addEventListener('click', printActiveReport);

// ============================================================
//  PERIOD NAVIGATION
// ============================================================
function initPeriod() {
  const now = new Date();
  STATE.currentPeriod = periodKey(now.getFullYear(), now.getMonth() + 1);
}

function shiftPeriod(delta) {
  const { year, month } = parsePeriod(STATE.currentPeriod);
  let m = month + delta, y = year;
  if (m > 12) { m = 1; y++; }
  if (m < 1)  { m = 12; y--; }
  STATE.currentPeriod = periodKey(y, m);
  renderPage(activePage);
}

document.getElementById('prev-month').addEventListener('click', () => shiftPeriod(-1));
document.getElementById('next-month').addEventListener('click', () => shiftPeriod(+1));
document.getElementById('billing-prev-month').addEventListener('click', () => shiftPeriod(-1));
document.getElementById('billing-next-month').addEventListener('click', () => shiftPeriod(+1));
document.getElementById('billing-month-input').addEventListener('change', (e) => {
  const nextPeriod = e.target.value;
  if (!nextPeriod) return;
  STATE.currentPeriod = nextPeriod;
  renderPage(activePage);
});
document.getElementById('report-prev-month').addEventListener('click', () => shiftPeriod(-1));
document.getElementById('report-next-month').addEventListener('click', () => shiftPeriod(+1));
document.getElementById('report-month-input').addEventListener('change', (e) => {
  if (!e.target.value) return;
  STATE.currentPeriod = e.target.value;
  renderPage(activePage);
});
document.getElementById('btn-transfer-period').addEventListener('click', openTransferPeriodModal);
document.getElementById('btn-transfer-expenses').addEventListener('click', openTransferExpensesModal);
document.getElementById('expenses-prev-month').addEventListener('click', () => shiftPeriod(-1));
document.getElementById('expenses-next-month').addEventListener('click', () => shiftPeriod(+1));
document.getElementById('expenses-month-input').addEventListener('change', (e) => {
  if (!e.target.value) return;
  STATE.currentPeriod = e.target.value;
  renderPage(activePage);
});
document.getElementById('expense-category').addEventListener('change', (e) => {
  document.getElementById('expense-name-row').hidden = e.target.value !== 'other';
});
document.getElementById('expense-form-cancel').addEventListener('click', resetExpenseForm);
document.getElementById('expense-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const id = document.getElementById('expense-id').value;
  const category = document.getElementById('expense-category').value;
  const amount = Number(document.getElementById('expense-amount').value);
  const name = document.getElementById('expense-name').value.trim();
  if (!Number.isFinite(amount) || amount < 0) {
    showToast('Vui lòng nhập số tiền hợp lệ', 'error');
    return;
  }
  if (category === 'other' && !name) {
    showToast('Vui lòng nhập tên chi phí khác', 'error');
    return;
  }
  const item = {
    id: id || uuid(),
    category,
    name: category === 'other' ? name : '',
    amount,
    paidDate: document.getElementById('expense-date').value,
    note: document.getElementById('expense-note').value.trim()
  };
  const expenses = getPeriodExpenses();
  const index = expenses.findIndex(expense => expense.id === item.id);
  if (index >= 0) expenses[index] = item;
  else expenses.push(item);
  STATE.expenses[STATE.currentPeriod] = expenses;
  saveState();
  resetExpenseForm();
  renderExpenses();
  renderDashboard();
  showToast(index >= 0 ? 'Đã cập nhật khoản chi ✓' : 'Đã lưu khoản chi ✓', 'success');
});

// ============================================================
//  SETTINGS
// ============================================================
document.getElementById('save-deduction').addEventListener('click', () => {
  const val = parseFloat(document.getElementById('deduction-input').value);
  if (isNaN(val)) { showToast('Số không hợp lệ', 'error'); return; }
  STATE.settings.deduction = val;
  saveState();
  renderDashboard();
  showToast('Đã lưu cài đặt ✓', 'success');
});

const bankSelect = document.getElementById('bank-select');
if (bankSelect) {
  bankSelect.addEventListener('change', (e) => {
    const customInput = document.getElementById('bank-custom-input');
    if (e.target.value === 'custom') {
      customInput.style.display = 'inline-block';
      customInput.value = '';
      customInput.focus();
    } else {
      customInput.style.display = 'none';
    }
  });
}

const saveBankBtn = document.getElementById('save-bank-settings');
if (saveBankBtn) {
  saveBankBtn.addEventListener('click', async event => {
    const bankSelectVal = document.getElementById('bank-select').value;
    const bankCustomVal = document.getElementById('bank-custom-input').value.trim();
    const accountVal = document.getElementById('bank-account-input').value.trim();
    const ownerVal = document.getElementById('bank-owner-input').value.trim();

    let finalBankId = bankSelectVal;
    if (bankSelectVal === 'custom') {
      finalBankId = bankCustomVal.toUpperCase();
    }

    if (!finalBankId && accountVal) {
      showToast('Vui lòng chọn hoặc nhập mã Ngân hàng', 'error');
      return;
    }

    const normalizedBankId = finalBankId.trim().toUpperCase();
    const normalizedAccount = accountVal.replace(/[\s-]/g, '');
    const normalizedOwner = removeVietnameseTones(ownerVal).trim().replace(/\s+/g, ' ').toUpperCase();
    const hasAnyBankValue = Boolean(normalizedBankId || normalizedAccount || normalizedOwner);
    if (hasAnyBankValue && !/^[A-Z0-9]{2,20}$/.test(normalizedBankId)) {
      showToast('Mã ngân hàng phải có từ 2 đến 20 chữ hoặc số.', 'error');
      return;
    }
    if (hasAnyBankValue && !/^[0-9]{4,30}$/.test(normalizedAccount)) {
      showToast('Số tài khoản phải có từ 4 đến 30 chữ số.', 'error');
      return;
    }
    if (hasAnyBankValue && (normalizedOwner.length < 2 || normalizedOwner.length > 100)) {
      showToast('Nhập đầy đủ tên chủ tài khoản nhận tiền.', 'error');
      return;
    }

    const previous = {
      bankId: STATE.settings.bankId,
      bankAccount: STATE.settings.bankAccount,
      bankOwnerName: STATE.settings.bankOwnerName
    };
    STATE.settings.bankId = normalizedBankId;
    STATE.settings.bankAccount = normalizedAccount;
    STATE.settings.bankOwnerName = normalizedOwner;
    const button = event.currentTarget;
    button.disabled = true;
    try {
      saveState();
      await flushState({ throwOnError: true });
    } catch (_) {
      Object.assign(STATE.settings, previous);
      renderDashboard();
      return;
    } finally {
      button.disabled = false;
    }
    showToast('Đã lưu cấu hình tài khoản nhận tiền ✓', 'success');
    renderDashboard();
    renderRentPaymentChannel();
  });
}

const saveReminderBtn = document.getElementById('save-reminder-settings');
if (saveReminderBtn) {
  saveReminderBtn.addEventListener('click', () => {
    const enabled = document.getElementById('reminder-enabled-input').checked;
    const day = parseInt(document.getElementById('reminder-day-select').value);
    const timeVal = document.getElementById('reminder-time-input').value;
    
    if (!timeVal) {
      showToast('Vui lòng chọn thời gian nhắc nhở', 'error');
      return;
    }
    
    STATE.settings.reminderEnabled = enabled;
    STATE.settings.reminderDay = day;
    STATE.settings.reminderTime = timeVal;
    saveState();
    
    if (typeof AndroidApp !== 'undefined' && AndroidApp.scheduleReminder) {
      const [hour, minute] = timeVal.split(':').map(Number);
      AndroidApp.scheduleReminder(day, hour, minute, enabled);
    } else if (enabled) {
      if ('Notification' in window) {
        Notification.requestPermission().then(permission => {
          if (permission !== 'granted') {
            showToast('Lưu cấu hình nhắc nhở ✓ (Cần cấp quyền thông báo)', 'warning');
          } else {
            showToast('Đã lưu cấu hình nhắc nhở ✓', 'success');
          }
        });
        return;
      }
    }
    
    showToast('Đã lưu cấu hình nhắc nhở ✓', 'success');
    renderDashboard();
  });
}

const saveInvoiceReminderBtn = document.getElementById('save-invoice-reminder-settings');
if (saveInvoiceReminderBtn) {
  saveInvoiceReminderBtn.addEventListener('click', async () => {
    const enabled = !!document.getElementById('invoice-reminder-enabled')?.checked;
    const beforeDays = selectedInvoiceReminderDays(
      'invoice-reminder-before',
      INVOICE_REMINDER_BEFORE_OPTIONS
    );
    const afterDays = selectedInvoiceReminderDays(
      'invoice-reminder-after',
      INVOICE_REMINDER_AFTER_OPTIONS
    );
    if (enabled && beforeDays.length + afterDays.length === 0) {
      showToast('Cần chọn ít nhất một mốc nhắc trước hạn hoặc sau hạn', 'error');
      return;
    }
    const previous = {
      enabled: !!STATE.settings.invoiceReminderEnabled,
      beforeDays: [...(STATE.settings.invoiceReminderBeforeDays || [])],
      afterDays: [...(STATE.settings.invoiceReminderAfterDays || [])]
    };
    saveInvoiceReminderBtn.disabled = true;
    try {
      STATE.settings.invoiceReminderEnabled = enabled;
      STATE.settings.invoiceReminderBeforeDays = beforeDays;
      STATE.settings.invoiceReminderAfterDays = afterDays;
      saveState();
      await flushState({ throwOnError: true });
      showToast(enabled ? 'Đã bật nhắc thanh toán tự động ✓' : 'Đã tắt nhắc thanh toán tự động', 'success');
    } catch (_) {
      STATE.settings.invoiceReminderEnabled = previous.enabled;
      STATE.settings.invoiceReminderBeforeDays = previous.beforeDays;
      STATE.settings.invoiceReminderAfterDays = previous.afterDays;
      renderInvoiceReminderSettings();
    } finally {
      saveInvoiceReminderBtn.disabled = false;
    }
  });
}

const logoutAllDevicesBtn = document.getElementById('btn-logout-all');
if (logoutAllDevicesBtn) {
  logoutAllDevicesBtn.addEventListener('click', async () => {
    if (!confirm('Đăng xuất tài khoản khỏi tất cả điện thoại, máy tính và trình duyệt?')) return;
    logoutAllDevicesBtn.disabled = true;
    logoutAllDevicesBtn.textContent = 'Đang đăng xuất...';
    try {
      await flushState();
      await API.logoutAll();
      _sessionGeneration += 1;
      cancelPendingStateSave();
      clearSensitiveStateFromMemory();
      announceSessionChange();
      _appStarted = false;
      showAuthScreen(true);
      showAuthFeedback('Đã đăng xuất khỏi tất cả thiết bị.', 'success');
    } catch (error) {
      showToast(error.message || 'Không thể đăng xuất tất cả thiết bị', 'error', 3000);
      logoutAllDevicesBtn.disabled = false;
      logoutAllDevicesBtn.textContent = 'Đăng xuất tất cả thiết bị';
    }
  });
}

const AUDIT_ACTION_LABELS = {
  policy_accept: 'Đồng ý chính sách',
  tenant_sensitive_create: 'Tạo hồ sơ khách thuê',
  tenant_sensitive_view: 'Xem CCCD đầy đủ',
  admin_tenant_sensitive_view: 'Admin xem CCCD để hỗ trợ',
  tenant_sensitive_update: 'Sửa dữ liệu khách thuê',
  tenant_sensitive_delete: 'Xóa dữ liệu khách thuê',
  account_data_export: 'Xuất dữ liệu tài khoản',
  account_delete: 'Xóa tài khoản'
};
let privacyActionMode = '';

async function loadPrivacyStatus() {
  const statusEl = document.getElementById('privacy-status');
  const acceptButton = document.getElementById('btn-accept-policies');
  if (!statusEl || !API.isLoggedIn()) return;
  try {
    const status = await API.privacy.getStatus();
    statusEl.textContent = status.accepted
      ? `Đã đồng ý chính sách phiên bản ${status.policyVersion}. Backup tối đa ${status.retention.backupDays} ngày; audit ${status.retention.auditDays} ngày.`
      : `Tài khoản cũ chưa xác nhận chính sách phiên bản ${status.policyVersion}.`;
    acceptButton.hidden = status.accepted;
  } catch (error) {
    statusEl.textContent = error.message || 'Không tải được trạng thái quyền riêng tư.';
  }
}

async function loadPrivacyAudit() {
  const container = document.getElementById('privacy-audit-list');
  const button = document.getElementById('btn-load-privacy-audit');
  button.disabled = true;
  try {
    const result = await API.privacy.listAuditLogs(50);
    const logs = result.logs || [];
    container.innerHTML = logs.length
      ? logs.map(log => `
          <div class="privacy-audit-item">
            <span>${escapeHtml(new Date(log.createdAt).toLocaleString('vi-VN'))}</span>
            <span><strong>${escapeHtml(AUDIT_ACTION_LABELS[log.action] || log.action)}</strong>${log.changedFields.length ? ` · ${escapeHtml(log.changedFields.join(', '))}` : ''}${log.purpose ? ` · ${escapeHtml(log.purpose)}` : ''}</span>
          </div>`).join('')
      : '<div class="settings-security-note">Chưa có hoạt động dữ liệu nào được ghi nhận.</div>';
    container.hidden = false;
  } catch (error) {
    showToast(error.message || 'Không tải được nhật ký dữ liệu', 'error');
  } finally {
    button.disabled = false;
  }
}

function closePrivacyActionModal() {
  document.getElementById('privacy-action-modal').hidden = true;
  document.getElementById('privacy-action-form').reset();
  document.getElementById('privacy-action-error').hidden = true;
  privacyActionMode = '';
}

function openPrivacyActionModal(mode) {
  privacyActionMode = mode;
  const deleting = mode === 'delete';
  document.getElementById('privacy-action-title').textContent = deleting
    ? 'Xóa tài khoản và toàn bộ dữ liệu'
    : 'Xuất toàn bộ dữ liệu tài khoản';
  document.getElementById('privacy-action-description').textContent = deleting
    ? 'Thao tác này xóa ngay dữ liệu khỏi database chính và không thể hoàn tác.'
    : 'File JSON chứa cả CCCD đầy đủ. Hãy lưu file ở nơi an toàn và không chia sẻ công khai.';
  const confirmLabel = document.getElementById('privacy-delete-confirm-label');
  const confirmation = document.getElementById('privacy-delete-confirmation');
  confirmLabel.hidden = !deleting;
  confirmation.required = deleting;
  const submit = document.getElementById('privacy-action-submit');
  submit.textContent = deleting ? 'Xóa vĩnh viễn' : 'Xuất dữ liệu';
  submit.className = deleting ? 'btn btn--danger' : 'btn btn--primary';
  document.getElementById('privacy-action-modal').hidden = false;
  setTimeout(() => document.getElementById('privacy-action-password').focus(), 0);
}

function initPrivacyEvents() {
  document.getElementById('btn-export-data').addEventListener('click', () => openPrivacyActionModal('export'));
  document.getElementById('btn-delete-account').addEventListener('click', () => openPrivacyActionModal('delete'));
  document.getElementById('privacy-action-close').addEventListener('click', closePrivacyActionModal);
  document.getElementById('privacy-action-cancel').addEventListener('click', closePrivacyActionModal);
  document.getElementById('btn-load-privacy-audit').addEventListener('click', loadPrivacyAudit);
  document.getElementById('btn-accept-policies').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await API.privacy.acceptPolicies();
      await loadPrivacyStatus();
      await loadPrivacyAudit();
      showToast('Đã ghi nhận đồng ý chính sách hiện tại ✓', 'success');
    } catch (error) {
      showToast(error.message || 'Không lưu được xác nhận chính sách', 'error');
    } finally {
      button.disabled = false;
    }
  });

  document.getElementById('privacy-action-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const password = document.getElementById('privacy-action-password').value;
    const confirmation = document.getElementById('privacy-delete-confirmation').value;
    const errorEl = document.getElementById('privacy-action-error');
    const submit = document.getElementById('privacy-action-submit');
    errorEl.hidden = true;
    submit.disabled = true;
    try {
      if (privacyActionMode === 'export') {
        await flushState({ throwOnError: true });
        exportStateFile(await API.privacy.exportData(password));
        closePrivacyActionModal();
        await loadPrivacyAudit();
      } else if (privacyActionMode === 'delete') {
        await API.privacy.deleteAccount(password, confirmation);
        _sessionGeneration += 1;
        cancelPendingStateSave();
        API.clearSession();
        clearSensitiveStateFromMemory();
        announceSessionChange();
        closePrivacyActionModal();
        _appStarted = false;
        showAuthScreen(true);
        showAuthFeedback('Tài khoản và dữ liệu trong database chính đã được xóa.', 'success');
      }
    } catch (error) {
      errorEl.textContent = error.message || 'Không thực hiện được yêu cầu';
      errorEl.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
}

// ============================================================
//  DONATE — VietQR + Google Play Consumable IAP
// ============================================================
// Thông tin ủng hộ là cấu hình TOÀN CỤC do admin thiết lập (GET /api/config).
// User bình thường chỉ đọc, không lưu.
let DONATE_CONFIG = { donateBankId: '', donateAccount: '', donateOwnerName: '', donateMessage: 'Ung ho' };

// Kiểm tra và hiện block IAP Donate khi chạy trong Android App
(function initDonateIapBlock() {
  if (typeof AndroidApp !== 'undefined') {
    const iapBlock = document.getElementById('donate-iap-block');
    if (iapBlock) iapBlock.style.display = 'flex';
  }
})();

// Tải cấu hình ủng hộ chung từ server
async function loadDonateConfig() {
  try {
    DONATE_CONFIG = await API.getConfig();
  } catch (e) {
    // giữ giá trị mặc định nếu lỗi
  }
  renderDonateInfo();
}

// Cập nhật gợi ý theo tình trạng cấu hình chung
function renderDonateInfo() {
  const hint = document.getElementById('donate-empty-hint');
  const btn = document.getElementById('btn-donate-vietqr');
  const ready = !!(DONATE_CONFIG.donateBankId && DONATE_CONFIG.donateAccount);
  if (hint) hint.hidden = ready;
  if (btn) btn.disabled = !ready;
}

// Nút tạo mã VietQR donate
const btnDonateVietQR = document.getElementById('btn-donate-vietqr');
if (btnDonateVietQR) {
  btnDonateVietQR.addEventListener('click', () => {
    const amount = parseInt(document.getElementById('donate-amount-input').value, 10) || 50000;
    openDonateModal(amount);
  });
}

function openDonateModal(amount) {
  const modal = document.getElementById('donate-modal');
  const qrImg = document.getElementById('donate-qr-img');
  const amountDisplay = document.getElementById('donate-amount-display');
  if (!modal || !qrImg) return;

  const bank  = DONATE_CONFIG.donateBankId || '';
  const acct  = DONATE_CONFIG.donateAccount || '';
  const owner = DONATE_CONFIG.donateOwnerName || '';
  const msg   = DONATE_CONFIG.donateMessage || 'Ung ho';

  if (!bank || !acct) {
    showToast('Quản trị viên chưa thiết lập thông tin ủng hộ.', 'error');
    return;
  }

  const qrUrl = `https://img.vietqr.io/image/${bank}-${acct}-compact2.png` +
    `?amount=${amount}&addInfo=${encodeURIComponent(msg)}&accountName=${encodeURIComponent(owner)}`;

  qrImg.src = qrUrl;
  const bankDisp  = document.getElementById('donate-bank-display');
  const ownerDisp = document.getElementById('donate-owner-display');
  const acctNum   = document.getElementById('donate-account-num');
  const msgDisp   = document.getElementById('donate-message-display');
  if (bankDisp)  bankDisp.textContent  = bank;
  if (ownerDisp) ownerDisp.textContent = owner || '—';
  if (acctNum)   acctNum.textContent   = acct;
  if (msgDisp)   msgDisp.textContent   = msg;
  if (amountDisplay) amountDisplay.textContent = amount.toLocaleString('vi-VN') + ' đ';
  modal.hidden = false;
}

// Đóng Modal Donate
const donateModalClose = document.getElementById('donate-modal-close');
if (donateModalClose) {
  donateModalClose.addEventListener('click', () => {
    document.getElementById('donate-modal').hidden = true;
  });
}
document.getElementById('donate-modal')?.addEventListener('click', (e) => {
  if (e.target === document.getElementById('donate-modal')) {
    document.getElementById('donate-modal').hidden = true;
  }
});

// Nút copy số TK donate
const btnCopyDonateAcct = document.getElementById('btn-copy-donate-account');
if (btnCopyDonateAcct) {
  btnCopyDonateAcct.addEventListener('click', () => {
    navigator.clipboard.writeText(DONATE_CONFIG.donateAccount || '').then(() => showToast('Đã sao chép số tài khoản ✓', 'success'));
  });
}

// Google Play IAP Donate – Consumable tiers
const donateProducts = { '20k': 'donate_20k', '50k': 'donate_50k', '100k': 'donate_100k' };
['20k', '50k', '100k'].forEach(tier => {
  const btn = document.getElementById(`btn-donate-${tier}`);
  if (btn) {
    btn.addEventListener('click', () => {
      if (typeof AndroidApp !== 'undefined' && AndroidApp.buyDonate) {
        AndroidApp.buyDonate(donateProducts[tier]);
      }
    });
  }
});

// Callback khi donate thành công (gọi từ native)
window.onDonationSuccess = function(productId) {
  showToast('💜 Cảm ơn bạn đã ủng hộ TrọBill!', 'success');
};

function checkServerEntitlement(featureName, onApproved, featureCode = 'roomManagement') {
  const feature = SERVER_ENTITLEMENTS.features[featureCode];
  if (feature && feature.enabled) {
    onApproved();
  } else {
    showToast(`Gói hiện tại chưa cho phép ${featureName}.`, 'error', 3000);
  }
}

// ============================================================
//  BACKUP & SYNC SYSTEM
// ============================================================
function exportStateFile(exportedState) {
  const stateStr = JSON.stringify(exportedState, null, 2);
  const filename = `trobill_backup_${new Date().toISOString().slice(0, 10)}.json`;

  // Platform 1: Android native (WebView wrapper with JavascriptInterface)
  if (typeof AndroidApp !== 'undefined' && typeof AndroidApp.saveBackupData === 'function') {
    try {
      AndroidApp.saveBackupData(stateStr, filename);
      showToast('Đã lưu sao lưu vào Downloads ✓', 'success');
      return;
    } catch (e) {
      console.warn('AndroidApp.saveBackupData failed, falling back', e);
    }
  }

  // Platform 2: iOS WKWebView / browsers with Web Share API (supports file sharing)
  if (navigator.canShare && typeof Blob !== 'undefined') {
    try {
      const blob = new Blob([stateStr], { type: 'application/json' });
      const file = new File([blob], filename, { type: 'application/json' });
      if (navigator.canShare({ files: [file] })) {
        navigator.share({ files: [file], title: 'TrọBill Sao lưu' })
          .then(() => showToast('Đã chia sẻ file sao lưu ✓', 'success'))
          .catch(err => {
            console.warn('navigator.share with file failed, falling back', err);
            exportStateBlobFallback(stateStr, filename);
          });
        return;
      }
    } catch (e) {
      console.warn('Web Share API with file failed, falling back', e);
    }
  }

  // Platform 3 & 4: Blob URL → data URI fallback for standard desktop browsers
  exportStateBlobFallback(stateStr, filename);
}

function exportStateBlobFallback(stateStr, filename) {
  // Platform 3: Modern browsers – Blob URL (cleaner, avoids URL length limits)
  if (typeof Blob !== 'undefined' && typeof URL !== 'undefined' && URL.createObjectURL) {
    try {
      const blob = new Blob([stateStr], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      showToast('Đã xuất file sao lưu ✓', 'success');
      return;
    } catch (e) {
      console.warn('Blob URL download failed, falling back to data URI', e);
    }
  }

  // Platform 4: Legacy – data URI anchor (last resort)
  const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(stateStr);
  const a = document.createElement('a');
  a.setAttribute('href', dataStr);
  a.setAttribute('download', filename);
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  showToast('Đã xuất file sao lưu ✓', 'success');
}

document.getElementById('btn-import-trigger').addEventListener('click', () => {
  document.getElementById('import-file-input').click();
});

document.getElementById('import-file-input').addEventListener('change', (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = (event) => {
    try {
      const importedState = JSON.parse(event.target.result);
      if (importedState && importedState.rooms && Array.isArray(importedState.rooms)) {
        const tenantCount = importedState.rooms.reduce(
          (count, room) => count + (Array.isArray(room.tenants) ? room.tenants.length : 0),
          0
        );
        if (tenantCount > 0 && !confirm(
          `File có ${tenantCount} khách thuê. Xác nhận bạn đã thông báo mục đích thu thập dữ liệu cho những khách này trước khi nhập?`
        )) {
          e.target.value = '';
          return;
        }
        importedState.rooms.forEach(room => {
          (room.tenants || []).forEach(tenant => { tenant.dataNoticeAcknowledged = true; });
        });
        loadState(importedState);   // nạp trực tiếp từ object đã import
        saveState();                // đẩy lên Neon
        initTheme();
        renderPage(activePage);
        showToast('Nhập dữ liệu thành công ✓ (đã đồng bộ server)', 'success');
      } else {
        showToast('File sao lưu không hợp lệ', 'error');
      }
    } catch (err) {
      showToast('Không thể đọc file sao lưu', 'error');
    }
  };
  reader.readAsText(file);
});


// ============================================================
//  NAV & ROUTING
// ============================================================
document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.addEventListener('click', () => navigate(tab.dataset.page));
});

document.getElementById('btn-enter-all').addEventListener('click', () => navigate('billing'));
document.getElementById('theme-toggle').addEventListener('click', toggleTheme);

// ============================================================
//  SEED DATA (Default Local Dev & Testing Data from Backup JSON)
//  ⚠️ CRITICAL FOR PROD BUILD (với Ads/APK):
//  Dữ liệu backup JSON này (9 phòng, VCB settings) CHỈ DÙNG CHO LOCAL DEV & TESTING.
//  Khi build bản Production compile APK/AAB (có ads/IAP), bắt buộc phải CLEAN HẾT (để trống hoặc xoá data trong seedFromExcel) trước khi compile!
// ============================================================
function seedFromExcel() {
  // Safeguard: Chặn tự động nạp dữ liệu local test nếu đang chạy bên trong App native Android (Prod)
  if (typeof AndroidApp !== 'undefined' || typeof Android !== 'undefined') return;
  if (STATE.rooms.length > 0) return;
  const backupData = {
    "rooms": [
      {
        "id": "1ea78820-7a83-441d-a183-f290ede10d39",
        "name": "PHÒNG 1",
        "rentPrice": 2500000,
        "electricRate": 3200,
        "waterRate": 50000,
        "waterType": "người",
        "peopleCount": 4,
        "trashFee": 50000,
        "wifiFee": 0,
        "manageFee": 0,
        "electricPrev": 6270,
        "notes": "",
        "tenants": [
          { "id": uuid(), "fullName": "Nguyễn Văn An", "phone": "0901234567", "cccd": "079099001234", "issueDate": "2021-05-10", "dob": "1999-08-15", "gender": "Nam", "address": "Quận 1, TP. Hồ Chí Minh" },
          { "id": uuid(), "fullName": "Trần Thị Mai", "phone": "0909876543", "cccd": "079199005678", "issueDate": "2022-01-20", "dob": "2000-11-02", "gender": "Nữ", "address": "Thủ Đức, TP. Hồ Chí Minh" }
        ]
      },
      {
        "id": "5678a495-7a22-40df-8d82-fd84667c0f74",
        "name": "PHÒNG 2",
        "rentPrice": 2200000,
        "electricRate": 3200,
        "waterRate": 50000,
        "waterType": "người",
        "peopleCount": 2,
        "trashFee": 50000,
        "wifiFee": 40000,
        "manageFee": 0,
        "electricPrev": 12361,
        "notes": "",
        "tenants": [
          { "id": uuid(), "fullName": "Lê Hoàng Long", "phone": "0938112233", "cccd": "048098004321", "issueDate": "2020-10-12", "dob": "1998-03-24", "gender": "Nam", "address": "Hải Châu, Đà Nẵng" }
        ]
      },
      { "id": "1385c840-4896-4391-af5a-7467d9cdf745", "name": "PHÒNG 3", "rentPrice": 2200000, "electricRate": 3400, "waterRate": 50000, "waterType": "người", "peopleCount": 1, "trashFee": 50000, "wifiFee": 40000, "manageFee": 0, "electricPrev": 974, "notes": "", "tenants": [] },
      { "id": "57a22130-f567-403c-9a6c-17635e1b28e6", "name": "PHÒNG 4", "rentPrice": 2200000, "electricRate": 3400, "waterRate": 50000, "waterType": "người", "peopleCount": 2, "trashFee": 50000, "wifiFee": 40000, "manageFee": 0, "electricPrev": 1488, "notes": "", "tenants": [] },
      { "id": "5abce627-e63b-4132-b3a1-8e4f7be464a8", "name": "PHÒNG 5", "rentPrice": 2300000, "electricRate": 3400, "waterRate": 50000, "waterType": "người", "peopleCount": 2, "trashFee": 50000, "wifiFee": 40000, "manageFee": 0, "electricPrev": 6608, "notes": "", "tenants": [] },
      { "id": "9b1de9b8-0865-4297-859e-a88e25ee47db", "name": "PHÒNG 6", "rentPrice": 2200000, "electricRate": 3400, "waterRate": 50000, "waterType": "người", "peopleCount": 1, "trashFee": 50000, "wifiFee": 40000, "manageFee": 0, "electricPrev": 3567, "notes": "", "tenants": [] },
      { "id": "e8a12999-23a3-4456-8c66-af51e2252258", "name": "PHÒNG 7", "rentPrice": 2200000, "electricRate": 3400, "waterRate": 50000, "waterType": "người", "peopleCount": 1, "trashFee": 50000, "wifiFee": 40000, "manageFee": 0, "electricPrev": 5138, "notes": "", "tenants": [] },
      { "id": "4b42abdc-7524-44fb-b078-06fdb220feec", "name": "PHÒNG 8", "rentPrice": 2000000, "electricRate": 3200, "waterRate": 50000, "waterType": "người", "peopleCount": 4, "trashFee": 50000, "wifiFee": 0, "manageFee": 0, "electricPrev": 7726, "notes": "", "tenants": [] },
      { "id": "79843146-2e03-49c6-af8c-066eaae7a785", "name": "PHÒNG 9", "rentPrice": 2000000, "electricRate": 3200, "waterRate": 50000, "waterType": "người", "peopleCount": 3, "trashFee": 50000, "wifiFee": 0, "manageFee": 0, "electricPrev": 9409, "notes": "", "tenants": [] }
    ],
    "billingData": {
      "2026-06": {
        "1ea78820-7a83-441d-a183-f290ede10d39": { "electricNew": "", "waterUnits": 4 },
        "5678a495-7a22-40df-8d82-fd84667c0f74": { "electricNew": "", "waterUnits": 2 }
      },
      "2026-07": {
        "1ea78820-7a83-441d-a183-f290ede10d39": { "electricNew": 6416, "waterUnits": 4, "paid": true },
        "1385c840-4896-4391-af5a-7467d9cdf745": { "electricNew": 1039, "waterUnits": 1, "paid": true },
        "57a22130-f567-403c-9a6c-17635e1b28e6": { "electricNew": 1564, "waterUnits": 2, "paid": true },
        "9b1de9b8-0865-4297-859e-a88e25ee47db": { "electricNew": 3597, "waterUnits": 1, "paid": true },
        "e8a12999-23a3-4456-8c66-af51e2252258": { "electricNew": 5300, "waterUnits": 1, "paid": true },
        "5abce627-e63b-4132-b3a1-8e4f7be464a8": { "electricNew": 6749, "waterUnits": 2, "paid": true },
        "4b42abdc-7524-44fb-b078-06fdb220feec": { "electricNew": 7788, "waterUnits": 4, "paid": true },
        "79843146-2e03-49c6-af8c-066eaae7a785": { "electricNew": 9468, "waterUnits": 3, "paid": true },
        "5678a495-7a22-40df-8d82-fd84667c0f74": { "electricNew": 12566, "waterUnits": 2, "paid": true }
      }
    },
    "settings": {
      "deduction": 450000,
      "bankId": "MB",
      "bankAccount": "999988889999",
      "bankOwnerName": "NGUYEN VAN A",
      "bankTransferPattern": "",
      "reminderEnabled": true,
      "reminderDay": 4,
      "reminderTime": "08:35"
    },
    "history": [
      {
        "period": "2026-07",
        "deduction": 450000,
        "timestamp": 1783745195511,
        "bills": [
          { "roomId": "1ea78820-7a83-441d-a183-f290ede10d39", "roomName": "PHÒNG 1", "rentPrice": 2500000, "electricOld": 6270, "electricNew": 6416, "electricRate": 3200, "kwh": 146, "electricAmt": 467200, "waterType": "người", "waterRate": 50000, "waterUnits": 4, "waterAmt": 200000, "trashFee": 50000, "wifiFee": 0, "manageFee": 0, "total": 3217200, "paid": true },
          { "roomId": "5678a495-7a22-40df-8d82-fd84667c0f74", "roomName": "PHÒNG 2", "rentPrice": 2200000, "electricOld": 12361, "electricNew": 12566, "electricRate": 3200, "kwh": 205, "electricAmt": 656000, "waterType": "người", "waterRate": 50000, "waterUnits": 2, "waterAmt": 100000, "trashFee": 50000, "wifiFee": 40000, "manageFee": 0, "total": 3046000, "paid": true },
          { "roomId": "1385c840-4896-4391-af5a-7467d9cdf745", "roomName": "PHÒNG 3", "rentPrice": 2200000, "electricOld": 974, "electricNew": 1039, "electricRate": 3400, "kwh": 65, "electricAmt": 221000, "waterType": "người", "waterRate": 50000, "waterUnits": 1, "waterAmt": 50000, "trashFee": 50000, "wifiFee": 40000, "manageFee": 0, "total": 2561000, "paid": true },
          { "roomId": "57a22130-f567-403c-9a6c-17635e1b28e6", "roomName": "PHÒNG 4", "rentPrice": 2200000, "electricOld": 1488, "electricNew": 1564, "electricRate": 3400, "kwh": 76, "electricAmt": 258400, "waterType": "người", "waterRate": 50000, "waterUnits": 2, "waterAmt": 100000, "trashFee": 50000, "wifiFee": 40000, "manageFee": 0, "total": 2648400, "paid": true },
          { "roomId": "5abce627-e63b-4132-b3a1-8e4f7be464a8", "roomName": "PHÒNG 5", "rentPrice": 2300000, "electricOld": 6608, "electricNew": 6749, "electricRate": 3400, "kwh": 141, "electricAmt": 479400, "waterType": "người", "waterRate": 50000, "waterUnits": 2, "waterAmt": 100000, "trashFee": 50000, "wifiFee": 40000, "manageFee": 0, "total": 2969400, "paid": true },
          { "roomId": "9b1de9b8-0865-4297-859e-a88e25ee47db", "roomName": "PHÒNG 6", "rentPrice": 2200000, "electricOld": 3567, "electricNew": 3597, "electricRate": 3400, "kwh": 30, "electricAmt": 102000, "waterType": "người", "waterRate": 50000, "waterUnits": 1, "waterAmt": 50000, "trashFee": 50000, "wifiFee": 40000, "manageFee": 0, "total": 2442000, "paid": true },
          { "roomId": "e8a12999-23a3-4456-8c66-af51e2252258", "roomName": "PHÒNG 7", "rentPrice": 2200000, "electricOld": 5138, "electricNew": 5300, "electricRate": 3400, "kwh": 162, "electricAmt": 550800, "waterType": "người", "waterRate": 50000, "waterUnits": 1, "waterAmt": 50000, "trashFee": 50000, "wifiFee": 40000, "manageFee": 0, "total": 2890800, "paid": true },
          { "roomId": "4b42abdc-7524-44fb-b078-06fdb220feec", "roomName": "PHÒNG 8", "rentPrice": 2000000, "electricOld": 7726, "electricNew": 7788, "electricRate": 3200, "kwh": 62, "electricAmt": 198400, "waterType": "người", "waterRate": 50000, "waterUnits": 4, "waterAmt": 200000, "trashFee": 50000, "wifiFee": 0, "manageFee": 0, "total": 2448400, "paid": true },
          { "roomId": "79843146-2e03-49c6-af8c-066eaae7a785", "roomName": "PHÒNG 9", "rentPrice": 2000000, "electricOld": 9409, "electricNew": 9468, "electricRate": 3200, "kwh": 59, "electricAmt": 188800, "waterType": "người", "waterRate": 50000, "waterUnits": 3, "waterAmt": 150000, "trashFee": 50000, "wifiFee": 0, "manageFee": 0, "total": 2388800, "paid": true }
        ]
      }
    ],
    "theme": "dark"
  };

  STATE.rooms = backupData.rooms;
  STATE.billingData = backupData.billingData;
  STATE.settings = { ...STATE.settings, ...backupData.settings };
  STATE.history = backupData.history;
  STATE.theme = backupData.theme || 'system';
  saveState();
  showToast('Đã nạp dữ liệu mặc định từ file backup ✓', 'success', 3500);
}

function seedDemoData() {
  // Deprecated: default data is now fully seeded inside seedFromExcel from backup JSON.
}

// ============================================================
//  TENANTS MANAGEMENT & CCCD QR CODES (CR3 v2.0)
// ============================================================
let activeTenantRoomId = null;
let _cccdScanner = null;

function depositEntryTypeLabel(entryType) {
  const labels = {
    collection: 'Thu tiền cọc',
    deduction: 'Khấu trừ cọc',
    refund: 'Hoàn cọc',
    reversal: 'Hoàn tác giao dịch'
  };
  return labels[entryType] || entryType || 'Giao dịch tiền cọc';
}

function closeTenantDepositModal() {
  const modal = document.getElementById('deposit-modal');
  if (modal) modal.hidden = true;
  ACTIVE_DEPOSIT_TENANT_ID = null;
  ACTIVE_DEPOSIT_RESULT = null;
}

function updateDepositFormState() {
  const typeInput = document.getElementById('deposit-entry-type');
  const amountInput = document.getElementById('deposit-amount');
  const hint = document.getElementById('deposit-form-hint');
  if (!typeInput || !amountInput || !hint) return;
  const type = typeInput.value;
  const balance = Math.max(0, Number(ACTIVE_DEPOSIT_RESULT?.account?.balanceVnd) || 0);
  amountInput.removeAttribute('max');
  if (type === 'collection') {
    hint.textContent = 'Thu cọc sẽ làm tăng số dư của khách.';
    return;
  }
  amountInput.max = String(balance);
  hint.textContent = type === 'deduction'
    ? `Khấu trừ tối đa ${fmt(balance)}. Ghi rõ lý do hư hỏng hoặc chi phí.`
    : `Hoàn tối đa ${fmt(balance)} cho khách.`;
}

function renderTenantDeposit(result) {
  ACTIVE_DEPOSIT_RESULT = result;
  const account = result.account || {};
  const transactions = Array.isArray(result.transactions) ? result.transactions : [];
  const title = document.getElementById('deposit-modal-title');
  const balance = document.getElementById('deposit-balance');
  const context = document.getElementById('deposit-account-context');
  const list = document.getElementById('deposit-ledger-list');
  if (!title || !balance || !context || !list) return;

  title.textContent = `💰 Tiền cọc – ${account.tenantName || 'Khách thuê'}`;
  balance.textContent = fmt(account.balanceVnd || 0);
  context.textContent = `${account.roomName || account.roomId || '—'} · ${account.transactionCount || 0} giao dịch`;

  if (transactions.length === 0) {
    list.innerHTML = '<p class="deposit-ledger-empty">Chưa có giao dịch tiền cọc.</p>';
  } else {
    list.innerHTML = transactions.map((transaction) => {
      const amount = Number(transaction.amountVnd) || 0;
      const canReverse = transaction.entryType !== 'reversal' && !transaction.isReversed;
      return `
        <article class="deposit-ledger-item ${transaction.isReversed ? 'is-reversed' : ''}">
          <div class="deposit-ledger-main">
            <div>
              <strong>${escapeHtml(depositEntryTypeLabel(transaction.entryType))}</strong>
              ${transaction.isReversed ? '<span class="badge badge--empty">Đã hoàn tác</span>' : ''}
            </div>
            <span>${escapeHtml(transaction.code || '')} · ${escapeHtml(rentPaymentMethodLabel(transaction.paymentMethod))}</span>
            <span>${escapeHtml(new Date(transaction.occurredAt).toLocaleString('vi-VN'))}</span>
            ${transaction.note ? `<p>${escapeHtml(transaction.note)}</p>` : ''}
          </div>
          <div class="deposit-ledger-side">
            <strong class="${amount < 0 ? 'is-negative' : 'is-positive'}">${amount > 0 ? '+' : ''}${fmt(amount)}</strong>
            ${canReverse ? `<button type="button" class="btn btn--danger btn--sm" data-reverse-deposit="${transaction.id}">Hoàn tác</button>` : ''}
          </div>
        </article>`;
    }).join('');
  }

  list.querySelectorAll('[data-reverse-deposit]').forEach((button) => {
    button.addEventListener('click', async () => {
      const reason = window.prompt('Nhập lý do hoàn tác (từ 10 đến 500 ký tự):', '');
      if (reason === null) return;
      const normalizedReason = reason.trim();
      if (normalizedReason.length < 10 || normalizedReason.length > 500) {
        showToast('Lý do hoàn tác phải từ 10 đến 500 ký tự', 'error');
        return;
      }
      button.disabled = true;
      try {
        await API.reverseDepositTransaction(button.dataset.reverseDeposit, normalizedReason);
        showToast('Đã tạo bút toán hoàn tác tiền cọc', 'success');
        await openTenantDeposit(ACTIVE_DEPOSIT_TENANT_ID, { preserveForm: true });
      } catch (error) {
        if (error.code === 401) return handleAuthExpired();
        button.disabled = false;
        showToast(error.message || 'Không hoàn tác được giao dịch tiền cọc', 'error', 4000);
      }
    });
  });
  updateDepositFormState();
}

async function openTenantDeposit(tenantId, options = {}) {
  const normalizedTenantId = String(tenantId || '').trim();
  if (!normalizedTenantId) return;
  const modal = document.getElementById('deposit-modal');
  const list = document.getElementById('deposit-ledger-list');
  const form = document.getElementById('deposit-transaction-form');
  const error = document.getElementById('deposit-form-error');
  if (!modal || !list || !form || !error) return;
  ACTIVE_DEPOSIT_TENANT_ID = normalizedTenantId;
  ACTIVE_DEPOSIT_RESULT = null;
  if (!options.preserveForm) form.reset();
  error.hidden = true;
  error.textContent = '';
  list.innerHTML = '<p class="deposit-ledger-empty">Đang tải sổ tiền cọc…</p>';
  modal.hidden = false;
  try {
    const result = await API.getTenantDeposit(normalizedTenantId);
    if (ACTIVE_DEPOSIT_TENANT_ID !== normalizedTenantId) return;
    renderTenantDeposit(result);
  } catch (apiError) {
    if (apiError.code === 401) return handleAuthExpired();
    list.innerHTML = `<p class="deposit-ledger-empty deposit-form-error">${escapeHtml(apiError.message || 'Không tải được sổ tiền cọc')}</p>`;
  }
}

async function submitDepositTransaction(event) {
  event.preventDefault();
  if (!ACTIVE_DEPOSIT_TENANT_ID || !ACTIVE_DEPOSIT_RESULT) return;
  const entryType = document.getElementById('deposit-entry-type').value;
  const amountVnd = Number(document.getElementById('deposit-amount').value);
  const paymentMethod = document.getElementById('deposit-payment-method').value;
  const note = document.getElementById('deposit-note').value.trim();
  const error = document.getElementById('deposit-form-error');
  const submit = document.getElementById('deposit-submit');
  const balance = Math.max(0, Number(ACTIVE_DEPOSIT_RESULT.account?.balanceVnd) || 0);
  error.hidden = true;
  if (!Number.isSafeInteger(amountVnd) || amountVnd <= 0) {
    error.textContent = 'Số tiền phải là số nguyên lớn hơn 0.';
    error.hidden = false;
    return;
  }
  if (entryType !== 'collection' && amountVnd > balance) {
    error.textContent = `Số tiền không được vượt quá số dư ${fmt(balance)}.`;
    error.hidden = false;
    return;
  }
  if (entryType !== 'collection' && note.length < 3) {
    error.textContent = 'Khấu trừ hoặc hoàn cọc phải có ghi chú ít nhất 3 ký tự.';
    error.hidden = false;
    return;
  }
  submit.disabled = true;
  const originalLabel = submit.textContent;
  submit.textContent = 'Đang ghi…';
  try {
    await API.createDepositTransaction({
      tenantId: ACTIVE_DEPOSIT_TENANT_ID,
      entryType,
      amountVnd,
      paymentMethod,
      note,
      idempotencyKey: `deposit:${uuid()}`,
      occurredAt: new Date().toISOString()
    });
    document.getElementById('deposit-amount').value = '';
    document.getElementById('deposit-note').value = '';
    showToast(`Đã ghi ${depositEntryTypeLabel(entryType).toLowerCase()}`, 'success');
    await openTenantDeposit(ACTIVE_DEPOSIT_TENANT_ID, { preserveForm: true });
  } catch (apiError) {
    if (apiError.code === 401) return handleAuthExpired();
    error.textContent = apiError.message || 'Không ghi được giao dịch tiền cọc';
    error.hidden = false;
  } finally {
    submit.disabled = false;
    submit.textContent = originalLabel;
  }
}

// ============================================================
//  ROOM LIFECYCLE MANAGEMENT MODAL
// ============================================================

async function openRoomLifecycleModal(roomId) {
  const room = STATE.rooms.find(r => r.id === roomId);
  if (!room) return;
  ACTIVE_ROOM_LIFECYCLE_ROOM_ID = roomId;
  const modalHtml = `
    <div class="modal-overlay" id="room-lifecycle-mgmt-modal">
      <div class="modal room-lifecycle-mgmt-modal" role="dialog" aria-modal="true" aria-labelledby="room-lifecycle-mgmt-title">
        <div class="modal-header">
          <div>
            <h2 class="modal-title" id="room-lifecycle-mgmt-title">Trạng thái phòng</h2>
            <p class="rental-contract-room">${escapeHtml(room.name)}</p>
          </div>
          <button type="button" class="modal-close" data-room-lifecycle-close aria-label="Đóng">✕</button>
        </div>
        <div class="room-lifecycle-mgmt-body">
          <div class="room-lifecycle-current" id="room-lifecycle-current"></div>
          <div id="room-lifecycle-mgmt-content">
            <p class="rental-contract-empty">Đang tải trạng thái phòng…</p>
          </div>
        </div>
      </div>
    </div>
  `;
  const oldModal = document.getElementById('room-lifecycle-mgmt-modal');
  if (oldModal) oldModal.remove();
  document.body.insertAdjacentHTML('beforeend', modalHtml);
  const modal = document.getElementById('room-lifecycle-mgmt-modal');
  modal.addEventListener('click', event => {
    if (event.target === modal || event.target.closest('[data-room-lifecycle-close]')) {
      closeRoomLifecycleMgmtModal();
      return;
    }
    if (event.target.closest('[data-maintenance-start]')) {
      openStartMaintenanceForm();
      return;
    }
    const completeButton = event.target.closest('[data-maintenance-complete]');
    if (completeButton) openCompleteMaintenanceForm(Number(completeButton.dataset.maintenanceComplete));
  });
  syncModalScrollLock();
  try {
    const result = await API.getRoomMaintenance();
    applyRoomOperationalStatusPayload(result);
    renderRooms();
    renderRoomLifecycleContent();
  } catch (error) {
    if (error.code === 401) return handleAuthExpired();
    document.getElementById('room-lifecycle-mgmt-content').innerHTML =
      `<p class="rental-contract-document-error">${escapeHtml(error.message || 'Không tải được trạng thái phòng')}</p>`;
  }
}

function renderRoomLifecycleContent() {
  const content = document.getElementById('room-lifecycle-mgmt-content');
  const statusElement = document.getElementById('room-lifecycle-current');
  const room = STATE.rooms.find(item => item.id === ACTIVE_ROOM_LIFECYCLE_ROOM_ID);
  if (!content || !statusElement || !room) return;
  const status = getRoomOperationalStatus(room.id);
  const maintenancePeriods = ROOM_MAINTENANCE_PERIODS.filter(item => item.roomId === room.id);
  const activeMaintenance = maintenancePeriods.find(m => m.status === 'active');
  statusElement.className = `room-lifecycle-current room-lifecycle-current--${status.conflict ? 'conflict' : status.status}`;
  statusElement.textContent = `Trạng thái hiện tại: ${status.label}`;
  let html = '';
  if (status.conflict) {
    html += `
      <p class="rental-contract-document-error">
        Phòng đang có nhiều nguồn trạng thái hoạt động cùng lúc. Hãy hoàn thành đợt sửa hoặc xử lý hợp đồng/giữ chỗ trước khi tiếp tục.
      </p>`;
  } else if (status.status === 'maintenance' && activeMaintenance) {
    html += `
      <section class="room-lifecycle-section">
        <h3>Đợt sửa chữa đang hoạt động</h3>
        <div class="room-maintenance-active">
          <div><strong>Mã:</strong> ${escapeHtml(activeMaintenance.code)}</div>
          <div><strong>Bắt đầu:</strong> ${escapeHtml(dateLabel(activeMaintenance.startsOn) || activeMaintenance.startsOn)}</div>
          ${activeMaintenance.expectedEndsOn ? `<div><strong>Dự kiến hoàn thành:</strong> ${escapeHtml(dateLabel(activeMaintenance.expectedEndsOn) || activeMaintenance.expectedEndsOn)}</div>` : ''}
          <div><strong>Lý do:</strong> ${escapeHtml(activeMaintenance.reason)}</div>
        </div>
        <button type="button" class="btn btn--primary" data-maintenance-complete="${Number(activeMaintenance.id)}">
          ✓ Hoàn thành sửa chữa
        </button>
      </section>
    `;
  } else if (status.status === 'vacant') {
    html += `
      <section class="room-lifecycle-section">
        <p>Phòng đang trống. Bạn có thể:</p>
        <button type="button" class="btn btn--primary" data-maintenance-start>
          🔧 Bắt đầu sửa chữa
        </button>
      </section>
    `;
  } else {
    html += `
      <section class="room-lifecycle-section">
        <p class="rental-contract-helper">Phòng đang ${escapeHtml(status.label.toLowerCase())}. Chỉ phòng trống mới có thể bắt đầu sửa chữa.</p>
      </section>
    `;
  }
  if (maintenancePeriods.length > 0) {
    html += `
      <section class="room-lifecycle-section room-lifecycle-history">
        <h3>Lịch sử sửa chữa</h3>
    `;
    for (const m of [...maintenancePeriods].sort((a, b) => b.id - a.id).slice(0, 5)) {
      html += `
        <article class="room-maintenance-history-card">
          <div class="room-maintenance-history-head">
            <strong>${escapeHtml(m.code)}</strong>
            <span>${m.status === 'active' ? '● Đang sửa' : '● Đã hoàn thành'}</span>
          </div>
          <div class="rental-contract-helper">
            ${escapeHtml(dateLabel(m.startsOn) || m.startsOn)} ${m.endedOn ? `→ ${escapeHtml(dateLabel(m.endedOn) || m.endedOn)}` : ''}
          </div>
          <div class="rental-contract-helper">${escapeHtml(m.reason.length > 100 ? `${m.reason.slice(0, 100)}…` : m.reason)}</div>
        </article>
      `;
    }
    html += '</section>';
  }
  content.innerHTML = html;
}

function openStartMaintenanceForm() {
  const content = document.getElementById('room-lifecycle-mgmt-content');
  const roomId = ACTIVE_ROOM_LIFECYCLE_ROOM_ID;
  if (!content || !roomId) return;
  content.innerHTML = `
    <form class="room-maintenance-form" id="start-maintenance-form">
      <label class="form-label">Ngày bắt đầu sửa *
        <input class="form-input" type="date" id="maintenance-start-date" required value="${vietnamCalendarDate()}">
      </label>
      <label class="form-label">Ngày dự kiến hoàn thành
        <input class="form-input" type="date" id="maintenance-expected-end-date">
      </label>
      <label class="form-label room-maintenance-wide">Lý do sửa chữa * (10–500 ký tự)
        <textarea class="form-input" id="maintenance-reason" required minlength="10" maxlength="500" rows="4" placeholder="Ví dụ: sửa điện nước, sơn tường, thay nội thất…"></textarea>
      </label>
      <p class="rental-contract-document-error room-maintenance-wide" id="maintenance-error" hidden></p>
      <div class="rental-contract-document-actions room-maintenance-wide">
        <button type="button" class="btn btn--ghost" data-room-lifecycle-close>Hủy</button>
        <button type="submit" class="btn btn--primary">Bắt đầu sửa chữa</button>
      </div>
    </form>
  `;
  document.getElementById('start-maintenance-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('maintenance-error');
    const submit = e.currentTarget.querySelector('[type="submit"]');
    errorEl.hidden = true;
    submit.disabled = true;
    try {
      const input = {
        roomId,
        startsOn: document.getElementById('maintenance-start-date').value,
        expectedEndsOn: document.getElementById('maintenance-expected-end-date').value || null,
        reason: document.getElementById('maintenance-reason').value.trim()
      };
      await API.createRoomMaintenance(input);
      await refreshRoomOperationalStatuses();
      showToast('Đã bắt đầu sửa chữa phòng', 'success');
      closeRoomLifecycleMgmtModal();
    } catch (error) {
      if (error.code === 401) return handleAuthExpired();
      errorEl.textContent = error.message || 'Có lỗi xảy ra';
      errorEl.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
}

function openCompleteMaintenanceForm(maintenanceId) {
  const content = document.getElementById('room-lifecycle-mgmt-content');
  if (!content || !Number.isSafeInteger(maintenanceId)) return;
  content.innerHTML = `
    <form class="room-maintenance-form" id="complete-maintenance-form">
      <label class="form-label">Ngày hoàn thành *
        <input class="form-input" type="date" id="maintenance-end-date" required value="${vietnamCalendarDate()}">
      </label>
      <label class="form-label room-maintenance-wide">Ghi chú hoàn thành * (10–500 ký tự)
        <textarea class="form-input" id="maintenance-completion-note" required minlength="10" maxlength="500" rows="4" placeholder="Mô tả công việc đã hoàn thành và tình trạng phòng…"></textarea>
      </label>
      <p class="rental-contract-document-error room-maintenance-wide" id="maintenance-error" hidden></p>
      <div class="rental-contract-document-actions room-maintenance-wide">
        <button type="button" class="btn btn--ghost" data-room-lifecycle-close>Hủy</button>
        <button type="submit" class="btn btn--primary">Hoàn thành</button>
      </div>
    </form>
  `;
  document.getElementById('complete-maintenance-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const errorEl = document.getElementById('maintenance-error');
    const submit = e.currentTarget.querySelector('[type="submit"]');
    errorEl.hidden = true;
    submit.disabled = true;
    try {
      const input = {
        endedOn: document.getElementById('maintenance-end-date').value,
        completionNote: document.getElementById('maintenance-completion-note').value.trim()
      };
      await API.completeRoomMaintenance(maintenanceId, input);
      await refreshRoomOperationalStatuses();
      showToast('Đã hoàn thành sửa chữa phòng', 'success');
      closeRoomLifecycleMgmtModal();
    } catch (error) {
      if (error.code === 401) return handleAuthExpired();
      errorEl.textContent = error.message || 'Có lỗi xảy ra';
      errorEl.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
}

async function refreshRoomOperationalStatuses() {
  const result = await API.getRoomMaintenance();
  applyRoomOperationalStatusPayload(result);
  renderRooms();
}

function closeRoomLifecycleMgmtModal() {
  const modal = document.getElementById('room-lifecycle-mgmt-modal');
  if (modal) modal.remove();
  ACTIVE_ROOM_LIFECYCLE_ROOM_ID = '';
  syncModalScrollLock();
}

function openTenantsModal(roomId) {
  checkServerEntitlement('quản lý khách trọ và CCCD', () => {
    activeTenantRoomId = roomId;
    const room = STATE.rooms.find(r => r.id === roomId);
    if (!room) return;
    
    document.getElementById('tenants-room-name').textContent = room.name;
    
    // Hide form, show add button
    const formEl = document.getElementById('tenant-form');
    const addBtn = document.getElementById('tenant-add-btn');
    formEl.style.display = 'none';
    addBtn.style.display = 'block';
    formEl.reset();
    document.getElementById('tenant-id').value = '';
    
    renderTenantsList(roomId);
    document.getElementById('tenants-modal').hidden = false;
  });
}

function renderTenantsList(roomId) {
  const room = STATE.rooms.find(r => r.id === roomId);
  if (!room) return;
  
  const container = document.getElementById('tenants-list-container');
  container.innerHTML = '';
  
  const tenants = room.tenants || [];
  if (tenants.length === 0) {
    container.innerHTML = '<div class="empty-state" style="padding: 24px 10px;"><p style="margin:0;">Chưa có khách trọ nào.</p></div>';
    return;
  }
  
  tenants.forEach(t => {
    const item = document.createElement('div');
    item.className = 'tenant-item';
    
    const formatDate = (dateStr) => {
      if (!dateStr) return '—';
      const parts = dateStr.split('-');
      if (parts.length === 3) return `${parts[2]}/${parts[1]}/${parts[0]}`;
      return dateStr;
    };
    
    item.innerHTML = `
      <div class="tenant-info">
        <div class="tenant-name-row" style="display:flex; align-items:center; gap:8px;">
          <span style="font-weight:600; font-size:0.92rem; color:var(--text);">${escapeHtml(t.fullName)}</span>
          <span style="font-size:0.7rem; padding:1px 6px; border-radius:4px; background:var(--bg2); color:var(--text-muted); border:1px solid var(--border); font-weight:500;">
            ${escapeHtml(t.gender || 'Nam')}
          </span>
        </div>
        <div class="tenant-meta" style="font-size:0.78rem; color:var(--text-muted); margin-top:4px; display:flex; flex-direction:column; gap:2px;">
          <div>📞 SĐT: ${escapeHtml(t.phone || '—')}</div>
          <div>✉️ Email: ${escapeHtml(t.email || '—')}</div>
          <div>🪪 CCCD: <span data-tenant-cccd-value="${escapeHtml(t.id)}">${escapeHtml(maskCccdForDisplay(t.cccd))}</span> (${escapeHtml(formatDate(t.issueDate))}) <button type="button" class="link-btn" data-reveal-tenant="${escapeHtml(t.id)}">Xem</button></div>
          <div>🎂 Sinh nhật: ${formatDate(t.dob)}</div>
          <div style="font-size:0.74rem; color:var(--text-muted); margin-top:2px;">📍 Thường trú: ${escapeHtml(t.address || '—')}</div>
        </div>
      </div>
      <div class="tenant-actions" style="display:flex; gap:8px; align-self:flex-start; flex-wrap:wrap; justify-content:flex-end;">
        <button type="button" class="btn btn--ghost btn--sm" style="padding: 4px 8px; font-size: 0.8rem;" data-deposit-tenant="${escapeHtml(t.id)}">💰 Cọc</button>
        <button type="button" class="btn btn--ghost btn--sm" style="padding: 4px 8px; font-size: 0.8rem;" data-edit-tenant="${escapeHtml(t.id)}">✏️</button>
        <button type="button" class="btn btn--danger btn--sm" style="padding: 4px 8px; font-size: 0.8rem; background: var(--red); border-color: var(--red);" data-delete-tenant="${escapeHtml(t.id)}">🗑️</button>
      </div>
    `;

    item.querySelector('[data-reveal-tenant]').addEventListener('click', async (event) => {
      const button = event.currentTarget;
      button.disabled = true;
      try {
        const revealed = await API.privacy.revealTenantCccd(t.id, 'view');
        const value = item.querySelector('[data-tenant-cccd-value]');
        value.textContent = revealed.cccd || '—';
        button.textContent = 'Đã ghi nhật ký';
        setTimeout(() => {
          if (value.isConnected) value.textContent = maskCccdForDisplay(revealed.cccd);
          if (button.isConnected) {
            button.textContent = 'Xem';
            button.disabled = false;
          }
        }, 30000);
      } catch (error) {
        button.disabled = false;
        showToast(error.message || 'Không xem được CCCD', 'error');
      }
    });
    
    item.querySelector('[data-edit-tenant]').addEventListener('click', () => {
      openTenantForm(roomId, t.id);
    });

    item.querySelector('[data-deposit-tenant]').addEventListener('click', () => {
      openTenantDeposit(t.id);
    });
    
    item.querySelector('[data-delete-tenant]').addEventListener('click', () => {
      deleteTenant(roomId, t.id);
    });
    
    container.appendChild(item);
  });
}

function openTenantForm(roomId, tenantId = null) {
  const room = STATE.rooms.find(r => r.id === roomId);
  if (!room) return;
  
  const formEl = document.getElementById('tenant-form');
  const addBtn = document.getElementById('tenant-add-btn');
  const cccdInput = document.getElementById('tenant-cccd');
  const revealButton = document.getElementById('tenant-cccd-reveal-btn');
  const noticeCheckbox = document.getElementById('tenant-data-notice-ack');
  formEl.reset();
  revealButton.disabled = false;
  stopCccdScanner();
  
  if (tenantId) {
    const t = room.tenants.find(x => x.id === tenantId);
    if (!t) return;
    
    document.getElementById('tenant-form-title').textContent = '✏️ Sửa thông tin khách trọ';
    document.getElementById('tenant-id').value = t.id;
    document.getElementById('tenant-fullname').value = t.fullName;
    document.getElementById('tenant-phone').value = t.phone || '';
    document.getElementById('tenant-email').value = t.email || '';
    cccdInput.value = maskCccdForDisplay(t.cccd);
    cccdInput.readOnly = true;
    revealButton.hidden = false;
    revealButton.dataset.tenantId = t.id;
    document.getElementById('tenant-issue-date').value = t.issueDate || '';
    document.getElementById('tenant-dob').value = t.dob || '';
    document.getElementById('tenant-gender').value = t.gender || 'Nam';
    document.getElementById('tenant-address').value = t.address || '';
    noticeCheckbox.checked = !!t.dataNoticeAcknowledged;
  } else {
    document.getElementById('tenant-form-title').textContent = '➕ Thêm khách trọ mới';
    document.getElementById('tenant-id').value = '';
    cccdInput.readOnly = false;
    revealButton.hidden = true;
    delete revealButton.dataset.tenantId;
    noticeCheckbox.checked = false;
  }
  
  addBtn.style.display = 'none';
  formEl.style.display = 'flex';
}

function deleteTenant(roomId, tenantId) {
  const room = STATE.rooms.find(r => r.id === roomId);
  if (!room) return;
  
  const tenant = room.tenants.find(t => t.id === tenantId);
  if (!tenant) return;
  
  showConfirm(
    `Xóa khách trọ “${tenant.fullName}” khỏi phòng?`,
    async () => {
      const previousTenants = room.tenants;
      const previousPeopleCount = room.peopleCount;
      room.tenants = room.tenants.filter(t => t.id !== tenantId);
      
      // Auto sync peopleCount
      room.peopleCount = room.tenants.length;

      try {
        saveState();
        await flushState({ throwOnError: true });
      } catch (_) {
        room.tenants = previousTenants;
        room.peopleCount = previousPeopleCount;
        return;
      }
      renderTenantsList(roomId);
      renderRooms();
      showToast(`Đã xóa khách trọ ${tenant.fullName}`, 'info');
    }
  );
}

function startCccdScanner() {
  const scanModal = document.getElementById('tenant-scan-modal');
  scanModal.hidden = false;
  
  if (typeof Html5Qrcode === 'undefined') {
    showToast('Thư viện quét QR chưa được tải. Thử lại sau.', 'error');
    return;
  }
  
  _cccdScanner = new Html5Qrcode("cccd-qr-reader");
  
  const config = {
    fps: 10,
    qrbox: { width: 250, height: 250 }
  };
  
  _cccdScanner.start(
    { facingMode: "environment" },
    config,
    (qrCodeMessage) => {
      handleCccdQrResult(qrCodeMessage);
      stopCccdScanner();
    },
    (errorMessage) => {
      // Keep searching silently
    }
  ).catch(err => {
    console.error("Camera error:", err);
    showToast("Không mở được camera. Thử chọn ảnh có sẵn.", "error");
    stopCccdScanner();
  });
}

function stopCccdScanner() {
  const scanModal = document.getElementById('tenant-scan-modal');
  scanModal.hidden = true;
  
  if (_cccdScanner) {
    if (_cccdScanner.isScanning) {
      _cccdScanner.stop().then(() => {
        _cccdScanner = null;
      }).catch(err => {
        console.error("Stop error:", err);
        _cccdScanner = null;
      });
    } else {
      _cccdScanner = null;
    }
  }
}

function handleCccdQrResult(qrText) {
  const data = parseCccdQr(qrText);
  if (!data) {
    showToast("Mã QR không đúng định dạng CCCD Việt Nam.", "error");
    return;
  }
  
  document.getElementById('tenant-fullname').value = data.fullName;
  document.getElementById('tenant-cccd').value = data.cccd;
  document.getElementById('tenant-issue-date').value = data.issueDate;
  document.getElementById('tenant-dob').value = data.dob;
  document.getElementById('tenant-gender').value = data.gender;
  document.getElementById('tenant-address').value = data.address;
  
  if (typeof AndroidApp !== 'undefined' && AndroidApp.vibrate) {
    AndroidApp.vibrate(50);
  } else if (navigator.vibrate) {
    navigator.vibrate(50);
  }
  
  showToast("Đã điền thông tin từ CCCD ✓", "success");
}

function parseCccdQr(qrText) {
  if (!qrText) return null;
  const parts = qrText.split('|');
  if (parts.length < 7) return null;
  
  const cccd = parts[0].trim();
  const fullName = parts[2].trim();
  
  // ddMMyyyy -> YYYY-MM-DD
  const dobRaw = parts[3].trim();
  let dob = '';
  if (dobRaw.length === 8) {
    dob = `${dobRaw.substring(4, 8)}-${dobRaw.substring(2, 4)}-${dobRaw.substring(0, 2)}`;
  }
  
  let gender = parts[4].trim();
  if (gender !== 'Nam' && gender !== 'Nữ') {
    gender = 'Khác';
  }
  
  const address = parts[5].trim();
  
  const issueDateRaw = parts[6].trim();
  let issueDate = '';
  if (issueDateRaw.length === 8) {
    issueDate = `${issueDateRaw.substring(4, 8)}-${issueDateRaw.substring(2, 4)}-${issueDateRaw.substring(0, 2)}`;
  }
  
  return { cccd, fullName, dob, gender, address, issueDate };
}

function initTenantsEvents() {
  document.getElementById('deposit-modal-close').addEventListener('click', closeTenantDepositModal);
  document.getElementById('deposit-modal-close-footer').addEventListener('click', closeTenantDepositModal);
  document.getElementById('deposit-entry-type').addEventListener('change', updateDepositFormState);
  document.getElementById('deposit-transaction-form').addEventListener('submit', submitDepositTransaction);

  document.getElementById('tenants-modal-close').addEventListener('click', () => {
    document.getElementById('tenants-modal').hidden = true;
    stopCccdScanner();
  });
  
  document.getElementById('tenant-add-btn').addEventListener('click', () => {
    openTenantForm(activeTenantRoomId);
  });
  
  document.getElementById('tenant-form-cancel').addEventListener('click', () => {
    document.getElementById('tenant-form').style.display = 'none';
    document.getElementById('tenant-add-btn').style.display = 'block';
  });
  
  document.getElementById('tenant-scan-close').addEventListener('click', stopCccdScanner);
  document.getElementById('tenant-scan-cancel-btn').addEventListener('click', stopCccdScanner);
  
  document.getElementById('tenant-scan-btn').addEventListener('click', () => {
    startCccdScanner();
  });

  document.getElementById('tenant-cccd-reveal-btn').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    const tenantId = button.dataset.tenantId;
    if (!tenantId) return;
    button.disabled = true;
    try {
      const revealed = await API.privacy.revealTenantCccd(tenantId, 'edit');
      const input = document.getElementById('tenant-cccd');
      input.value = revealed.cccd || '';
      input.readOnly = false;
      button.hidden = true;
      input.focus();
    } catch (error) {
      button.disabled = false;
      showToast(error.message || 'Không xem được CCCD', 'error');
    }
  });
  
  const tenantUploadBtn = document.getElementById('tenant-upload-btn');
  const tenantQrFile = document.getElementById('tenant-qr-file');
  
  if (tenantUploadBtn && tenantQrFile) {
    tenantUploadBtn.addEventListener('click', () => {
      tenantQrFile.click();
    });
    
    tenantQrFile.addEventListener('change', (e) => {
      if (e.target.files.length === 0) return;
      const file = e.target.files[0];
      
      if (typeof Html5Qrcode === 'undefined') {
        showToast('Thư viện quét QR chưa sẵn sàng.', 'error');
        return;
      }
      
      const reader = new Html5Qrcode("cccd-qr-reader");
      showToast("Đang quét ảnh...", "info");
      
      reader.scanFile(file, true)
        .then(qrCodeMessage => {
          handleCccdQrResult(qrCodeMessage);
        })
        .catch(err => {
          console.error("File scan error:", err);
          showToast("Không tìm thấy mã QR CCCD hợp lệ trong ảnh.", "error");
        });
    });
  }
  
  document.getElementById('tenant-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!activeTenantRoomId) return;
    
    const id = document.getElementById('tenant-id').value;
    const fullName = document.getElementById('tenant-fullname').value.trim();
    const phone = document.getElementById('tenant-phone').value.trim();
    const email = document.getElementById('tenant-email').value.trim().toLowerCase();
    const cccd = document.getElementById('tenant-cccd').value.trim();
    const issueDate = document.getElementById('tenant-issue-date').value;
    const dob = document.getElementById('tenant-dob').value;
    const gender = document.getElementById('tenant-gender').value;
    const address = document.getElementById('tenant-address').value.trim();
    const dataNoticeAcknowledged = document.getElementById('tenant-data-notice-ack').checked;
    
    if (!fullName || !cccd || !dob || !gender || !address || !issueDate) {
      showToast('Vui lòng điền đủ thông tin bắt buộc (*)', 'error');
      return;
    }
    if (!dataNoticeAcknowledged) {
      showToast('Cần xác nhận đã thông báo mục đích thu thập dữ liệu cho khách thuê', 'error');
      return;
    }
    
    const room = STATE.rooms.find(r => r.id === activeTenantRoomId);
    if (!room) return;
    if (!room.tenants) room.tenants = [];
    const previousTenants = room.tenants.map(tenant => ({ ...tenant }));
    const previousPeopleCount = room.peopleCount;
    
    const tenantData = {
      id: id || uuid(),
      fullName,
      phone,
      email,
      cccd,
      issueDate,
      dob,
      gender,
      address,
      dataNoticeAcknowledged: true
    };
    
    const successMessage = id
      ? 'Cập nhật thông tin khách trọ thành công ✓'
      : 'Thêm khách trọ thành công ✓';
    if (id) {
      const idx = room.tenants.findIndex(t => t.id === id);
      if (idx > -1) room.tenants[idx] = tenantData;
    } else {
      room.tenants.push(tenantData);
    }
    
    // Auto sync people count
    room.peopleCount = room.tenants.length;
    
    try {
      saveState();
      await flushState({ throwOnError: true });
    } catch (_) {
      room.tenants = previousTenants;
      room.peopleCount = previousPeopleCount;
      return;
    }
    renderTenantsList(activeTenantRoomId);
    renderRooms(); // Refresh the room-detail count
    showToast(successMessage, 'success');
    
    // Hide form
    document.getElementById('tenant-form').style.display = 'none';
    document.getElementById('tenant-add-btn').style.display = 'block';
  });
}

function seedDemoData() {
  // Demo data is seeded by seedFromExcel()
}

// ============================================================
//  INIT
// ============================================================
function init() {
  // state đã được nạp từ server ở startApp() trước khi gọi init()
  initPeriod();
  initTheme();
  navigate('dashboard');
  if (typeof initOcrModalEvents === 'function') initOcrModalEvents();
  if (typeof initTenantsEvents === 'function') initTenantsEvents();
  if (typeof initPrivacyEvents === 'function') initPrivacyEvents();

  if (typeof AndroidApp !== 'undefined' && AndroidApp.scheduleReminder && STATE.settings.reminderTime) {
    const enabled = !!STATE.settings.reminderEnabled;
    const day = STATE.settings.reminderDay || 30;
    const [hour, minute] = STATE.settings.reminderTime.split(':').map(Number);
    AndroidApp.scheduleReminder(day, hour, minute, enabled);
  }

  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (STATE.theme === 'system') {
      initTheme();
    }
  });

  // Offline/PWA đã bỏ: gỡ mọi service worker cũ để tránh cache khóa file
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(regs => {
      regs.forEach(r => r.unregister());
    }).catch(() => {});
  }

  if (new URLSearchParams(window.location.search).get('test') === 'true') {
    runRegressionTests();
  }
}

function runRegressionTests() {
  console.warn('Regression test cũ (dựa trên localStorage) đã tắt sau khi chuyển sang backend.');
  return;
  // eslint-disable-next-line no-unreachable
  console.log("Starting JSON Import/Export Regression Tests...");

  // Clear any existing localStorage state first to have clean slate
  localStorage.removeItem(STORAGE_KEY);
  
  // 1. Initialize custom settings
  STATE.settings = {
    deduction: 500000,
    bankId: 'MB',
    bankAccount: '1234567890',
    bankOwnerName: 'TEST OWNER',
    bankTransferPattern: '{room} {period}',
    reminderEnabled: true,
    reminderDay: 25,
    reminderTime: '18:30'
  };
  saveState();
  
  // 2. Prepare mock JSON backup file content from an OLD version
  // This backup does NOT have settings, theme, or billingData keys, and lacks new room properties (wifiFee, manageFee, waterPrev)
  const oldBackupJson = JSON.stringify({
    rooms: [
      { id: 'room-old-1', name: 'Old Room 1', rentPrice: 1500000, electricRate: 3500, electricPrev: 120 }
    ]
  });
  
  // 3. Simulate importing this old backup
  localStorage.setItem(STORAGE_KEY, oldBackupJson);
  
  // 4. Trigger the new loadState() and saveState() logic
  loadState();
  saveState();
  
  // 5. Verify the state in memory
  const passedRooms = STATE.rooms.length === 1 && STATE.rooms[0].name === 'Old Room 1';
  // Check that new fields are normalized correctly
  const passedNormalization = STATE.rooms[0].wifiFee === 0 && STATE.rooms[0].manageFee === 0 && STATE.rooms[0].trashFee === 50000 && STATE.rooms[0].waterPrev === 0;
  // Check that pre-existing settings (like bankAccount, reminderEnabled) are preserved/merged correctly
  const passedSettings = STATE.settings.bankAccount === '1234567890' && STATE.settings.reminderEnabled === true && STATE.settings.deduction === 500000;
  
  // 6. Verify that the merged state was written to localStorage
  const rawSaved = localStorage.getItem(STORAGE_KEY);
  let passedPersistence = false;
  if (rawSaved) {
    try {
      const parsedSaved = JSON.parse(rawSaved);
      passedPersistence = parsedSaved.settings && parsedSaved.settings.bankAccount === '1234567890' && parsedSaved.rooms && parsedSaved.rooms[0].wifiFee === 0 && parsedSaved.rooms[0].waterPrev === 0;
    } catch(e) {}
  }
  
  const allPassed = passedRooms && passedNormalization && passedSettings && passedPersistence;
  
  // Create UI overlay to show test result clearly
  const resultDiv = document.createElement('div');
  resultDiv.id = 'test-result-overlay';
  resultDiv.style.position = 'fixed';
  resultDiv.style.top = '0';
  resultDiv.style.left = '0';
  resultDiv.style.width = '100%';
  resultDiv.style.height = '100%';
  resultDiv.style.background = allPassed ? 'rgba(0, 128, 0, 0.9)' : 'rgba(255, 0, 0, 0.9)';
  resultDiv.style.color = '#fff';
  resultDiv.style.display = 'flex';
  resultDiv.style.flexDirection = 'column';
  resultDiv.style.alignItems = 'center';
  resultDiv.style.justifyContent = 'center';
  resultDiv.style.zIndex = '999999';
  resultDiv.style.fontFamily = 'sans-serif';
  
  resultDiv.innerHTML = `
    <h1 style="font-size: 3rem; margin-bottom: 20px;">${allPassed ? '✓ REGRESSION TEST PASSED' : '✗ REGRESSION TEST FAILED'}</h1>
    <div style="font-size: 1.2rem; line-height: 1.8; max-width: 600px; text-align: left;">
      <p><b>Rooms count correct:</b> ${passedRooms ? 'YES' : 'NO'}</p>
      <p><b>WiFi/Manage/Water prev normalized:</b> ${passedNormalization ? 'YES' : 'NO'}</p>
      <p><b>Pre-existing settings merged & preserved:</b> ${passedSettings ? 'YES' : 'NO'}</p>
      <p><b>Correctly saved to localStorage:</b> ${passedPersistence ? 'YES' : 'NO'}</p>
    </div>
  `;
  document.body.appendChild(resultDiv);
}

// ============================================================
//  AUTH GATE + BOOT
// ============================================================
let _appStarted = false;
let _sessionGeneration = 0;
let _sessionReloading = false;
let _sessionCheckPromise = null;
let _authChannel = null;
const AUTH_CHANNEL_NAME = 'trobill_auth_v1';
const AUTH_EVENT_STORAGE_KEY = 'trobill_auth_event_v1';

function announceSessionChange() {
  const event = {
    id: `${Date.now()}-${Math.random().toString(16).slice(2)}`,
    accountContext: API.getAccountContext()
  };
  if (_authChannel) _authChannel.postMessage(event);
  try {
    localStorage.setItem(AUTH_EVENT_STORAGE_KEY, JSON.stringify(event));
  } catch (_) {}
}

function reloadForSessionChange(message = 'Tài khoản đã thay đổi ở một tab khác.') {
  if (_sessionReloading) return;
  _sessionReloading = true;
  _sessionGeneration += 1;
  cancelPendingStateSave();
  API.clearSession();
  clearSensitiveStateFromMemory();
  _appStarted = false;
  showAuthScreen(true);
  showAuthFeedback(`${message} Đang tải lại dữ liệu an toàn...`, 'success');
  setTimeout(() => window.location.reload(), 0);
}

function handleExternalAuthEvent(event) {
  const nextContext = String(event && event.accountContext || '');
  if (nextContext === API.getAccountContext()) return;
  reloadForSessionChange();
}

function initSessionCoordination() {
  API.onSessionMismatch(() => reloadForSessionChange(
    'Phiên của tab không còn thuộc tài khoản đang đăng nhập.'
  ));
  if ('BroadcastChannel' in window) {
    _authChannel = new BroadcastChannel(AUTH_CHANNEL_NAME);
    _authChannel.addEventListener('message', ({ data }) => handleExternalAuthEvent(data));
  }
  window.addEventListener('storage', (event) => {
    if (event.key !== AUTH_EVENT_STORAGE_KEY || !event.newValue) return;
    try {
      handleExternalAuthEvent(JSON.parse(event.newValue));
    } catch (_) {}
  });
  window.addEventListener('focus', () => revalidateCurrentSession());
}

function beginAccountSession(session, { announce = false } = {}) {
  _sessionGeneration += 1;
  cancelPendingStateSave();
  clearSensitiveStateFromMemory();
  API.adoptSession(session);
  if (announce) announceSessionChange();
}

async function revalidateCurrentSession() {
  if (_sessionReloading || _sessionCheckPromise) return _sessionCheckPromise;
  const expectedContext = API.getAccountContext();
  _sessionCheckPromise = API.me()
    .then((session) => {
      if (String(session.accountContext || '') !== expectedContext) {
        reloadForSessionChange();
      }
    })
    .catch((error) => {
      if (error.code === 401 && expectedContext) {
        reloadForSessionChange('Phiên đăng nhập đã kết thúc ở một tab khác.');
      }
    })
    .finally(() => { _sessionCheckPromise = null; });
  return _sessionCheckPromise;
}

function showAuthScreen(show) {
  const el = document.getElementById('auth-screen');
  const nav = document.getElementById('main-nav');
  const bottomNav = document.getElementById('bottom-nav');
  const logoutBtn = document.getElementById('logout-btn');
  if (el) el.hidden = !show;
  // Ẩn/hiện phần app
  document.querySelectorAll('.page').forEach(p => { p.style.visibility = show ? 'hidden' : ''; });
  if (nav) nav.style.visibility = show ? 'hidden' : '';
  if (bottomNav) bottomNav.style.display = show ? 'none' : '';
  if (logoutBtn) logoutBtn.hidden = show;
  const adminBtn = document.getElementById('admin-entry');
  if (adminBtn && show) { adminBtn.hidden = true; adminBtn.classList.remove('show'); }
}

function handleAuthExpired() {
  _sessionGeneration += 1;
  cancelPendingStateSave();
  clearSensitiveStateFromMemory();
  _appStarted = false;
  API.clearSession();
  announceSessionChange();
  if (typeof showToast === 'function') showToast('Phiên đăng nhập đã hết hạn', 'error', 3000);
  showAuthScreen(true);
}

async function startApp() {
  const expectedAccountContext = API.getAccountContext();
  const expectedGeneration = _sessionGeneration;
  if (!expectedAccountContext) {
    const error = new Error('Chưa xác định được tài khoản của phiên');
    error.code = 401;
    throw error;
  }
  // State và entitlement đều do server trả; client chỉ dùng entitlement cho UX.
  const [serverState, entitlement, plansResult, paymentsResult, rentPaymentsResult, channelsResult, bankTransactionsResult, maintenanceResult] = await Promise.all([
    API.getState(),
    API.getSubscription(),
    API.getPlans().catch(() => ({ plans: [] })),
    API.getSubscriptionPayments(30).catch(() => ({ payments: [] })),
    API.getRentPaymentSummaries().catch((error) => {
      console.warn('Không tải được sổ giao dịch tiền trọ:', error.message);
      return { invoices: [] };
    }),
    API.getRentPaymentChannels().catch((error) => {
      console.warn('Không tải được kênh thanh toán:', error.message);
      return { channels: [] };
    }),
    API.getRentBankTransactions('pending', 50).catch((error) => {
      console.warn('Không tải được giao dịch cần đối soát:', error.message);
      return { transactions: [] };
    }),
    API.getRoomMaintenance().catch((error) => {
      console.warn('Không tải được lịch sử bảo trì:', error.message);
      return { maintenancePeriods: [] };
    })
  ]);
  if (expectedGeneration !== _sessionGeneration ||
      expectedAccountContext !== API.getAccountContext()) return;
  applyServerEntitlements(entitlement);
  SERVER_PLANS = Array.isArray(plansResult.plans) ? plansResult.plans : [];
  SERVER_SUBSCRIPTION_PAYMENTS = Array.isArray(paymentsResult.payments)
    ? paymentsResult.payments
    : [];
  loadState(serverState);
  applyRoomOperationalStatusPayload(maintenanceResult);
  setRentInvoiceSummaries(rentPaymentsResult.invoices || []);
  RENT_PAYMENT_CHANNELS = Array.isArray(channelsResult.channels) ? channelsResult.channels : [];
  RENT_BANK_TRANSACTIONS = Array.isArray(bankTransactionsResult.transactions)
    ? bankTransactionsResult.transactions
    : [];
  try {
    await syncRentInvoicesWithLedger();
  } catch (error) {
    console.warn('Không đồng bộ được hóa đơn với ledger:', error.message);
    syncLegacyPaidFlagsFromLedger();
  }
  if (expectedGeneration !== _sessionGeneration ||
      expectedAccountContext !== API.getAccountContext()) return;
  renderSubscriptionSummary();
  renderSubscriptionPlans();
  renderSubscriptionPaymentHistory();
  renderRentPaymentChannel();
  loadDonateConfig();
  loadPrivacyStatus();
  showAuthScreen(false);
  updateAdminEntry();
  if (!_appStarted) {
    init();
    _appStarted = true;
  } else {
    initPeriod();
    initTheme();
    navigate('dashboard');
  }
}

// Hiện nút vào trang quản trị nếu tài khoản là admin
async function updateAdminEntry() {
  const btn = document.getElementById('admin-entry');
  if (!btn) return;
  try {
    const me = await API.me();
    if (me && me.isAdmin) {
      btn.hidden = false;
      btn.classList.add('show');
    } else {
      btn.hidden = true;
      btn.classList.remove('show');
    }
  } catch (_) {
    btn.hidden = true;
  }
}

function showAuthFeedback(message, type = 'error') {
  const feedback = document.getElementById('auth-feedback');
  if (!feedback) return;
  feedback.textContent = message || '';
  feedback.classList.toggle('auth-feedback--success', type === 'success');
  feedback.classList.toggle('auth-feedback--error', type !== 'success');
  feedback.hidden = !message;
}

function showDevelopmentAuthLink(url = '', label = 'Mở liên kết local') {
  const devLink = document.getElementById('auth-dev-verify');
  if (!devLink) return;
  devLink.href = url || '#';
  devLink.textContent = label;
  devLink.hidden = !url;
}

function showVerificationActions(email, verificationUrl = '') {
  const resendBtn = document.getElementById('auth-resend');
  if (resendBtn) {
    resendBtn.dataset.email = email || '';
    resendBtn.hidden = !email;
  }
  showDevelopmentAuthLink(verificationUrl, 'Mở liên kết xác minh local');
}

function clearVerificationActions() {
  showVerificationActions('', '');
}

function clearAuthQueryParam(name) {
  const url = new URL(window.location.href);
  url.searchParams.delete(name);
  const cleanUrl = `${url.pathname}${url.search}${url.hash}`;
  window.history.replaceState({}, document.title, cleanUrl);
}

function initAuthUI() {
  let mode = 'login'; // 'login' | 'register' | 'forgot' | 'reset'
  let resetToken = new URLSearchParams(window.location.search).get('reset') || '';
  const tabs = document.getElementById('auth-tabs');
  const sub = document.getElementById('auth-sub');
  const tabLogin = document.getElementById('auth-tab-login');
  const tabReg = document.getElementById('auth-tab-register');
  const form = document.getElementById('auth-form');
  const emailLabel = document.getElementById('auth-email-label');
  const passwordLabel = document.getElementById('auth-password-label');
  const confirmLabel = document.getElementById('auth-confirm-label');
  const emailEl = document.getElementById('auth-email');
  const passEl = document.getElementById('auth-password');
  const confirmEl = document.getElementById('auth-confirm-password');
  const policyConsent = document.getElementById('auth-policy-consent');
  const policyCheckbox = document.getElementById('auth-policy-checkbox');
  const submitBtn = document.getElementById('auth-submit');
  const resendBtn = document.getElementById('auth-resend');
  const forgotBtn = document.getElementById('auth-forgot');
  const logoutBtn = document.getElementById('logout-btn');

  function submitLabel(currentMode) {
    if (currentMode === 'register') return 'Đăng ký';
    if (currentMode === 'forgot') return 'Gửi liên kết đặt lại';
    if (currentMode === 'reset') return 'Đặt lại mật khẩu';
    return 'Đăng nhập';
  }

  function setMode(m) {
    mode = m;
    tabLogin.classList.toggle('active', m === 'login');
    tabReg.classList.toggle('active', m === 'register');
    tabs.hidden = m === 'forgot' || m === 'reset';
    emailLabel.hidden = m === 'reset';
    passwordLabel.hidden = m === 'forgot';
    confirmLabel.hidden = m !== 'reset';
    policyConsent.hidden = m !== 'register';
    emailEl.required = m !== 'reset';
    passEl.required = m !== 'forgot';
    confirmEl.required = m === 'reset';
    policyCheckbox.required = m === 'register';
    submitBtn.textContent = submitLabel(m);
    passEl.setAttribute('autocomplete', m === 'login' ? 'current-password' : 'new-password');
    forgotBtn.hidden = m === 'register';
    forgotBtn.textContent = m === 'login'
      ? 'Quên mật khẩu?'
      : m === 'reset'
        ? 'Yêu cầu liên kết mới'
        : 'Quay lại đăng nhập';
    sub.textContent = m === 'forgot'
      ? 'Nhận liên kết đặt lại mật khẩu qua email'
      : m === 'reset'
        ? 'Tạo mật khẩu mới cho tài khoản'
        : 'Tính tiền nhà trọ hàng tháng';
    showAuthFeedback('');
    clearVerificationActions();
  }
  tabLogin.addEventListener('click', () => setMode('login'));
  tabReg.addEventListener('click', () => setMode('register'));
  forgotBtn.addEventListener('click', () => {
    if (mode === 'login') return setMode('forgot');
    if (mode === 'reset') {
      resetToken = '';
      clearAuthQueryParam('reset');
      return setMode('forgot');
    }
    return setMode('login');
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    showAuthFeedback('');
    clearVerificationActions();
    const email = emailEl.value.trim();
    const password = passEl.value;
    submitBtn.disabled = true;
    submitBtn.textContent = 'Đang xử lý...';
    try {
      if (mode === 'login') {
        const session = await API.login(email, password);
        beginAccountSession(session, { announce: true });
        await startApp();
      } else if (mode === 'register') {
        const result = await API.register(email, password, {
          acceptPrivacy: policyCheckbox.checked,
          acceptTerms: policyCheckbox.checked
        });
        passEl.value = '';
        showVerificationActions(email, result.verificationUrl || '');
        if (result.verificationUrl) {
          showAuthFeedback(
            'Tài khoản đã được tạo. Môi trường local không gửi email thật; hãy mở liên kết xác minh bên dưới.',
            'success'
          );
        } else if (result.emailSent) {
          showAuthFeedback('Đã gửi email xác minh. Vui lòng kiểm tra cả hộp thư rác.', 'success');
        } else {
          showAuthFeedback(result.warning || 'Chưa gửi được email. Vui lòng bấm gửi lại.');
        }
      } else if (mode === 'forgot') {
        const result = await API.forgotPassword(email);
        showDevelopmentAuthLink(result.resetUrl || '', 'Mở liên kết đặt lại mật khẩu local');
        showAuthFeedback(
          result.resetUrl
            ? 'Đã tạo liên kết đặt lại mật khẩu local. Hãy mở liên kết bên dưới.'
            : result.message,
          'success'
        );
      } else {
        if (password !== confirmEl.value) {
          throw new Error('Mật khẩu nhập lại chưa khớp');
        }
        await API.resetPassword(resetToken, password);
        _sessionGeneration += 1;
        cancelPendingStateSave();
        API.clearSession();
        clearSensitiveStateFromMemory();
        announceSessionChange();
        resetToken = '';
        passEl.value = '';
        confirmEl.value = '';
        clearAuthQueryParam('reset');
        setMode('login');
        showAuthFeedback('Đã đặt lại mật khẩu. Bạn có thể đăng nhập bằng mật khẩu mới.', 'success');
      }
    } catch (err) {
      showAuthFeedback(err.message || 'Có lỗi xảy ra');
      if (err.errorCode === 'EMAIL_NOT_VERIFIED') showVerificationActions(email);
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = submitLabel(mode);
    }
  });

  if (resendBtn) {
    resendBtn.addEventListener('click', async () => {
      const email = resendBtn.dataset.email || emailEl.value.trim();
      if (!email) return;
      resendBtn.disabled = true;
      resendBtn.textContent = 'Đang gửi...';
      try {
        const result = await API.resendVerification(email);
        showVerificationActions(email, result.verificationUrl || '');
        showAuthFeedback(
          result.verificationUrl
            ? 'Đã tạo liên kết xác minh local mới.'
            : 'Nếu tài khoản tồn tại và chưa xác minh, email mới sẽ được gửi.',
          'success'
        );
      } catch (err) {
        showAuthFeedback(err.message || 'Không gửi lại được email xác minh');
      } finally {
        resendBtn.disabled = false;
        resendBtn.textContent = 'Gửi lại email xác minh';
      }
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener('click', async () => {
      await flushState();
      try {
        await API.logout();
        _sessionGeneration += 1;
        cancelPendingStateSave();
        clearSensitiveStateFromMemory();
        announceSessionChange();
        _appStarted = false;
        showAuthScreen(true);
      } catch (err) {
        showToast('Không thể đăng xuất, vui lòng thử lại', 'error', 3000);
      }
    });
  }

  setMode(resetToken ? 'reset' : 'login');
}

async function boot() {
  initSessionCoordination();
  initAuthUI();

  const verificationToken = new URLSearchParams(window.location.search).get('verify');
  if (verificationToken) {
    showAuthScreen(true);
    showAuthFeedback('Đang xác minh địa chỉ email...', 'success');
    try {
      const session = await API.verifyEmail(verificationToken);
      beginAccountSession(session, { announce: true });
      clearAuthQueryParam('verify');
      await startApp();
      showToast('Đã xác minh email thành công ✓', 'success', 3000);
      return;
    } catch (err) {
      if (err.code) clearAuthQueryParam('verify');
      showAuthFeedback(err.message || 'Không xác minh được email');
      showAuthScreen(true);
      return;
    }
  }


  if (new URLSearchParams(window.location.search).get('reset')) {
    showAuthScreen(true);
    return;
  }

  // Cookie HttpOnly không thể được JavaScript đọc. Gọi API để server xác nhận
  // phiên thay vì dựa vào một token lưu ở trình duyệt.
  try {
    beginAccountSession(await API.me());
    await startApp();
    return;
  } catch (err) {
    if (err.code === 401) API.clearSession();
    else console.warn('Không nạp được state:', err.message);
  }
  showAuthScreen(true);
}

boot();
