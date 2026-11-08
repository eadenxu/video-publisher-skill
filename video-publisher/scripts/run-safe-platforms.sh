#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <package.json> [task-suffix] [platform...]" >&2
  echo "   or: $0 --package <package.json> [--platform name]... [--task-suffix name] [--job-id id]" >&2
  echo "   or: $0 --operation diagnose-binding" >&2
  echo "   or: $0 --operation maintenance-diagnose --profile-id ID --display-name NAME --account-id ID --maintenance-space-name vp-maint-NAME --maintenance-root DIR" >&2
  echo "      maintenance-diagnose requires VIDEO_PUBLISHER_CONFIG from: node scripts/config.mjs init-maintenance-account && node scripts/config.mjs validate-maintenance" >&2
  echo "   or: $0 --operation maintenance-space-status --profile-id ID --display-name NAME --account-id ID --maintenance-space-name EXACT" >&2
  echo "      maintenance-space-status only lists one exact name. It does not create, resume, or close." >&2
  echo "   or: $0 --cleanup-only [--state-root DIR] [--package file] [--job-id id]" >&2
  echo "Options: --operation auto|create|resume|inspect|replace-cover|repost|diagnose-binding|diagnose-dedup|maintenance-diagnose|maintenance-space-status --replace-cover --confirm-new-copy" >&2
  echo "         --inspect-only --confirm-original-rights --fresh-space --reuse-space --force-fresh-space" >&2
  echo "         --keep-space --close-on-complete --cleanup-stale-spaces --no-cleanup-stale-spaces" >&2
  echo "         --space-prefix NAME --space-name NAME --space-suffix SUFFIX" >&2
  echo "         --cleanup-name NAME --cleanup-prefix PREFIX --state-root DIR" >&2
  echo "         --check-concurrency N --upload-concurrency N" >&2
  exit 2
fi

exec node "${script_dir}/v2/publisher.mjs" "$@"
