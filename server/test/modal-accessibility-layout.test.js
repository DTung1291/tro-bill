const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('popup ghi nhận thu tiền ưu tiên công nợ, tách phần nhập và giữ footer trong viewport', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(
    html,
    /class="modal rent-payment-entry-modal" role="dialog" aria-modal="true" aria-labelledby="rent-payment-entry-title" aria-describedby="rent-payment-entry-context"/
  );
  assert.match(
    html,
    /id="rent-payment-entry-overview-title">Kiểm tra số tiền cần thu[\s\S]*id="rent-payment-entry-details-title">Nhập thông tin giao dịch/
  );
  assert.match(html, /class="rent-payment-entry-body"[\s\S]*class="modal-actions rent-payment-entry-actions"/);
  assert.match(html, /id="rent-payment-entry-error" role="alert" tabindex="-1" hidden/);
  assert.match(
    app,
    /rent-payment-entry-balance[\s\S]*Tổng còn phải thu lúc này[\s\S]*Hóa đơn kỳ này[\s\S]*Đã thu kỳ này[\s\S]*Nợ cũ chuyển sang/
  );
  assert.match(app, /Đang ghi nhận…[\s\S]*setAttribute\('aria-busy', 'true'\)/);
  assert.match(
    css,
    /\.modal\.rent-payment-entry-modal\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*overflow:\s*hidden;/s
  );
  assert.match(
    css,
    /\.rent-payment-entry-body\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto;[^}]*overscroll-behavior:\s*contain;/s
  );
  assert.match(css, /\.rent-payment-entry-actions\s*\{[^}]*flex:\s*0 0 auto;[^}]*border-top:/s);
  assert.match(
    css,
    /@media\s*\(max-width:\s*480px\)[\s\S]*\.rent-payment-entry-form \.rent-payment-summary-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/
  );
});

test('popup ứng dụng dùng semantics, Escape, focus trap và trả focus về điểm mở', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

  assert.match(
    html,
    /class="modal modal--confirm" role="alertdialog" aria-modal="true" aria-labelledby="confirm-modal-title" aria-describedby="confirm-modal-body"/
  );
  assert.doesNotMatch(html, /id="confirm-modal-ok"[^>]*style=/);
  assert.match(app, /function prepareModalAccessibility\(overlay\)/);
  assert.match(app, /dialog\.setAttribute\('aria-modal', 'true'\)/);
  assert.match(app, /function topOpenModalOverlay\(\)/);
  assert.match(app, /if \(event\.key === 'Escape'/);
  assert.match(app, /if \(event\.key !== 'Tab'\) return/);
  assert.match(app, /function restoreFocusAfterModal\(overlay\)/);
  assert.match(app, /modalObserver\.observe\(document\.body,[\s\S]*childList:\s*true[\s\S]*subtree:\s*true/);
});

test('popup Super Admin có cùng semantics và điều khiển bàn phím', () => {
  const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  const admin = fs.readFileSync(path.join(root, 'admin.js'), 'utf8');

  assert.match(
    html,
    /id="admin-modal" class="admin-modal" role="dialog" aria-modal="true" aria-labelledby="admin-modal-title"/
  );
  assert.match(html, /class="admin-modal-card" tabindex="-1"/);
  assert.match(admin, /function adminModalFocusableElements\(\)/);
  assert.match(admin, /if \(event\.key === 'Escape'\)/);
  assert.match(admin, /if \(event\.key !== 'Tab'\) return/);
  assert.match(html, /src="admin\.js\?v=83"/);
});
