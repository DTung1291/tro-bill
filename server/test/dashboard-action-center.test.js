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

function renderFixture({ owner = true, operations = ['billing', 'report', 'rooms'], invoices = [], available = true } = {}) {
  const container = {
    innerHTML: '',
    querySelectorAll: () => []
  };
  const rooms = [
    { id: 'occupied', tenants: [{ temporaryResidenceCurrent: true }] },
    { id: 'vacant', tenants: [] },
    { id: 'former', tenants: [{ temporaryResidenceCurrent: false }] }
  ];
  const context = {
    rooms,
    document: { getElementById: () => container },
    RENT_INVOICE_SUMMARIES: new Map(invoices.map(invoice => [invoice.invoiceId, invoice])),
    RENT_INVOICE_SUMMARIES_AVAILABLE: available,
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

test('dashboard action center respects staff operation scope', () => {
  const rendered = renderFixture({ owner: false, operations: ['billing'] });
  assert.match(rendered, /Chưa nhập chỉ số/);
  assert.doesNotMatch(rendered, /công nợ|Hóa đơn quá hạn|Tạm trú cần gia hạn/);
});

test('dashboard action center is present and has a narrow mobile layout', () => {
  assert.match(html, /id="dashboard-actions-title"[\s\S]*id="dashboard-action-list"/);
  assert.match(css, /@media \(max-width: 600px\)\s*\{[\s\S]*?\.dashboard-action\s*\{\s*flex-wrap: wrap/);
});
