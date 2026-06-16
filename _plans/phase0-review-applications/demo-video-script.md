# Demo video — single recording for all four reviews

One screencast satisfies Google OAuth verification, YouTube quota
expansion, Meta App Review, and TikTok audit. Record it once, upload
to YouTube as **Unlisted**, paste the link into each form.

## Format

- 60–90 seconds total. Reviewers skim fast; don't go over 2 minutes.
- 1920×1080 mp4, screen recording with system audio + a voiceover
  microphone. Voiceover in English.
- No music, no intro card longer than 2 seconds, no marketing copy.
  Reviewers reject sizzle reels — they want to see the actual app
  performing the actual scope.
- Show the URL bar throughout so reviewers can see `lorewire.com` is
  the real origin.

## Scene-by-scene script

### 0:00 — 0:05  Title

Plain text overlay: "LoreWire — publish a short to YouTube, Facebook,
Instagram, TikTok." Voiceover: "LoreWire is a content tool that
publishes short videos to a creator's connected social accounts. This
demo shows the end-to-end flow."

### 0:05 — 0:15  Connect YouTube

1. Open `https://lorewire.com/admin/settings/social-accounts`.
2. Click "Connect YouTube".
3. The Google OAuth consent screen appears. Pause on the consent
   screen so the requested scope (`https://www.googleapis.com/auth/youtube.upload`)
   is clearly visible. Voiceover: "The user explicitly authorizes
   YouTube upload."
4. Click "Continue". Land back on the settings page showing the
   channel name connected.

### 0:15 — 0:25  Connect Instagram + Facebook

1. Click "Connect Instagram & Facebook Page".
2. The Meta OAuth dialog appears. Pause so the requested permissions
   (`instagram_basic`, `instagram_content_publish`,
   `pages_show_list`, `pages_manage_posts`, `publish_video`,
   `pages_read_engagement`) are visible.
3. Click "Continue", land on the settings page showing the IG handle
   and the Page name.

### 0:25 — 0:30  Connect TikTok

1. Click "Connect TikTok".
2. The TikTok OAuth dialog appears. Pause so the requested scope
   (`video.publish`) is visible.
3. Click "Continue", land on the settings page showing the TikTok handle.

### 0:30 — 0:50  Open a finished short

1. Navigate to a story that has a rendered short.
2. Open the short editor. Voiceover: "Here is a 30-second short the
   user already rendered."
3. Show the preview playing a few seconds so the reviewer sees real
   content, not a placeholder.

### 0:50 — 1:10  Publish to YouTube

1. Click the "Publish to YouTube" button.
2. Confirmation modal shows: "About to publish to YouTube. This will
   use 1,600 YouTube quota units."
3. Click Confirm. Show the inline progress indicator running.
4. When it completes, click the resulting public URL. The video plays
   on youtube.com. Voiceover: "The short is now live on the user's
   connected YouTube channel. The user clicked Publish; nothing was
   published unsolicited."

### 1:10 — 1:25  (Meta/TikTok variant — record once for each, splice)

Repeat the publish step for Meta and TikTok if those flows have UI by
the time you record. If they don't (Phase 1 only has YouTube live),
record the YouTube flow once and note in the form: "Meta and TikTok
flows follow the same one-click pattern; we will re-submit this video
once those flows ship."

### 1:25 — 1:30  Disconnect

1. Back on the social accounts page, click "Disconnect" on YouTube.
2. Confirm. Voiceover: "On disconnect, LoreWire revokes the token at
   the platform and removes it from our database immediately."
3. Show the connection row flip to "Not connected".

## What NOT to include

- No internal admin features unrelated to publishing.
- No marketing claims about engagement, growth, or audience targeting.
- No third-party analytics integration shots (reviewers will assume we
  exfiltrate data).
- No mention of monetization or ads.

## Upload settings (YouTube)

- Title: "LoreWire — Multi-platform short publishing demo"
- Description: One paragraph: "LoreWire is a content tool. This video
  shows the end-to-end OAuth + publish flow used by the YouTube,
  Meta, and TikTok integrations."
- Visibility: **Unlisted**
- Made for kids: No
- Don't add tags. Don't add to playlists.
