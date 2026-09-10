const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('quản lý phòng nhóm thông tin và thao tác, responsive trên mobile', () => {
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const app = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'style.css'), 'utf8');

  assert.match(html, /class="rooms-directory"[\s\S]*id="rooms-property-summary"[\s\S]*id="rooms-list"/);
  assert.match(app, /class="room-card-head"[\s\S]*class="room-card-overview"[\s\S]*class="room-meter-details"/);
  assert.match(app, /class="room-card-actions-main"[\s\S]*class="room-card-actions-secondary"/);
  assert.match(app, /room\.notes \? `<span>📝 \$\{escapeHtml\(room\.notes\)\}<\/span>`/);
  assert.match(
    css,
    /@media\s*\(max-width:\s*760px\)[\s\S]*?\.room-card-overview\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/
  );
  assert.match(
    css,
    /@media\s*\(max-width:\s*480px\)[\s\S]*?\.room-card-actions-main,[\s\S]*?grid-template-columns:\s*minmax\(0,\s*1fr\)/
  );
  assert.match(html, /href="style\.css\?v=137"[\s\S]*src="app\.js\?v=141"/);
});
