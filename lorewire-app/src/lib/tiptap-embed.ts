// Tiptap Embed node — sandboxed iframes for YouTube, X (Twitter), and
// TikTok only. The provider allowlist is the security boundary: an
// unrecognized URL never reaches the iframe src. The conversion table
// translates the writer-pasted URL into the provider's canonical embed
// URL (YouTube's /embed/ID, X's platform.twitter.com/embed/Tweet.html,
// TikTok's /embed/v2/ID) so we don't trust whatever query string the
// writer pastes.
//
// Why these three: highest editorial demand for a Phase 5 launch. Adding
// a fourth (Vimeo, Instagram, Bluesky) is one new branch in toEmbedUrl
// plus a hostname allowlist entry.

import { Node, mergeAttributes } from "@tiptap/core";

export type EmbedProvider = "youtube" | "x" | "tiktok";

export const EMBED_PROVIDERS: EmbedProvider[] = ["youtube", "x", "tiktok"];

declare module "@tiptap/core" {
  interface Commands<ReturnType> {
    articleEmbed: {
      insertArticleEmbed: (attrs: { url: string }) => ReturnType;
    };
  }
}

// Allowed iframe hostnames. We allow the bare provider host AND the
// canonical embed host so X's platform.twitter.com and TikTok's
// www.tiktok.com both pass — the iframe src is always one of these.
const ALLOWED_EMBED_HOSTS = new Set([
  "www.youtube.com",
  "youtube.com",
  "platform.twitter.com",
  "www.tiktok.com",
  "tiktok.com",
]);

// Parse a writer-pasted URL into (provider, canonical embed URL). Returns
// null for anything not on the allowlist so the NodeView can refuse the
// insert and the public renderer can fall back to a noscript-ish marker.
export function toEmbedUrl(
  raw: string,
): { provider: EmbedProvider; embedUrl: string } | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;

  // YouTube — accept both watch?v= and youtu.be/<id>
  if (u.hostname === "www.youtube.com" || u.hostname === "youtube.com") {
    const v = u.searchParams.get("v");
    if (v && /^[\w-]{11}$/.test(v)) {
      return {
        provider: "youtube",
        embedUrl: `https://www.youtube.com/embed/${v}`,
      };
    }
  }
  if (u.hostname === "youtu.be") {
    const v = u.pathname.slice(1);
    if (/^[\w-]{11}$/.test(v)) {
      return {
        provider: "youtube",
        embedUrl: `https://www.youtube.com/embed/${v}`,
      };
    }
  }

  // X / Twitter — status ids are pure digits, length is unbounded but
  // realistically <= 25 chars. We cap at 30 as a paranoia limit.
  if (u.hostname === "twitter.com" || u.hostname === "x.com") {
    const m = u.pathname.match(/^\/[^/]+\/status\/(\d{1,30})/);
    if (m) {
      return {
        provider: "x",
        embedUrl: `https://platform.twitter.com/embed/Tweet.html?id=${m[1]}`,
      };
    }
  }

  // TikTok — video ids are digits, optional /@username/video/<id> shape.
  if (u.hostname === "www.tiktok.com" || u.hostname === "tiktok.com") {
    const m = u.pathname.match(/\/video\/(\d{1,30})/);
    if (m) {
      return {
        provider: "tiktok",
        embedUrl: `https://www.tiktok.com/embed/v2/${m[1]}`,
      };
    }
  }

  return null;
}

// Hostname allowlist guard used by renderHTML — defense in depth. Even if
// the stored URL was bypassed at insert time, we re-check on every render
// and refuse to emit an iframe to a non-allowlisted host.
function isAllowedEmbedHost(url: string): boolean {
  try {
    const u = new URL(url);
    return ALLOWED_EMBED_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export const ArticleEmbed = Node.create({
  name: "articleEmbed",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      provider: {
        default: "" as EmbedProvider | "",
        parseHTML: (el: HTMLElement) =>
          el.getAttribute("data-provider") ?? "",
      },
      url: {
        default: "",
        parseHTML: (el: HTMLElement) =>
          el.querySelector("iframe")?.getAttribute("src") ?? "",
      },
      originalUrl: {
        default: "",
        parseHTML: (el: HTMLElement) =>
          el.getAttribute("data-original-url") ?? "",
      },
    };
  },

  parseHTML() {
    return [{ tag: "div[data-article-embed]" }];
  },

  renderHTML({ HTMLAttributes, node }) {
    const url = String(node.attrs.url ?? "");
    const provider = String(node.attrs.provider ?? "");
    const wrapper = mergeAttributes(HTMLAttributes, {
      "data-article-embed": "",
      "data-provider": provider,
      "data-original-url": String(node.attrs.originalUrl ?? ""),
    });
    if (!url || !isAllowedEmbedHost(url)) {
      // Fall back to a marker the reader CSS can style as "Unsupported
      // embed" rather than emit a hidden / silently-broken iframe.
      return [
        "div",
        wrapper,
        ["p", { class: "embed-fallback" }, "Unsupported embed"],
      ];
    }
    // sandbox: the bare minimum each provider needs to function.
    //   allow-scripts          — the embed runs its own JS.
    //   allow-same-origin      — required for YouTube and TikTok to load
    //                            their own assets cross-origin.
    //   allow-presentation     — fullscreen video.
    //   allow-popups           — share/profile click-through on X/TikTok.
    // We deliberately omit allow-forms and allow-top-navigation so the
    // embed can't post to our domain or hijack the parent frame.
    const sandbox =
      "allow-scripts allow-same-origin allow-presentation allow-popups";
    return [
      "div",
      wrapper,
      [
        "iframe",
        {
          src: url,
          sandbox,
          loading: "lazy",
          referrerpolicy: "no-referrer-when-downgrade",
          allowfullscreen: "true",
          // Aspect-ratio reservation so the embed doesn't cause CLS while
          // loading. 16:9 covers YouTube and TikTok; X reflows.
          width: "100%",
          height: "auto",
          style: "aspect-ratio: 16 / 9; width: 100%; border: 0;",
          title: provider ? `${provider} embed` : "Embedded media",
        },
      ],
    ];
  },

  addCommands() {
    return {
      insertArticleEmbed:
        (attrs) =>
        ({ commands }) => {
          const parsed = toEmbedUrl(attrs.url);
          if (!parsed) return false;
          return commands.insertContent({
            type: this.name,
            attrs: {
              provider: parsed.provider,
              url: parsed.embedUrl,
              originalUrl: attrs.url,
            },
          });
        },
    };
  },
});
