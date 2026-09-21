const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('tổng quan phân cấp tài chính và trạng thái phòng, thu về một cột trên mobile', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const api = fs.readFileSync(path.join(root, 'api.js'), 'utf8');
  const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');

  assert.match(
    html,
    /class="dashboard-finance"[\s\S]*id="total-amount"[\s\S]*id="total-profit"[\s\S]*id="rooms-entered"/
  );
  assert.match(
    html,
    /class="dashboard-room-section"[\s\S]*id="dashboard-room-title"[\s\S]*id="room-status-list"/
  );
  assert.match(
    html,
    /class="dashboard-trend"[\s\S]*id="dashboard-trend-change"[\s\S]*id="dashboard-trend-average"[\s\S]*id="dashboard-trend-best"[\s\S]*id="dashboard-trend-chart"/
  );
  assert.match(html, /data-dashboard-trend-months="6"[\s\S]*data-dashboard-trend-months="12"/);
  assert.match(html, /id="dashboard-trend-status" aria-live="polite"/);
  assert.match(css, /\.cards-grid\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.card--primary\s*\{[^}]*grid-column:\s*span 2;[^}]*grid-row:\s*span 2/s);
  assert.match(css, /\.dashboard-trend-insights\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(css, /\.dashboard-trend-chart-shell\s*\{[^}]*overflow-x:\s*auto/s);
  assert.match(css, /\.dashboard-trend-expense-line\s*\{/);
  assert.match(app, /function dashboardTrendChartHtml\(/);
  assert.match(app, /function loadDashboardTrend\(/);
  assert.match(app, /DASHBOARD_TREND_MONTH_COUNT = 6/);
  assert.match(app, /<table class="sr-only">[\s\S]*So sánh tài chính theo tháng/);
  assert.match(api, /function getDashboardTrend\(/);
  assert.match(server, /\/api\/dashboard\/trend[\s\S]*requireWorkspace\('overview'\)/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*480px\)[\s\S]*?\.cards-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)[^}]*\}[\s\S]*?\.card--primary\s*\{[^}]*grid-column:\s*auto/
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*480px\)[\s\S]*?\.room-status-item\s*\{[^}]*flex-direction:\s*column/
  );
  assert.match(html, /href="style\.css\?v=160"/);
  assert.match(html, /src="api\.js\?v=118"/);
  assert.match(html, /src="app\.js\?v=157"/);
});
