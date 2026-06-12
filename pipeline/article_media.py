"""Per-asset image regeneration for articles.

Articles are TS-owned but the asset re-render worker (pipeline/image_render_worker.py)
needs to regenerate their images on demand. This module is the
article-side counterpart to media.regen_one() — same return shape
(output_url, cost_cents), same exception semantics. Routed via the
worker's owner_kind dispatch.

Today's assets:
    hero            article.hero_image column. One image, top-of-page.
    og              article.og_image column. One social-card image.
    body_images     every articleImage node in articles.document.
                    Walks the Tiptap JSON, regenerates each node's src
                    based on its alt text + caption, writes the doc back.
    gallery_images  every gallery item across every articleGallery node.
                    Same walk pattern.

Style: articles are not the doodle-short aesthetic that stories use.
We default to "editorial illustration" but read seo.* + video.style
settings so a curated style still flows through. The style is a setting
override in the future; for v1 it's hardcoded here.

Cost: per-image at the active kie model's rate (mirrors story-side
media._per_image_cost_cents). The worker records the actual spend.
"""
from __future__ import annotations

import copy
import json
from pathlib import Path

from pipeline import gcs, images, llm, models, store


# Output layout — articles share the public/generated/<id>/ tree the story
# pipeline uses. Different filename namespace so the two never collide.
PUBLIC_DIR_RELATIVE = Path("lorewire-app") / "public" / "generated"
PUBLIC_URL_PREFIX = "/generated"

# Mirrors media.IMAGE_COST_USD. Kept in sync deliberately — both worker
# paths burn the same daily budget so the per-image rate has to match.
IMAGE_COST_USD = {
    "kie/gpt-image-2": 0.05,
    "kie/nano-banana-2": 0.04,
    "kie/nano-banana-pro": 0.10,
}

# Editorial illustration default. Articles aren't the doodle-short style
# the video composition uses; this leans toward newsroom-friendly art.
DEFAULT_ARTICLE_STYLE = (
    "editorial illustration, clean composition, restrained palette, "
    "magazine-quality, photoreal-leaning"
)


def _per_image_cost_cents() -> int:
    active = models.get_selected("images")
    return round(IMAGE_COST_USD.get(active, 0.05) * 100)


def _safe_id(article_id: str) -> str:
    """Conservative path-component sanitization. articles are UUIDs by
    default but a defensive guard avoids any path traversal regardless of
    what got into the column."""
    import re
    if not re.match(r"^[a-zA-Z0-9_-]{1,64}$", article_id):
        raise ValueError(f"article id {article_id!r} fails safety check")
    return article_id


def regen_article_one(
    article_id: str, asset: str, repo_root: Path,
) -> tuple[str, int]:
    """Top-level dispatcher. Worker hands us (article_id, asset_slug);
    we return (output_url, cost_cents) or raise."""
    safe_id = _safe_id(article_id)
    article = store.fetch_article(article_id)
    if article is None:
        raise ValueError(f"article {article_id!r} not found")

    out_dir = repo_root / PUBLIC_DIR_RELATIVE / safe_id
    out_dir.mkdir(parents=True, exist_ok=True)

    if asset == "hero":
        return _regen_hero(article, out_dir, safe_id)
    if asset == "og":
        return _regen_og(article, out_dir, safe_id)
    if asset == "body_images":
        return _regen_body_images(article, out_dir, safe_id)
    if asset == "gallery_images":
        return _regen_gallery_images(article, out_dir, safe_id)

    # Per-image granular regens. Indices are flat: body:N targets the Nth
    # articleImage node in document order; gallery:N targets the Nth item
    # across every articleGallery in document order.
    if asset.startswith("body:"):
        return _regen_one_body_image(article, out_dir, safe_id, _parse_index(asset))
    if asset.startswith("gallery:"):
        return _regen_one_gallery_item(article, out_dir, safe_id, _parse_index(asset))

    raise NotImplementedError(f"unknown article asset slug {asset!r}")


def _parse_index(asset: str) -> int:
    """Same shape as media._parse_index. Defensive against tampered queue
    rows even though the TS UI only ever sends well-formed indices."""
    _, _, suffix = asset.partition(":")
    if not suffix:
        raise ValueError(f"asset {asset!r} missing index after colon")
    try:
        n = int(suffix)
    except ValueError as exc:
        raise ValueError(f"asset {asset!r} has non-numeric index") from exc
    if n < 0:
        raise ValueError(f"asset {asset!r} has negative index")
    return n


