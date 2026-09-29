const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '../..');
const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
const source = app.slice(
  app.indexOf('function renderDashboardActionCenter('),
  app.indexOf('function temporaryResidenceStatus(')
);

function renderFixture({ owner = true, operations = ['billing', 'report', 'rooms'], invoices = [], available = true, maintenance = [], maintenanceStatus = 'ready' } = {}) {
  const container = {
    innerHTML: '',
    querySelectorAll: () => []
  };
  const rooms = [
    { id: 'occupied', name: 'A101', tenants: [{ temporaryResidenceCurrent: true }] },
    { id: 'vacant', name: 'B201', tenants: [] },
    { id: 'former', name: 'C301', tenants: [{ temporaryResidenceCurrent: false }] }
  ];
  const context = {
    rooms,
    document: { getElementById: () => container },
    RENT_INVOICE_SUMMARIES: new Map(invoices.map(invoice => [invoice.invoiceId, invoice])),
    RENT_INVOICE_SUMMARIES_AVAILABLE: available,
    DASHBOARD_MAINTENANCE_SUMMARY: maintenance,
    DASHBOARD_MAINTENANCE_STATUS: maintenanceStatus,
    DebtAge: require('../../debt-age'),
    isOwnerWorkspace: () => owner,
    workspacePageAllowed: page => operations.includes(page),
    vietnamCalendarDate: () => '2026-09-28',
    getRoomOperationalStatus: id => ({ status: id === 'occupied' ? 'occupied' : 'vacant' }),
    getPeriodRecord: () => null,
    temporaryResidenceStatus: tenant => ({ level: tenant.temporaryResidenceCurrent ? 'soon' : 'former' }),
    periodLabel: period => period,
    escapeHtml: value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  };
  vm.runInNewContext(`${source}\nrenderDashboardActionCenter(rooms, '2026-09');`, context);
  return container.innerHTML;
}

test('dashboard action center counts only occupied rooms, overdue invoices and current residence', () => {
  const rendered = renderFixture({ invoices: [
    { invoiceId: 1, roomId: 'occupied', period: '2026-08', remainingVnd: 100000, dueDate: '2026-08-01' },
    { invoiceId: 2, roomId: 'occupied', period: '2026-08', remainingVnd: 0, dueDate: '2026-08-01' },
    { invoiceId: 3, roomId: 'elsewhere', period: '2026-08', remainingVnd: 100000, dueDate: '2026-08-01' }
  ] });
  assert.match(rendered, /Chưa nhập chỉ số/);
  assert.match(rendered, /Hóa đơn quá hạn/);
  assert.match(rendered, /Tạm trú cần gia hạn/);
  assert.equal((rendered.match(/aria-label="1 việc"/g) || []).length, 3);
  assert.match(rendered, /data-action-period="2026-08"/);
});

test('dashboard action center does not claim missing invoice data means no debt', () => {
  const rendered = renderFixture({ available: false });
  assert.match(rendered, /Chưa kiểm tra được công nợ/);
  assert.doesNotMatch(rendered, /Hóa đơn quá hạn/);
});

test('chỉ nhắc xác minh gửi của hóa đơn còn dư đúng kỳ và đúng phòng', () => {
  const rendered = renderFixture({ invoices: [
    { invoiceId: 1, roomId: 'occupied', period: '2026-09', remainingVnd: 1000, deliveryStatus: 'unsent' },
    { invoiceId: 2, roomId: 'occupied', period: '2026-09', remainingVnd: 1000, deliveryStatus: 'unknown' },
    { invoiceId: 3, roomId: 'occupied', period: '2026-09', remainingVnd: 1000, deliveryStatus: 'sent' },
    { invoiceId: 4, roomId: 'elsewhere', period: '2026-09', remainingVnd: 1000, deliveryStatus: 'unsent' },
    { invoiceId: 5, roomId: 'occupied', period: '2026-09', remainingVnd: 0, deliveryStatus: 'unsent' }
  ] });
  assert.match(rendered, /Cần kiểm tra gửi hóa đơn/);
  assert.match(rendered, /1 chưa gửi · 1 hóa đơn cũ chưa rõ/);
  assert.match(rendered, /data-action-delivery="needs_review"/);
  assert.match(rendered, /aria-label="2 việc"/);
});

test('dashboard action center respects staff operation scope', () => {
  const rendered = renderFixture({ owner: false, operations: ['billing'], maintenance: [
    { roomId: 'occupied', openCount: 2, unassignedCount: 0 }
  ] });
  assert.match(rendered, /Chưa nhập chỉ số/);
  assert.doesNotMatch(rendered, /công nợ|Hóa đơn quá hạn|Tạm trú cần gia hạn|Yêu cầu sửa chữa đang mở/);
});

test('dashboard counts open maintenance only in visible rooms and links to each room', () => {
  const rendered = renderFixture({ maintenance: [
    { roomId: 'occupied', openCount: 2, unassignedCount: 1 },
    { roomId: 'vacant', openCount: 3, unassignedCount: 2 },
    { roomId: 'elsewhere', openCount: 9, unassignedCount: 9 }
  ] });
  assert.match(rendered, /Yêu cầu sửa chữa đang mở/);
  assert.match(rendered, /2 phòng · 3 chưa phân công/);
  assert.match(rendered, /aria-label="5 việc"/);
  assert.match(rendered, /data-dashboard-maintenance-room="occupied"/);
  assert.match(rendered, /data-dashboard-maintenance-room="vacant"/);
  assert.doesNotMatch(rendered, /data-dashboard-maintenance-room="elsewhere"/);
});

test('dashboard does not mistake failed maintenance request for an empty queue', () => {
  const rendered = renderFixture({ maintenanceStatus: 'error' });
  assert.match(rendered, /Chưa kiểm tra được yêu cầu sửa chữa/);
  assert.match(rendered, /data-dashboard-action="maintenance-retry"/);
  assert.doesNotMatch(rendered, /Không có việc cần xử lý/);
});

test('dashboard action center is present and has a narrow mobile layout', () => {
  assert.match(html, /id="dashboard-actions-title"[\s\S]*id="dashboard-action-list"/);
  assert.match(css, /@media \(max-width: 600px\)\s*\{[\s\S]*?\.dashboard-action\s*\{\s*flex-wrap: wrap/);
});
