"""Image-output safety for user submissions (Phase 4 of
_plans/2026-06-29-user-submitted-stories.md).

Text moderation never sees the AI-generated images. Before a SUBMISSION render
goes any further, moderate the visible frames (the base character image + the
scene frames). A flagged image raises ImageSafetyError, which the short-render
worker catches and fails the render — so a problem image never publishes under the
brand. Gated to submission-origin stories by the caller (admin Reddit renders are
unaffected).

Uses OpenAI's free omni-moderation-latest with image_url inputs, over urllib (the
pipeline has no openai package), matching pipeline/llm.py's HTTP style. Fail
CLOSED: if the check cannot run (no key, API error), the render halts rather than
publishing an unchecked image — a render the admin already approved is recoverable
by retry; an unchecked bad image is not.
"""
from __future__ import annotations

import json
import urllib.error
import urllib.request

from pipeline import config

_MODERATION_URL = "https://api.openai.com/v1/moderations"
_MODEL = "omni-moderation-latest"
_TIMEOUT = 30


class ImageSafetyError(RuntimeError):
    """Raised to halt a render whose generated image was flagged, or that could
    not be checked. The short-render worker's per-row `except` catches it and
    fails the render."""


def check_images_safe(urls: list[str]) -> None:
    """Moderate the given image URLs in a single call. Raises ImageSafetyError if
    any image is flagged, or if the check cannot run. No-op for an empty list."""
    clean = [u for u in urls if u]
    if not clean:
        return

    key = config.env("OPENAI_API_KEY")
    if not key:
        raise ImageSafetyError("image safety unavailable: OPENAI_API_KEY not set")

    payload = {
        "model": _MODEL,
        "input": [{"type": "image_url", "image_url": {"url": u}} for u in clean],
    }
    req = urllib.request.Request(
        _MODERATION_URL,
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=_TIMEOUT) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except (urllib.error.URLError, TimeoutError, ValueError) as e:
        raise ImageSafetyError(
            f"image safety unavailable: {type(e).__name__}"
        ) from e

    for i, res in enumerate(data.get("results") or []):
        if res.get("flagged"):
            cats = [c for c, on in (res.get("categories") or {}).items() if on]
            raise ImageSafetyError(
                f"generated image {i} flagged: {', '.join(cats) or 'unspecified'}"
            )
