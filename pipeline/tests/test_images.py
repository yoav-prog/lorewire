"""Tests for `pipeline.images`: the kie createTask body shape, and the
MEDIA_PUBLIC_BASE rewriter wired in at the outbound boundary.

Plan: _plans/2026-06-23-pipeline-outbound-url-rewriter.md. The post-2026-06-22
R2 migration leaves legacy GCS URLs persisted in `short_renders.props`. When
those land on kie's `input_urls` raw, kie fetches the legacy host and 404s. The
fix wires the same host-rewrite the Next reader uses (`media-url.ts`) into
`images.generate` so kie always sees a fetchable URL.

We mock `_post` and `_get` so no network is touched.
"""
from __future__ import annotations

import json
import os
import unittest
from unittest import mock

from pipeline import images

BASE = "https://media.lorewire.com"
SUCCESS_RECORD = {
    "data": {
        "state": "success",
        "resultJson": json.dumps({"resultUrls": ["https://kie.example/out.png"]}),
        "creditsConsumed": 1,
    }
}


def _stub_kie(captured: dict):
    """Build a (_post, _get) pair that captures the createTask body and
    returns a synthetic "task done" response so generate() returns quickly."""

    def fake_post(path: str, body: dict) -> dict:
        captured["post_path"] = path
        captured["post_body"] = body
        return {"code": 200, "data": {"taskId": "t-1"}}

    def fake_get(path: str) -> dict:
        captured["get_path"] = path
        return SUCCESS_RECORD

    return fake_post, fake_get


class GenerateRewritesInputUrlsTests(unittest.TestCase):
    """The gpt-image-2-i2i path: refs go into `input_urls`. With
    MEDIA_PUBLIC_BASE set, legacy GCS URLs must arrive at kie as the
    rewritten delivery host. Without it set, they pass through (dev / pre-cut)."""

    def setUp(self):
        # Reset cost meters so assertion math doesn't depend on test order.
        images.totals["images"] = 0
        images.totals["credits"] = 0

    def test_input_urls_rewritten_when_base_set(self):
        captured: dict = {}
        post, get = _stub_kie(captured)
        with mock.patch.dict(
            os.environ,
            {"MEDIA_PUBLIC_BASE": BASE, "KIE_API_KEY": "k"},
            clear=False,
        ):
            with mock.patch.object(images, "_post", side_effect=post), mock.patch.object(
                images, "_get", side_effect=get
            ):
                images.generate(
                    prompt="probe",
                    image_input=[
                        "https://storage.googleapis.com/aporia-unleash/envelope-short/character.png",
                        "https://storage.googleapis.com/aporia-unleash/envelope-short/frame-00.webp?v=abc",
                    ],
                    model="kie/gpt-image-2-i2i",
                )
        body = captured["post_body"]
        self.assertEqual(body["model"], "gpt-image-2-image-to-image")
        self.assertEqual(
            body["input"]["input_urls"],
            [
                f"{BASE}/envelope-short/character.png",
                f"{BASE}/envelope-short/frame-00.webp?v=abc",
            ],
        )

    def test_input_urls_passthrough_when_base_unset(self):
        captured: dict = {}
        post, get = _stub_kie(captured)
        with mock.patch.dict(os.environ, {"KIE_API_KEY": "k"}, clear=False):
            os.environ.pop("MEDIA_PUBLIC_BASE", None)
            with mock.patch.object(images, "_post", side_effect=post), mock.patch.object(
                images, "_get", side_effect=get
            ):
                images.generate(
                    prompt="probe",
                    image_input=[
                        "https://storage.googleapis.com/aporia-unleash/envelope-short/character.png",
                    ],
                    model="kie/gpt-image-2-i2i",
                )
        body = captured["post_body"]
        # Pass-through: the legacy URL reaches kie unchanged when the
        # delivery base is not configured (dev / pre-cutover).
        self.assertEqual(
            body["input"]["input_urls"],
            ["https://storage.googleapis.com/aporia-unleash/envelope-short/character.png"],
        )

    def test_already_on_base_url_left_alone(self):
        captured: dict = {}
        post, get = _stub_kie(captured)
        already = f"{BASE}/envelope-short/character.png"
        with mock.patch.dict(
            os.environ,
            {"MEDIA_PUBLIC_BASE": BASE, "KIE_API_KEY": "k"},
            clear=False,
        ):
            with mock.patch.object(images, "_post", side_effect=post), mock.patch.object(
                images, "_get", side_effect=get
            ):
                images.generate(
                    prompt="probe",
                    image_input=[already],
                    model="kie/gpt-image-2-i2i",
                )
        body = captured["post_body"]
        self.assertEqual(body["input"]["input_urls"], [already])

    def test_kie_tempfile_url_left_alone(self):
        # kie's own result URLs come from `tempfile.aiquickdraw.com` and must
        # never be mistaken for legacy media we should rewrite.
        captured: dict = {}
        post, get = _stub_kie(captured)
        kie_url = "https://tempfile.aiquickdraw.com/images/chatgpt/file_abc.png"
        with mock.patch.dict(
            os.environ,
            {"MEDIA_PUBLIC_BASE": BASE, "KIE_API_KEY": "k"},
            clear=False,
        ):
            with mock.patch.object(images, "_post", side_effect=post), mock.patch.object(
                images, "_get", side_effect=get
            ):
                images.generate(
                    prompt="probe",
                    image_input=[kie_url],
                    model="kie/gpt-image-2-i2i",
                )
        body = captured["post_body"]
        self.assertEqual(body["input"]["input_urls"], [kie_url])

    def test_empty_refs_drop_input_urls_entirely(self):
        captured: dict = {}
        post, get = _stub_kie(captured)
        with mock.patch.dict(
            os.environ,
            {"MEDIA_PUBLIC_BASE": BASE, "KIE_API_KEY": "k"},
            clear=False,
        ):
            with mock.patch.object(images, "_post", side_effect=post), mock.patch.object(
                images, "_get", side_effect=get
            ):
                images.generate(
                    prompt="probe",
                    image_input=["", None],  # type: ignore[list-item]
                    model="kie/gpt-image-2-i2i",
                )
        body = captured["post_body"]
        # No refs survived filtering, so input_urls is absent (matches the
        # pre-existing contract for the no-refs path).
        self.assertNotIn("input_urls", body["input"])


