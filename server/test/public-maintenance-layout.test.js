'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '../..');

test('cổng báo sửa ưu tiên trạng thái, chia biểu mẫu theo bước và thu gọn trên mobile', () => {
  const html = fs.readFileSync(path.join(root, 'maintenance.html'), 'utf8');
  const css = fs.readFileSync(path.join(root, 'maintenance-public.css'), 'utf8');
  const js = fs.readFileSync(path.join(root, 'maintenance-public.js'), 'utf8');
  const refreshCss = css.slice(css.indexOf('CỔNG BÁO SỬA'));

  assert.match(html, /class="maintenance-security"[\s\S]*Liên kết bảo mật/);
  assert.match(
    html,
    /id="maintenance-room"[\s\S]*id="maintenance-next-step"[\s\S]*class="maintenance-emergency"[\s\S]*id="maintenance-request-form"[\s\S]*id="maintenance-request-list"/
  );
  assert.equal((html.match(/class="maintenance-form-section"/g) || []).length, 3);
  assert.match(html, /id="maintenance-urgency"[^>]*aria-describedby="maintenance-urgency-guidance"/);
  assert.match(html, /id="maintenance-form-message"[^>]*tabindex="-1"/);
  assert.match(html, /maintenance-public\.css\?v=2[\s\S]*maintenance-public\.js\?v=3/);

  assert.match(js, /function renderNextStep\(\)/);
  assert.match(js, /\['new', 'acknowledged', 'in_progress'\]\.includes\(request\.status\)/);
  assert.match(js, /function renderUrgencyGuidance\(\)/);
  assert.match(js, /submit\.textContent = 'Đang gửi yêu cầu…'/);
  assert.match(js, /item\.dataset\.status = request\.status \|\| ''/);
  assert.doesNotMatch(js, /localStorage|sessionStorage|innerHTML|insertAdjacentHTML/);

  assert.match(refreshCss, /\.maintenance-shell\s*\{[^}]*width:\s*min\(900px,/s);
  assert.match(refreshCss, /\.maintenance-next-step\s*\{[^}]*grid-template-columns:\s*42px minmax\(0,\s*1fr\)/s);
  assert.match(refreshCss, /\.maintenance-form-section\s*\{[^}]*border-radius:\s*15px/s);
  assert.match(
    refreshCss,
    /@media\s*\(max-width:\s*680px\)[\s\S]*?\.maintenance-form-grid\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/
  );
  assert.match(
    refreshCss,
    /@media\s*\(max-width:\s*520px\)[\s\S]*?\.maintenance-submit-row\s*\{[^}]*flex-direction:\s*column[\s\S]*?#maintenance-submit\s*\{[^}]*width:\s*100%/
  );
  assert.match(
    refreshCss,
    /@media\s*\(max-width:\s*390px\)[\s\S]*?\.maintenance-brand\s*\{[^}]*flex-wrap:\s*wrap/
  );
});
