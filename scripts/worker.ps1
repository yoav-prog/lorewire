# PowerShell wrapper that runs the story_jobs worker from the right cwd.
#
# `python -m pipeline.story_jobs_worker` only resolves when the current
# working directory is the repo root (the directory that contains
# `pipeline/`). Running it from `scripts/` or `lorewire-app/` fails with
# `ModuleNotFoundError: No module named 'pipeline'`. This wrapper resolves
# the script's own location, cd's to the parent (which IS the repo root),
# and invokes the worker with the same arguments you'd type by hand.
#
# Usage:
#   .\scripts\worker.ps1                  # default: poll every 5s
#   .\scripts\worker.ps1 --poll-seconds 3
#   .\scripts\worker.ps1 --once           # process one job and exit
#
# Stops on Ctrl+C — the Python worker catches KeyboardInterrupt and
# prints "[story-jobs worker] stopping on interrupt" before exiting.

$ErrorActionPreference = "Stop"

$RepoRoot = Split-Path -Parent $PSScriptRoot
Set-Location $RepoRoot

Write-Host "[worker.ps1] cwd=$RepoRoot" -ForegroundColor DarkGray
Write-Host "[worker.ps1] starting python -m pipeline.story_jobs_worker $args" -ForegroundColor DarkGray

# -u: unbuffered stdout so log lines appear immediately, not after a
# multi-line buffer fills. Important for "is it alive?" debugging.
python -u -m pipeline.story_jobs_worker @args
