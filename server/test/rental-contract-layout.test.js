const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('modal hợp đồng có quy trình rõ, giữ header footer và thao tác responsive', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(
    html,
    /id="rental-contract-modal"[\s\S]*class="rental-contract-journey"[\s\S]*Bước 01 · Tùy chọn[\s\S]*Bước 02 · Điều khoản thuê[\s\S]*Bước 03 · Theo dõi/
  );
  assert.match(
    app,
    /class="rental-contract-meta-key rental-contract-meta-current"[\s\S]*Giá hiện hành[\s\S]*class="rental-contract-meta-key rental-contract-meta-next"[\s\S]*Kỳ đến hạn tiếp theo/
  );
  assert.match(
    app,
    /class="rental-contract-action-panel"[\s\S]*class="rental-contract-card-actions"[\s\S]*data-contract-deposit[\s\S]*data-contract-document/
  );
  assert.match(
    css,
    /\.modal\.rental-contract-modal\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*overflow:\s*hidden/s
  );
  assert.match(
    css,
    /\.rental-contract-body\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto/s
  );
  assert.match(
    css,
    /\.rental-contract-meta\s*\{[^}]*grid-template-columns:\s*repeat\(12,\s*minmax\(0,\s*1fr\)\)/s
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*480px\)[\s\S]*?\.rental-contract-journey\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/
  );
  assert.match(html, /href="style\.css\?v=146"[\s\S]*src="app\.js\?v=148"/);
});
