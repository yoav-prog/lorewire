// Tests for the read-time media URL resolver — the dual-read shim that lets the
// delivery backend move from GCS to the R2 custom domain without rewriting
// stored rows. The migration's safety rests on this resolving BOTH legacy
// absolute GCS URLs and bare object keys to the same delivery URL, while never
// touching external URLs (DiceBear avatars, OAuth pictures). Pin it hard.

import { describe, expect, it } from "vitest";

import {
  mediaPublicBase,
  resolveMediaUrl,
  rewriteStoredMediaUrl,
  rewriteStoredMediaUrlsDeep,
} from "./media-url";

const BASE = "https://media.lorewire.com";

describe("resolveMediaUrl — base unset (dev / pre-cutover)", () => {
  it("passes every shape through unchanged", () => {
    expect(
      resolveMediaUrl("https://storage.googleapis.com/bucket/abc/video.mp4", null),
    ).toBe("https://storage.googleapis.com/bucket/abc/video.mp4");
    expect(resolveMediaUrl("abc/video.mp4", null)).toBe("abc/video.mp4");
    expect(resolveMediaUrl("/generated/abc/video.mp4", null)).toBe(
      "/generated/abc/video.mp4",
    );
  });
});

describe("resolveMediaUrl — base set (post-cutover delivery)", () => {
  it("rewrites a legacy GCS URL onto the base, dropping the bucket segment", () => {
    expect(
      resolveMediaUrl("https://storage.googleapis.com/lorewire-gen/abc/video.mp4", BASE),
    ).toBe(`${BASE}/abc/video.mp4`);
  });

  it("preserves a nested key path", () => {
    expect(
      resolveMediaUrl(
        "https://storage.googleapis.com/lorewire-gen/abc-short/video.mp4",
        BASE,
      ),
    ).toBe(`${BASE}/abc-short/video.mp4`);
  });

  it("preserves a cache-bust query string across the rewrite", () => {
    // The short renderer appends `?v=token`; it must survive the host swap or
    // the browser keeps a stale cached frame.
    expect(
      resolveMediaUrl(
        "https://storage.googleapis.com/lorewire-gen/abc-short/video.mp4?v=abc123",
        BASE,
      ),
    ).toBe(`${BASE}/abc-short/video.mp4?v=abc123`);
  });

  it("prepends the base to a bare object key", () => {
    expect(resolveMediaUrl("abc/hero.png", BASE)).toBe(`${BASE}/abc/hero.png`);
  });

  it("leaves an external absolute URL untouched (DiceBear avatar)", () => {
    const dicebear = "https://api.dicebear.com/10.x/notionists/svg?seed=Nova";
    expect(resolveMediaUrl(dicebear, BASE)).toBe(dicebear);
  });

  it("leaves a URL already on the delivery base untouched", () => {
    const already = `${BASE}/abc/video.mp4`;
    expect(resolveMediaUrl(already, BASE)).toBe(already);
  });

  it("leaves a site-relative path untouched even with a base set", () => {
    expect(resolveMediaUrl("/generated/abc/video.mp4", BASE)).toBe(
      "/generated/abc/video.mp4",
    );
  });

  it("normalizes a base passed with a trailing slash (no double slash)", () => {
    expect(resolveMediaUrl("abc/hero.png", `${BASE}/`)).toBe(`${BASE}/abc/hero.png`);
  });
});

describe("resolveMediaUrl — empty inputs", () => {
  it("returns null for null, undefined, and empty string", () => {
    expect(resolveMediaUrl(null, BASE)).toBeNull();
    expect(resolveMediaUrl(undefined, BASE)).toBeNull();
    expect(resolveMediaUrl("", BASE)).toBeNull();
  });
});

describe("mediaPublicBase", () => {
  it("reads MEDIA_PUBLIC_BASE and trims a trailing slash", () => {
    const prev = process.env.MEDIA_PUBLIC_BASE;
    try {
      process.env.MEDIA_PUBLIC_BASE = `${BASE}/`;
      expect(mediaPublicBase()).toBe(BASE);
      delete process.env.MEDIA_PUBLIC_BASE;
      expect(mediaPublicBase()).toBeNull();
      process.env.MEDIA_PUBLIC_BASE = "   ";
      expect(mediaPublicBase()).toBeNull();
    } finally {
      if (prev === undefined) delete process.env.MEDIA_PUBLIC_BASE;
      else process.env.MEDIA_PUBLIC_BASE = prev;
    }
  });
});

