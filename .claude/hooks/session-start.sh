#!/bin/bash
# Cloud sessions start from a fresh clone: install and build once here, so the
# first test run does not pay for it and lib/ is never missing.
set -euo pipefail
[ "${CLAUDE_CODE_REMOTE:-}" = "true" ] || exit 0
cd "$CLAUDE_PROJECT_DIR"
pnpm install --frozen-lockfile
pnpm run build
echo 'export DSH_TELEMETRY_DISABLED=1' >> "$CLAUDE_ENV_FILE"
