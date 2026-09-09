'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-landing-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.COOKIE_SECURE = 'false';
process.env.NODE_ENV = 'test';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const db = require('../db');
const app = require('../index');

const root = path.join(__dirname, '..', '..');

function listen(serverApp) {
  return new Promise((resolve, reject) => {
    const server = serverApp.listen(0, '127.0.0.1', () => resolve(server));
    server.once('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

test('landing page có route riêng và nội dung sản phẩm trung thực', async (t) => {
  const server = await listen(app);
  t.after(() => close(server));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/gioi-thieu`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(html, /Chốt bill\. Gửi QR\./);
  assert.match(html, /id="tinh-nang"/);
  assert.match(html, /id="bang-gia"/);
  assert.match(html, /Backup mã hóa/);
  assert.match(html, /chưa được mở chính thức/);
  assert.match(html, /href="\/privacy\.html"/);
  assert.match(html, /href="\/terms\.html"/);
});

test('API landing chỉ trả gói đang công khai mà không cần phiên đăng nhập', async (t) => {
  const originalQuery = db.query;
  let capturedSql = '';
  db.query = async (sql) => {
    capturedSql = sql;
    return {
      rows: [{
        code: 'free',
        name: 'Free',
        description: 'Bắt đầu miễn phí',
        monthly_price_vnd: '0',
        yearly_price_vnd: '0',
        room_limit: 5,
        staff_limit: 0,
        trial_days: 0,
        is_active: true,
        is_public: true,
        sort_order: 10
      }]
    };
  };
  t.after(() => { db.query = originalQuery; });

  const server = await listen(app);
  t.after(() => close(server));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/public/plans`);
  const payload = await response.json();

  assert.equal(response.status, 200);
  assert.match(capturedSql, /is_active=true AND is_public=true/);
  assert.equal(payload.plans.length, 1);
  assert.equal(payload.plans[0].code, 'free');
  assert.equal(payload.plans[0].monthlyPriceVnd, 0);
});

test('landing render bảng giá an toàn và có layout mobile', () => {
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const script = fs.readFileSync(path.join(root, 'landing.js'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'landing.css'), 'utf8');
  const appStyles = fs.readFileSync(path.join(root, 'style.css'), 'utf8');
  const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));

  assert.match(index, /class="auth-dev-link auth-pricing-link" href="\/gioi-thieu">Xem tính năng và bảng giá/);
  assert.match(appStyles, /\.auth-pricing-link\s*\{\s*margin-top:\s*10px;/);
  assert.match(index, /class="auth-shell"/);
  assert.match(index, /Chốt bill, gửi QR và theo dõi công nợ trong một nơi/);
  assert.match(index, /class="auth-benefits"/);
  assert.match(appStyles, /@media \(max-width: 900px\)[\s\S]*\.auth-intro \{ display: none;/);
  assert.match(appStyles, /@media \(max-width: 520px\)[\s\S]*\.auth-card \{ max-width: none;/);
  assert.match(script, /fetch\('\/api\/public\/plans'/);
  assert.match(script, /textContent/);
  assert.doesNotMatch(script, /innerHTML/);
  assert.match(script, /plan\.isActive === true && plan\.isPublic === true/);
  assert.match(styles, /@media \(max-width: 640px\)/);
  assert.match(styles, /prefers-reduced-motion/);
  assert.deepEqual(vercel.rewrites[0], {
    source: '/gioi-thieu',
    destination: '/landing.html'
  });
});