# ─── prompts ─────────────────────────────────────────────────────────────────

def _build_article_image_prompt(
    article: dict,
    context: str,
    aspect_ratio: str,
) -> str:
    """One LLM call to write a clean editorial illustration prompt for a
    specific article image. `context` is what the image is OF — for hero
    it's the article summary; for body/gallery items it's the writer's
    alt text + caption. Style stays consistent across calls."""
    style = DEFAULT_ARTICLE_STYLE
    title = (article.get("title") or "").strip()
    subtitle = (article.get("subtitle") or "").strip()
    summary = (article.get("summary") or "").strip()

    prompt = (
        "You write image-generation prompts for a publication's editorial "
        "illustrations. Output a single English prompt, 80-180 words, "
        "describing one image. No preamble, no markdown, no bullet points.\n\n"
        f"Style: {style}.\n"
        f"Aspect ratio: {aspect_ratio}.\n"
        f"Article title: {title}\n"
        f"Article subtitle: {subtitle}\n"
        f"Article summary: {summary}\n"
        f"What this image should show: {context}\n\n"
        "Describe composition, subject, lighting, and palette. Keep the "
        "subject specific and concrete. Avoid logos, real people's faces, "
        "and any text in the image."
    )
    return llm.chat(prompt, max_tokens=400)


# ─── hero / og ───────────────────────────────────────────────────────────────

def _regen_hero(article: dict, out_dir: Path, safe_id: str) -> tuple[str, int]:
    return _regen_top_level_image(
        article, out_dir, safe_id,
        filename="article-hero.png",
        column_updater=store.update_article_hero,
        aspect_ratio="3:2",
    )


def _regen_og(article: dict, out_dir: Path, safe_id: str) -> tuple[str, int]:
    return _regen_top_level_image(
        article, out_dir, safe_id,
        filename="article-og.png",
        column_updater=store.update_article_og,
        aspect_ratio="1.91:1",  # 1200x630 = ~1.91:1, the OG card spec
    )


def _regen_top_level_image(
    article: dict,
    out_dir: Path,
    safe_id: str,
    filename: str,
    column_updater,
    aspect_ratio: str,
) -> tuple[str, int]:
    summary = (article.get("summary") or article.get("subtitle") or "").strip()
    if not summary:
        # No summary AND no subtitle is a thin article. Fall back to the
        # title so we have *something* to ground the prompt against.
        summary = (article.get("title") or "").strip()
    if not summary:
        raise ValueError(
            f"article {safe_id} has no title/summary/subtitle — no context for the prompt"
        )

    prompt = _build_article_image_prompt(article, summary, aspect_ratio)
    print(f"[article regen] id={safe_id} {filename} aspect={aspect_ratio}")

    kie_url = images.generate(prompt=prompt, aspect_ratio=aspect_ratio)
    public_url = f"{PUBLIC_URL_PREFIX}/{safe_id}/{filename}"
    local_path = out_dir / filename
    images.download(kie_url, local_path)
    stored_url = gcs.publish(local_path, f"{safe_id}/{filename}", public_url)

    column_updater(article["id"], stored_url)
    return stored_url, _per_image_cost_cents()


# ─── body images ─────────────────────────────────────────────────────────────

