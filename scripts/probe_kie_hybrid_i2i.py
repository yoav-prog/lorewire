"""One-shot diagnostic: probe kie's gpt-image-2-image-to-image with the
exact hybrid two-URL input shape the failing `hero_thumbnail_from_short`
job uses, plus a single-URL control probe.

Run with:
    python scripts/probe_kie_hybrid_i2i.py [story_id]

Defaults to story_id="envelope" — the story whose hero+thumb finisher
keeps failing with "all five i2i calls failed" (2026-06-23). Pulls the
latest short_renders row for that story, extracts character_base_url
and the picker-chosen scene URLs (idx 0 + idx 5, per the admin
timeline's "Picker chose hero=#0 thumb=#5"), then:

  1. HEAD-checks every URL kie would be asked to fetch (character +
     scene[0] + scene[5]) and prints status + content-type. If kie
     can't reach one of them, that's the answer.
  2. POSTs ONE kie createTask with input_urls=[character, scene[0]] —
     mirrors the failing "hero portrait" variant. Polls recordInfo
     every 3s up to 90s and prints state + failMsg + resultUrls
     verbatim.
  3. POSTs ONE control kie createTask with input_urls=[character]
     only — mirrors the proven-working _regen_hero_from_short single-
     ref path. Same poll.

The two probes together answer:
  - URL access broken? -> step 1 reveals non-200 status on a URL
  - kie shape rejection of 2 refs? -> step 2 fails, step 3 succeeds
  - kie down / API contract changed? -> both 2 and 3 fail similarly

Cost: two paid kie createTask calls (~$0.04 total at current pricing).
Diagnostic-only, no tests, safe to delete after the issue is closed.
"""
from __future__ import annotations

import json
import os
import sys
import time
import urllib.error
import urllib.request

from dotenv import load_dotenv

load_dotenv(".env.local")
import psycopg

KIE_BASE = "https://api.kie.ai/api/v1/jobs"
KIE_MODEL = "gpt-image-2-image-to-image"
POLL_TIMEOUT_S = 90
POLL_INTERVAL_S = 3
# Picker indices taken verbatim from the failing job's admin timeline
# ("Picker chose hero=#0 thumb=#5"). Hardcoded so the probe reproduces
# exactly what kie was asked to do, not a fresh picker call.
HERO_SCENE_IDX = 0
THUMB_SCENE_IDX = 5
PROBE_PROMPT = (
    "Test probe — redraw the character from the first reference image "
    "in a simple neutral pose. Plain background. No text. Diagnostic only."
)


def _log(tag: str, **kv: object) -> None:
    payload = " ".join(f"{k}={v!r}" for k, v in kv.items())
    print(f"[probe kie i2i {tag}] {payload}")


