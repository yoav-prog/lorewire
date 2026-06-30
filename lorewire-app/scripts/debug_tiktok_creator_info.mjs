// Diagnostic: walk the same two-step the publisher walks
// (oauth/token → creator_info/query) and dump the raw response body so
// we can pinpoint exactly where TikTok rejects us — or confirm the
// token side is healthy and the failure is downstream.
//
// One-shot, read-only against TikTok. Does NOT touch the database, does
// NOT publish anything, does NOT mutate any TikTok state. Cases the
// analysis distinguishes:
//   - HTTP 200 + error.code="ok" + privacy_level_options present
//       → creator_info is fine. open_id is intentionally absent from
//         this endpoint's response — open_id defense-in-depth lives on
//         the /oauth/token/ response. Any publish failure is downstream.
//   - HTTP 200 + error.code !== "ok" (e.g. scope_not_authorized)
//       → token was minted with the wrong scopes — re-mint and
//         re-consent the OAuth flow.
//   - HTTP 200 + error.code="ok" + privacy_level_options missing
//       → unexpected; treat as a TikTok-side API change and read the
//         raw body printed above.
//   - non-200
//       → token expired / revoked / wrong client_key+secret pair.
//
// Usage (from lorewire-app/):
//   node --env-file=.env.local scripts/debug_tiktok_creator_info.mjs
//
// Output safety (rule 13): masks the actual access_token, refresh_token,
// and client_secret in the printed lines — only lengths + last-6 chars
// are shown. The raw creator_info response body IS printed verbatim, but
// that body does not contain credentials so it's safe to paste.

const TT_OAUTH_URL = "https://open.tiktokapis.com/v2/oauth/token/";
const TT_CREATOR_INFO_URL =
  "https://open.tiktokapis.com/v2/post/publish/creator_info/query/";

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY ?? "";
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET ?? "";
const REFRESH_TOKEN = process.env.TIKTOK_REFRESH_TOKEN ?? "";
const EXPECTED_OPEN_ID = process.env.TIKTOK_OPEN_ID ?? "";

if (!CLIENT_KEY || !CLIENT_SECRET || !REFRESH_TOKEN) {
  console.error(
    "Missing TIKTOK_CLIENT_KEY / CLIENT_SECRET / REFRESH_TOKEN in env.",
  );
  console.error(
    "Run with --env-file=.env.local from lorewire-app/, or set them inline.",
  );
  process.exit(1);
}

function mask(s) {
  if (!s) return "(empty)";
  if (s.length <= 8) return `(len ${s.length}, masked)`;
  return `(len ${s.length}, …${s.slice(-6)})`;
}

console.log("");
console.log("[debug tiktok] config:");
console.log(
  "  client_key      :",
  mask(CLIENT_KEY),
  CLIENT_KEY.startsWith("sb") ? "(SANDBOX app — sb-prefix)" : "(prod app)",
);
console.log("  client_secret   :", mask(CLIENT_SECRET));
console.log("  refresh_token   :", mask(REFRESH_TOKEN));
console.log("  open_id (env)   :", mask(EXPECTED_OPEN_ID));
console.log("");

// --- Step 1: refresh access token ------------------------------------------

console.log("[1/2] POST /v2/oauth/token/  (grant_type=refresh_token)…");

let oauthResp;
try {
  oauthResp = await fetch(TT_OAUTH_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "Cache-Control": "no-cache",
    },
    body: new URLSearchParams({
      client_key: CLIENT_KEY,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: "refresh_token",
    }).toString(),
  });
} catch (e) {
  console.error("  network error calling /oauth/token/:", e.message ?? e);
  process.exit(1);
}

const oauthText = await oauthResp.text();
let oauthJson;
try {
  oauthJson = JSON.parse(oauthText);
} catch {
  console.error("  oauth response was not JSON:");
  console.error(oauthText.slice(0, 500));
  process.exit(1);
}

console.log("  http status      :", oauthResp.status);
console.log("  oauth open_id    :", mask(oauthJson.open_id ?? ""));
console.log(
  "  scopes granted   :",
  oauthJson.scope ?? "(missing from response)",
);
console.log("  access_token     :", mask(oauthJson.access_token ?? ""));
console.log(
  "  refresh rotated  :",
  typeof oauthJson.refresh_token === "string" &&
    oauthJson.refresh_token !== REFRESH_TOKEN,
);
console.log("  expires_in (s)   :", oauthJson.expires_in ?? "?");
if (oauthJson.error || oauthJson.error_description) {
  console.log(
    "  error            :",
    oauthJson.error ?? oauthJson.error_description,
  );
}

