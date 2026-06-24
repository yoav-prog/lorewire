// One-time CLI: mint a YouTube OAuth refresh token for the LoreWire
// channel and print it. Paste the output into Vercel env as
// YOUTUBE_REFRESH_TOKEN (+ YOUTUBE_CHANNEL_ID, which this script also
// prints after a /channels?mine=true lookup).
//
// Plan: _plans/2026-06-24-youtube-and-tiktok-auto-publish-and-socials-admin.md
// (see "OAuth setup scripts").
//
// Usage:
//   1. In Google Cloud Console, create an OAuth client of type "Web
//      application". Add http://localhost:3719/callback as an Authorized
//      Redirect URI. Take note of the client id + client secret.
//   2. Put the client id + secret in your shell:
//        $env:YOUTUBE_CLIENT_ID = "..."
//        $env:YOUTUBE_CLIENT_SECRET = "..."
//   3. Run this script from the lorewire-app folder:
//        node scripts/get_youtube_refresh_token.mjs
//   4. Your default browser opens to Google's consent screen. Sign in
//      with the Google account that owns @LoreWireHQ. Approve.
//   5. The script captures the auth code via the localhost callback,
//      exchanges it for tokens, and prints the refresh_token +
//      channel_id to stdout.
//   6. Paste them into Vercel env. Redeploy.
//
// Security notes:
//   - The client secret is read from env, never persisted by the script.
//   - The refresh token is printed to stdout once. Don't pipe to a file
//     in a shared shell history.
//   - The localhost callback server binds to 127.0.0.1 only; the
//     auth code never leaves the loopback interface.

import http from "node:http";
import { URL, URLSearchParams } from "node:url";
import { exec } from "node:child_process";

const CLIENT_ID = process.env.YOUTUBE_CLIENT_ID ?? "";
const CLIENT_SECRET = process.env.YOUTUBE_CLIENT_SECRET ?? "";
const REDIRECT_URI = "http://localhost:3719/callback";
const SCOPES = ["https://www.googleapis.com/auth/youtube.upload"];

if (!CLIENT_ID || !CLIENT_SECRET) {
  console.error(
    "Missing YOUTUBE_CLIENT_ID or YOUTUBE_CLIENT_SECRET in env. See script header for setup.",
  );
  process.exit(1);
}

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", CLIENT_ID);
authUrl.searchParams.set("redirect_uri", REDIRECT_URI);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", SCOPES.join(" "));
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");

console.log("Opening Google consent URL in your default browser…");
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
  res
    .writeHead(200, { "Content-Type": "text/html" })
    .end(
      "<h1>LoreWire YouTube OAuth: token captured.</h1><p>Return to the terminal to copy your refresh token.</p>",
    );

  try {
    const tokenResp = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        redirect_uri: REDIRECT_URI,
        grant_type: "authorization_code",
      }).toString(),
    });
    const tokenJson = await tokenResp.json();
    if (!tokenResp.ok || !tokenJson.refresh_token) {
      console.error("Token exchange failed:", tokenJson);
      server.close();
      process.exit(1);
    }
    const accessToken = tokenJson.access_token;
    const refreshToken = tokenJson.refresh_token;

    // Resolve the channel id so the operator can paste both into Vercel.
    const chResp = await fetch(
      "https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true",
      { headers: { Authorization: `Bearer ${accessToken}` } },
    );
    const chJson = await chResp.json();
    const channelId = chJson?.items?.[0]?.id ?? "(could not resolve)";
    const channelTitle = chJson?.items?.[0]?.snippet?.title ?? "(unknown)";

    console.log("");
    console.log("✓ YouTube OAuth complete.");
    console.log("");
    console.log("Channel:           ", channelTitle);
    console.log("YOUTUBE_CHANNEL_ID:", channelId);
    console.log("YOUTUBE_REFRESH_TOKEN:", refreshToken);
    console.log("");
    console.log(
      "Paste the env vars into Vercel (Production + Preview). Redeploy.",
    );
    server.close();
    process.exit(0);
  } catch (e) {
    console.error("Token exchange threw:", e);
    server.close();
    process.exit(1);
  }
});

server.listen(3719, "127.0.0.1", () => {
  openInBrowser(authUrl.toString());
  console.log("Waiting for Google consent callback on", REDIRECT_URI, "…");
});
