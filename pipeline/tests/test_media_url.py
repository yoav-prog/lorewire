"""Tests for `pipeline.media_url` — the read-time GCS->R2 host rewriter.

Mirrors `lorewire-app/src/lib/media-url.test.ts` branch-for-branch. The two
sides must stay aligned so a URL rewritten by the Next reader and one
rewritten by the Python pipeline resolve to the same delivery URL; a drift
here would silently split outbound traffic between hosts.
"""
from __future__ import annotations

import os
import unittest
from unittest import mock

from pipeline import media_url

BASE = "https://media.lorewire.com"


class ResolveMediaUrlBaseUnsetTests(unittest.TestCase):
    """Dev / pre-cutover: every shape passes through unchanged."""

    def test_legacy_gcs_url_passes_through(self):
        self.assertEqual(
            media_url.resolve_media_url(
                "https://storage.googleapis.com/bucket/abc/video.mp4", None
            ),
            "https://storage.googleapis.com/bucket/abc/video.mp4",
        )

    def test_bare_object_key_passes_through(self):
        self.assertEqual(
            media_url.resolve_media_url("abc/video.mp4", None),
            "abc/video.mp4",
        )

    def test_site_relative_path_passes_through(self):
        self.assertEqual(
            media_url.resolve_media_url("/generated/abc/video.mp4", None),
            "/generated/abc/video.mp4",
        )


class ResolveMediaUrlBaseSetTests(unittest.TestCase):
    """Post-cutover delivery: legacy URLs and bare keys land on the base.
    External and on-base URLs pass through untouched."""

    def test_rewrites_legacy_gcs_dropping_bucket_segment(self):
        self.assertEqual(
            media_url.resolve_media_url(
                "https://storage.googleapis.com/lorewire-gen/abc/video.mp4", BASE
            ),
            f"{BASE}/abc/video.mp4",
        )

    def test_preserves_nested_key_path(self):
        self.assertEqual(
            media_url.resolve_media_url(
                "https://storage.googleapis.com/lorewire-gen/abc-short/video.mp4",
                BASE,
            ),
            f"{BASE}/abc-short/video.mp4",
        )

    def test_preserves_cache_bust_query_string(self):
        # The short renderer appends `?v=token`; it must survive the host
        # swap or the browser keeps a stale cached frame.
        self.assertEqual(
            media_url.resolve_media_url(
                "https://storage.googleapis.com/lorewire-gen/abc-short/video.mp4?v=abc123",
                BASE,
            ),
            f"{BASE}/abc-short/video.mp4?v=abc123",
        )

    def test_prepends_base_to_bare_object_key(self):
        self.assertEqual(
            media_url.resolve_media_url("abc/hero.png", BASE),
            f"{BASE}/abc/hero.png",
        )

    def test_leaves_dicebear_avatar_alone(self):
        dicebear = "https://api.dicebear.com/10.x/notionists/svg?seed=Nova"
        self.assertEqual(media_url.resolve_media_url(dicebear, BASE), dicebear)

    def test_leaves_kie_tempfile_url_alone(self):
        # kie's i2i result URLs come from a non-GCS host and must not be
        # mistaken for legacy media we should rewrite.
        kie = "https://tempfile.aiquickdraw.com/images/chatgpt/foo.png"
        self.assertEqual(media_url.resolve_media_url(kie, BASE), kie)

    def test_leaves_url_already_on_delivery_base_alone(self):
        already = f"{BASE}/abc/video.mp4"
        self.assertEqual(media_url.resolve_media_url(already, BASE), already)

    def test_leaves_site_relative_path_alone(self):
        self.assertEqual(
            media_url.resolve_media_url("/generated/abc/video.mp4", BASE),
            "/generated/abc/video.mp4",
        )

    def test_normalizes_base_with_trailing_slash(self):
        self.assertEqual(
            media_url.resolve_media_url("abc/hero.png", f"{BASE}/"),
            f"{BASE}/abc/hero.png",
        )

    def test_normalizes_base_with_multiple_trailing_slashes(self):
        self.assertEqual(
            media_url.resolve_media_url("abc/hero.png", f"{BASE}///"),
            f"{BASE}/abc/hero.png",
        )


