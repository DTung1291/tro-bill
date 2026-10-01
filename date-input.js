/* Date fields display Vietnamese day/month/year while retaining ISO values for app code. */
(function (global) {
  'use strict';

  function validDate(year, month, day) {
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
  }

  function toIso(value, withTime) {
    const text = String(value || '').trim();
    if (!text) return '';
    const match = text.match(withTime
      ? /^(\d{1,2})\/(\d{1,2})\/(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/
      : /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (!match) return null;
    const [, dayText, monthText, yearText, hourText, minuteText, secondText] = match;
    const day = Number(dayText);
    const month = Number(monthText);
    const year = Number(yearText);
    if (!validDate(year, month, day)) return null;
    if (withTime && (Number(hourText) > 23 || Number(minuteText) > 59 || Number(secondText || 0) > 59)) return null;
    const date = `${yearText}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!withTime) return date;
    return `${date}T${String(Number(hourText)).padStart(2, '0')}:${minuteText}${secondText ? `:${secondText}` : ''}`;
  }

  function toDisplay(value, withTime) {
    const text = String(value || '');
    const match = text.match(withTime
      ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
      : /^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match || !validDate(Number(match[1]), Number(match[2]), Number(match[3]))) return text;
    return `${match[3]}/${match[2]}/${match[1]}${withTime ? ` ${match[4]}:${match[5]}${match[6] ? `:${match[6]}` : ''}` : ''}`;
  }

  function formatTypedDate(value, withTime = false, deleting = false) {
    const raw = String(value || '');
    if (!/^[\d/:\s]*$/.test(raw)) return raw;
    // Giữ nguyên phần người dùng đang xóa hoặc ngày 1 chữ số được nhập với '/'.
    if ((deleting && /[/:\s]/.test(raw)) || /^\d\/|^\d{1,2}\/\d\//.test(raw)) return raw;
    const digits = raw.replace(/\D/g, '').slice(0, withTime ? 14 : 8);
    if (!digits) return '';
    let display = digits.slice(0, 2);
    if (digits.length >= 2 && (!deleting || digits.length > 2)) display += '/';
    display += digits.slice(2, 4);
    if (digits.length >= 4 && (!deleting || digits.length > 4)) display += '/';
    display += digits.slice(4, 8);
    if (withTime && digits.length > 8) {
      const time = digits.slice(8);
      display += ` ${time.slice(0, 2)}`;
      if (time.length >= 2 && (!deleting || time.length > 2)) display += ':';
      display += time.slice(2, 4);
      if (time.length > 4) display += `:${time.slice(4, 6)}`;
    }
    return display;
  }

  function caretAfterDigits(text, count) {
    if (!count) return 0;
    let digits = 0;
    for (let index = 0; index < text.length; index++) {
      if (/\d/.test(text[index]) && ++digits === count) {
        let caret = index + 1;
        while (caret < text.length && /[/:\s]/.test(text[caret])) caret++;
        return caret;
      }
    }
    return text.length;
  }

  function enhance(input) {
    if (input.dataset.localizedDateInput || input.dataset.localizedDatePicker) return;
    const withTime = input.type === 'datetime-local';
    if (input.type !== 'date' && !withTime) return;
    const initial = input.value;
    const originalType = input.type;
    const labelText = input.labels?.[0]?.textContent
      || input.closest('.form-row')?.querySelector('.form-label')?.textContent
      || input.parentElement?.querySelector('label')?.textContent;
    const label = !input.hasAttribute('aria-label') && labelText?.replace(/\s+/g, ' ').trim();
    const nativeValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    const wrapper = document.createElement('span');
    wrapper.className = 'localized-date-field';
    input.parentNode.insertBefore(wrapper, input);
    wrapper.appendChild(input);
    input.type = 'text';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.placeholder = withTime ? 'dd/mm/yyyy hh:mm' : 'dd/mm/yyyy';
    if (label) input.setAttribute('aria-label', label);
    input.dataset.localizedDateInput = originalType;
    input.defaultValue = toDisplay(input.defaultValue, withTime);
    nativeValue.set.call(input, toDisplay(initial, withTime));

    const picker = document.createElement('input');
    picker.type = originalType;
    picker.className = 'localized-date-picker';
    picker.dataset.localizedDatePicker = 'true';
    picker.tabIndex = -1;
    picker.setAttribute('aria-hidden', 'true');
    for (const name of ['min', 'max', 'step']) {
      if (input.hasAttribute(name)) picker.setAttribute(name, input.getAttribute(name));
    }
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'localized-date-button';
    button.setAttribute('aria-label', withTime ? 'Mở lịch chọn ngày và giờ' : 'Mở lịch chọn ngày');
    button.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M7 3v4M17 3v4M3 10h18"/></svg>';
    wrapper.appendChild(button);
    wrapper.appendChild(picker);
    let skipFormattingOnce = false;

    function validate() {
      const raw = nativeValue.get.call(input);
      const iso = toIso(raw, withTime);
      const invalid = raw.trim() && (iso === null || (input.min && iso < input.min) || (input.max && iso > input.max));
      input.setCustomValidity(invalid ? (withTime ? 'Nhập ngày giờ theo dd/mm/yyyy hh:mm.' : 'Nhập ngày theo dd/mm/yyyy.') : '');
      if (invalid) input.setAttribute('aria-invalid', 'true');
      else input.removeAttribute('aria-invalid');
      picker.value = iso || '';
      return iso;
    }

    Object.defineProperty(input, 'value', {
      configurable: true,
      get() { return toIso(nativeValue.get.call(this), withTime) || ''; },
      set(value) {
        nativeValue.set.call(this, toDisplay(value, withTime));
        validate();
      }
    });
    input.addEventListener('beforeinput', (event) => {
      if (!['deleteContentBackward', 'deleteContentForward'].includes(event.inputType)
          || input.selectionStart !== input.selectionEnd) return;
      const raw = nativeValue.get.call(input);
      const backward = event.inputType === 'deleteContentBackward';
      const separator = backward ? input.selectionStart - 1 : input.selectionStart;
      const digit = backward ? separator - 1 : separator + 1;
      if (raw[separator] !== '/' || !/\d/.test(raw[digit] || '')) return;
      event.preventDefault();
      // Khi dấu tự thêm đang ở cuối, Backspace xóa cả dấu lẫn số ngay trước nó.
      // Nếu giữ dấu '/' ở đây, lần gõ tiếp sẽ bị hiểu là nhập tháng thay vì sửa ngày.
      const next = backward && separator === raw.length - 1
        ? raw.slice(0, digit)
        : raw.slice(0, digit) + raw.slice(digit + 1);
      nativeValue.set.call(input, next);
      input.setSelectionRange(digit, digit);
      skipFormattingOnce = true;
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    input.addEventListener('input', (event) => {
      if (!event.isComposing && !skipFormattingOnce) {
        const raw = nativeValue.get.call(input);
        const deleting = event.inputType?.startsWith('delete') || false;
        const display = formatTypedDate(raw, withTime, deleting);
        if (display !== raw) {
          const digitsBeforeCaret = (raw.slice(0, input.selectionStart || 0).match(/\d/g) || []).length;
          nativeValue.set.call(input, display);
          const caret = deleting ? Math.min(input.selectionStart || 0, display.length)
            : caretAfterDigits(display, digitsBeforeCaret);
          input.setSelectionRange(caret, caret);
        }
      }
      skipFormattingOnce = false;
      validate();
    });
    input.addEventListener('change', validate);
    input.addEventListener('blur', () => {
      const iso = validate();
      if (iso) nativeValue.set.call(input, toDisplay(iso, withTime));
    });
    button.addEventListener('click', () => {
      picker.value = input.value;
      if (typeof picker.showPicker === 'function') {
        try { picker.showPicker(); return; } catch (_) { /* Fall back to native click. */ }
      }
      picker.click();
    });
    picker.addEventListener('change', () => {
      input.value = picker.value;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      input.focus();
    });
    validate();
  }

  function install(root = document) {
    root.querySelectorAll('input[type="date"], input[type="datetime-local"]').forEach(enhance);
  }

  if (typeof document !== 'undefined') {
    const start = () => {
      install();
      new MutationObserver(records => {
        for (const record of records) {
          for (const node of record.addedNodes) {
            if (node.nodeType !== 1) continue;
            if (node.matches?.('input[type="date"], input[type="datetime-local"]')) enhance(node);
            install(node);
          }
        }
      }).observe(document.body, { childList: true, subtree: true });
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
    else start();
  }

  if (typeof module !== 'undefined') module.exports = { toIso, toDisplay, formatTypedDate };
})(typeof window === 'undefined' ? globalThis : window);
