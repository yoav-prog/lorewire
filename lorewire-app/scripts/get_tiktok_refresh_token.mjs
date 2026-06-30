// One-time CLI: mint a TikTok OAuth refresh token for the LoreWire
// TikTok account and print it. Paste the output into Vercel env as
// TIKTOK_REFRESH_TOKEN (+ TIKTOK_OPEN_ID, also printed).
//
// Plan: _plans/2026-06-24-youtube-and-tiktok-auto-publish-and-socials-admin.md.
//
// Usage:
//   1. In TikTok for Developers, register an app under the LoreWire org.
//      Enable the Content Posting API product. Request scopes
//      `video.upload`, `video.publish`, `user.info.basic`. Add
//      http://localhost:3720/callback as a Redirect URI.
//      Take note of the Client Key + Client Secret.
//   2. Put them in your shell:
//        $env:TIKTOK_CLIENT_KEY = "..."
//        $env:TIKTOK_CLIENT_SECRET = "..."
//   3. Run this script from the lorewire-app folder:
//        node scripts/get_tiktok_refresh_token.mjs
//   4. Your default browser opens to TikTok's consent screen. Sign in
//      with the LoreWire TikTok account. Approve.
//   5. The script captures the auth code via the localhost callback,
//      exchanges it for tokens, and prints the refresh_token +
//      open_id to stdout.
//   6. Paste them into Vercel env. Redeploy.
//
// Notes:
//   - TikTok rotates refresh_token on every exchange; once you paste
//     the token into Vercel, the publisher will use it on the next
//     publish, rotate, and… you'll need to update Vercel again if you
//     re-run the publisher in dev with the same env. Production
//     publishes auto-rotate via the publish-to-tiktok module; the
//     `refresh_token_rotated` log field warns when it changed.
//   - Until TikTok approves your app audit for video.publish, posts
//     land in the Inbox (drafts) regardless of the post_mode setting.

import http from "node:http";
import { URL, URLSearchParams } from "node:url";
import { exec } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";

const CLIENT_KEY = process.env.TIKTOK_CLIENT_KEY ?? "";
const CLIENT_SECRET = process.env.TIKTOK_CLIENT_SECRET ?? "";
const REDIRECT_URI = "http://localhost:3720/callback";
const SCOPES = ["video.upload", "video.publish", "user.info.basic"];
const STATE = randomBytes(16).toString("hex");
// PKCE (RFC 7636). TikTok's v2 authorize endpoint rejects requests
// without a code_challenge (errCode 10007). The verifier stays in this
// process's memory and ships to /oauth/token/ on the exchange.
const CODE_VERIFIER = randomBytes(32).toString("base64url");
const CODE_CHALLENGE = createHash("sha256")
  .update(CODE_VERIFIER)
  .digest("base64url");

if (!CLIENT_KEY || !CLIENT_SECRET) {
  console.error(
    "Missing TIKTOK_CLIENT_KEY or TIKTOK_CLIENT_SECRET in env. See script header for setup.",
  );
  process.exit(1);
}

const authUrl = new URL("https://www.tiktok.com/v2/auth/authorize/");
authUrl.searchParams.set("client_key", CLIENT_KEY);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES.join(","));
authUrl.searchParams.set("state", STATE);
authUrl.searchParams.set("code_challenge", CODE_CHALLENGE);
authUrl.searchParams.set("code_challenge_method", "S256");

console.log("Opening TikTok consent URL in your default browser…");
console.log(authUrl.toString());

function openInBrowser(url) {
  const cmd =
    process.platform === "win32"
      ? `start "" "${url}"`
      : process.platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) {
      console.warn(
        "Could not auto-open the browser. Copy the URL above into your browser manually.",
      );
    }
  });
}

const server = http.createServer(async (req, res) => {
  if (!req.url || !req.url.startsWith("/callback")) {
    res.writeHead(404).end();
    return;
  }
  const u = new URL(req.url, REDIRECT_URI);
  const code = u.searchParams.get("code");
  const error = u.searchParams.get("error");
  const state = u.searchParams.get("state");
  if (error) {
    res.writeHead(400, { "Content-Type": "text/plain" }).end(`Error: ${error}`);
    console.error("OAuth error:", error);
    server.close();
    process.exit(1);
  }
  if (!code) {
    res.writeHead(400, { "Content-Type": "text/plain" }).end("Missing code");
    return;
  }
  if (state !== STATE) {
    res.writeHead(400, { "Content-Type": "text/plain" }).end("State mismatch");
    console.error("State mismatch — possible CSRF. Aborting.");
    server.close();
    process.exit(1);
  }
  res
    .writeHead(200, { "Content-Type": "text/html" })
    .end(
      "<h1>LoreWire TikTok OAuth: token captured.</h1><p>Return to the terminal to copy your refresh token.</p>",
    );

  try {
    const tokenResp = await fetch("https://open.tiktokapis.com/v2/oauth/token/", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "Cache-Control": "no-cache",
      },
      body: new URLSearchParams({
        client_key: CLIENT_KEY,
        client_secret: CLIENT_SECRET,
        code,
        grant_type: "authorization_code",
        redirect_uri: REDIRECT_URI,
        code_verifier: CODE_VERIFIER,
      }).toString(),
    });
    const tokenJson = await tokenResp.json();
    if (!tokenResp.ok || !tokenJson.refresh_token || !tokenJson.open_id) {
      console.error("Token exchange failed:", tokenJson);
      server.close();
      process.exit(1);
    }
    console.log("");
    console.log("✓ TikTok OAuth complete.");
    console.log("");
    console.log("TIKTOK_OPEN_ID:        ", tokenJson.open_id);
    console.log("TIKTOK_REFRESH_TOKEN:  ", tokenJson.refresh_token);
    console.log("");
    console.log("Scopes granted:        ", tokenJson.scope ?? "(unknown)");
    console.log("");
    console.log(
      "Paste the env vars into Vercel (Production + Preview). Redeploy.",
    );
    console.log(
      "Note: if `video.publish` is NOT in the scopes list above, the app",
    );
    console.log(
      "is still in sandbox / pre-audit. Set publisher.tiktok.post_mode to",
    );
    console.log(
      "'inbox' in Settings → Socials → TikTok until the audit clears.",
    );
    server.close();
    process.exit(0);
  } catch (e) {
    console.error("Token exchange threw:", e);
    server.close();
    process.exit(1);
  }
});

server.listen(3720, "127.0.0.1", () => {
  openInBrowser(authUrl.toString());
  console.log("Waiting for TikTok consent callback on", REDIRECT_URI, "…");
});
