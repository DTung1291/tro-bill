'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline/promises');
const { parse } = require('dotenv');

const serverDir = path.resolve(__dirname, '..', 'server');
const profiles = {
  dev: { file: '.env.local-dev', databaseEnvironment: 'development' },
  stg: { file: '.env.local-stg', databaseEnvironment: 'staging' },
  pro: { file: '.env.local-pro', databaseEnvironment: 'production' }
};
const confirmationPhrase = 'GHI VAO PRODUCTION';
const forbiddenKeys = [
  'SUPER_ADMIN_EMAIL', 'SUPER_ADMIN_PASSWORD', 'ADMIN_EMAIL', 'ADMIN_PASSWORD',
  'BREVO_API_KEY', 'RESEND_API_KEY', 'OPS_ALERT_WEBHOOK_URL',
  'CRON_SECRET', 'PAYMENT_WEBHOOK_SECRET', 'VERCEL', 'VERCEL_ENV', 'NODE_ENV'
];

function databaseTarget(connectionString) {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname || !url.pathname || url.pathname === '/') {
    throw new Error('DATABASE_URL phải là URL PostgreSQL có host và database.');
  }
  if (url.hostname.endsWith('.invalid') || url.hostname.includes('example') || url.hostname.includes('xxx')) {
    throw new Error('DATABASE_URL vẫn là giá trị mẫu.');
  }
  // Neon có thể dùng cả endpoint trực tiếp và hậu tố -pooler cho cùng branch.
  return url.hostname.toLowerCase().replace(/-pooler(?=\.)/, '');
}

function validateProfile(name, values, otherValues) {
  const spec = profiles[name];
  if (!spec) throw new Error('Chọn dev, stg hoặc pro. Ví dụ: npm start stg');
  if (values.APP_ENV !== 'development' || values.DATABASE_ENVIRONMENT !== spec.databaseEnvironment) {
    throw new Error(`${spec.file}: APP_ENV phải là development và DATABASE_ENVIRONMENT phải là ${spec.databaseEnvironment}.`);
  }
  if (!values.DATABASE_URL) throw new Error(`${spec.file}: thiếu DATABASE_URL.`);
  const target = databaseTarget(values.DATABASE_URL);
  if (name !== 'pro') {
    const productionHost = String(values.PRODUCTION_DATABASE_HOST || '').toLowerCase().trim();
    if (!/^[a-z0-9.-]+$/.test(productionHost) || productionHost.includes('example') || productionHost.includes('xxx')) {
      throw new Error(`${spec.file}: đặt PRODUCTION_DATABASE_HOST bằng hostname endpoint Neon Production thật để chống chọn nhầm.`);
    }
    const normalizedProductionHost = productionHost.replace(/-pooler(?=\.)/, '');
    if (target === normalizedProductionHost) {
      throw new Error(`${spec.file}: DATABASE_URL đang trỏ endpoint Production; đã từ chối khởi động.`);
    }
  }
  let otherTarget = null;
  if (otherValues?.DATABASE_URL) {
    try { otherTarget = databaseTarget(otherValues.DATABASE_URL); } catch (_) { /* Hồ sơ kia chưa cấu hình. */ }
  }
  if (target === otherTarget) {
    throw new Error('Hồ sơ staging và Production đang trỏ cùng endpoint/branch; đã từ chối khởi động.');
  }
  if (String(values.JWT_SECRET || '').length < 32 || /^(replace-|thay-bang)/i.test(values.JWT_SECRET)) {
    throw new Error(`${spec.file}: JWT_SECRET phải có ít nhất 32 ký tự và khác môi trường triển khai.`);
  }
  if (values.COOKIE_SECURE !== 'false') {
    throw new Error(`${spec.file}: local HTTP cần COOKIE_SECURE=false.`);
  }
  const port = String(values.PORT || '3000');
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) {
    throw new Error(`${spec.file}: PORT không hợp lệ.`);
  }
  if (!['http://localhost:' + port, 'http://127.0.0.1:' + port].includes(values.APP_URL)) {
    throw new Error(`${spec.file}: APP_URL phải là http://localhost:${port} hoặc http://127.0.0.1:${port}.`);
  }
  const forbidden = forbiddenKeys.find(key => Object.hasOwn(values, key));
  if (forbidden) throw new Error(`${spec.file}: không đặt ${forbidden} trong hồ sơ local.`);
  return { name, file: spec.file, databaseEnvironment: spec.databaseEnvironment };
}

function readProfile(name) {
  const spec = profiles[name];
  if (!spec) throw new Error('Chọn dev, stg hoặc pro. Ví dụ: npm start stg');
  const filename = path.join(serverDir, spec.file);
  if (!fs.existsSync(filename)) {
    throw new Error(`Thiếu server/${spec.file}. Sao chép server/local-${name}.template.txt rồi điền cấu hình riêng; không dùng server/.env cũ.`);
  }
  return parse(fs.readFileSync(filename));
}

function childEnvironment(values) {
  // Không kế thừa DATABASE_URL, seed admin hoặc secret Production từ shell/.env cũ.
  const inherited = {};
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'TERM', 'TMPDIR', 'TZ']) {
    if (process.env[key]) inherited[key] = process.env[key];
  }
  return { ...inherited, ...values, NODE_ENV: 'development' };
}

async function start() {
  const name = process.argv[2] || 'stg';
  const watch = process.argv.includes('--watch');
  const values = readProfile(name);
  const otherName = name === 'stg' ? 'pro' : name === 'pro' ? 'stg' : null;
  const otherFile = otherName && path.join(serverDir, profiles[otherName].file);
  const otherValues = otherFile && fs.existsSync(otherFile) ? parse(fs.readFileSync(otherFile)) : null;
  validateProfile(name, values, otherValues);

  if (name === 'pro') {
    if (!process.stdin.isTTY) throw new Error('Production cần xác nhận trực tiếp trên terminal; không chạy tự động.');
    console.warn('CẢNH BÁO: local sẽ kết nối và CÓ THỂ GHI vào database Production. Mọi dữ liệu test tạo ra sẽ ảnh hưởng người dùng thật.');
    const prompt = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answer;
    try {
      answer = await prompt.question(`Nhập đúng "${confirmationPhrase}" để tiếp tục: `);
    } finally {
      prompt.close();
    }
    if (answer.trim() !== confirmationPhrase) throw new Error('Chưa xác nhận; không kết nối Production.');
  }

  console.log(`Khởi động local với database ${name === 'dev' ? 'development' : name === 'stg' ? 'staging' : 'PRODUCTION'}; file ${profiles[name].file}.`);
  const child = spawn(process.execPath, [...(watch ? ['--watch'] : []), 'index.js'], {
    cwd: serverDir,
    env: { ...childEnvironment(values), TROBILL_LOCAL_PROFILE: name },
    stdio: 'inherit'
  });
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
  child.on('error', error => {
    console.error(`Không khởi động được server: ${error.message}`);
    process.exitCode = 1;
  });
  child.on('exit', (code, signal) => {
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1);
  });
}

if (require.main === module) {
  start().catch(error => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { childEnvironment, databaseTarget, profiles, validateProfile };
