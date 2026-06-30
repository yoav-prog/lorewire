// Unit tests for the Cloud Run R2 client. Mirrors the shape of
// lorewire-app/src/lib/r2.test.ts's gate + URL-construction coverage —
// the fetch-level behavior is exhaustively tested on the Next-app
// canonical version, so here we focus on the env-detection logic and
// the public delivery URL builder that the render service relies on.
//
// Uses node:test (same runtime the project's other test surface uses)
// against the compiled dist/server/r2.js. The test:server script tsc's
// the server first, then runs this file.

import { strict as assert } from "node:assert";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  __resetR2ClientForTests,
  isR2Configured,
  isR2MediaActive,
  mediaBucket,
  parseR2SegmentUrl,
  publicMediaUrl,
} from "../dist/server/r2.js";

// Snapshot + restore every env var these tests touch so cases can't
// leak state into each other. node:test does not isolate process.env
// the way vitest does, so we do it ourselves.
const ENV_KEYS = [
  "R2_ACCESS_KEY_ID",
  "R2_SECRET_ACCESS_KEY",
  "R2_ACCOUNT_ID",
  "R2_ENDPOINT",
  "R2_MEDIA_BUCKET",
  "R2_MEDIA_WRITE_ENABLED",
  "MEDIA_PUBLIC_BASE",
];
let envSnapshot = {};

beforeEach(() => {
  envSnapshot = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  __resetR2ClientForTests();
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (envSnapshot[k] === undefined) delete process.env[k];
    else process.env[k] = envSnapshot[k];
  }
  __resetR2ClientForTests();
});

describe("isR2Configured", () => {
  it("is false when no credentials are set", () => {
    assert.equal(isR2Configured(), false);
  });

  it("is false when credentials are set but no endpoint source", () => {
    process.env.R2_ACCESS_KEY_ID = "k";
    process.env.R2_SECRET_ACCESS_KEY = "s";
    assert.equal(isR2Configured(), false);
  });

  it("is true with credentials + R2_ACCOUNT_ID", () => {
    process.env.R2_ACCESS_KEY_ID = "k";
    process.env.R2_SECRET_ACCESS_KEY = "s";
    process.env.R2_ACCOUNT_ID = "acct";
    assert.equal(isR2Configured(), true);
  });

  it("is true with credentials + R2_ENDPOINT", () => {
    process.env.R2_ACCESS_KEY_ID = "k";
    process.env.R2_SECRET_ACCESS_KEY = "s";
    process.env.R2_ENDPOINT = "https://example.r2.cloudflarestorage.com";
    assert.equal(isR2Configured(), true);
  });
});

describe("isR2MediaActive (the cutover gate)", () => {
  function setFullEnv() {
    process.env.R2_ACCESS_KEY_ID = "k";
    process.env.R2_SECRET_ACCESS_KEY = "s";
    process.env.R2_ACCOUNT_ID = "acct";
    process.env.R2_MEDIA_BUCKET = "media";
    process.env.MEDIA_PUBLIC_BASE = "https://media.lorewire.com";
  }

  it("is false when the flag is unset, even with full creds", () => {
    setFullEnv();
    assert.equal(isR2MediaActive(), false);
  });

  it("is false when the flag is 'false'", () => {
    setFullEnv();
    process.env.R2_MEDIA_WRITE_ENABLED = "false";
    assert.equal(isR2MediaActive(), false);
  });

  it("is true with flag=true + every required env", () => {
    setFullEnv();
    process.env.R2_MEDIA_WRITE_ENABLED = "true";
    assert.equal(isR2MediaActive(), true);
  });

  it("accepts every truthy variant of the flag", () => {
    setFullEnv();
    for (const flag of ["1", "true", "yes", "on", "TRUE", "Yes", "ON"]) {
      process.env.R2_MEDIA_WRITE_ENABLED = flag;
      assert.equal(isR2MediaActive(), true, `flag=${flag} should be truthy`);
    }
  });

  it("is false when MEDIA_PUBLIC_BASE is missing", () => {
    setFullEnv();
    process.env.R2_MEDIA_WRITE_ENABLED = "true";
    delete process.env.MEDIA_PUBLIC_BASE;
    assert.equal(isR2MediaActive(), false);
  });

  it("is false when R2_MEDIA_BUCKET is missing", () => {
    setFullEnv();
    process.env.R2_MEDIA_WRITE_ENABLED = "true";
    delete process.env.R2_MEDIA_BUCKET;
    assert.equal(isR2MediaActive(), false);
  });

  it("is false when the credentials are missing", () => {
    setFullEnv();
    process.env.R2_MEDIA_WRITE_ENABLED = "true";
    delete process.env.R2_ACCESS_KEY_ID;
    assert.equal(isR2MediaActive(), false);
  });
});

