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
