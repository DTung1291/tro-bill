const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('cổng sửa chữa phía chủ trọ tách tổng quan, cổng khách và hàng đợi xử lý', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

  assert.match(
    html,
    /id="tenant-maintenance-modal"[\s\S]*id="tenant-maintenance-open-count"[\s\S]*id="tenant-maintenance-unassigned-count"[\s\S]*id="tenant-maintenance-urgent-count"[\s\S]*id="tenant-maintenance-expense-total"/
  );
  assert.match(
    html,
    /id="tenant-maintenance-link-title">Cổng khách thuê[\s\S]*id="tenant-maintenance-request-title">Hàng đợi sửa chữa/
  );
  assert.match(
    html,
    /data-maintenance-filter="all"[\s\S]*data-maintenance-filter="attention"[\s\S]*data-maintenance-filter="in_progress"[\s\S]*data-maintenance-filter="closed"/
  );
  assert.match(app, /function renderTenantMaintenanceOverview\(\)[\s\S]*openRequests[\s\S]*expenseTotal/);
  assert.match(app, /function tenantMaintenanceRequestMatchesFilter\(request\)/);
  assert.match(app, /function tenantMaintenanceStatusPath\(status\)/);
  assert.match(app, /data-maintenance-filter[\s\S]*renderTenantMaintenanceRequests\(\)/);
});

test('modal chủ trọ cuộn nội dung, thu gọn an toàn và giữ nguyên các thao tác nghiệp vụ', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

  assert.match(
    css,
    /\.modal\.tenant-maintenance-modal\s*\{[^}]*display:\s*flex;[^}]*max-width:\s*1120px;[^}]*flex-direction:\s*column;[^}]*overflow:\s*hidden/s
  );
  assert.match(
    css,
    /\.tenant-maintenance-body\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto/s
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*760px\)[\s\S]*?\.tenant-maintenance-workspace\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*480px\)[\s\S]*?\.tenant-maintenance-overview\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/
  );
  assert.match(app, /data-maintenance-assignment/);
  assert.match(app, /data-maintenance-status=/);
  assert.match(app, /data-maintenance-expense=/);
  assert.match(html, /href="style\.css\?v=165"[\s\S]*src="app\.js\?v=164"/);
});
