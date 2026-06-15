"""kie.ai image generation: async createTask, then poll recordInfo.

The active image model is the admin selection from the registry/DB (default
gpt-image-2). Only KIE_API_KEY comes from the environment. Results are
kie-hosted URLs; download() saves them locally for durability during
validation (swap for GCS once a bucket/credentials are configured).
"""
from __future__ import annotations

import json
import time
import urllib.error
import urllib.request
from pathlib import Path

from pipeline import config, models

KIE_BASE = "https://api.kie.ai/api/v1/jobs"

# Registry id -> kie market model slug.
MODEL_SLUG = {
    "kie/gpt-image-2": "gpt-image-2-text-to-image",
    "kie/gpt-image-2-i2i": "gpt-image-2-image-to-image",
    "kie/nano-banana-2": "nano-banana-2",
    "kie/nano-banana-pro": "nano-banana-pro",
}

# Running totals for cost metering this process.
totals = {"images": 0, "credits": 0}


def _key() -> str:
    key = config.env("KIE_API_KEY")
    if not key:
        raise RuntimeError("KIE_API_KEY is not set. Add it to .env.local to run image stages.")
    return key


def _post(path: str, body: dict) -> dict:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{KIE_BASE}/{path}",
        data=data,
        headers={"Authorization": f"Bearer {_key()}", "Content-Type": "application/json"},
        method="POST",
    )
    # Retry transient timeouts / rate limits / 5xx with backoff; fail fast on
    # other 4xx. kie's endpoints occasionally drop a read mid-request.
    delay = 2.0
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=60) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503, 504) and attempt < 3:
                time.sleep(delay)
                delay *= 2
                continue
            raise RuntimeError(f"kie HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:200]}") from e
        except (urllib.error.URLError, TimeoutError) as e:
            if attempt < 3:
                time.sleep(delay)
                delay *= 2
                continue
            raise RuntimeError(f"kie request failed after 4 attempts: {e}") from e
    raise RuntimeError("kie request: unreachable")


