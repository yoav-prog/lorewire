// Coverage for the static public/ads.txt authorized-sellers file. This file
// is what Google's ads.txt crawler reads to confirm LoreWire is allowed to
// sell its ad inventory; a missing file or a mangled publisher ID silently
// blocks AdSense approval and, later, ad revenue. Regression target: keep the
// exact Google DIRECT record intact through any future public/ reshuffle.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ADS_TXT_PATH = fileURLToPath(
  new URL("../../public/ads.txt", import.meta.url),
);

describe("public/ads.txt", () => {
  const contents = readFileSync(ADS_TXT_PATH, "utf8");

  it("authorizes the Google AdSense publisher account as a DIRECT seller", () => {
    const record = contents
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line.length > 0 && !line.startsWith("#"));

    expect(record).toBe(
      "google.com, pub-9080253851513212, DIRECT, f08c47fec0942fa0",
    );
  });
});
