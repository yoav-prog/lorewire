#!/usr/bin/env bash
# POSIX wrapper for the story_jobs worker. Mirrors scripts/worker.ps1.
#
# `python -m pipeline.story_jobs_worker` only resolves when the current
# working directory is the repo root. This wrapper resolves its own path,
# cd's there, and invokes the worker with the same arguments you'd type
# by hand.
#
# Usage:
#   ./scripts/worker.sh                  # default: poll every 5s
#   ./scripts/worker.sh --poll-seconds 3
#   ./scripts/worker.sh --once           # process one job and exit

set -euo pipefail

# Resolve the script's directory even if invoked via a symlink.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

echo "[worker.sh] cwd=$REPO_ROOT"
echo "[worker.sh] starting python -m pipeline.story_jobs_worker $*"

# -u: unbuffered stdout so log lines appear immediately. Important for
# diagnosing the "is it alive?" case during a long media run.
exec python -u -m pipeline.story_jobs_worker "$@"
