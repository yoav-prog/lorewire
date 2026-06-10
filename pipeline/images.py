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
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"kie HTTP {e.code}: {e.read().decode('utf-8', 'ignore')[:200]}") from e


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
    slug = MODEL_SLUG.get(selected)
    if not slug:
        raise NotImplementedError(
            f"image model {selected!r} is not wired; options: {list(MODEL_SLUG)}"
        )
    return slug


def generate(
    prompt: str,
    aspect_ratio: str = "3:4",
    resolution: str = "1K",
    poll_timeout: int = 180,
) -> str:
    """Create one image, poll to completion, return its kie-hosted URL."""
    created = _post(
        "createTask",
        {
            "model": _slug(),
            "input": {"prompt": prompt, "aspect_ratio": aspect_ratio, "resolution": resolution},
        },
    )
    if created.get("code") != 200:
        raise RuntimeError(f"kie createTask failed: {created}")
    task_id = created["data"]["taskId"]

    deadline = time.time() + poll_timeout
    while time.time() < deadline:
        data = _get(f"recordInfo?taskId={task_id}").get("data", {})
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


def download(url: str, dest: Path) -> Path:
    dest.parent.mkdir(parents=True, exist_ok=True)
    # The kie tempfile host rejects the default urllib user-agent (403).
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (LoreWire pipeline)"})
    with urllib.request.urlopen(req, timeout=120) as resp:
        dest.write_bytes(resp.read())
    return dest