def _regen_body_images(
    article: dict, out_dir: Path, safe_id: str,
) -> tuple[str, int]:
    """Walk the Tiptap doc for articleImage nodes; regenerate each and
    splice the new src in place. Writes the modified doc back to
    articles.document."""
    doc_raw = article.get("document")
    if not doc_raw:
        raise ValueError(
            f"article {safe_id} has no document — no body images to regenerate"
        )
    try:
        doc = json.loads(doc_raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"article {safe_id} document is not valid JSON: {e}") from e

    doc_copy = copy.deepcopy(doc)
    image_nodes = _find_nodes(doc_copy, "articleImage")
    if not image_nodes:
        raise ValueError(
            f"article {safe_id} has no articleImage nodes in its document"
        )

    per_image_cents = _per_image_cost_cents()
    total_cents = 0
    first_url: str | None = None

    for idx, node in enumerate(image_nodes):
        attrs = node.setdefault("attrs", {})
        alt = (attrs.get("alt") or "").strip()
        caption = (attrs.get("caption") or "").strip()
        context_parts = [p for p in (alt, caption) if p]
        if not context_parts:
            context = f"a clean editorial illustration for the article body, image {idx + 1}"
        else:
            context = ". ".join(context_parts)

        prompt = _build_article_image_prompt(article, context, "3:2")
        filename = f"article-body-{idx + 1}.png"
        public_url = f"{PUBLIC_URL_PREFIX}/{safe_id}/{filename}"
        local_path = out_dir / filename
        try:
            kie_url = images.generate(prompt=prompt, aspect_ratio="3:2")
            images.download(kie_url, local_path)
            stored_url = gcs.publish(
                local_path, f"{safe_id}/{filename}", public_url,
            )
        except Exception as e:
            print(f"[article regen body-{idx + 1}] FAILED: {e}")
            continue

        attrs["src"] = stored_url
        total_cents += per_image_cents
        if first_url is None:
            first_url = stored_url

    if first_url is None:
        raise RuntimeError("body images regen produced 0 images — all kie calls failed")

    store.update_article_document(article["id"], json.dumps(doc_copy))
    return first_url, total_cents


# ─── gallery items ───────────────────────────────────────────────────────────

def _regen_gallery_images(
    article: dict, out_dir: Path, safe_id: str,
) -> tuple[str, int]:
    """Walk the Tiptap doc for articleGallery nodes; for each item in each
    gallery, regenerate and splice the new src into the items array. One
    write back to articles.document covers every change."""
    doc_raw = article.get("document")
    if not doc_raw:
        raise ValueError(
            f"article {safe_id} has no document — no gallery items to regenerate"
        )
    try:
        doc = json.loads(doc_raw)
    except json.JSONDecodeError as e:
        raise ValueError(f"article {safe_id} document is not valid JSON: {e}") from e

    doc_copy = copy.deepcopy(doc)
    gallery_nodes = _find_nodes(doc_copy, "articleGallery")
    if not gallery_nodes:
        raise ValueError(
            f"article {safe_id} has no articleGallery nodes in its document"
        )

    per_image_cents = _per_image_cost_cents()
    total_cents = 0
    first_url: str | None = None
    flat_idx = 0  # filename counter spans every gallery in the doc

    for gallery_node in gallery_nodes:
        attrs = gallery_node.setdefault("attrs", {})
        items = attrs.get("items")
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            alt = (item.get("alt") or "").strip()
            caption = (item.get("caption") or "").strip()
            context_parts = [p for p in (alt, caption) if p]
            if not context_parts:
                context = f"a gallery image illustrating the article, item {flat_idx + 1}"
            else:
                context = ". ".join(context_parts)

            prompt = _build_article_image_prompt(article, context, "1:1")
            filename = f"article-gallery-{flat_idx + 1}.png"
            public_url = f"{PUBLIC_URL_PREFIX}/{safe_id}/{filename}"
            local_path = out_dir / filename
            try:
                kie_url = images.generate(prompt=prompt, aspect_ratio="1:1")
                images.download(kie_url, local_path)
                stored_url = gcs.publish(
                    local_path, f"{safe_id}/{filename}", public_url,
                )
            except Exception as e:
                print(f"[article regen gallery-{flat_idx + 1}] FAILED: {e}")
                flat_idx += 1
                continue

            item["src"] = stored_url
            total_cents += per_image_cents
            if first_url is None:
                first_url = stored_url
            flat_idx += 1

    if first_url is None:
        raise RuntimeError(
            "gallery images regen produced 0 images — all kie calls failed"
        )

    store.update_article_document(article["id"], json.dumps(doc_copy))
    return first_url, total_cents


# ─── doc walking ─────────────────────────────────────────────────────────────

# ─── per-image regens ────────────────────────────────────────────────────────
# Single-element variants. UI surfaces them from the per-thumbnail
# Regenerate buttons in the granular grid. Each updates one image and
# leaves the rest of the document untouched.

