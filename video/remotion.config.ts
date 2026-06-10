import { Config } from "@remotion/cli/config";

// Hardware acceleration on Windows uses the Chromium swiftshader path which
// has caused intermittent encode failures on long compositions. Disable until
// we have a real reason to turn it back on.
Config.setHardwareAcceleration("disable");

// We render at 1080x1920 (vertical). 30 fps matches the yt-studio Shorts target
// and keeps file size manageable for a 2-3 minute video.
Config.setVideoImageFormat("jpeg");
Config.setJpegQuality(85);
