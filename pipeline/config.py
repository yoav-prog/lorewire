"""Pipeline configuration.

Real runs read keys from the environment (copy .env.example to .env and fill
in rotated keys; load it with your shell or python-dotenv). Dry runs need no
keys at all, so the flow can be verified offline.
"""
from __future__ import annotations

import os
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DB_PATH = os.environ.get("PIPELINE_DB", str(ROOT / "lorewire.db"))

# Env vars required per stage for REAL (non-dry-run) execution. The model is
# kept provider-agnostic (admin-selectable, per the plan): point LLM_BASE_URL
# at kie.ai / OpenAI / Anthropic and set LLM_MODEL accordingly.
REQUIRED_KEYS: dict[str, list[str]] = {
    "scrape": ["DECODO_TOKEN"],
    "llm": ["LLM_API_KEY", "LLM_BASE_URL", "LLM_MODEL"],
    "images": ["KIE_API_KEY"],
    "voice": ["TTS_PROVIDER"],
}


def env(name: str, default: str | None = None) -> str | None:
    return os.environ.get(name, default)


def missing(group: str) -> list[str]:
    """Return the required env vars for a stage that are not set."""
    return [k for k in REQUIRED_KEYS.get(group, []) if not os.environ.get(k)]
