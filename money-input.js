/* Display VND with thousands separators while app code continues to read raw digits. */
(function (global) {
  'use strict';

  const nativeValue = typeof HTMLInputElement === 'undefined'
    ? null : Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const selector = 'input[data-money-input], input[name="newMonthlyRentVnd"], '
    + 'input.bill-adjustment-input, input#room-asset-price, input.admin-plan-price';

  function digits(value) {
    return String(value ?? '').replace(/\D/g, '').replace(/^0+(?=\d)/, '');
  }

  function format(value) {
    return digits(value).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }

  function caretAfterDigits(value, count) {
    if (!count) return 0;
    let seen = 0;
    for (let index = 0; index < value.length; index++) {
      if (/\d/.test(value[index]) && ++seen === count) return index + 1;
    }
    return value.length;
  }

  function enhance(input) {
    if (!nativeValue || !input?.matches?.(selector) || input.dataset.moneyEnhanced) return;
    const initial = nativeValue.get.call(input);
    input.dataset.moneyInput = 'true';
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.dataset.moneyEnhanced = 'true';
    if (/^\d+$/.test(input.placeholder)) input.placeholder = format(input.placeholder);
    input.defaultValue = format(input.defaultValue);

    function validate() {
      const raw = digits(nativeValue.get.call(input));
      if (!raw) return input.setCustomValidity('');
      const amount = Number(raw);
      const minText = input.getAttribute('min')?.trim();
      const maxText = input.getAttribute('max')?.trim();
      const stepText = input.getAttribute('step')?.trim();
      const minimum = minText ? Number(minText) : null;
      const maximum = maxText ? Number(maxText) : null;
      const step = stepText ? Number(stepText) : null;
      const base = Number.isFinite(minimum) ? minimum : 0;
      const invalid = !Number.isSafeInteger(amount)
        || (minimum !== null && amount < minimum)
        || (maximum !== null && amount > maximum)
        || (step > 0 && (amount - base) % step !== 0);
      input.setCustomValidity(invalid ? 'Nhập số tiền hợp lệ theo giới hạn của ô này.' : '');
    }

    Object.defineProperty(input, 'value', {
      configurable: true,
      get() { return digits(nativeValue.get.call(this)); },
      set(value) {
        nativeValue.set.call(this, format(value));
        validate();
      }
    });
    input.value = initial;

    input.addEventListener('beforeinput', event => {
      if (!['deleteContentBackward', 'deleteContentForward'].includes(event.inputType)
          || input.selectionStart !== input.selectionEnd) return;
      const display = nativeValue.get.call(input);
      const backward = event.inputType === 'deleteContentBackward';
      const separator = backward ? input.selectionStart - 1 : input.selectionStart;
      const digitIndex = backward ? separator - 1 : separator + 1;
      if (display[separator] !== '.' || !/\d/.test(display[digitIndex] || '')) return;
      event.preventDefault();
      const next = display.slice(0, digitIndex) + display.slice(digitIndex + 1);
      const caretDigits = (next.slice(0, digitIndex).match(/\d/g) || []).length;
      nativeValue.set.call(input, format(next));
      const caret = caretAfterDigits(nativeValue.get.call(input), caretDigits);
      input.setSelectionRange(caret, caret);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    input.addEventListener('input', event => {
      if (event.isComposing) return;
      const typed = nativeValue.get.call(input);
      const count = (typed.slice(0, input.selectionStart ?? typed.length).match(/\d/g) || []).length;
      const display = format(typed);
      if (typed !== display) {
        nativeValue.set.call(input, display);
        const caret = caretAfterDigits(display, count);
        input.setSelectionRange(caret, caret);
      }
      validate();
    });
    input.addEventListener('compositionend', () => {
      input.value = nativeValue.get.call(input);
    });
    input.addEventListener('change', validate);
  }

  function install(root = document) {
    if (root.matches?.(selector)) enhance(root);
    root.querySelectorAll?.(selector).forEach(enhance);
  }

  if (typeof document !== 'undefined' && document.body) {
    install();
    new MutationObserver(records => {
      for (const record of records) {
        if (record.type === 'attributes' && record.target.dataset?.moneyEnhanced) {
          record.target.value = record.target.value;
          continue;
        }
        for (const node of record.addedNodes) {
          if (node.nodeType === 1) install(node);
        }
      }
    }).observe(document.body, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: ['min', 'max', 'step']
    });
    document.addEventListener('reset', event => {
      queueMicrotask(() => event.target.querySelectorAll?.('input[data-money-enhanced]').forEach(input => {
        input.value = nativeValue.get.call(input);
      }));
    });
  }

  global.MoneyInput = { digits, format, enhance, install };
  if (typeof module !== 'undefined') module.exports = { digits, format, caretAfterDigits };
})(typeof window === 'undefined' ? globalThis : window);
