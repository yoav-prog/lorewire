"""Request-driven Vercel Python endpoint: synthesize a short voiceover preview.

The admin /admin/voiceovers page lets an admin hear a preset before committing
it. The TS `previewVoiceoverAction` (behind requireAdmin) POSTs the preset's
config here with the shared CRON_SECRET; this endpoint renders a fixed sample
line through the same `narration.render_narration` path the shorts pipeline uses
and returns the MP3 inline as base64 (no GCS object to clean up later).

Mirrors the drain handlers' shape: CRON_SECRET Bearer auth, `_lib` sys.path
injection for the vendored pipeline, structured logs, fail-closed. Unlike the
drains this is POST-only and synchronous — one synth per click, so there is no
queue, lock, or per-tick budget.

Runtime: pure Python + HTTPS (Google Cloud TTS + STT) writing to /tmp, so it
runs end-to-end on Vercel. Needs the GOOGLE_TTS_* creds in the environment;
without them the synth raises and the handler returns 500 with the message.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import sys
import tempfile
from http.server import BaseHTTPRequestHandler
from pathlib import Path

_HERE = Path(__file__).resolve().parent
_LIB = _HERE / "_lib"
if str(_LIB) not in sys.path:
    sys.path.insert(0, str(_LIB))

from pipeline import narration  # noqa: E402

LOG = logging.getLogger("preview_voiceover")
LOG.setLevel(logging.INFO)
if not LOG.handlers:
    _h = logging.StreamHandler(sys.stdout)
    _h.setFormatter(logging.Formatter("%(message)s"))
    LOG.addHandler(_h)

# A punchy hook-first sample so the admin hears the cold-open + pause + pace the
# real shorts will use, not a flat sentence.
SAMPLE_TEXT = (
    "She said yes. Then she brought her ex. "
    "Let's back up three days. They matched on a Monday, talked all week, and "
    "planned the perfect first date. Then the door opens, and she is not alone. "
    "Would you have stayed, or walked out?"
)
# Hard cap on caller-supplied sample length so a preview can't be turned into a
# cheap bulk-synth vector.
MAX_TEXT_CHARS = 600


def _log(event: str, **fields) -> None:
    LOG.info(f"[preview_voiceover {event}] {json.dumps(fields, default=str)}")


def _is_authorized(authorization_header: str | None) -> bool:
    expected = os.environ.get("CRON_SECRET")
    if not expected or not authorization_header:
        return False
    return authorization_header == f"Bearer {expected}"


def render_preview(config: dict) -> dict:
    """Synthesize the sample with the given voiceover config and return the MP3
    as base64. `config` keys: provider, voice_id, style_prompt, speaking_rate,
    hook_pause, text (optional override). Pure-ish entry point for tests."""
    provider = (config.get("provider") or "").strip()
    voice_id = (config.get("voice_id") or "").strip()
    if not provider or not voice_id:
        raise ValueError("preview requires both provider and voice_id")
    text = (config.get("text") or SAMPLE_TEXT).strip()[:MAX_TEXT_CHARS]
    rate = config.get("speaking_rate")
    work = Path(tempfile.mkdtemp(prefix="vo-preview-"))
    dest = work / "preview.mp3"
    narration.render_narration(
        text,
        dest,
        override_provider=provider,
        override_voice_id=voice_id,
        speaking_rate=(float(rate) if rate not in (None, "") else None),
        hook_pause=bool(config.get("hook_pause")),
        # No structured hook here; the pause anchors on the first sentence.
        style_prompt=(config.get("style_prompt") or None),
    )
    audio_b64 = base64.b64encode(dest.read_bytes()).decode("ascii")
    try:
        dest.unlink()
        work.rmdir()
    except OSError:
        pass
    return {"audio_base64": audio_b64, "content_type": "audio/mpeg"}


class handler(BaseHTTPRequestHandler):  # noqa: N801 — Vercel expects this name
    def do_POST(self) -> None:  # noqa: N802
        auth = self.headers.get("authorization") or self.headers.get("Authorization")
        if not _is_authorized(auth):
            _log("auth_fail", ip=self.headers.get("x-forwarded-for", "unknown"))
            self._json(401, {"error": "unauthorized"})
            return
        try:
            length = int(self.headers.get("content-length") or 0)
            raw = self.rfile.read(length) if length else b"{}"
            config = json.loads(raw.decode("utf-8") or "{}")
            body = render_preview(config)
            _log("ok", provider=config.get("provider"), voice_id=config.get("voice_id"))
            self._json(200, body)
        except ValueError as exc:
            _log("bad_request", error=str(exc))
            self._json(400, {"error": str(exc)})
        except Exception as exc:  # noqa: BLE001 — top-level guard
            _log("fatal", error=str(exc))
            self._json(500, {"error": str(exc)})

    def _json(self, status: int, body: dict) -> None:
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode("utf-8"))

    def log_message(self, format, *args) -> None:  # noqa: A002
        return
