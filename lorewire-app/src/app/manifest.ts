import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "LoreWire",
    short_name: "LoreWire",
    description: "The internet's stories, retold. Watch, read, or read along.",
    start_url: "/",
    display: "standalone",
    orientation: "portrait",
    background_color: "#0A0A0C",
    theme_color: "#0A0A0C",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
    ],
  };
}
