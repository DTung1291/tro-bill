const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('modal khách trọ tách danh sách, hồ sơ, bảo vệ CCCD và responsive', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(
    html,
    /id="tenants-modal"[\s\S]*class="modal tenants-modal"[\s\S]*class="tenant-directory"[\s\S]*id="tenants-count"[\s\S]*id="tenant-form" hidden/
  );
  assert.match(
    html,
    /class="tenant-identity-tools"[\s\S]*Ảnh chỉ được dùng trên thiết bị[\s\S]*class="tenant-data-notice"/
  );
  assert.match(
    html,
    /id="tenant-scan-modal"[\s\S]*class="modal tenant-scan-modal-card"[\s\S]*class="tenant-scan-body"/
  );
  assert.doesNotMatch(html, /class="modal" style="max-width: 600px;"/);
  assert.doesNotMatch(html, /id="tenants-list-container"[^>]*style=/);
  assert.doesNotMatch(html, /id="tenant-form"[^>]*style=/);
  assert.doesNotMatch(html, /id="cccd-qr-reader"[^>]*style=/);

  assert.match(app, /function setTenantFormOpen\(isOpen\)[\s\S]*body\.classList\.toggle\('is-form-open', isOpen\)/);
  assert.match(app, /function setTenantFormOpen\(isOpen\)[\s\S]*form\.hidden = !isOpen/);
  assert.match(app, /tenants\.length\.toLocaleString\('vi-VN'\)[\s\S]*class="tenant-meta-grid"[\s\S]*class="tenant-actions"/);
  assert.match(app, /escapeHtml\(formatDate\(t\.issueDate\)\)[\s\S]*escapeHtml\(formatDate\(t\.dob\)\)/);
  assert.doesNotMatch(app, /tenant-name-row" style=|tenant-actions" style=/);

  assert.match(
    css,
    /\.modal\.tenants-modal\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*overflow:\s*hidden/s
  );
  assert.match(
    css,
    /\.tenants-modal-body\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto/s
  );
  assert.match(css, /\.tenant-meta-grid\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(
    css,
    /@media\s*\(max-width:\s*480px\)[\s\S]*?\.tenant-meta-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/
  );
  assert.match(html, /href="style\.css\?v=145"[\s\S]*src="app\.js\?v=147"/);
});
