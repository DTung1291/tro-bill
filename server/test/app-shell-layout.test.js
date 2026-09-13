'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('khung ứng dụng phân cấp điều hướng desktop và mobile rõ ràng', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const shellCss = css.slice(css.indexOf('KHUNG ỨNG DỤNG'));

  assert.match(
    html,
    /class="nav-brand"[\s\S]*class="nav-brand-copy"[\s\S]*id="workspace-switcher"[\s\S]*class="nav-utilities"[\s\S]*class="nav-tabs nav-tabs--desktop"/
  );
  assert.match(
    html,
    /id="theme-toggle"[^>]*aria-label="Đổi giao diện sáng hoặc tối"[\s\S]*id="admin-entry"[^>]*aria-label="Mở trang Super Admin"[\s\S]*id="logout-btn"[^>]*aria-label="Đăng xuất"/
  );
  assert.doesNotMatch(html, /class="nav-nav-wrap"|class="nav-inner"[^>]*style=/);
  assert.match(html, /href="style\.css\?v=145"[\s\S]*src="app\.js\?v=147"/);

  assert.match(shellCss, /:root\s*\{[^}]*--app-nav-height:\s*110px/);
  assert.match(
    shellCss,
    /\.nav-inner\s*\{[^}]*grid-template-areas:[^}]*"brand workspace utilities"[^}]*"tabs tabs tabs"[^}]*max-width:\s*1180px/s
  );
  assert.match(
    shellCss,
    /\.nav-tabs--desktop\s*\{[^}]*display:\s*flex\s*!important[\s\S]*?\.nav-tabs--desktop \.nav-tab\s*\{[^}]*flex:\s*1 1 0/s
  );
  assert.match(shellCss, /\.main\s*\{[^}]*max-width:\s*1120px[^}]*var\(--app-nav-height\)/s);
  assert.match(shellCss, /\.workspace-access-banner\s*\{[^}]*top:\s*calc\(var\(--app-nav-height\)/s);

  assert.match(
    shellCss,
    /@media\s*\(max-width:\s*640px\)[\s\S]*?:root\s*\{[^}]*--app-nav-height:\s*62px[\s\S]*?\.bottom-nav\s*\{[^}]*left:\s*8px[^}]*right:\s*8px[^}]*height:\s*66px[^}]*border-radius:\s*17px/s
  );
  assert.match(
    shellCss,
    /@media\s*\(max-width:\s*370px\)[\s\S]*?\.nav-brand-copy\s*\{[^}]*display:\s*none/
  );
});
