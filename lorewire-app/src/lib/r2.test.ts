// Tests for the pure R2 URL helper. userContentKeyFromUrl decides which stored
// picture_url values are OUR objects (safe to reap) vs external ones (DiceBear /
// OAuth, never touch). The `avatars/` prefix guard is security-relevant: a
// crafted picture_url must not be able to make us delete an arbitrary key.

import { describe, expect, it } from "vitest";

import {
  isR2MediaActive,
  mediaUrlToKey,
  presignR2PutUrl,
  userContentKeyFromUrl,
} from "./r2";

const BASE = "https://usercontent.lorewire.com";

describe("userContentKeyFromUrl", () => {
  it("extracts the key from one of our avatar URLs", () => {
    expect(
      userContentKeyFromUrl(`${BASE}/avatars/u1-abcdef0123456789.webp`, BASE),
    ).toBe("avatars/u1-abcdef0123456789.webp");
  });

  it("strips a query string / fragment", () => {
    expect(userContentKeyFromUrl(`${BASE}/avatars/u1-x.webp?v=2`, BASE)).toBe(
      "avatars/u1-x.webp",
    );
    expect(userContentKeyFromUrl(`${BASE}/avatars/u1-x.webp#a`, BASE)).toBe(
      "avatars/u1-x.webp",
    );
  });

  it("normalizes a base with a trailing slash", () => {
    expect(userContentKeyFromUrl(`${BASE}/avatars/u1-x.webp`, `${BASE}/`)).toBe(
      "avatars/u1-x.webp",
    );
  });

  it("returns null for external URLs (DiceBear, OAuth)", () => {
    expect(
      userContentKeyFromUrl("https://api.dicebear.com/10.x/notionists/svg?seed=Nova", BASE),
    ).toBeNull();
    expect(
      userContentKeyFromUrl("https://lh3.googleusercontent.com/a/abc", BASE),
    ).toBeNull();
  });

  it("refuses keys outside the avatars/ prefix (can't reap arbitrary objects)", () => {
    expect(userContentKeyFromUrl(`${BASE}/other/secret.webp`, BASE)).toBeNull();
    expect(userContentKeyFromUrl(`${BASE}/../media/x`, BASE)).toBeNull();
  });

  it("returns null for empty url or base", () => {
    expect(userContentKeyFromUrl(null, BASE)).toBeNull();
    expect(userContentKeyFromUrl(undefined, BASE)).toBeNull();
    expect(userContentKeyFromUrl(`${BASE}/avatars/x.webp`, null)).toBeNull();
    expect(userContentKeyFromUrl("", BASE)).toBeNull();
  });
});

describe("mediaUrlToKey", () => {
  const MEDIA = "https://media.lorewire.com";

  it("extracts any key under the media base (query stripped)", () => {
    expect(mediaUrlToKey(`${MEDIA}/abc/video.mp4`, MEDIA)).toBe("abc/video.mp4");
    expect(mediaUrlToKey(`${MEDIA}/abc-short/video.mp4?v=1`, MEDIA)).toBe(
      "abc-short/video.mp4",
    );
  });

  it("returns null for non-media URLs and empty inputs", () => {
    expect(
      mediaUrlToKey("https://storage.googleapis.com/b/abc/video.mp4", MEDIA),
    ).toBeNull();
    expect(mediaUrlToKey(null, MEDIA)).toBeNull();
    expect(mediaUrlToKey(`${MEDIA}/abc`, null)).toBeNull();
  });
});

describe("isR2MediaActive", () => {
  const FULL: Record<string, string> = {
    R2_ACCESS_KEY_ID: "ak",
    R2_SECRET_ACCESS_KEY: "sk",
    R2_ACCOUNT_ID: "acct",
    R2_MEDIA_BUCKET: "lorewire-media-prod",
    MEDIA_PUBLIC_BASE: "https://media.lorewire.com",
    R2_MEDIA_WRITE_ENABLED: "true",
  };
  const KEYS = [
    "R2_ACCESS_KEY_ID",
    "R2_SECRET_ACCESS_KEY",
    "R2_ACCOUNT_ID",
    "R2_ENDPOINT",
    "R2_MEDIA_BUCKET",
    "MEDIA_PUBLIC_BASE",
    "R2_MEDIA_WRITE_ENABLED",
  ];

  function withEnv(env: Record<string, string>, fn: () => void) {
    const prev: Record<string, string | undefined> = {};
    for (const k of KEYS) {
      prev[k] = process.env[k];
      delete process.env[k];
    }
    Object.assign(process.env, env);
    try {
      fn();
    } finally {
      for (const k of KEYS) {
        if (prev[k] === undefined) delete process.env[k];
        else process.env[k] = prev[k];
      }
    }
  }

  it("is true only with full config AND the cutover flag on", () => {
    withEnv(FULL, () => expect(isR2MediaActive()).toBe(true));
  });

  it("is false when the flag is off, even fully wired (the safety invariant)", () => {
    const { R2_MEDIA_WRITE_ENABLED: _flag, ...noFlag } = FULL;
    withEnv(noFlag, () => expect(isR2MediaActive()).toBe(false));
  });

  it("is false with the flag on but missing config", () => {
    const { MEDIA_PUBLIC_BASE: _base, ...noBase } = FULL;
    withEnv(noBase, () => expect(isR2MediaActive()).toBe(false));
  });
});

describe("presignR2PutUrl", () => {
  it("presigns a single-PUT URL on the object path, with signature + expiry", async () => {
    const prev = {
      ak: process.env.R2_ACCESS_KEY_ID,
      sk: process.env.R2_SECRET_ACCESS_KEY,
      acct: process.env.R2_ACCOUNT_ID,
      ep: process.env.R2_ENDPOINT,
    };
    process.env.R2_ACCESS_KEY_ID = "AKIAEXAMPLE0000000000";
    process.env.R2_SECRET_ACCESS_KEY = "secretsecretsecretsecretsecretsecret00";
    process.env.R2_ACCOUNT_ID = "acct123";
    delete process.env.R2_ENDPOINT;
    try {
      const url = await presignR2PutUrl(
        "lorewire-media-prod",
        "segments/abc.source.mp4",
        600,
      );
      expect(url).toContain(
        "acct123.r2.cloudflarestorage.com/lorewire-media-prod/segments/abc.source.mp4",
      );
      expect(url).toContain("X-Amz-Algorithm=AWS4-HMAC-SHA256");
      expect(url).toContain("X-Amz-Signature=");
      expect(url).toContain("X-Amz-Expires=600");
    } finally {
      // Reset the cached signer (built with the example creds) and the env.
      globalThis.__lwR2Client = undefined;
      const restore = (k: string, v: string | undefined) => {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      };
      restore("R2_ACCESS_KEY_ID", prev.ak);
      restore("R2_SECRET_ACCESS_KEY", prev.sk);
      restore("R2_ACCOUNT_ID", prev.acct);
      restore("R2_ENDPOINT", prev.ep);
    }
  });
});