class GenerateNanoBananaImageInputTests(unittest.TestCase):
    """The nano-banana variant uses `image_input` instead of `input_urls`,
    same rewriter discipline."""

    def test_image_input_field_carries_rewritten_urls(self):
        captured: dict = {}
        post, get = _stub_kie(captured)
        with mock.patch.dict(
            os.environ,
            {"MEDIA_PUBLIC_BASE": BASE, "KIE_API_KEY": "k"},
            clear=False,
        ):
            with mock.patch.object(images, "_post", side_effect=post), mock.patch.object(
                images, "_get", side_effect=get
            ):
                images.generate(
                    prompt="probe",
                    image_input=[
                        "https://storage.googleapis.com/aporia-unleash/character.png",
                    ],
                    model="kie/nano-banana-2",
                )
        body = captured["post_body"]
        self.assertEqual(body["model"], "nano-banana-2")
        self.assertEqual(
            body["input"]["image_input"],
            [f"{BASE}/character.png"],
        )


class EditImageRewriteTests(unittest.TestCase):
    """The mouth-swap path: `image_url` is the single reference. Same
    rewriter discipline."""

    def test_image_url_rewritten_when_base_set(self):
        captured: dict = {}
        post, get = _stub_kie(captured)
        with mock.patch.dict(
            os.environ,
            {"MEDIA_PUBLIC_BASE": BASE, "KIE_API_KEY": "k"},
            clear=False,
        ):
            with mock.patch.object(images, "_post", side_effect=post), mock.patch.object(
                images, "_get", side_effect=get
            ):
                images.edit_image(
                    "https://storage.googleapis.com/aporia-unleash/abc/hero.png",
                    prompt="remove mouth",
                )
        body = captured["post_body"]
        self.assertEqual(body["input"]["image_url"], f"{BASE}/abc/hero.png")

    def test_image_url_passthrough_when_base_unset(self):
        captured: dict = {}
        post, get = _stub_kie(captured)
        with mock.patch.dict(os.environ, {"KIE_API_KEY": "k"}, clear=False):
            os.environ.pop("MEDIA_PUBLIC_BASE", None)
            with mock.patch.object(images, "_post", side_effect=post), mock.patch.object(
                images, "_get", side_effect=get
            ):
                images.edit_image(
                    "https://storage.googleapis.com/aporia-unleash/abc/hero.png",
                    prompt="remove mouth",
                )
        body = captured["post_body"]
        self.assertEqual(
            body["input"]["image_url"],
            "https://storage.googleapis.com/aporia-unleash/abc/hero.png",
        )


if __name__ == "__main__":
    unittest.main()