def _regen_one_body_image(
    article: dict, out_dir: Path, safe_id: str, index: int,
) -> tuple[str, int]:
    """Regenerate the Nth articleImage node in document order. The rest
    of the doc is unchanged."""
    doc_raw = article.get("document")
    if not doc_raw:
        raise ValueError(
            f"article {safe_id} has no document — no body image to regenerate"
        )
    try:
        doc = json.loads(doc_raw)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"article {safe_id} document is not valid JSON: {exc}"
        ) from exc

    doc_copy = copy.deepcopy(doc)
    nodes = _find_nodes(doc_copy, "articleImage")
    if index >= len(nodes):
        raise ValueError(
            f"body image index {index} out of range "
            f"(article has {len(nodes)} body images)"
        )
    node = nodes[index]
    attrs = node.setdefault("attrs", {})
    alt = (attrs.get("alt") or "").strip()
    caption = (attrs.get("caption") or "").strip()
    context_parts = [p for p in (alt, caption) if p]
    if not context_parts:
        context = (
            f"a clean editorial illustration for the article body, "
            f"image {index + 1}"
        )
    else:
        context = ". ".join(context_parts)

    prompt = _build_article_image_prompt(article, context, "3:2")
    filename = f"article-body-{index + 1}.png"
    public_url = f"{PUBLIC_URL_PREFIX}/{safe_id}/{filename}"
    local_path = out_dir / filename
    kie_url = images.generate(prompt=prompt, aspect_ratio="3:2")
    images.download(kie_url, local_path)
    stored_url = gcs.publish(local_path, f"{safe_id}/{filename}", public_url)

    attrs["src"] = stored_url
    store.update_article_document(article["id"], json.dumps(doc_copy))
    return stored_url, _per_image_cost_cents()


def _regen_one_gallery_item(
    article: dict, out_dir: Path, safe_id: str, index: int,
) -> tuple[str, int]:
    """Regenerate the Nth gallery item across the doc's gallery nodes.
    Indexing is flat: a 2-item gallery followed by a 3-item gallery
    addresses items 0-1 in the first node and 2-4 in the second."""
    doc_raw = article.get("document")
    if not doc_raw:
        raise ValueError(
            f"article {safe_id} has no document — no gallery item to regenerate"
        )
    try:
        doc = json.loads(doc_raw)
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"article {safe_id} document is not valid JSON: {exc}"
        ) from exc

    doc_copy = copy.deepcopy(doc)
    galleries = _find_nodes(doc_copy, "articleGallery")
    target_item: dict | None = None
    flat_idx = 0
    for gallery in galleries:
        items = gallery.get("attrs", {}).get("items")
        if not isinstance(items, list):
            continue
        for item in items:
            if not isinstance(item, dict):
                continue
            if flat_idx == index:
                target_item = item
                break
            flat_idx += 1
        if target_item is not None:
            break

    if target_item is None:
        raise ValueError(
            f"gallery item index {index} out of range "
            f"(article has {flat_idx} gallery items)"
        )

    alt = (target_item.get("alt") or "").strip()
    caption = (target_item.get("caption") or "").strip()
    context_parts = [p for p in (alt, caption) if p]
    if not context_parts:
        context = (
            f"a gallery image illustrating the article, item {index + 1}"
        )
    else:
        context = ". ".join(context_parts)

    prompt = _build_article_image_prompt(article, context, "1:1")
    filename = f"article-gallery-{index + 1}.png"
    public_url = f"{PUBLIC_URL_PREFIX}/{safe_id}/{filename}"
    local_path = out_dir / filename
    kie_url = images.generate(prompt=prompt, aspect_ratio="1:1")
    images.download(kie_url, local_path)
    stored_url = gcs.publish(local_path, f"{safe_id}/{filename}", public_url)

    target_item["src"] = stored_url
    store.update_article_document(article["id"], json.dumps(doc_copy))
    return stored_url, _per_image_cost_cents()


def _find_nodes(root: object, node_type: str) -> list[dict]:
    """Depth-first walk of a Tiptap JSON doc, returning every node whose
    `type` field equals `node_type`. Mutating the returned dicts mutates
    the source structure (intentional — the regen loops modify attrs.src
    in place and then re-serialize the whole doc)."""
    out: list[dict] = []

    def walk(node: object) -> None:
        if not isinstance(node, dict):
            return
        if node.get("type") == node_type:
            out.append(node)
        content = node.get("content")
        if isinstance(content, list):
            for child in content:
                walk(child)

    walk(root)
    return out
