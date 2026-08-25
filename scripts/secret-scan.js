'use strict';

const fs = require('fs');
const { execFileSync, spawn } = require('child_process');

const patterns = [
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{20,}\b/],
  ['resend-api-key', /\bre_[A-Za-z0-9]{20,}\b/],
  ['stripe-secret-key', /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/],
  ['aws-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['generic-secret-assignment', /\b(?:JWT_SECRET|API_SECRET|PRIVATE_TOKEN)\s*=\s*['"]?[A-Za-z0-9_+/=-]{24,}/]
];

function ignoredPath(file) {
  return /(?:^|\/)\.env(?:\.[^/]+)?\.example$/.test(file)
    || file.endsWith('.lock')
    || file.endsWith('-lock.json');
}

function databaseCredential(line) {
  const match = line.match(/postgres(?:ql)?:\/\/([^\s:'"<>]+):([^\s@'"<>]+)@([^\s/'"<>]+)/i);
  if (!match) return false;
  const [, username, password, hostWithPort] = match;
  const hostname = hostWithPort.replace(/:\d+$/, '').toLowerCase();
  if (['localhost', '127.0.0.1', 'postgres'].includes(hostname)) return false;
  if (hostname.endsWith('.invalid')) return false;
  if (/^(?:test|user|username)$/i.test(username) && /^(?:test|password)$/i.test(password)) return false;
  if (/^(?:host|hostname)$/i.test(hostname)
      && /^(?:test|user|username|placeholder)$/i.test(username)
      && /^(?:test|secret|password|placeholder)$/i.test(password)) return false;
  return true;
}

function detect(line) {
  const matches = [];
  if (databaseCredential(line)) matches.push('database-credentials');
  for (const [name, pattern] of patterns) {
    if (pattern.test(line)) matches.push(name);
  }
  return matches;
}

function scanTrackedFiles() {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
    .split('\0')
    .filter(Boolean);
  const findings = [];

  for (const file of files) {
    if (ignoredPath(file)) continue;
    let content;
    try {
      content = fs.readFileSync(file);
    } catch (_) {
      continue;
    }
    if (content.includes(0)) continue;
    content.toString('utf8').split(/\r?\n/).forEach((line, index) => {
      for (const type of detect(line)) findings.push({ scope: 'tracked', file, line: index + 1, type });
    });
  }
  return findings;
}

function scanHistory() {
  return new Promise((resolve, reject) => {
    const findings = [];
    let commit = 'unknown';
    let file = 'unknown';
    let lineNumber = 0;
    let buffered = '';
    const child = spawn('git', [
      'log', '--all', '--format=__TROBILL_COMMIT__%H', '--patch', '--no-ext-diff', '--',
      '.', ':(exclude)package-lock.json', ':(exclude)server/package-lock.json'
    ], { stdio: ['ignore', 'pipe', 'inherit'] });

    function consume(rawLine) {
      const line = rawLine.replace(/\r$/, '');
      if (line.startsWith('__TROBILL_COMMIT__')) {
        commit = line.slice('__TROBILL_COMMIT__'.length, '__TROBILL_COMMIT__'.length + 12);
        return;
      }
      if (line.startsWith('diff --git a/')) {
        const match = line.match(/^diff --git a\/(.+) b\/(.+)$/);
        if (match) file = match[2];
        return;
      }
      if (line.startsWith('+++ b/')) {
        file = line.slice(6);
        lineNumber = 0;
        return;
      }
      if (line.startsWith('--- a/')) {
        file = line.slice(6);
        return;
      }
      if (line.startsWith('@@')) {
        const match = line.match(/\+(\d+)/);
        lineNumber = match ? Number(match[1]) - 1 : 0;
        return;
      }
      if (!line.startsWith('+') && !line.startsWith('-')) return;
      if (line.startsWith('+++') || line.startsWith('---')) return;
      if (line.startsWith('+')) lineNumber += 1;
      if (ignoredPath(file)) return;
      for (const type of detect(line.slice(1))) {
        findings.push({ scope: `history:${commit}`, file, line: Math.max(lineNumber, 1), type });
      }
    }

    child.stdout.on('data', chunk => {
      buffered += chunk.toString('utf8');
      const lines = buffered.split('\n');
      buffered = lines.pop();
      lines.forEach(consume);
    });
    child.once('error', reject);
    child.once('close', code => {
      if (buffered) consume(buffered);
      if (code !== 0) return reject(new Error(`git log exited with ${code}`));
      return resolve(findings);
    });
  });
}

async function main() {
  const findings = scanTrackedFiles();
  if (process.argv.includes('--history')) findings.push(...await scanHistory());

  const unique = [...new Map(findings.map(item => [
    `${item.scope}:${item.file}:${item.line}:${item.type}`,
    item
  ])).values()];

  if (unique.length) {
    console.error('Phát hiện dữ liệu có dạng secret (chỉ hiển thị vị trí, không hiển thị giá trị):');
    unique.forEach(item => console.error(`- ${item.scope} ${item.file}:${item.line} [${item.type}]`));
    process.exitCode = 1;
    return;
  }
  console.log(`Secret scan sạch (${process.argv.includes('--history') ? 'tracked files + git history' : 'tracked files'}).`);
}

if (require.main === module) {
  main().catch(error => {
    console.error(`Secret scan không chạy được: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { databaseCredential, detect, ignoredPath, scanHistory, scanTrackedFiles };
