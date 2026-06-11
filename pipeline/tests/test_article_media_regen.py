"""Tests for pipeline.article_media.regen_article_one.

Mocks the kie + GCS + LLM surface so the dispatch + doc-traversal +
DB-update wiring is exercised without burning credits. Article doc
shapes match what the TS editor (lorewire-app/src/lib/tiptap-article-image.ts,
tiptap-gallery.ts) actually writes.
"""
from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from pipeline import article_media


ARTICLE = {
    "id": "art-1",
    "title": "Test article title",
    "subtitle": "A short subtitle",
    "summary": "Summary describing what the article is about.",
    "document": "",  # filled per test
}


def _doc_with_body_images(n: int) -> str:
    """Build a minimal Tiptap doc with N articleImage nodes."""
    images = [
        {
            "type": "articleImage",
            "attrs": {
                "src": f"https://old/img-{i}.png",
                "alt": f"alt text {i}",
                "caption": f"caption {i}",
            },
        }
        for i in range(n)
    ]
    return json.dumps({"type": "doc", "content": images})


def _doc_with_gallery(items_per_gallery: list[int]) -> str:
    """Build a doc with K galleries; items_per_gallery[k] items in each."""
    galleries = []
    flat_idx = 0
    for items_n in items_per_gallery:
        items = []
        for j in range(items_n):
            items.append({
                "src": f"https://old/g-{flat_idx}.png",
                "alt": f"alt {flat_idx}",
                "label": f"label {flat_idx}",
            })
            flat_idx += 1
        galleries.append({
            "type": "articleGallery",
            "attrs": {"items": items},
        })
    return json.dumps({"type": "doc", "content": galleries})


def _patches(article=None, extra=None):
    article = article or ARTICLE
    patches = {
        "fetch_article": mock.patch.object(
            article_media.store, "fetch_article", return_value=article,
        ),
        "images_generate": mock.patch.object(
            article_media.images, "generate", return_value="https://kie/x.png",
        ),
        "download": mock.patch.object(article_media.images, "download"),
        "publish": mock.patch.object(
            article_media.gcs, "publish",
            side_effect=lambda local, key, fallback: fallback,
        ),
        "llm_chat": mock.patch.object(
            article_media.llm, "chat", return_value="generated prompt",
        ),
        "get_selected": mock.patch.object(
            article_media.models, "get_selected", return_value="kie/gpt-image-2",
        ),
    }
    if extra:
        patches.update(extra)
    return patches


def _apply(patches, test_case):
    started = {}
    for name, p in patches.items():
        started[name] = p.start()
        test_case.addCleanup(p.stop)
    return started


class HeroOgRegenTests(unittest.TestCase):
    def test_hero_updates_hero_image_column(self):
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches(extra={
                "update_hero": mock.patch.object(
                    article_media.store, "update_article_hero",
                ),
            })
            mocks = _apply(patches, self)
            url, cents = article_media.regen_article_one(
                "art-1", "hero", Path(tmp),
            )
            self.assertTrue(url.endswith("/article-hero.png"))
            self.assertEqual(cents, 5)
            mocks["update_hero"].assert_called_once_with("art-1", url)

    def test_og_updates_og_image_column(self):
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches(extra={
                "update_og": mock.patch.object(
                    article_media.store, "update_article_og",
                ),
            })
            mocks = _apply(patches, self)
            url, cents = article_media.regen_article_one(
                "art-1", "og", Path(tmp),
            )
            self.assertTrue(url.endswith("/article-og.png"))
            self.assertEqual(cents, 5)
            mocks["update_og"].assert_called_once_with("art-1", url)

    def test_hero_raises_when_article_has_no_context(self):
        empty = {**ARTICLE, "title": "", "subtitle": "", "summary": ""}
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches(article=empty, extra={
                "update_hero": mock.patch.object(
                    article_media.store, "update_article_hero",
                ),
            })
            _apply(patches, self)
            with self.assertRaises(ValueError):
                article_media.regen_article_one("art-1", "hero", Path(tmp))


