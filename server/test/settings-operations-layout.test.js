const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('cài đặt vận hành có mục lục, phân nhóm và responsive rõ ràng', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(
    html,
    /class="settings-hub"[\s\S]*href="#settings-subscription"[\s\S]*href="#team-members-card"[\s\S]*href="#settings-payments"[\s\S]*href="#settings-automation"[\s\S]*href="#settings-data"/
  );
  assert.match(
    html,
    /id="settings-payments"[\s\S]*class="settings-card settings-operation-card settings-deduction-card"[\s\S]*class="settings-card settings-operation-card default-bank-settings-card"/
  );
  assert.match(
    html,
    /id="settings-automation"[\s\S]*class="settings-card settings-operation-card meter-reminder-settings-card"[\s\S]*id="invoice-reminder-settings-title"[\s\S]*id="electronic-invoice-profile-card"/
  );
  assert.match(
    html,
    /id="settings-data"[\s\S]*class="settings-card settings-operation-card account-data-card"[\s\S]*class="settings-card privacy-settings-card"[\s\S]*class="settings-card settings-security-card"/
  );
  assert.match(html, /id="bank-custom-input" class="inline-input default-bank-settings-custom"/);
  assert.doesNotMatch(html, /id="bank-custom-input"[^>]+hidden/);
  assert.match(css, /\.settings-hub-links\s*\{[^}]*grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\)/s);
  assert.match(
    css,
    /@media\s*\(max-width:\s*640px\)[\s\S]*?\.settings-hub-links\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*640px\)[\s\S]*?\.default-bank-settings-fields\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/
  );
  assert.match(html, /href="style\.css\?v=138"[\s\S]*src="app\.js\?v=141"/);
});
