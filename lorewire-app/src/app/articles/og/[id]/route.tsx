// /articles/og/[id] — dynamic Open Graph image generator.
//
// Used as a fallback when an article does not have an explicit og_image
// set. The metadata exporter for the reader page points here so social
// previews always get a clean, branded card without the writer having to
// upload one. Satori (Vercel's renderer under ImageResponse) supports a
// subset of flexbox; we keep the layout intentionally simple — no fonts
// fetched at request time, no images embedded — so the image is fast and
// the bundle stays under the 500 KB cap.

import { ImageResponse } from "next/og";
import { getArticle } from "@/lib/repo";

// Standard Open Graph card dimensions. Twitter, Facebook, LinkedIn, and
// the Telegram preview all crop / render this size correctly.
const WIDTH = 1200;
const HEIGHT = 630;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const article = await getArticle(id);
  if (!article || article.status !== "published") {
    return new Response("Not found", { status: 404 });
  }
  const language = article.language ?? "en";
  const isRtl = language === "he";
  const title = article.title ?? "LoreWire";
  const subtitle = article.subtitle ?? article.summary ?? "";
  const type = article.type ?? "feature";

  console.info("[articles reader] og", { id, type, language });

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          backgroundColor: "#0A0A0C",
          color: "#F2F2F4",
          padding: 64,
          // RTL: flip horizontal alignment so Hebrew text reads from the
          // right edge as the writer intends. Satori inherits CSS dir,
          // so setting it on the root container is enough.
          direction: isRtl ? "rtl" : "ltr",
        }}
      >
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 22,
            letterSpacing: 4,
            textTransform: "uppercase",
            color: "#7A7A82",
          }}
        >
          <span>
            LORE<span style={{ color: "#FF5A2E" }}>WIRE</span>
          </span>
          <span>{type}</span>
        </div>

        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 24,
            marginTop: "auto",
          }}
        >
          <div
            style={{
              fontSize: 64,
              fontWeight: 800,
              lineHeight: 1.05,
              color: "#F2F2F4",
              // Long titles wrap; we cap the visible characters at ~160
              // so the card never renders mojibake on a runaway title.
              display: "-webkit-box",
              WebkitLineClamp: 3,
              WebkitBoxOrient: "vertical",
              overflow: "hidden",
            }}
          >
            {title.length > 160 ? title.slice(0, 157) + "…" : title}
          </div>
          {subtitle && (
            <div
              style={{
                fontSize: 30,
                lineHeight: 1.3,
                color: "#9C9CA4",
                display: "-webkit-box",
                WebkitLineClamp: 2,
                WebkitBoxOrient: "vertical",
                overflow: "hidden",
              }}
            >
              {subtitle.length > 200 ? subtitle.slice(0, 197) + "…" : subtitle}
            </div>
          )}
        </div>
      </div>
    ),
    {
      width: WIDTH,
      height: HEIGHT,
      headers: {
        // OG images don't change often once an article is published; one
        // day cache eases social-share storms without locking in a stale
        // title forever (a manual re-publish busts the underlying URL).
        "Cache-Control": "public, max-age=86400, s-maxage=86400",
      },
    },
  );
}
