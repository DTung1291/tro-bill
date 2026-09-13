const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('sổ thu tiền và tiền cọc ưu tiên số dư, đối soát và responsive', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(
    html,
    /id="rent-payment-modal"[\s\S]*finance-ledger-modal-kicker[\s\S]*Đối soát hóa đơn[\s\S]*rent-payment-modal-body/
  );
  assert.match(
    html,
    /id="deposit-modal"[\s\S]*Tài chính khách thuê[\s\S]*Giao dịch mới[\s\S]*id="deposit-ledger-count"/
  );
  assert.match(
    app,
    /rent-payment-summary-primary[\s\S]*Còn lại tháng này[\s\S]*rent-payment-summary-collected[\s\S]*rent-payment-summary-debt[\s\S]*rent-payment-summary-transfer/
  );
  assert.match(app, /Lịch sử đối soát[\s\S]*transactions\.length\.toLocaleString\('vi-VN'\)/);
  assert.match(app, /getElementById\('deposit-ledger-count'\)[\s\S]*transactions\.length\.toLocaleString\('vi-VN'\)/);
  assert.match(
    css,
    /\.modal\.rent-payment-modal\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*overflow:\s*hidden/s
  );
  assert.match(
    css,
    /\.deposit-modal-body\s*\{[^}]*flex:\s*1 1 auto;[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto/s
  );
  assert.match(
    css,
    /\.rent-payment-modal-body \.rent-payment-summary-grid\s*\{[^}]*grid-template-columns:\s*repeat\(12,\s*minmax\(0,\s*1fr\)\)/s
  );
  assert.match(
    css,
    /\.rent-payment-modal-body \.rent-payment-summary-primary\s*\{[^}]*grid-column:\s*span 6;[^}]*grid-row:\s*span 2/s
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*480px\)[\s\S]*?\.rent-payment-modal-body \.rent-payment-summary-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/
  );
  assert.match(html, /href="style\.css\?v=144"[\s\S]*src="app\.js\?v=146"/);
});
