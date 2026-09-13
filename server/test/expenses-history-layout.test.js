const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('chi phí và lịch sử tháng có phân cấp, thao tác và responsive rõ ràng', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(
    html,
    /class="expense-overview"[\s\S]*id="expense-overview-total"[\s\S]*id="expense-summary"[\s\S]*class="expense-layout"/
  );
  assert.match(
    html,
    /class="history-workspace"[\s\S]*id="history-period-count"[\s\S]*id="history-list"/
  );
  assert.match(app, /getElementById\('expense-overview-total'\)\.textContent = fmt\(total\)/);
  assert.match(app, /expense-summary-item expense-summary-item--\$\{category\}/);
  assert.doesNotMatch(app, /Object\.entries\(EXPENSE_CATEGORIES\)[\s\S]{0,100}filter\(\(\[category\]\) => category !== 'other'\)/);
  assert.match(app, /class="history-room-name">\$\{escapeHtml\(b\.roomName\)\}/);
  assert.match(app, /role="button" tabindex="0" aria-expanded="false"/);
  assert.match(app, /if \(!\['Enter', ' '\]\.includes\(event\.key\)\) return/);
  assert.match(
    css,
    /\.expense-summary\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/s
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*480px\)[\s\S]*?\.history-room-actions\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*480px\)[\s\S]*?\.expense-item-actions\s*\{[^}]*grid-column:\s*1\s*\/\s*-1/
  );
  assert.match(html, /href="style\.css\?v=146"[\s\S]*src="app\.js\?v=148"/);
});
