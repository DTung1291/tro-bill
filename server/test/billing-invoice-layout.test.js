const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('luồng nhập chỉ số và hóa đơn có tiến độ, CTA và responsive rõ ràng', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(
    html,
    /id="page-billing"[\s\S]*class="workflow-step">Bước 1\/2[\s\S]*id="billing-progress-done"[\s\S]*id="btn-review-bills"/
  );
  assert.match(
    html,
    /id="page-report"[\s\S]*class="workflow-step">Bước 2\/2[\s\S]*class="invoice-workspace"[\s\S]*id="btn-back-to-billing"[\s\S]*id="report-list"/
  );
  assert.match(app, /reviewButton\.disabled = done === 0/);
  assert.match(app, /reviewButton\.hidden = !workspacePageAllowed\('report'\)/);
  assert.match(app, /totalOutstanding \+= Math\.max\(0, payment\.totalDueVnd\)/);
  assert.match(app, /summaryEl\.style\.display = 'grid'/);
  assert.match(app, /class="bill-room-name">\$\{escapeHtml\(room\.name\)\}/);
  assert.match(app, /Ghi chú: \$\{escapeHtml\(rec\.note\)\}/);
  assert.match(app, /getElementById\('btn-review-bills'\)\?\.addEventListener\('click', \(\) => navigate\('report'\)\)/);
  assert.match(
    css,
    /#page-report\.active\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column/s
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*680px\)[\s\S]*?\.report-summary-bar\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*680px\)[\s\S]*?\.bill-footer-primary,[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/
  );
  assert.match(html, /href="style\.css\?v=144"[\s\S]*src="app\.js\?v=146"/);
});