class BodyImagesRegenTests(unittest.TestCase):
    def test_body_swaps_src_on_every_image_node(self):
        article = {**ARTICLE, "document": _doc_with_body_images(3)}
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches(article=article, extra={
                "update_doc": mock.patch.object(
                    article_media.store, "update_article_document",
                ),
            })
            mocks = _apply(patches, self)
            url, cents = article_media.regen_article_one(
                "art-1", "body_images", Path(tmp),
            )
            self.assertEqual(cents, 15)  # 3 * $0.05
            mocks["update_doc"].assert_called_once()
            new_doc_json = mocks["update_doc"].call_args.args[1]
            new_doc = json.loads(new_doc_json)
            srcs = [n["attrs"]["src"] for n in new_doc["content"]]
            for s in srcs:
                self.assertNotIn("https://old/", s)
                self.assertIn("/article-body-", s)
            self.assertEqual(url, srcs[0])

    def test_body_raises_when_doc_has_no_image_nodes(self):
        article = {**ARTICLE, "document": json.dumps({"type": "doc", "content": []})}
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches(article=article)
            _apply(patches, self)
            with self.assertRaises(ValueError) as ctx:
                article_media.regen_article_one(
                    "art-1", "body_images", Path(tmp),
                )
            self.assertIn("no articleImage nodes", str(ctx.exception))

    def test_body_raises_when_document_is_not_json(self):
        article = {**ARTICLE, "document": "{not valid"}
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches(article=article)
            _apply(patches, self)
            with self.assertRaises(ValueError) as ctx:
                article_media.regen_article_one(
                    "art-1", "body_images", Path(tmp),
                )
            self.assertIn("not valid JSON", str(ctx.exception))


class GalleryRegenTests(unittest.TestCase):
    def test_gallery_swaps_src_on_every_item_across_galleries(self):
        # Two galleries: 2 items then 3 items. Total 5 items.
        article = {**ARTICLE, "document": _doc_with_gallery([2, 3])}
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches(article=article, extra={
                "update_doc": mock.patch.object(
                    article_media.store, "update_article_document",
                ),
            })
            mocks = _apply(patches, self)
            url, cents = article_media.regen_article_one(
                "art-1", "gallery_images", Path(tmp),
            )
            self.assertEqual(cents, 25)  # 5 * $0.05
            new_doc = json.loads(mocks["update_doc"].call_args.args[1])
            # Filename counter spans every gallery — assert that.
            galleries = new_doc["content"]
            self.assertEqual(len(galleries), 2)
            self.assertEqual(len(galleries[0]["attrs"]["items"]), 2)
            self.assertEqual(len(galleries[1]["attrs"]["items"]), 3)
            flat_srcs = [
                it["src"]
                for g in galleries
                for it in g["attrs"]["items"]
            ]
            for i, s in enumerate(flat_srcs):
                self.assertIn(f"/article-gallery-{i + 1}.png", s)

    def test_gallery_raises_when_no_galleries(self):
        article = {**ARTICLE, "document": json.dumps({"type": "doc", "content": []})}
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches(article=article)
            _apply(patches, self)
            with self.assertRaises(ValueError):
                article_media.regen_article_one(
                    "art-1", "gallery_images", Path(tmp),
                )


class DispatchTests(unittest.TestCase):
    def test_unknown_asset_raises_not_implemented(self):
        with tempfile.TemporaryDirectory() as tmp:
            _apply(_patches(), self)
            with self.assertRaises(NotImplementedError):
                article_media.regen_article_one("art-1", "weird", Path(tmp))

    def test_missing_article_raises_value_error(self):
        with tempfile.TemporaryDirectory() as tmp:
            patches = _patches(extra={
                "fetch_article": mock.patch.object(
                    article_media.store, "fetch_article", return_value=None,
                ),
            })
            _apply(patches, self)
            with self.assertRaises(ValueError):
                article_media.regen_article_one("nope", "hero", Path(tmp))

    def test_unsafe_article_id_raises(self):
        with tempfile.TemporaryDirectory() as tmp:
            with self.assertRaises(ValueError):
                article_media.regen_article_one(
                    "../etc/passwd", "hero", Path(tmp),
                )


class FindNodesTests(unittest.TestCase):
    def test_finds_nodes_at_any_depth(self):
        doc = {
            "type": "doc",
            "content": [
                {"type": "paragraph", "content": [
                    {"type": "articleImage", "attrs": {"src": "a"}},
                ]},
                {"type": "articleImage", "attrs": {"src": "b"}},
            ],
        }
        found = article_media._find_nodes(doc, "articleImage")
        self.assertEqual(len(found), 2)
        self.assertEqual(found[0]["attrs"]["src"], "a")
        self.assertEqual(found[1]["attrs"]["src"], "b")

    def test_returns_empty_on_non_dict_input(self):
        self.assertEqual(article_media._find_nodes(None, "articleImage"), [])
        self.assertEqual(article_media._find_nodes("string", "x"), [])
        self.assertEqual(article_media._find_nodes([], "x"), [])


if __name__ == "__main__":
    unittest.main()