def _get(path: str) -> dict:
    req = urllib.request.Request(
        f"{KIE_BASE}/{path}",
        headers={"Authorization": f"Bearer {_key()}"},
        method="GET",
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def _slug() -> str:
    selected = models.get_selected("images")  # e.g. "kie/gpt-image-2"
    return _slug_for(selected)


def _slug_for(registry_id: str) -> str:
    """Map a registry id (e.g. "kie/nano-banana-2") to the kie API
    model slug. Raises NotImplementedError on unknown ids so a typo in
    the override path fails loudly instead of silently falling back
    to the global selection."""
    slug = MODEL_SLUG.get(registry_id)
    if not slug:
        raise NotImplementedError(
            f"image model {registry_id!r} is not wired; options: {list(MODEL_SLUG)}"
        )
    return slug


def generate(
    prompt: str,
    aspect_ratio: str = "3:4",
    resolution: str = "1K",
    poll_timeout: int = 180,
    image_input: list[str] | None = None,
    model: str | None = None,
) -> str:
    """Create one image, poll to completion, return its kie-hosted URL.

    `image_input` (added 2026-06-14 for the world-bible plan) is an
    optional list of reference image URLs. Only `kie/nano-banana-2` and
    `kie/nano-banana-pro` accept references; passing refs to
    `kie/gpt-image-2` is silently dropped (gpt-image-2 has no
    image_input field in its API contract — verified against kie docs).
    Refs are capped at 4 here even though kie accepts up to 14, because
    larger ref sets degrade scene coherence in tests and 4 covers the
    realistic on-screen entity count (lead + 1-2 supporting + 1 item).

    `model` (added 2026-06-14) optionally overrides the registry-active
    selection from `models.get_selected("images")`. Used by the scene
    path so the world-bible flow can pin nano-banana-2 for refs while
    other asset types (hero, props, mouth swap) keep the global
    selection. Pass a kie/registry id (e.g. "kie/nano-banana-2"); the
    function maps it through `MODEL_SLUG` like any other selection.
    """
    refs: list[str] = []
    if image_input:
        # Drop empty / falsy URLs defensively — a bible row with a
        # missing reference_image_url shouldn't poison the call.
        refs = [u for u in image_input if isinstance(u, str) and u][:4]
    inputs: dict = {
        "prompt": prompt,
        "aspect_ratio": aspect_ratio,
        "resolution": resolution,
    }
    slug = _slug_for(model) if model else _slug()
    if refs and slug == "gpt-image-2-image-to-image":
        # kie's gpt-image-2 i2i takes the source image(s) as `input_urls`
        # (NOT `image_input`). It is the strongest at keeping a character
        # identical across new poses / places / moods — the model yt-studio
        # uses for variant edits. See
        # _reference/youtubestudio/src/lib/gpt-image-2-edit.ts.
        inputs["input_urls"] = refs
        inputs["output_format"] = "png"
    elif refs and slug in {"nano-banana-2", "nano-banana-pro"}:
        # kie's contract: `image_input` is the ref-image array on both
        # nano-banana models. Output format default png matches our
        # existing gpt-image-2 path.
        inputs["image_input"] = refs
        inputs["output_format"] = "png"
    created = _post(
        "createTask",
        {"model": slug, "input": inputs},
    )
    if created.get("code") != 200:
        raise RuntimeError(f"kie createTask failed: {created}")
    task_id = created["data"]["taskId"]

    deadline = time.time() + poll_timeout
    while time.time() < deadline:
        try:
            data = _get(f"recordInfo?taskId={task_id}").get("data", {})
        except (urllib.error.URLError, TimeoutError):
            time.sleep(3)
            continue
        state = data.get("state")
        if state == "success":
            urls = json.loads(data.get("resultJson") or "{}").get("resultUrls", [])
            if not urls:
                raise RuntimeError(f"kie task {task_id} succeeded but returned no resultUrls")
            totals["images"] += 1
            totals["credits"] += data.get("creditsConsumed", 0) or 0
            return urls[0]
        if state == "fail":
            raise RuntimeError(f"kie task {task_id} failed: {data.get('failMsg')}")
        time.sleep(3)
    raise RuntimeError(f"kie task {task_id} timed out after {poll_timeout}s")


def edit_image(image_url: str, prompt: str, aspect_ratio: str = "3:4", poll_timeout: int = 180) -> str:
    """Edit an existing image via kie's qwen2/image-edit endpoint.

    Same createTask / recordInfo flow as generate(), different model + input
    shape. Used by the MouthSwap pipeline step to remove a character's mouth
    so SVG mouth shapes can be overlaid at render time. Verified live against
    the envelope hero on 2026-06-11; the model preserved the surrounding
    composition and replaced the mouth with neutral skin in the same style.
    Cost: ~5-6 kie credits per edit (~$0.03).
    """
    created = _post(
        "createTask",
        {
            "model": "qwen2/image-edit",
            "input": {
                "prompt": prompt,
                "image_url": image_url,
                "image_size": aspect_ratio,
                "output_format": "png",
            },
        },
    )
    if created.get("code") != 200:
        raise RuntimeError(f"kie edit createTask failed: {created}")
    task_id = created["data"]["taskId"]

    deadline = time.time() + poll_timeout
    while time.time() < deadline:
        try:
            data = _get(f"recordInfo?taskId={task_id}").get("data", {})
        except (urllib.error.URLError, TimeoutError):
            time.sleep(3)
            continue
        state = data.get("state")
        if state == "success":
            urls = json.loads(data.get("resultJson") or "{}").get("resultUrls", [])
            if not urls:
                raise RuntimeError(f"kie edit task {task_id} succeeded but returned no resultUrls")
            totals["images"] += 1
            totals["credits"] += data.get("creditsConsumed", 0) or 0
            return urls[0]
        if state == "fail":
            raise RuntimeError(f"kie edit task {task_id} failed: {data.get('failMsg')}")
        time.sleep(3)
    raise RuntimeError(f"kie edit task {task_id} timed out after {poll_timeout}s")


def download(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    # The kie tempfile host rejects the default urllib user-agent (403).
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (LoreWire pipeline)"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        dest.write_bytes(resp.read())
    return dest