if (!oauthJson.access_token) {
  console.error("");
  console.error("[debug tiktok] FAIL: oauth refresh did not return access_token.");
  console.error("  Full response body:");
  console.error(JSON.stringify(oauthJson, null, 2));
  process.exit(1);
}

const accessToken = oauthJson.access_token;
const oauthOpenId = (oauthJson.open_id ?? "").toString();
const grantedScopes = (oauthJson.scope ?? "").toString();

// --- Step 2: creator_info query --------------------------------------------

console.log("");
console.log("[2/2] POST /v2/post/publish/creator_info/query/  (Bearer token)…");

let ciResp;
try {
  ciResp = await fetch(TT_CREATOR_INFO_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json; charset=UTF-8",
    },
    body: "",
  });
} catch (e) {
  console.error("  network error calling /creator_info/query/:", e.message ?? e);
  process.exit(1);
}

const ciText = await ciResp.text();
let ciJson;
try {
  ciJson = JSON.parse(ciText);
} catch {
  console.error("  creator_info response was not JSON:");
  console.error(ciText.slice(0, 500));
  process.exit(1);
}

console.log("  http status      :", ciResp.status);
console.log("  raw response body:");
console.log(JSON.stringify(ciJson, null, 2));

// --- Analysis --------------------------------------------------------------

console.log("");
console.log("[debug tiktok] analysis:");

const ciData = ciJson?.data ?? {};
const ciError = ciJson?.error ?? {};
const ciPrivacy = Array.isArray(ciData.privacy_level_options)
  ? ciData.privacy_level_options
  : [];
const ciNickname = (ciData.creator_nickname ?? "").toString();
const ciUsername = (ciData.creator_username ?? "").toString();

if (ciError.code && ciError.code !== "ok") {
  console.log(`  ✗ TikTok returned error.code = "${ciError.code}"`);
  console.log(`    message : ${ciError.message ?? "(none)"}`);
  console.log(`    log_id  : ${ciError.log_id ?? "(none)"}`);
  console.log("");
  if (
    ciError.code === "scope_not_authorized" ||
    /scope/i.test(ciError.message ?? "")
  ) {
    console.log("  → Token doesn't carry the required scope. Re-mint via");
    console.log("    scripts/get_tiktok_refresh_token.mjs and approve both");
    console.log("    `video.upload` AND `video.publish` at the consent screen.");
  } else {
    console.log("  → Treat the error code above as the diagnosis.");
    console.log("    Likely scope / audit / app config.");
  }
} else if (ciPrivacy.length === 0) {
  console.log("  ⚠ HTTP 200 + error.code=\"ok\" but no privacy_level_options.");
  console.log("    Unexpected — TikTok always returns at least SELF_ONLY when");
  console.log("    the token is valid. Possible API change; read the raw body");
  console.log("    above. May also indicate a sandbox account never approved.");
} else {
  console.log("  ✓ creator_info is healthy.");
  if (ciNickname || ciUsername) {
    console.log(
      `    creator        : ${ciNickname || "(no nickname)"} ` +
        `(@${ciUsername || "no-username"})`,
    );
  }
  console.log(`    privacy levels : ${JSON.stringify(ciPrivacy)}`);
  console.log("");
  console.log(
    "  Note: open_id is intentionally NOT in this response — TikTok",
  );
  console.log(
    "  returns it on /oauth/token/, which the publisher already",
  );
  console.log(
    "  validates against env via defaultGetAccessToken. The token-side",
  );
  console.log("  of the publisher is wired correctly.");
  console.log("");
  if (EXPECTED_OPEN_ID && oauthOpenId && oauthOpenId !== EXPECTED_OPEN_ID) {
    console.log(
      `  ⚠ env TIKTOK_OPEN_ID ends …${EXPECTED_OPEN_ID.slice(-6)} but oauth`,
    );
    console.log(
      `    returned …${oauthOpenId.slice(-6)}. Publisher will refuse to post.`,
    );
  } else if (oauthOpenId) {
    console.log(
      `  ✓ oauth open_id matches env (…${oauthOpenId.slice(-6)}). Any publish`,
    );
    console.log(
      "    failure is downstream (init / status_poll / scope), not auth.",
    );
  }
}

console.log("");
console.log(`[debug tiktok] granted scopes on this token: "${grantedScopes}"`);
if (!grantedScopes.includes("video.publish")) {
  console.log(
    "  ⚠ `video.publish` NOT in granted scopes — direct posting will fail",
  );
  console.log("    even after audit clears. Re-consent the OAuth flow.");
}
if (!grantedScopes.includes("video.upload")) {
  console.log(
    "  ⚠ `video.upload` NOT in granted scopes — inbox/drafts mode will fail.",
  );
}
console.log("");
