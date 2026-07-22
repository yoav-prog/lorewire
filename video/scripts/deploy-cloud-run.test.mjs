// Tests for the deploy script's env-line parser. Covers every validation
// rule + the exact 2026-06-30 corruption shape as a regression test. The
// deploy script is module-gated so importing the parser doesn't spawn
// gcloud — these tests run as pure unit tests against the exported
// functions.

import { strict as assert } from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

import { parseEnvLine, loadEnvFile } from "./deploy-cloud-run.mjs";

describe("parseEnvLine: skip cases", () => {
  it("skips an empty line", () => {
    assert.deepEqual(parseEnvLine(""), { kind: "skip" });
  });

  it("skips a whitespace-only line", () => {
    assert.deepEqual(parseEnvLine("   "), { kind: "skip" });
    assert.deepEqual(parseEnvLine("\t\t"), { kind: "skip" });
  });

  it("skips a comment", () => {
    assert.deepEqual(parseEnvLine("# this is a comment"), { kind: "skip" });
  });

  it("skips an indented comment", () => {
    assert.deepEqual(parseEnvLine("  # indented comment"), { kind: "skip" });
  });

  it("strips a BOM at the start of the first line", () => {
    const result = parseEnvLine("﻿GCS_BUCKET=aporia-unleash");
    assert.deepEqual(result, {
      kind: "assign",
      key: "GCS_BUCKET",
      value: "aporia-unleash",
    });
  });

  it("strips a trailing CR (CRLF lines)", () => {
    const result = parseEnvLine("GCS_BUCKET=aporia-unleash\r");
    assert.deepEqual(result, {
      kind: "assign",
      key: "GCS_BUCKET",
      value: "aporia-unleash",
    });
  });
});

describe("parseEnvLine: clean assignments", () => {
  it("accepts an unquoted ASCII value", () => {
    assert.deepEqual(parseEnvLine("GCS_BUCKET=aporia-unleash"), {
      kind: "assign",
      key: "GCS_BUCKET",
      value: "aporia-unleash",
    });
  });

  it("strips a matched double-quote pair", () => {
    assert.deepEqual(parseEnvLine('GCS_BUCKET="aporia-unleash"'), {
      kind: "assign",
      key: "GCS_BUCKET",
      value: "aporia-unleash",
    });
  });

  it("strips a matched single-quote pair", () => {
    assert.deepEqual(parseEnvLine("GCS_BUCKET='aporia-unleash'"), {
      kind: "assign",
      key: "GCS_BUCKET",
      value: "aporia-unleash",
    });
  });

  it("preserves an unquoted value with safe punctuation", () => {
    // Tokens, base URLs, dashes, dots — none of these should be rejected.
    assert.deepEqual(
      parseEnvLine("MEDIA_PUBLIC_BASE=https://media.lorewire.com"),
      {
        kind: "assign",
        key: "MEDIA_PUBLIC_BASE",
        value: "https://media.lorewire.com",
      },
    );
    assert.deepEqual(
      parseEnvLine("CRON_SECRET=abc-123_DEF.456+ghi/789="),
      {
        kind: "assign",
        key: "CRON_SECRET",
        value: "abc-123_DEF.456+ghi/789=",
      },
    );
  });

  it("accepts a single character of value (post-strip)", () => {
    assert.deepEqual(parseEnvLine('GCS_BUCKET="x"'), {
      kind: "assign",
      key: "GCS_BUCKET",
      value: "x",
    });
  });

  it("accepts an empty unquoted value (caller's requireVar gates use)", () => {
    assert.deepEqual(parseEnvLine("OPTIONAL_VAR="), {
      kind: "assign",
      key: "OPTIONAL_VAR",
      value: "",
    });
  });

  it("accepts an empty quoted value", () => {
    assert.deepEqual(parseEnvLine('OPTIONAL_VAR=""'), {
      kind: "assign",
      key: "OPTIONAL_VAR",
      value: "",
    });
  });
});

