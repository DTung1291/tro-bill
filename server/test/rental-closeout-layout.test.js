const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('luồng trả phòng nối biên bản, kết thúc hợp đồng và quyết toán theo đúng thứ tự', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');

  assert.match(
    html,
    /id="rental-handover-closeout-journey"[\s\S]*Biên bản trả phòng[\s\S]*Kết thúc hợp đồng[\s\S]*Quyết toán/
  );
  assert.match(
    html,
    /id="rental-lifecycle-journey"[\s\S]*id="rental-lifecycle-prerequisite"[\s\S]*id="rental-lifecycle-open-handover"/
  );
  assert.match(
    html,
    /id="rental-final-settlement-journey"[\s\S]*id="rental-final-settlement-summary"[\s\S]*id="rental-final-settlement-balance"/
  );
  assert.match(
    app,
    /refreshRentalLifecycleReadiness[\s\S]*API\.getRentalHandovers\(contract\.id\)[\s\S]*handoverType === 'check_out'/
  );
  assert.match(
    app,
    /continueCheckoutAfterHandover[\s\S]*const type = rentalHandoverContinuationType \|\| 'checkout'[\s\S]*closeRentalHandoverModal\(\)[\s\S]*openRentalLifecycleModal\(contract, type\)/
  );
  assert.match(app, /Xác nhận trả phòng & tiếp tục/);
  assert.match(app, /Sau khi xác nhận, hệ thống chốt hóa đơn đến hết ngày này/);
});

test('popup trả phòng giữ header trong viewport và thu gọn an toàn trên mobile', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(
    css,
    /\.modal\.rental-lifecycle-modal\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*overflow:\s*hidden/s
  );
  assert.match(
    css,
    /\.modal\.rental-final-settlement-modal\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*overflow:\s*hidden/s
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*480px\)[\s\S]*?\.closeout-journey\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/
  );
  assert.match(
    css,
    /\.rental-final-settlement-balance\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\)/s
  );
  assert.match(html, /href="style\.css\?v=164"[\s\S]*src="app\.js\?v=161"/);
});
