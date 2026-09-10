'use strict';

process.env.JWT_SECRET ||= 'test-secret-that-is-long-enough-for-quick-start-tests';
process.env.DATABASE_URL ||= 'postgresql://test:test@localhost:5432/test';
process.env.COOKIE_SECURE = 'false';
process.env.NODE_ENV = 'test';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');
const assert = require('node:assert/strict');
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

test('hướng dẫn bắt đầu nhanh được phục vụ công khai với cảnh báo nhập an toàn', async (t) => {
  const server = await listen(app);
  t.after(() => close(server));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/huong-dan`);
  const html = await response.text();

  assert.equal(response.status, 200);
  assert.match(html, /Năm bước từ tài khoản trống/);
  assert.match(html, /Chỉ nhập vào tài khoản trống/);
  assert.match(html, /không có tên khách, CCCD, số điện thoại, email/);
  assert.match(html, /id="download-sample"/);
  assert.match(html, /Nhập file JSON/);
});

test('file mẫu tạo UUID mới và không chứa dữ liệu cá nhân hoặc ngân hàng', () => {
  const source = fs.readFileSync(path.join(root, 'quick-start.js'), 'utf8');
  assert.match(source, /crypto\.randomUUID/);
  assert.match(source, /crypto\.getRandomValues/);
  assert.match(source, /tenants: \[\]/);
  assert.match(source, /containsTenantPersonalData: false/);
  assert.match(source, /bankAccount: ''/);
  assert.doesNotMatch(source, /cccd\s*:/i);
  assert.doesNotMatch(source, /phone\s*:/i);
  assert.doesNotMatch(source, /email\s*:/i);
});

test('generator xuất state có ba phòng, biểu phí và chỉ số cùng kỳ', () => {
  const source = fs.readFileSync(path.join(root, 'quick-start.js'), 'utf8');
  const exposedSource = source
    .replace("  downloadButton.addEventListener('click', downloadSample);", '  globalThis.__sampleState = sampleState;')
    .replace("  periodLabel.textContent = `${month}/${year}`;", '');
  let idCounter = 0;
  const context = {
    crypto: {
      randomUUID() { idCounter += 1; return `00000000-0000-4000-8000-${String(idCounter).padStart(12, '0')}`; }
    },
    document: { getElementById() { return {}; } },
    Date,
    Blob,
    URL,
    setTimeout
  };
  vm.runInNewContext(exposedSource, context);
  const state = context.__sampleState();
  const period = state.currentPeriod;

  assert.equal(state.rooms.length, 3);
  assert.equal(new Set(state.rooms.map((room) => room.id)).size, 3);
  assert.equal(Object.keys(state.billingData[period]).length, 3);
  assert.equal(state.rooms.every((room) => room.rateHistory[0].effectiveFrom === period), true);
  assert.equal(state.rooms.every((room) => room.tenants.length === 0), true);
});

test('route Vercel, liên kết app và layout mobile đều được nối', () => {
  const vercel = JSON.parse(fs.readFileSync(path.join(root, 'vercel.json'), 'utf8'));
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const appSource = fs.readFileSync(path.join(root, 'app.js'), 'utf8');
  const landing = fs.readFileSync(path.join(root, 'landing.html'), 'utf8');
  const styles = fs.readFileSync(path.join(root, 'quick-start.css'), 'utf8');

  assert.equal(vercel.rewrites.some((route) => (
    route.source === '/huong-dan' && route.destination === '/quick-start.html'
  )), true);
  assert.match(index, /href="\/huong-dan"[^>]*>Mở hướng dẫn/);
  assert.match(index, /app\.js\?v=140/);
  assert.match(appSource, /href="\/huong-dan"/);
  assert.match(landing, /href="\/huong-dan">Hướng dẫn/);
  assert.match(styles, /@media \(max-width: 600px\)/);
});