class ResolveMediaUrlEmptyTests(unittest.TestCase):
    def test_none_returns_none(self):
        self.assertIsNone(media_url.resolve_media_url(None, BASE))

    def test_empty_string_returns_none(self):
        self.assertIsNone(media_url.resolve_media_url("", BASE))


class MediaPublicBaseTests(unittest.TestCase):
    def test_reads_env_and_trims_trailing_slash(self):
        with mock.patch.dict(
            os.environ, {"MEDIA_PUBLIC_BASE": f"{BASE}/"}, clear=False
        ):
            self.assertEqual(media_url.media_public_base(), BASE)

    def test_returns_none_when_unset(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("MEDIA_PUBLIC_BASE", None)
            self.assertIsNone(media_url.media_public_base())

    def test_returns_none_when_blank(self):
        with mock.patch.dict(os.environ, {"MEDIA_PUBLIC_BASE": "   "}, clear=False):
            self.assertIsNone(media_url.media_public_base())


class RewriteStoredMediaUrlTests(unittest.TestCase):
    """The embedded-document variant: rewrites legacy GCS URLs only, never
    treats a bare string as an object key. Safe to apply blindly to every
    string in a JSON props blob or rich-text article body."""

    def test_rewrites_legacy_gcs_with_query(self):
        self.assertEqual(
            media_url.rewrite_stored_media_url(
                "https://storage.googleapis.com/b/abc/img.png?v=1", BASE
            ),
            f"{BASE}/abc/img.png?v=1",
        )

    def test_leaves_plain_prose_alone(self):
        self.assertEqual(
            media_url.rewrite_stored_media_url("A plain caption", BASE),
            "A plain caption",
        )

    def test_leaves_external_url_alone(self):
        self.assertEqual(
            media_url.rewrite_stored_media_url("https://example.com/x.png", BASE),
            "https://example.com/x.png",
        )

    def test_leaves_url_already_on_base_alone(self):
        self.assertEqual(
            media_url.rewrite_stored_media_url(f"{BASE}/abc/img.png", BASE),
            f"{BASE}/abc/img.png",
        )

    def test_leaves_bare_word_alone(self):
        # The load-bearing difference from resolve_media_url: a bare word is
        # NOT treated as an object key, so prose never gets corrupted into a URL.
        self.assertEqual(media_url.rewrite_stored_media_url("hero", BASE), "hero")

    def test_no_op_when_base_unset(self):
        self.assertEqual(
            media_url.rewrite_stored_media_url(
                "https://storage.googleapis.com/b/abc/img.png", None
            ),
            "https://storage.googleapis.com/b/abc/img.png",
        )


class ResolveOutboundUrlsTests(unittest.TestCase):
    """The list helper used by `images.generate` to log rewrite counts."""

    def test_counts_rewrites_when_base_set(self):
        with mock.patch.dict(
            os.environ, {"MEDIA_PUBLIC_BASE": BASE}, clear=False
        ):
            out, rewrote = media_url.resolve_outbound_urls(
                [
                    "https://storage.googleapis.com/b/a/1.png",
                    "https://tempfile.aiquickdraw.com/x.png",
                    "https://storage.googleapis.com/b/a/2.png?v=x",
                ]
            )
            self.assertEqual(
                out,
                [
                    f"{BASE}/a/1.png",
                    "https://tempfile.aiquickdraw.com/x.png",
                    f"{BASE}/a/2.png?v=x",
                ],
            )
            self.assertEqual(rewrote, 2)

    def test_drops_empty_entries(self):
        with mock.patch.dict(os.environ, {"MEDIA_PUBLIC_BASE": BASE}, clear=False):
            out, rewrote = media_url.resolve_outbound_urls(
                ["", None, "https://storage.googleapis.com/b/a/1.png"]  # type: ignore[list-item]
            )
            self.assertEqual(out, [f"{BASE}/a/1.png"])
            self.assertEqual(rewrote, 1)

    def test_silent_when_no_rewrite_happens(self):
        with mock.patch.dict(os.environ, {}, clear=False):
            os.environ.pop("MEDIA_PUBLIC_BASE", None)
            out, rewrote = media_url.resolve_outbound_urls(
                ["https://storage.googleapis.com/b/a/1.png"]
            )
            self.assertEqual(out, ["https://storage.googleapis.com/b/a/1.png"])
            self.assertEqual(rewrote, 0)


if __name__ == "__main__":
    unittest.main()