describe("parseEnvLine: refuses malformed lines", () => {
  it("REGRESSION 2026-06-30: refuses an unmatched-quote-with-trailing-junk value", () => {
    // The exact shape that poisoned production:
    //   GCS_BUCKET="aporia-unleash"M9OP0\-
    // The pre-fix parser stripped only if BOTH sides were quotes, so this
    // fell through with the whole literal as the value and Cloud Run got
    // a corrupted GCS_BUCKET runtime env.
    const result = parseEnvLine('GCS_BUCKET="aporia-unleash"M9OP0\\-');
    assert.equal(result.kind, "error");
    assert.match(result.message, /GCS_BUCKET/);
    assert.match(result.message, /mismatched double-quote/);
  });

  it('refuses a value that starts with " but doesn\'t end with one', () => {
    const result = parseEnvLine('GCS_BUCKET="aporia-unleash');
    assert.equal(result.kind, "error");
    assert.match(result.message, /mismatched double-quote/);
  });

  it('refuses a value that ends with " but doesn\'t start with one', () => {
    const result = parseEnvLine('GCS_BUCKET=aporia-unleash"');
    assert.equal(result.kind, "error");
    assert.match(result.message, /mismatched double-quote/);
  });

  it("refuses a mismatched single-quote", () => {
    const result = parseEnvLine("GCS_BUCKET='aporia-unleash");
    assert.equal(result.kind, "error");
    assert.match(result.message, /mismatched single-quote/);
  });

  it("refuses a bare lone double-quote", () => {
    const result = parseEnvLine('GCS_BUCKET="');
    assert.equal(result.kind, "error");
    assert.match(result.message, /single bare " — not a usable value/);
  });

  it("refuses a bare lone single-quote", () => {
    const result = parseEnvLine("GCS_BUCKET='");
    assert.equal(result.kind, "error");
    assert.match(result.message, /single bare ' — not a usable value/);
  });

  it('refuses an embedded " inside a quoted literal', () => {
    const result = parseEnvLine('GCS_BUCKET="foo"bar"');
    assert.equal(result.kind, "error");
    assert.match(result.message, /embedded " inside the quoted literal/);
  });

  it("refuses an embedded ' inside a quoted literal", () => {
    const result = parseEnvLine("GCS_BUCKET='foo'bar'");
    assert.equal(result.kind, "error");
    assert.match(result.message, /embedded ' inside the quoted literal/);
  });

  it("refuses a NUL byte in the value", () => {
    const result = parseEnvLine("GCS_BUCKET=aporia\x00unleash");
    assert.equal(result.kind, "error");
    assert.match(result.message, /control character/);
  });

  it("refuses an ESC byte (ANSI escape paste) in the value", () => {
    // The literal shape a terminal copy can produce when ANSI colour
    // sequences sneak into a paste.
    const result = parseEnvLine("GCS_BUCKET=aporia\x1B[31munleash");
    assert.equal(result.kind, "error");
    assert.match(result.message, /control character/);
  });

  it("refuses a tab in the value", () => {
    const result = parseEnvLine("GCS_BUCKET=aporia\tunleash");
    assert.equal(result.kind, "error");
    assert.match(result.message, /control character/);
  });

  it("refuses a DEL byte in the value", () => {
    const result = parseEnvLine("GCS_BUCKET=aporia\x7Funleash");
    assert.equal(result.kind, "error");
    assert.match(result.message, /control character/);
  });

  it("refuses leading whitespace on an assignment line", () => {
    const result = parseEnvLine("  GCS_BUCKET=aporia-unleash");
    assert.equal(result.kind, "error");
    assert.match(result.message, /leading whitespace/);
  });

  it("refuses a tab-indented assignment line", () => {
    const result = parseEnvLine("\tGCS_BUCKET=aporia-unleash");
    assert.equal(result.kind, "error");
    assert.match(result.message, /leading whitespace/);
  });

  it("refuses the `export KEY=VALUE` form (dotenv-style)", () => {
    const result = parseEnvLine("export GCS_BUCKET=aporia-unleash");
    assert.equal(result.kind, "error");
    assert.match(result.message, /not a recognized KEY=VALUE line/);
  });

  it("refuses a line missing the equals sign", () => {
    const result = parseEnvLine("GCS_BUCKET aporia-unleash");
    assert.equal(result.kind, "error");
    assert.match(result.message, /not a recognized KEY=VALUE line/);
  });

  it("refuses a key with lowercase letters (gcloud env names are uppercase)", () => {
    const result = parseEnvLine("gcs_bucket=aporia-unleash");
    assert.equal(result.kind, "error");
    assert.match(result.message, /not a recognized KEY=VALUE line/);
  });

  it("refuses a key starting with a digit", () => {
    const result = parseEnvLine("1KEY=value");
    assert.equal(result.kind, "error");
    assert.match(result.message, /not a recognized KEY=VALUE line/);
  });
});

describe("loadEnvFile", () => {
  let tmpDir;
  let tmpFile;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lw-env-test-"));
    tmpFile = path.join(tmpDir, ".env.local");
  });
  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns empty values + empty errors when the file is missing", () => {
    const missing = path.join(tmpDir, "does-not-exist");
    const result = loadEnvFile(missing);
    assert.deepEqual(result, { values: {}, errors: [] });
  });

  it("loads a clean multi-line file", async () => {
    await fs.writeFile(
      tmpFile,
      [
        "# comment",
        "",
        "GCS_BUCKET=aporia-unleash",
        'CRON_SECRET="some-secret"',
        "MEDIA_PUBLIC_BASE=https://media.lorewire.com",
      ].join("\n"),
    );
    const { values, errors } = loadEnvFile(tmpFile);
    assert.deepEqual(errors, []);
    assert.deepEqual(values, {
      GCS_BUCKET: "aporia-unleash",
      CRON_SECRET: "some-secret",
      MEDIA_PUBLIC_BASE: "https://media.lorewire.com",
    });
  });

  it("aggregates EVERY malformed line with file:lineNumber so one run surfaces all problems", async () => {
    await fs.writeFile(
      tmpFile,
      [
        "GCS_BUCKET=clean",
        'BROKEN_ONE="aporia-unleash"M9OP0\\-',
        "BROKEN_TWO='unclosed",
        "  INDENTED=value",
      ].join("\n"),
    );
    const { values, errors } = loadEnvFile(tmpFile);
    assert.equal(errors.length, 3);
    // Each error carries the file:line prefix.
    assert.ok(errors[0].includes(`${tmpFile}:2:`), errors[0]);
    assert.ok(errors[1].includes(`${tmpFile}:3:`), errors[1]);
    assert.ok(errors[2].includes(`${tmpFile}:4:`), errors[2]);
    // Clean line still landed in values.
    assert.equal(values.GCS_BUCKET, "clean");
    // Broken lines did NOT land in values.
    assert.equal(values.BROKEN_ONE, undefined);
    assert.equal(values.BROKEN_TWO, undefined);
    assert.equal(values.INDENTED, undefined);
  });

  it("handles CRLF line endings the same as LF", async () => {
    await fs.writeFile(
      tmpFile,
      "GCS_BUCKET=aporia-unleash\r\nCRON_SECRET=abc\r\n",
    );
    const { values, errors } = loadEnvFile(tmpFile);
    assert.deepEqual(errors, []);
    assert.deepEqual(values, {
      GCS_BUCKET: "aporia-unleash",
      CRON_SECRET: "abc",
    });
  });

  it("strips a BOM at the very start of the file", async () => {
    await fs.writeFile(tmpFile, "﻿GCS_BUCKET=aporia-unleash\n");
    const { values, errors } = loadEnvFile(tmpFile);
    assert.deepEqual(errors, []);
    assert.equal(values.GCS_BUCKET, "aporia-unleash");
  });
});
