'use strict';

(function initLandingPage() {
  const planGrid = document.getElementById('plan-grid');
  const pricingNote = document.getElementById('pricing-note');
  const billingSwitch = document.getElementById('billing-switch');
  const year = document.getElementById('current-year');
  const currency = new Intl.NumberFormat('vi-VN');
  const defaultPricingNote = 'Chọn gói phù hợp với số phòng của bạn. Kiểm tra giá và chu kỳ trước khi thanh toán.';
  let plans = [];
  let cycle = 'monthly';

  year.textContent = String(new Date().getFullYear());

  function element(tagName, className, text) {
    const node = document.createElement(tagName);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function planPrice(plan) {
    const value = cycle === 'yearly' ? plan.yearlyPriceVnd : plan.monthlyPriceVnd;
    if (plan.code === 'free' || value === 0) return { amount: '0 đ', suffix: '/ không thời hạn' };
    if (!Number.isSafeInteger(value) || value < 0) return { amount: 'Liên hệ', suffix: '' };
    return {
      amount: `${currency.format(value)} đ`,
      suffix: cycle === 'yearly' ? '/ năm' : '/ tháng'
    };
  }

  function annualSavings(plan) {
    const monthlyPrice = Number(plan.monthlyPriceVnd);
    const yearlyPrice = Number(plan.yearlyPriceVnd);
    if (!Number.isSafeInteger(monthlyPrice) || monthlyPrice <= 0
        || !Number.isSafeInteger(yearlyPrice) || yearlyPrice <= 0) return null;
    const regularAmount = monthlyPrice * 12;
    if (yearlyPrice >= regularAmount) return null;
    const savedAmount = regularAmount - yearlyPrice;
    return {
      regularAmount,
      savedAmount,
      discountPercent: Math.round((savedAmount / regularAmount) * 100),
      monthlyEquivalent: Math.round(yearlyPrice / 12)
    };
  }

  function updateYearlySwitchLabel() {
    const yearlyButton = billingSwitch.querySelector('[data-cycle="yearly"]');
    if (!yearlyButton) return;
    const discounts = plans.map(annualSavings).filter(Boolean);
    const highestDiscount = discounts.length > 0
      ? Math.max(...discounts.map((saving) => saving.discountPercent))
      : 0;
    yearlyButton.textContent = highestDiscount > 0
      ? `Theo năm · giảm đến ${highestDiscount}%`
      : 'Theo năm';
  }

  function roomLimitText(plan) {
    if (!Number.isFinite(plan.roomLimit) || plan.roomLimit <= 0) return 'Số phòng theo thỏa thuận';
    return `Tối đa ${currency.format(plan.roomLimit)} phòng`;
  }

  function staffLimitText(plan) {
    if (!Number.isFinite(plan.staffLimit) || plan.staffLimit <= 0) return 'Dành cho một người quản lý';
    return `Thêm tối đa ${currency.format(plan.staffLimit)} nhân viên`;
  }

  function createPlanCard(plan) {
    const card = element('article', 'plan-card');
    const price = planPrice(plan);
    const saving = cycle === 'yearly' ? annualSavings(plan) : null;
    const priceRow = element('div', 'plan-price', price.amount);
    const suffix = element('small', '', price.suffix);
    priceRow.append(' ', suffix);

    const features = element('ul', 'plan-features');
    [
      roomLimitText(plan),
      staffLimitText(plan),
      plan.trialDays > 0 ? `Dùng thử ${plan.trialDays} ngày` : 'Sử dụng ngay sau khi đăng ký'
    ].forEach((label) => features.append(element('li', '', label)));

    const action = element('a', 'button button--primary', plan.code === 'free' ? 'Bắt đầu miễn phí' : 'Chọn gói này');
    action.href = `/index.html?plan=${encodeURIComponent(plan.code)}&cycle=${cycle}`;
    action.setAttribute('aria-label', `${action.textContent} với gói ${plan.name}`);

    card.append(element('span', 'plan-name', plan.name));
    if (saving) {
      card.classList.add('plan-card--discounted');
      card.append(element('span', 'plan-saving-badge', `Giảm ${saving.discountPercent}%`));
    }
    card.append(priceRow);
    const savingDetails = element('div', 'plan-saving-details');
    if (saving) {
      const regularPrice = element('p', 'plan-regular-price', 'Giá đủ 12 tháng: ');
      regularPrice.append(element('del', '', `${currency.format(saving.regularAmount)} đ`));
      savingDetails.append(
        regularPrice,
        element('strong', 'plan-saving-copy', `Tiết kiệm ${currency.format(saving.savedAmount)} đ / năm`),
        element('small', 'plan-monthly-equivalent', `Tương đương ${currency.format(saving.monthlyEquivalent)} đ / tháng`)
      );
    }
    card.append(savingDetails);
    card.append(
      element('p', 'plan-description', plan.description || 'Gói sử dụng TrọBill'),
      features,
      action
    );
    return card;
  }

  function renderPlans() {
    planGrid.classList.toggle('plan-grid--yearly', cycle === 'yearly');
    planGrid.replaceChildren(...plans.map(createPlanCard));
    pricingNote.textContent = cycle === 'yearly'
      ? 'Thanh toán một lần cho 12 tháng. Mức tiết kiệm được so với trả từng tháng trong cùng thời gian.'
      : defaultPricingNote;
  }

  function renderError() {
    const message = element('div', 'plan-error');
    message.append(
      element('strong', '', 'Chưa tải được bảng giá.'),
      document.createElement('br'),
      document.createTextNode('Vui lòng thử lại sau hoặc mở TrọBill để dùng gói đang khả dụng.')
    );
    planGrid.replaceChildren(message);
    pricingNote.textContent = 'Bạn có thể thử tải lại bảng giá hoặc quay lại sau.';
    const retry = element('button', 'button button--primary', 'Thử lại');
    retry.type = 'button';
    retry.addEventListener('click', () => { retry.disabled = true; loadPlans(); });
    message.append(document.createElement('br'), retry);
  }

  billingSwitch.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-cycle]');
    if (!button) return;
    cycle = button.dataset.cycle;
    billingSwitch.querySelectorAll('button').forEach((item) => {
      const selected = item === button;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-pressed', String(selected));
    });
    renderPlans();
  });

  function loadPlans() {
  return fetch('/api/public/plans', { headers: { Accept: 'application/json' } })
    .then((response) => {
      if (!response.ok) throw new Error('PLAN_REQUEST_FAILED');
      return response.json();
    })
    .then((payload) => {
      plans = Array.isArray(payload.plans)
        ? payload.plans.filter((plan) => plan && plan.isActive === true && plan.isPublic === true)
        : [];
      if (plans.length === 0) throw new Error('NO_PUBLIC_PLANS');
      const hasPaidPlan = plans.some((plan) => plan.monthlyPriceVnd > 0 && plan.yearlyPriceVnd > 0);
      billingSwitch.hidden = !hasPaidPlan;
      updateYearlySwitchLabel();
      renderPlans();
    })
    .catch(renderError);
  }
  loadPlans();
})();
