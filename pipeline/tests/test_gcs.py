"""Tests for pipeline.gcs: configuration probe, mime resolution, publish
dispatch. Network calls are out of scope — we verify the seam that decides
whether a real upload happens vs the local-URL fallback.
"""
from __future__ import annotations

import os
import unittest
from pathlib import Path
from unittest import mock

from pipeline import gcs


class ConfigurationTests(unittest.TestCase):
    def test_missing_bucket_means_not_configured(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            for k in ("GCS_BUCKET", "GCS_CLIENT_EMAIL", "GCS_PRIVATE_KEY"):
                os.environ.pop(k, None)
            self.assertFalse(gcs.is_configured())

    def test_bucket_alone_is_not_enough(self):
        with mock.patch.dict(os.environ, {"GCS_BUCKET": "b"}, clear=False):
            for k in ("GCS_CLIENT_EMAIL", "GCS_PRIVATE_KEY"):
                os.environ.pop(k, None)
            self.assertFalse(gcs.is_configured())

    def test_all_three_present_is_configured(self):
        env = {
            "GCS_BUCKET": "b",
            "GCS_CLIENT_EMAIL": "e",
            "GCS_PRIVATE_KEY": "k",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            self.assertTrue(gcs.is_configured())


class MimeTests(unittest.TestCase):
    def test_known_extensions(self):
        self.assertEqual(gcs._mime_for("hero.png"), "image/png")
        self.assertEqual(gcs._mime_for("narration.mp3"), "audio/mpeg")
        self.assertEqual(gcs._mime_for("video.mp4"), "video/mp4")
        self.assertEqual(gcs._mime_for("FRAME.JPEG"), "image/jpeg")

    def test_unknown_extension_falls_back(self):
        # mimetypes may or may not know about .lwx — both branches are valid;
        # what matters is we never raise.
        self.assertTrue(gcs._mime_for("thing.lwx").startswith(("application/", "text/")))


class PublishDispatchTests(unittest.TestCase):
    def test_returns_local_url_when_not_configured(self):
        with mock.patch.object(gcs, "is_configured", return_value=False):
            url = gcs.publish(Path("nonexistent"), "envelope/hero.png", "/generated/envelope/hero.png")
        self.assertEqual(url, "/generated/envelope/hero.png")

    def test_returns_upload_url_on_success(self):
        with mock.patch.object(gcs, "is_configured", return_value=True), \
             mock.patch.object(gcs, "upload", return_value="https://storage.googleapis.com/b/envelope/hero.png"):
            url = gcs.publish(Path("nonexistent"), "envelope/hero.png", "/generated/envelope/hero.png")
        self.assertEqual(url, "https://storage.googleapis.com/b/envelope/hero.png")

    def test_falls_back_to_local_url_on_upload_failure(self):
        # A transient GCS failure must not lose the local file the caller
        # already wrote — DB gets the local URL and the next pipeline run can
        # retry the upload without re-spending money on synth.
        with mock.patch.object(gcs, "is_configured", return_value=True), \
             mock.patch.object(gcs, "upload", side_effect=RuntimeError("GCS HTTP 503")):
            url = gcs.publish(Path("nonexistent"), "envelope/hero.png", "/generated/envelope/hero.png")
        self.assertEqual(url, "/generated/envelope/hero.png")


if __name__ == "__main__":
    unittest.main()
