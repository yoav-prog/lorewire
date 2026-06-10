"""Minimal LLM client, standard library only.

The model is chosen from the registry/DB selection (admin-managed), NOT from an
env var. Only the API key comes from the environment. Request shape mirrors the
working calls in /from-amir.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

from pipeline import config, models


def _resolve() -> tuple[str, str, str]:
    selected = models.get_selected("llm")  # e.g. "openai/gpt-5.4-mini"
    provider, _, model = selected.partition("/")
    if provider == "openai":
        key = config.env("OPENAI_API_KEY")
        if not key:
            raise RuntimeError("OPENAI_API_KEY is not set. Add it to pipeline/.env to run the LLM stages.")
        base = config.env("OPENAI_BASE_URL", "https://api.openai.com/v1")
        return key, base, model
    raise NotImplementedError(
        f"LLM provider {provider!r} (model {selected!r}) is in the registry but not wired yet. "
        "Switch with `python -m pipeline.models set llm openai/gpt-5.4-mini`, or wire the adapter."
    )


def chat(prompt: str, max_tokens: int = 2000) -> str:
    key, base, model = _resolve()
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