def _head(url: str) -> tuple[int | str, str]:
    """Public-fetch sanity check. Returns (status, content_type).

    kie's tempfile host rejects the default urllib user-agent with 403
    (see pipeline/images.py download()); GCS public objects respond to
    a normal-looking UA. Treat anything other than 200 + image/* as a
    smoking gun for "kie can't fetch this URL either".
    """
    req = urllib.request.Request(
        url,
        method="HEAD",
        headers={"User-Agent": "Mozilla/5.0 (LoreWire probe)"},
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, resp.headers.get("Content-Type", "")
    except urllib.error.HTTPError as e:
        return e.code, ""
    except (urllib.error.URLError, TimeoutError) as e:
        return f"network:{e}", ""


def _post_create(api_key: str, body: dict) -> dict:
    data = json.dumps(body).encode("utf-8")
    req = urllib.request.Request(
        f"{KIE_BASE}/createTask",
        data=data,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            return {
                "http_status": resp.status,
                "body": json.loads(resp.read().decode("utf-8")),
            }
    except urllib.error.HTTPError as e:
        return {
            "http_status": e.code,
            "body": e.read().decode("utf-8", "ignore")[:500],
        }
    except (urllib.error.URLError, TimeoutError) as e:
        return {"http_status": f"network:{e}", "body": ""}


def _poll(api_key: str, task_id: str) -> dict:
    deadline = time.time() + POLL_TIMEOUT_S
    last: dict = {}
    while time.time() < deadline:
        req = urllib.request.Request(
            f"{KIE_BASE}/recordInfo?taskId={task_id}",
            headers={"Authorization": f"Bearer {api_key}"},
            method="GET",
        )
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                last = json.loads(resp.read().decode("utf-8")).get("data", {}) or {}
        except (urllib.error.URLError, TimeoutError):
            time.sleep(POLL_INTERVAL_S)
            continue
        state = last.get("state")
        if state in {"success", "fail"}:
            return last
        time.sleep(POLL_INTERVAL_S)
    return {"_timeout": True, **last}


def _probe(label: str, api_key: str, input_urls: list[str]) -> None:
    _log(f"{label} submit", input_url_count=len(input_urls), model=KIE_MODEL)
    body = {
        "model": KIE_MODEL,
        "input": {
            "prompt": PROBE_PROMPT,
            "aspect_ratio": "3:4",
            "resolution": "1K",
            "input_urls": input_urls,
            "output_format": "png",
        },
    }
    created = _post_create(api_key, body)
    _log(f"{label} createTask", **created)
    body_ok = isinstance(created.get("body"), dict) and created["body"].get("code") == 200
    if not body_ok:
        _log(f"{label} stop", reason="createTask non-200 — see body above")
        return
    task_id = created["body"]["data"]["taskId"]
    _log(f"{label} polling", task_id=task_id, timeout_s=POLL_TIMEOUT_S)
    result = _poll(api_key, task_id)
    state = result.get("state")
    fail_msg = result.get("failMsg")
    result_json = result.get("resultJson")
    try:
        urls = (
            json.loads(result_json).get("resultUrls", [])
            if isinstance(result_json, str)
            else []
        )
    except json.JSONDecodeError:
        urls = []
    _log(
        f"{label} done",
        state=state,
        failMsg=fail_msg,
        result_url_count=len(urls),
        timed_out=bool(result.get("_timeout")),
    )
    if urls:
        _log(f"{label} sample_url", url=urls[0])


def main(argv: list[str]) -> int:
    story_id = argv[1] if len(argv) > 1 else "envelope"
    db_url = os.environ.get("DATABASE_URL")
    api_key = os.environ.get("KIE_API_KEY")
    if not db_url:
        print("DATABASE_URL not set; aborting", file=sys.stderr)
        return 1
    if not api_key:
        print("KIE_API_KEY not set; aborting", file=sys.stderr)
        return 1

    _log("start", story_id=story_id, db_host=db_url.split("@")[-1][:40])
    with psycopg.connect(db_url) as con:
        with con.cursor() as cur:
            cur.execute(
                "SELECT props, status FROM short_renders "
                "WHERE story_id = %s "
                "ORDER BY requested_at DESC LIMIT 1",
                (story_id,),
            )
            row = cur.fetchone()
    if row is None:
        _log("abort", reason="no short_renders row for this story")
        return 2
    props_raw, status = row
    _log("short_render", status=status, props_len=len(props_raw or "") if isinstance(props_raw, str) else "json-decoded")
    if isinstance(props_raw, dict):
        props = props_raw
    else:
        try:
            props = json.loads(props_raw or "{}")
        except json.JSONDecodeError as e:
            _log("abort", reason=f"props is not valid JSON: {e}")
            return 3
    character = (props.get("character_base_url") or "").strip()
    if not character:
        _log("abort", reason="props has no character_base_url")
        return 4
    scenes = props.get("scenes")
    if not isinstance(scenes, list) or not scenes:
        scenes = props.get("doodle_frames") or []
    scenes = [s for s in scenes if isinstance(s, dict) and s.get("url")]
    _log("scenes", count=len(scenes))
    if len(scenes) <= max(HERO_SCENE_IDX, THUMB_SCENE_IDX):
        _log(
            "abort",
            reason=f"need at least {THUMB_SCENE_IDX + 1} scenes; have {len(scenes)}",
        )
        return 5
    hero_scene = scenes[HERO_SCENE_IDX]["url"]
    thumb_scene = scenes[THUMB_SCENE_IDX]["url"]

    # Step 1: public-fetch checks for every URL kie would be asked to load.
    for label, url in (
        ("character", character),
        (f"scene[{HERO_SCENE_IDX}]", hero_scene),
        (f"scene[{THUMB_SCENE_IDX}]", thumb_scene),
    ):
        st, ctype = _head(url)
        _log("url_check", what=label, url=url, status=st, content_type=ctype)

    # Step 2: hybrid two-URL probe — exactly what the failing hero
    # portrait call submits. If this fails and step 3 succeeds, the
    # gpt-image-2 i2i contract is single-image and the hybrid feature
    # is fundamentally broken on this model.
    _probe("two_url", api_key, [character, hero_scene])

    # Step 3: single-URL control — mirrors the proven-working
    # _regen_hero_from_short path. Establishes whether kie + auth +
    # the character URL are healthy in isolation.
    _probe("one_url", api_key, [character])

    _log("end")
    return 0


if __name__ == "__main__":
    raise SystemExit(main(sys.argv))
