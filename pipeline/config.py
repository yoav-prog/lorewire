"""Pipeline configuration.

Real runs read keys from the environment. The pipeline auto-loads the repo-root
`.env` and `.env.local`, then `pipeline/.env` if present (no external
dependency), so keys live in a gitignored file and never pass through chat or
git. Shell/exported variables always win over the files.
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def _load_dotenv() -> None:
    # Load repo-root .env, repo-root .env.local, then pipeline/.env (all
    # gitignored). Exported shell vars win; among files, the first to set a key
    # wins. Secret keys live in .env.local beside the GitHub/Vercel tokens.
    for env_file in (ROOT.parent / ".env", ROOT.parent / ".env.local", ROOT / ".env"):
        if not env_file.exists():
            continue
        for raw in env_file.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            key, val = key.strip(), val.strip().strip('"').strip("'")
            if key and key not in os.environ:
                os.environ[key] = val


_load_dotenv()


def _detect_vercel_runtime() -> None:
    """Set VERCEL=1 in os.environ when the pipeline module is loaded from
    Vercel's read-only Lambda mount (`/var/task/`).

    Why: production hit `OSError: [Errno 30] Read-only file system:
    '/var/task/api/_lib/lorewire-app'` while a story job's media stage
    tried to mkdir the legacy public/generated/ tree. The relevant
    detection (`pipeline/media.py:_staging_dir`) routes to /tmp ONLY when
    `os.environ.get("VERCEL")` is truthy. Vercel docs say VERCEL=1 is set
    on every function invocation, but observed prod runs are crashing
    against the legacy path — meaning that env var is not always set
    when the Python serverless function runs. The unmistakable signature
    is the deployment mount itself: `/var/task` is Lambda's read-only
    root. If the pipeline package was loaded from a path under there,
    no amount of mkdir is going to write back to the bundle, and we MUST
    route writes to /tmp.

    Setting VERCEL=1 here means every downstream
    `os.environ.get("VERCEL")` check Just Works regardless of whether
    the runtime set it.
    """
    if os.environ.get("VERCEL") or os.environ.get("VERCEL_ENV"):
        return
    try:
        if str(ROOT).startswith("/var/task"):
            os.environ["VERCEL"] = "1"
    except Exception:
        # Belt + suspenders. A startup probe must never crash the import.
        pass


_detect_vercel_runtime()

DB_PATH = os.environ.get("PIPELINE_DB", str(ROOT / "lorewire.db"))


def env(name: str, default: str | None = None) -> str | None:
    return os.environ.get(name, default)


def has_llm() -> bool:
    return bool(os.environ.get("OPENAI_API_KEY") or os.environ.get("LLM_API_KEY"))


def missing(group: str) -> list[str]:
    """Required env vars for a stage that are not set (for real, non-dry runs)."""
    if group == "llm":
        return [] if has_llm() else ["OPENAI_API_KEY (or LLM_API_KEY)"]
    req = {"scrape": ["DECODO_TOKEN"], "images": ["KIE_API_KEY"], "voice": ["TTS_PROVIDER"]}
    return [k for k in req.get(group, []) if not os.environ.get(k)]
