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
    /id="tenant-scan-modal"[\s\S]*class="modal tenant-scan-modal-card"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="tenant-scan-title"[^>]*aria-describedby="tenant-scan-description"[\s\S]*class="tenant-scan-body"/
  );
  assert.match(
    html,
    /class="tenant-scan-steps"[^>]*aria-label="Các bước quét CCCD"[\s\S]*data-scan-step="permission"[\s\S]*data-scan-step="scan"[\s\S]*data-scan-step="review"/
  );
  assert.match(
    html,
    /id="tenant-scan-status"[^>]*role="status"[^>]*aria-live="polite"[\s\S]*id="tenant-scan-retry-btn" hidden/
  );
  assert.match(html, /Camera chỉ đọc mã QR trên thiết bị\. TrọBill không chụp, tải lên hoặc lưu ảnh CCCD\./);
  assert.match(html, /id="tenant-scan-cancel-btn">Nhập thủ công<[\s\S]*id="tenant-scan-upload-btn">🖼️ Chọn ảnh</);
  assert.doesNotMatch(html, /class="modal" style="max-width: 600px;"/);
  assert.doesNotMatch(html, /id="tenants-list-container"[^>]*style=/);
  assert.doesNotMatch(html, /id="tenant-form"[^>]*style=/);
  assert.doesNotMatch(html, /id="cccd-qr-reader"[^>]*style=/);

  assert.match(app, /function setTenantFormOpen\(isOpen\)[\s\S]*body\.classList\.toggle\('is-form-open', isOpen\)/);
  assert.match(app, /function setTenantFormOpen\(isOpen\)[\s\S]*form\.hidden = !isOpen/);
  assert.match(app, /tenants\.length\.toLocaleString\('vi-VN'\)[\s\S]*class="tenant-meta-grid"[\s\S]*class="tenant-actions"/);
  assert.match(app, /escapeHtml\(formatDate\(t\.issueDate\)\)[\s\S]*escapeHtml\(formatDate\(t\.dob\)\)/);
  assert.match(app, /function setCccdScanState\(state, title, message\)[\s\S]*card\.dataset\.scanState = state/);
  assert.match(app, /async function disposeCccdScanner\(scanner\)[\s\S]*if \(scanner\.isScanning\) await scanner\.stop\(\)/);
  assert.match(app, /async function releaseCccdScanner\(\)[\s\S]*await disposeCccdScanner\(scanner\)/);
  assert.match(app, /if \(session !== _cccdScanSession\) \{[\s\S]*await disposeCccdScanner\(scanner\);[\s\S]*return;/);
  assert.match(app, /async function startCccdScanner\(\)[\s\S]*setCccdScanState\('requesting'\)[\s\S]*setCccdScanState\('scanning'\)/);
  assert.match(app, /Không mở được camera[\s\S]*Kiểm tra quyền camera, thử lại hoặc chọn ảnh CCCD có sẵn/);
  assert.match(app, /async function scanCccdFile\(file\)[\s\S]*setCccdScanState\('processing'\)[\s\S]*scanFile\(file, true\)/);
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
  assert.match(
    css,
    /\.modal\.tenant-scan-modal-card\s*\{[^}]*display:\s*flex;[^}]*max-height:\s*calc\(100dvh - 48px\);[^}]*overflow:\s*hidden/s
  );
  assert.match(css, /\.tenant-scan-body\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto/s);
  assert.match(css, /\.tenant-scan-stage\s*\{[^}]*width:\s*min\(100%,\s*340px\);[^}]*aspect-ratio:\s*1/s);
  assert.match(
    css,
    /@media\s*\(max-width:\s*480px\)[\s\S]*?\.tenant-scan-actions\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/
  );
  assert.match(html, /href="style\.css\?v=165"[\s\S]*src="app\.js\?v=162"/);
});
