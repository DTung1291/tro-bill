const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('popup sửa chỉ số và chuyển kỳ giải thích tác động, không tràn mobile', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(
    html,
    /id="edit-old-modal"[\s\S]*class="modal data-correction-modal reading-adjustment-modal"[\s\S]*id="edit-old-modal-reset" hidden/
  );
  assert.match(
    html,
    /id="transfer-period-modal"[\s\S]*class="period-transfer-route"[\s\S]*class="transfer-mode-list"[\s\S]*Chuyển hẳn[\s\S]*Sao chép/
  );
  assert.match(
    html,
    /id="transfer-expenses-modal"[\s\S]*Khoản chi gắn yêu cầu sửa chữa[\s\S]*name="transfer-expenses-mode"/
  );
  assert.doesNotMatch(html, /class="modal" style="max-width:(420|460)px"/);
  assert.doesNotMatch(html, /id="edit-old-modal-(desc|reset)"[^>]*style=/);

  assert.match(app, /resetBtn\.hidden = !hasOverride/);
  assert.match(app, /function executeTransferPeriod\(sourcePeriod, targetPeriod, mode\)[\s\S]*if \(mode === 'move'\)/);
  assert.match(app, /function executeTransferExpenses\(sourcePeriod, targetPeriod, mode\)[\s\S]*maintenanceRequestCode/);
  assert.match(app, /showConfirm\([\s\S]*Ghi đè & \$\{actionLabel\}/);

  assert.match(
    css,
    /\.modal\.data-correction-modal\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*overflow:\s*hidden/s
  );
  assert.match(css, /\.data-correction-body\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto/s);
  assert.match(
    css,
    /@media\s*\(max-width:\s*520px\)[\s\S]*?\.period-transfer-route\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*420px\)[\s\S]*?\.data-correction-actions\s*\{[^}]*flex-direction:\s*column-reverse/
  );
  assert.match(html, /href="style\.css\?v=146"[\s\S]*src="app\.js\?v=148"/);
});
