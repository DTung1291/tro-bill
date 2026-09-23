'use strict';

// Native top-layer dialogs also work above the app's existing modal stack.
window.UiDialog = (() => {
  let active = false;
  function open(message, { input = false, type = 'text', minLength = 1, maxLength = 500, value = '', title = 'Xác nhận', okText = 'Xác nhận' } = {}) {
    if (active) return Promise.resolve(null);
    active = true;
    return new Promise(resolve => {
      const previousFocus = document.activeElement;
      const api = typeof API === 'undefined' ? null : API;
      const accountContext = api?.getAccountContext();
      const workspaceId = api?.getWorkspaceAccountId();
      const dialog = document.createElement('dialog');
      dialog.className = 'ui-dialog';
      dialog.setAttribute('aria-labelledby', 'ui-dialog-title');
      const form = document.createElement('form');
      const heading = document.createElement('h2');
      heading.id = 'ui-dialog-title';
      heading.textContent = title;
      const label = document.createElement('label');
      const description = document.createElement('span');
      description.textContent = message;
      label.append(description);
      let field;
      if (input) {
        field = document.createElement(type === 'password' ? 'input' : 'textarea');
        if (type === 'password') {
          field.type = 'password';
          field.autocomplete = 'new-password';
        } else field.rows = 3;
        field.value = value;
        field.required = true;
        field.maxLength = maxLength;
        field.setAttribute('aria-describedby', 'ui-dialog-error');
        label.append(field);
      }
      const error = document.createElement('p');
      error.id = 'ui-dialog-error';
      error.setAttribute('role', 'alert');
      const actions = document.createElement('div');
      actions.className = 'ui-dialog-actions';
      const cancel = document.createElement('button');
      cancel.type = 'button';
      cancel.textContent = 'Hủy';
      const submit = document.createElement('button');
      submit.type = 'submit';
      submit.textContent = okText;
      actions.append(cancel, submit);
      form.append(heading, label, error, actions);
      dialog.append(form);
      const finish = result => {
        if (!dialog.isConnected) return;
        dialog.close();
        dialog.remove();
        document.documentElement.classList.remove('ui-dialog-open');
        active = false;
        if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
        resolve(result);
      };
      cancel.addEventListener('click', () => finish(null));
      dialog.addEventListener('cancel', event => { event.preventDefault(); finish(null); });
      form.addEventListener('submit', event => {
        event.preventDefault();
        if (accountContext !== api?.getAccountContext() || workspaceId !== api?.getWorkspaceAccountId()) {
          finish(null);
          return;
        }
        const result = input ? (type === 'password' ? field.value : field.value.trim()) : true;
        if (input && (result.length < minLength || result.length > maxLength)) {
          error.textContent = `Vui lòng nhập từ ${minLength} đến ${maxLength} ký tự.`;
          field.setAttribute('aria-invalid', 'true');
          field.focus();
          return;
        }
        submit.disabled = true;
        finish(result);
      });
      document.body.append(dialog);
      document.documentElement.classList.add('ui-dialog-open');
      dialog.showModal();
      (field || cancel).focus();
    });
  }
  return {
    prompt: (message, options = {}) => open(message, { ...options, input: true, title: options.title || 'Bổ sung thông tin' }),
    confirm: message => open(message),
    alert: message => open(message, { title: 'Thông báo', okText: 'Đã hiểu' })
  };
})();
