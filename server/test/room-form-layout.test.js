const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('form phòng chia ba bước, giữ biểu phí theo hiệu lực và responsive', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(
    html,
    /id="room-modal"[\s\S]*class="modal room-form-modal"[\s\S]*Bước 01[\s\S]*Thông tin phòng[\s\S]*Bước 02[\s\S]*Biểu phí theo hiệu lực[\s\S]*Bước 03[\s\S]*Nước và dịch vụ/
  );
  assert.match(
    html,
    /class="room-form-body"[\s\S]*id="room-rate-effective-from"[\s\S]*id="room-rate-history-section"[\s\S]*class="modal-actions room-form-actions"/
  );
  assert.match(html, /id="room-water-prev-container" hidden/);
  assert.doesNotMatch(html, /id="room-water-prev-container"[^>]*style=/);
  assert.doesNotMatch(html, /style="margin-top:26px"/);

  assert.match(
    app,
    /function syncRoomWaterFields\(waterType\)[\s\S]*previousReading\.hidden = !isMetered[\s\S]*peopleCount\.hidden = isMetered/
  );
  assert.match(app, /syncRoomWaterFields\(room\.waterType \|\| 'người'\)[\s\S]*syncRoomWaterFields\('người'\)/);
  assert.doesNotMatch(app, /room-water-prev-container'\)\.style\.display/);

  assert.match(
    css,
    /\.modal\.room-form-modal\s*\{[^}]*display:\s*flex;[^}]*flex-direction:\s*column;[^}]*overflow:\s*hidden/s
  );
  assert.match(css, /\.room-form-body\s*\{[^}]*min-height:\s*0;[^}]*overflow-y:\s*auto/s);
  assert.match(
    css,
    /@media\s*\(max-width:\s*480px\)[\s\S]*?\.room-form-actions\s*\{[^}]*flex-direction:\s*column-reverse/
  );
  assert.match(html, /href="style\.css\?v=146"[\s\S]*src="app\.js\?v=148"/);
});
