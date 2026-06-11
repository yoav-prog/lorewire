// Composition props shape, written by `pipeline/video.py` to a JSON file the
// CLI render command reads. Ported from yt-studio's ShortVideoConfig / ShortCaptionChunk
// (see _reference/youtubestudio/src/lib/shorts-render-types.ts) with the fields we
// actually need; LoreWire stories don't have variant chunks, channel branding from
// CMS, or i2v animation_url yet, so those are dropped.

export interface DoodleFrame {
  url: string;             // file:// or http(s):// path to the image
  caption_chunk_start_index: number; // index into ShortVideoConfig.captions
}

export interface ShortCaptionWord {
  word: string;
  start_ms: number;
  end_ms: number;
}

export interface ShortCaptionChunk {
  start_ms: number;
  end_ms: number;
  text: string;
  words?: ShortCaptionWord[]; // when present, drives the karaoke highlight
}

export interface ShortVideoConfig {
  voiceover_url: string;
  title?: string;
  channel_name?: string;
  duration_ms: number;
  doodle_frames: DoodleFrame[];
  captions: ShortCaptionChunk[];
  // Wave 2 admin toggle: when true, each held image gets a slow Ken-Burns
  // pan/zoom so 30-60 scenes don't feel static between cuts. Off by default
  // to preserve the doodle look.
  ken_burns?: boolean;
}
