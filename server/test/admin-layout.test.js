'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('trang Super Admin có phân cấp vận hành và responsive rõ ràng', () => {
  const html = fs.readFileSync(path.join(root, 'admin.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(
    html,
    /<body class="admin-page">[\s\S]*class="admin-header-brand"[\s\S]*class="admin-role-badge">Super Admin/
  );
  assert.match(
    html,
    /class="admin-nav"[\s\S]*href="#admin-revenue-section"[\s\S]*href="#subscription-payment-admin-section"[\s\S]*href="#plans-admin-section"[\s\S]*href="#admin-users-section"[\s\S]*href="#subscription-change-audit-section"/
  );
  assert.match(
    html,
    /class="admin-metric admin-metric--account"[\s\S]*class="admin-metric admin-metric--revenue"[\s\S]*class="admin-metric admin-metric--conversion"/
  );
  assert.equal((html.match(/class="admin-modal-head"/g) || []).length, 1);
  assert.match(html, /href="style\.css\?v=79"[\s\S]*src="api\.js\?v=80"[\s\S]*src="admin\.js\?v=80"/);
  assert.match(css, /\.admin-wrap\s*\{[^}]*max-width:\s*1240px/s);
  assert.match(css, /\.admin-nav\s*\{[^}]*position:\s*sticky[^}]*grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.admin-revenue-grid\s*\{[^}]*grid-template-columns:\s*repeat\(4,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(
    css,
    /@media\s*\(max-width:\s*960px\)[\s\S]*?\.admin-revenue-grid\s*\{[^}]*repeat\(2,[\s\S]*?\.admin-nav\s*\{[^}]*repeat\(3,/
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*480px\)[\s\S]*?\.admin-nav\s*\{[^}]*repeat\(2,[\s\S]*?\.admin-revenue-grid\s*\{[^}]*minmax\(0,\s*1fr\)/
  );
  assert.match(css, /\.admin-modal-card\s*\{[^}]*max-height:\s*calc\(100dvh - 32px\)[^}]*overflow:\s*hidden/s);
  assert.match(css, /\.admin-modal-body\s*\{[^}]*overflow:\s*auto/s);
});