describe("rewriteStoredMediaUrl (embedded document URLs)", () => {
  it("rewrites a legacy GCS URL onto the base, query preserved", () => {
    expect(
      rewriteStoredMediaUrl("https://storage.googleapis.com/b/abc/img.png?v=1", BASE),
    ).toBe(`${BASE}/abc/img.png?v=1`);
  });

  it("leaves non-GCS strings untouched — prose, external + on-base URLs", () => {
    expect(rewriteStoredMediaUrl("A plain caption", BASE)).toBe("A plain caption");
    expect(rewriteStoredMediaUrl("https://example.com/x.png", BASE)).toBe(
      "https://example.com/x.png",
    );
    expect(rewriteStoredMediaUrl(`${BASE}/abc/img.png`, BASE)).toBe(`${BASE}/abc/img.png`);
    // The load-bearing difference from resolveMediaUrl: a bare word is NOT
    // treated as an object key, so prose never gets corrupted into a URL.
    expect(rewriteStoredMediaUrl("hero", BASE)).toBe("hero");
  });

  it("is a passthrough no-op when the base is unset", () => {
    expect(
      rewriteStoredMediaUrl("https://storage.googleapis.com/b/abc/img.png", null),
    ).toBe("https://storage.googleapis.com/b/abc/img.png");
  });
});

describe("rewriteStoredMediaUrlsDeep (Cloud Run inputProps / article body trees)", () => {
  it("walks nested objects + arrays, rewriting every legacy GCS URL", () => {
    const tree = {
      character_base_url: "https://storage.googleapis.com/b/abc/character.png",
      audio_url: "https://storage.googleapis.com/b/abc/voice.mp3",
      scenes: [
        { url: "https://storage.googleapis.com/b/abc/frame-00.webp?v=1" },
        { url: "https://storage.googleapis.com/b/abc/frame-01.webp?v=1" },
      ],
      caption: "Just a caption, leave alone",
      external: "https://api.dicebear.com/10.x/svg",
      already: `${BASE}/keep/me.png`,
    };
    const rewrote = rewriteStoredMediaUrlsDeep(tree, BASE);
    expect(rewrote).toBe(4);
    expect(tree.character_base_url).toBe(`${BASE}/abc/character.png`);
    expect(tree.audio_url).toBe(`${BASE}/abc/voice.mp3`);
    expect(tree.scenes[0].url).toBe(`${BASE}/abc/frame-00.webp?v=1`);
    expect(tree.scenes[1].url).toBe(`${BASE}/abc/frame-01.webp?v=1`);
    expect(tree.caption).toBe("Just a caption, leave alone");
    expect(tree.external).toBe("https://api.dicebear.com/10.x/svg");
    expect(tree.already).toBe(`${BASE}/keep/me.png`);
  });

  it("is a no-op when the base is unset (dev / pre-cutover)", () => {
    const tree = {
      character_base_url: "https://storage.googleapis.com/b/abc/character.png",
    };
    const rewrote = rewriteStoredMediaUrlsDeep(tree, null);
    expect(rewrote).toBe(0);
    expect(tree.character_base_url).toBe(
      "https://storage.googleapis.com/b/abc/character.png",
    );
  });

  it("handles null + primitive leaves without throwing", () => {
    const tree: Record<string, unknown> = {
      maybe_url: null,
      maybe_count: 7,
      maybe_flag: true,
      nested: { nope: null, num: 0 },
    };
    expect(() => rewriteStoredMediaUrlsDeep(tree, BASE)).not.toThrow();
    expect(tree.maybe_url).toBeNull();
    expect(tree.maybe_count).toBe(7);
  });

  it("handles arrays of strings directly (no object wrapper)", () => {
    const tree = {
      input_urls: [
        "https://storage.googleapis.com/b/abc/character.png",
        "https://storage.googleapis.com/b/abc/scene.webp",
      ],
    };
    const rewrote = rewriteStoredMediaUrlsDeep(tree, BASE);
    expect(rewrote).toBe(2);
    expect(tree.input_urls).toEqual([
      `${BASE}/abc/character.png`,
      `${BASE}/abc/scene.webp`,
    ]);
  });
});
