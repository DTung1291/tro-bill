const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('tổng quan phân cấp tài chính và trạng thái phòng, thu về một cột trên mobile', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(
    html,
    /class="dashboard-finance"[\s\S]*id="total-amount"[\s\S]*id="total-profit"[\s\S]*id="rooms-entered"/
  );
  assert.match(
    html,
    /class="dashboard-room-section"[\s\S]*id="dashboard-room-title"[\s\S]*id="room-status-list"/
  );
  assert.match(css, /\.cards-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.card--primary\s*\{[^}]*grid-column:\s*span 2;[^}]*grid-row:\s*span 2/s);
  assert.match(
    css,
    /@media\s*\(max-width:\s*480px\)[\s\S]*?\.cards-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*\}[\s\S]*?\.card--primary\s*\{[^}]*grid-column:\s*auto/
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*480px\)[\s\S]*?\.room-status-item\s*\{[^}]*flex-direction:\s*column/
  );
  assert.match(html, /href="style\.css\?v=135"/);
});
