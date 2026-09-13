const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('báo cáo tài chính ưu tiên lợi nhuận, tách bộ lọc và thu về một cột trên mobile', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(
    html,
    /class="financial-report"[\s\S]*class="financial-report-kicker"[\s\S]*class="financial-report-control-panel"[\s\S]*class="financial-report-section-head"/
  );
  assert.match(
    html,
    /id="financial-report-grid"[\s\S]*id="financial-report-profit"[\s\S]*id="financial-report-revenue"[\s\S]*id="financial-report-expenses"/
  );
  assert.match(html, /class="financial-report-source"[\s\S]*Dữ liệu máy chủ/);
  assert.match(
    css,
    /\.financial-report-grid\s*\{[^}]*grid-template-columns:\s*repeat\(12,\s*minmax\(0,\s*1fr\)\)/s
  );
  assert.match(
    css,
    /\.financial-metric--profit\s*\{[^}]*grid-column:\s*span 4;[^}]*grid-row:\s*span 2/s
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*480px\)[\s\S]*?\.financial-report-filters,[\s\S]*?\.occupancy-report-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*480px\)[\s\S]*?\.financial-metric--profit,[\s\S]*?\.occupancy-metric--maintenance\s*\{[^}]*grid-column:\s*auto/
  );
  assert.match(html, /href="style\.css\?v=145"/);
});
