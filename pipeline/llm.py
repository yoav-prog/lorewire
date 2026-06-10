"""Minimal LLM client, standard library only (no extra dependency).

OpenAI by default (OPENAI_API_KEY); or any OpenAI-compatible endpoint via
LLM_API_KEY + LLM_BASE_URL + LLM_MODEL. The request shape mirrors the working
calls in the reference scripts under /from-amir.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

from pipeline import config


def _settings() -> tuple[str, str, str]:
    if config.env("OPENAI_API_KEY"):
        key = config.env("OPENAI_API_KEY") or ""
        base = config.env("LLM_BASE_URL", "https://api.openai.com/v1") or "https://api.openai.com/v1"
        model = config.env("OPENAI_MODEL") or config.env("LLM_MODEL") or "gpt-5.4-mini"
        return key, base, model
    if config.env("LLM_API_KEY"):
        key = config.env("LLM_API_KEY") or ""
        base = config.env("LLM_BASE_URL", "https://api.openai.com/v1") or "https://api.openai.com/v1"
        model = config.env("LLM_MODEL", "gpt-5.4-mini") or "gpt-5.4-mini"
        return key, base, model
    raise RuntimeError("No LLM key set (OPENAI_API_KEY or LLM_API_KEY).")


def chat(prompt: str, max_tokens: int = 2000) -> str:
    key, base, model = _settings()
    body = json.dumps(
        {
            "model": model,
            "messages": [{"role": "user", "content": prompt}],
            "max_completion_tokens": max_tokens,
        }
    ).encode("utf-8")
    req = urllib.request.Request(
        f"{base.rstrip('/')}/chat/completions",
        data=body,
        headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "ignore")[:300]
        raise RuntimeError(f"LLM HTTP {e.code}: {detail}") from e
    return data["choices"][0]["message"]["content"].strip()
