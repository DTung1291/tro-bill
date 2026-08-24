#!/usr/bin/env bash

set -Eeuo pipefail

action="${1:-}"
repository="${GITHUB_REPOSITORY:-}"
title="${OPS_ISSUE_TITLE:-}"
assignee="${OPS_ISSUE_ASSIGNEE:-DTung1291}"
run_url="${OPS_RUN_URL:-}"

if [[ "$action" != "open" && "$action" != "close" ]]; then
  echo "Cách dùng: scripts/manage-operations-issue.sh <open|close>" >&2
  exit 1
fi

if [[ -z "$repository" || -z "$title" ]]; then
  echo "Thiếu GITHUB_REPOSITORY hoặc OPS_ISSUE_TITLE." >&2
  exit 1
fi

issue_numbers="$({
  gh issue list \
    --repo "$repository" \
    --state open \
    --limit 100 \
    --json number,title
} | node -e '
  let input = "";
  process.stdin.on("data", chunk => { input += chunk; });
  process.stdin.on("end", () => {
    const issues = JSON.parse(input);
    for (const issue of issues) {
      if (issue.title === process.env.OPS_ISSUE_TITLE) console.log(issue.number);
    }
  });
')"

if [[ "$action" == "open" ]]; then
  if [[ -n "$issue_numbers" ]]; then
    echo "Issue cảnh báo đã mở: #$(printf '%s\n' "$issue_numbers" | head -n 1)"
    exit 0
  fi

  body="${OPS_ISSUE_BODY:-TrọBill phát hiện một sự cố vận hành.}"
  if [[ -n "$run_url" ]]; then
    body="${body}

Workflow: ${run_url}"
  fi
  gh issue create \
    --repo "$repository" \
    --title "$title" \
    --body "$body" \
    --assignee "$assignee"
  exit 0
fi

if [[ -z "$issue_numbers" ]]; then
  echo "Không có issue cảnh báo đang mở để đóng."
  exit 0
fi

while IFS= read -r issue_number; do
  [[ -n "$issue_number" ]] || continue
  recovery_message="Hệ thống đã phục hồi và workflow kiểm tra thành công."
  if [[ -n "$run_url" ]]; then
    recovery_message="${recovery_message} ${run_url}"
  fi
  gh issue close "$issue_number" \
    --repo "$repository" \
    --comment "$recovery_message"
done <<< "$issue_numbers"