describe("mediaBucket / publicMediaUrl", () => {
  it("mediaBucket throws when R2_MEDIA_BUCKET is unset", () => {
    assert.throws(() => mediaBucket(), /R2_MEDIA_BUCKET is not set/);
  });

  it("mediaBucket returns the trimmed bucket name", () => {
    process.env.R2_MEDIA_BUCKET = "  media-prod  ";
    assert.equal(mediaBucket(), "media-prod");
  });

  it("publicMediaUrl builds <base>/<key>, trimming trailing slashes on base", () => {
    process.env.MEDIA_PUBLIC_BASE = "https://media.lorewire.com/";
    assert.equal(
      publicMediaUrl("envelope-short/video.mp4"),
      "https://media.lorewire.com/envelope-short/video.mp4",
    );
  });

  it("publicMediaUrl throws when MEDIA_PUBLIC_BASE is unset", () => {
    assert.throws(
      () => publicMediaUrl("envelope-short/video.mp4"),
      /MEDIA_PUBLIC_BASE is not set/,
    );
  });
});

describe("parseR2SegmentUrl", () => {
  const BASE = "https://media.lorewire.com";

  it("returns the key for a well-formed URL under the configured base", () => {
    const key = parseR2SegmentUrl(
      `${BASE}/segments/intro-reel-2.norm.mp4`,
      BASE,
    );
    assert.equal(key, "segments/intro-reel-2.norm.mp4");
  });

  it("tolerates a trailing slash on the configured base", () => {
    const key = parseR2SegmentUrl(
      `${BASE}/segments/intro-reel-2.norm.mp4`,
      `${BASE}/`,
    );
    assert.equal(key, "segments/intro-reel-2.norm.mp4");
  });

  it("returns null when the URL doesn't start with the configured base (foreign host fails closed)", () => {
    assert.equal(
      parseR2SegmentUrl(
        "https://attacker.example/segments/intro-reel-2.norm.mp4",
        BASE,
      ),
      null,
    );
  });

  it("returns null when the URL host matches base but the path is a different prefix", () => {
    // `${BASE}-evil/...` shares the host root but isn't actually under BASE.
    assert.equal(
      parseR2SegmentUrl(
        "https://media.lorewire.com.evil/segments/x.mp4",
        BASE,
      ),
      null,
    );
  });

  it("returns null for http:// (insists on https)", () => {
    assert.equal(
      parseR2SegmentUrl(
        "http://media.lorewire.com/segments/intro.mp4",
        "http://media.lorewire.com",
      ),
      null,
    );
  });

  it("returns null when the path doesn't end in .mp4", () => {
    assert.equal(
      parseR2SegmentUrl(`${BASE}/segments/intro.txt`, BASE),
      null,
    );
    assert.equal(
      parseR2SegmentUrl(`${BASE}/segments/intro.mp4.bak`, BASE),
      null,
    );
  });

  it("returns null when the URL carries a query string or fragment", () => {
    assert.equal(
      parseR2SegmentUrl(`${BASE}/segments/intro.mp4?token=abc`, BASE),
      null,
    );
    assert.equal(
      parseR2SegmentUrl(`${BASE}/segments/intro.mp4#frag`, BASE),
      null,
    );
  });

  it("returns null on a path-traversal segment", () => {
    assert.equal(
      parseR2SegmentUrl(`${BASE}/segments/../etc/passwd.mp4`, BASE),
      null,
    );
    assert.equal(
      parseR2SegmentUrl(`${BASE}/segments/./intro.mp4`, BASE),
      null,
    );
    assert.equal(
      parseR2SegmentUrl(`${BASE}/segments//intro.mp4`, BASE),
      null,
    );
  });

  it("returns null when the base equals the URL with nothing after the slash", () => {
    assert.equal(parseR2SegmentUrl(`${BASE}/`, BASE), null);
  });

  it("returns null for empty or junk input", () => {
    assert.equal(parseR2SegmentUrl("", BASE), null);
    assert.equal(parseR2SegmentUrl("not a url", BASE), null);
  });

  it("returns null when the configured base is empty (fail closed on misconfig)", () => {
    assert.equal(
      parseR2SegmentUrl(`${BASE}/segments/intro.mp4`, ""),
      null,
    );
  });
});
