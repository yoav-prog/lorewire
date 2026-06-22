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


class R2ConfigurationTests(unittest.TestCase):
    R2_ENV = {
        "R2_ACCESS_KEY_ID": "ak",
        "R2_SECRET_ACCESS_KEY": "sk",
        "R2_ACCOUNT_ID": "acct123",
        "R2_MEDIA_BUCKET": "lorewire-media-prod",
        "MEDIA_PUBLIC_BASE": "https://media.lorewire.com",
        "R2_MEDIA_WRITE_ENABLED": "true",
    }

    @staticmethod
    def _clear_r2():
        for k in (
            "R2_ACCESS_KEY_ID",
            "R2_SECRET_ACCESS_KEY",
            "R2_ACCOUNT_ID",
            "R2_ENDPOINT",
            "R2_MEDIA_BUCKET",
            "MEDIA_PUBLIC_BASE",
            "R2_MEDIA_WRITE_ENABLED",
        ):
            os.environ.pop(k, None)

    def test_not_configured_by_default(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            self._clear_r2()
            self.assertFalse(gcs._r2_configured())

    def test_configured_when_all_present(self):
        with mock.patch.dict(os.environ, self.R2_ENV, clear=False):
            self.assertTrue(gcs._r2_configured())

    def test_all_wired_but_flag_off_is_inert(self):
        # The safety invariant: every R2 var present but the explicit cutover
        # flag absent must keep the pipeline on GCS. This is what stops a
        # pre-set MEDIA_PUBLIC_BASE/R2_MEDIA_BUCKET from silently flipping
        # production media to R2 before the copy.
        env = {k: v for k, v in self.R2_ENV.items() if k != "R2_MEDIA_WRITE_ENABLED"}
        with mock.patch.dict(os.environ, {}, clear=False):
            self._clear_r2()
            os.environ.update(env)
            self.assertFalse(gcs._r2_configured())

    def test_missing_public_base_keeps_it_inert(self):
        # Without MEDIA_PUBLIC_BASE the migration target stays off, so the
        # pipeline keeps writing to GCS until the cutover flips the base.
        env = {k: v for k, v in self.R2_ENV.items() if k != "MEDIA_PUBLIC_BASE"}
        with mock.patch.dict(os.environ, {}, clear=False):
            self._clear_r2()
            os.environ.update(env)
            self.assertFalse(gcs._r2_configured())


class R2UploadRoutingTests(unittest.TestCase):
    def test_upload_routes_to_r2_when_configured(self):
        import tempfile

        with tempfile.NamedTemporaryFile(suffix=".png", delete=False) as tf:
            tf.write(b"\x89PNG\r\n\x1a\n")
            path = Path(tf.name)
        try:
            with mock.patch.object(gcs, "_r2_configured", return_value=True), mock.patch.object(
                gcs,
                "_r2_upload",
                return_value="https://media.lorewire.com/envelope/hero.png",
            ) as r2up:
                url = gcs.upload(path, "envelope/hero.png")
            r2up.assert_called_once()
            self.assertEqual(url, "https://media.lorewire.com/envelope/hero.png")
        finally:
            path.unlink(missing_ok=True)

    def test_publish_uploads_when_only_r2_configured(self):
        # GCS not configured but R2 on -> publish still uploads (not local).
        with mock.patch.object(gcs, "is_configured", return_value=False), mock.patch.object(
            gcs, "_r2_configured", return_value=True
        ), mock.patch.object(
            gcs, "upload", return_value="https://media.lorewire.com/envelope/hero.png"
        ):
            url = gcs.publish(
                Path("nonexistent"),
                "envelope/hero.png",
                "/generated/envelope/hero.png",
            )
        self.assertEqual(url, "https://media.lorewire.com/envelope/hero.png")


if __name__ == "__main__":
    unittest.main()
