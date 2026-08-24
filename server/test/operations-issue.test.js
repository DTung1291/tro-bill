'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const issueScript = path.join(__dirname, '..', '..', 'scripts', 'manage-operations-issue.sh');

function createMockGh() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'trobill-ops-issue-'));
  const mockGh = path.join(directory, 'gh');
  const callLog = path.join(directory, 'calls.log');
  fs.writeFileSync(mockGh, `#!/usr/bin/env bash
set -euo pipefail
if [[ "\${1:-} \${2:-}" == "issue list" ]]; then
  printf '%s' "\${MOCK_ISSUES_JSON:-[]}"
  exit 0
fi
printf '%s\\n' "$*" >> "\${MOCK_GH_CALL_LOG}"
if [[ "\${1:-} \${2:-}" == "issue create" ]]; then
  echo 'https://github.com/DTung1291/tro-bill/issues/99'
fi
`, { mode: 0o700 });
  return { directory, callLog };
}

function runIssueScript(action, mock, issues) {
  return spawnSync('bash', [issueScript, action], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${mock.directory}:${process.env.PATH}`,
      GITHUB_REPOSITORY: 'DTung1291/tro-bill',
      OPS_ISSUE_TITLE: 'OPS test incident',
      OPS_ISSUE_ASSIGNEE: 'DTung1291',
      OPS_RUN_URL: 'https://github.example/actions/runs/1',
      MOCK_ISSUES_JSON: JSON.stringify(issues),
      MOCK_GH_CALL_LOG: mock.callLog
    }
  });
}

test('mở đúng một issue vận hành và gán cho chủ repository', (t) => {
  const mock = createMockGh();
  t.after(() => fs.rmSync(mock.directory, { recursive: true, force: true }));

  const result = runIssueScript('open', mock, []);
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(mock.callLog, 'utf8');
  assert.match(calls, /issue create/);
  assert.match(calls, /--assignee DTung1291/);
  assert.match(calls, /--title OPS test incident/);
});

test('không tạo issue trùng khi cảnh báo cùng tên đang mở', (t) => {
  const mock = createMockGh();
  t.after(() => fs.rmSync(mock.directory, { recursive: true, force: true }));

  const result = runIssueScript('open', mock, [{ number: 7, title: 'OPS test incident' }]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /#7/);
  assert.equal(fs.existsSync(mock.callLog), false);
});

test('tự đóng issue khi workflow phục hồi', (t) => {
  const mock = createMockGh();
  t.after(() => fs.rmSync(mock.directory, { recursive: true, force: true }));

  const result = runIssueScript('close', mock, [{ number: 7, title: 'OPS test incident' }]);
  assert.equal(result.status, 0, result.stderr);
  const calls = fs.readFileSync(mock.callLog, 'utf8');
  assert.match(calls, /issue close 7/);
  assert.match(calls, /--comment Hệ thống đã phục hồi/);
});

