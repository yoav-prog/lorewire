"""Minimal LLM client, standard library only.

The model is chosen from the registry/DB selection (admin-managed), NOT from an
env var. Only the API key comes from the environment. Request shape mirrors the
working calls in /from-amir.
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

from pipeline import config, models

# Running token totals for this process, for cost metering.
totals = {"calls": 0, "prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}


def _resolve(model_id: str | None = None) -> tuple[str, str, str]:
    selected = model_id or models.get_selected("llm")  # e.g. "openai/gpt-5.4-mini"
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


def chat(prompt: str, max_tokens: int = 2000, model: str | None = None) -> str:
    """Call the active LLM (or `model` when set, e.g. 'openai/gpt-5-nano').

    `model` is a registry id and falls back to the admin's stage selection when
    omitted. Used by smaller sub-stages (image-prompt builder, future title
    generator) that don't need the full article-rewrite model's budget.
    """
    key, base, model = _resolve(model)
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
    # Retry transient network timeouts / rate limits / 5xx with exponential
    # backoff; fail fast on other 4xx. The hosted endpoints occasionally drop a
    # read mid-request, and one drop should not sink a multi-call generation.
    delay = 2.0
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=300) as resp:
                data = json.loads(resp.read().decode("utf-8"))
            break
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < 3:
                time.sleep(delay)
                delay *= 2
                continue
            detail = e.read().decode("utf-8", "ignore")[:300]
            raise RuntimeError(f"LLM HTTP {e.code}: {detail}") from e
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < 3:
                time.sleep(delay)
                delay *= 2
                continue
            raise RuntimeError(f"LLM request failed after 4 attempts: {e}") from e
    usage = data.get("usage", {}) or {}
    totals["calls"] += 1
    totals["prompt_tokens"] += usage.get("prompt_tokens", 0)
    totals["completion_tokens"] += usage.get("completion_tokens", 0)
    totals["total_tokens"] += usage.get("total_tokens", 0)
    return data["choices"][0]["message"]["content"].strip()
