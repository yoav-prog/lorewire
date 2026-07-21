// Generates the built-in brand assets shipped in /public:
//
//   public/og.png    1200x630  default share card (og:image fallback)
//   public/logo.png  1024x1024 Organization JSON-LD logo
//
// Run from lorewire-app/:
//   npm i --no-save fontkit
//   node scripts/gen_brand_assets.mjs
//
// Text is converted to SVG path outlines via fontkit, then rasterized
// with sharp — no fonts need to be installed on the machine, so the output
// is identical everywhere. Fonts are fetched once and cached beside this
// script (same families the app loads via next/font: Archivo Black for
// the wordmark, Hanken Grotesk for body copy). fontkit, not opentype.js:
// opentype.js chokes on Hanken Grotesk twice (unsupported GSUB lookup in
// the variable TTF, NaN outline coordinates in the gstatic static).
//
// Palette mirrors globals.css: bg #0A0A0C, ink #F5F3EF, accent #E8462B,
// muted #C9C6CE. The share card echoes the app's own furniture: the LW
// badge from the mobile billboard, the two-tone LORE/WIRE wordmark from
// the desktop TopNav, and the giant low-opacity glyph from PosterArt's
// no-artwork fallback.
// Plan: _plans/2026-07-05-seo-brand-assets.md.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { create as createFont } from "fontkit";
import sharp from "sharp";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CACHE = path.join(ROOT, "scripts", ".font-cache");
const OUT = path.join(ROOT, "public");

const BG = "#0A0A0C";
const INK = "#F5F3EF";
const ACCENT = "#E8462B";
const MUTED = "#C9C6CE";

const FONTS = {
  archivo:
    "https://raw.githubusercontent.com/google/fonts/main/ofl/archivoblack/ArchivoBlack-Regular.ttf",
  // Static Medium instance from the gstatic CDN (resolved via the legacy
  // css?family=Hanken+Grotesk:500 API) — matches the weight the app's
  // body copy uses.
  hanken:
    "https://fonts.gstatic.com/s/hankengrotesk/v12/ieVq2YZDLWuGJpnzaiwFXS9tYvBRzyFLlZg_f_NcgWZq5vBJ.ttf",
};

async function loadFont(name, url) {
  await mkdir(CACHE, { recursive: true });
  const file = path.join(CACHE, `${name}.ttf`);
  if (!existsSync(file)) {
    console.info("[brand assets] fetching font", { name, url });
    const res = await fetch(url);
    if (!res.ok) throw new Error(`font fetch failed: ${name} ${res.status}`);
    await writeFile(file, Buffer.from(await res.arrayBuffer()));
  }
  return createFont(await readFile(file));
}

// fontkit shapes the run (kerning included) and yields glyph outlines in
// font units, Y-up. Each glyph becomes a <path> with a translate+scale
// transform that flips Y around the baseline. letterSpacing is in em.
function layoutGlyphs(font, text, size, opts = {}) {
  const scale = size / font.unitsPerEm;
  const spacing = (opts.letterSpacing ?? 0) * size;
  const run = font.layout(text);
  const glyphs = [];
  let cursor = 0;
  run.glyphs.forEach((glyph, i) => {
    const pos = run.positions[i];
    glyphs.push({
      glyph,
      x: cursor + pos.xOffset * scale,
      y: -pos.yOffset * scale,
    });
    cursor += pos.xAdvance * scale + spacing;
  });
  return { glyphs, width: cursor - spacing, scale };
}

// Text as filled <path> elements at (x, baselineY).
function textPath(font, text, x, y, size, fill, opts = {}) {
  const { glyphs, scale } = layoutGlyphs(font, text, size, opts);
  return glyphs
    .map(
      ({ glyph, x: gx, y: gy }) =>
        `<path d="${glyph.path.toSVG()}" fill="${fill}" ` +
        `transform="translate(${(x + gx).toFixed(2)} ${(y + gy).toFixed(2)}) scale(${scale} ${-scale})"/>`,
    )
    .join("");
}

function textWidth(font, text, size, opts = {}) {
  return layoutGlyphs(font, text, size, opts).width;
}

// The LW badge from the mobile billboard: light rounded square, dark LW,
// accent dot in the top-right corner. All coordinates scale from the
// app's 26px original.
function lwBadge(font, x, y, size) {
  const s = size / 26;
  const text = "LW";
  const textSize = 11 * s;
  const tw = textWidth(font, text, textSize, { letterSpacing: -0.04 });
  const tx = x + (size - tw) / 2;
  const ty = y + size / 2 + textSize * 0.36;
  const dotR = 2 * s;
  const dotCx = x + size - 4 * s - dotR;
  const dotCy = y + 3 * s + dotR;
  return [
    `<rect x="${x}" y="${y}" width="${size}" height="${size}" rx="${7 * s}" fill="${INK}"/>`,
    textPath(font, text, tx, ty, textSize, BG, { letterSpacing: -0.04 }),
    `<circle cx="${dotCx}" cy="${dotCy}" r="${dotR}" fill="${ACCENT}"/>`,
  ].join("");
}

async function buildOgCard(archivo, hanken) {
  const W = 1200;
  const H = 630;
  const LEFT = 100;
  const wordSize = 148;
  const spacing = -0.02;
  const loreW = textWidth(archivo, "LORE", wordSize, { letterSpacing: spacing });

  const svg = `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${W}" height="${H}" fill="${BG}"/>
  ${textPath(archivo, "?", 880, 560, 640, "rgba(255,255,255,0.06)")}
  ${lwBadge(archivo, LEFT, 108, 84)}
  ${textPath(archivo, "LORE", LEFT, 388, wordSize, INK, { letterSpacing: spacing })}
  ${textPath(archivo, "WIRE", LEFT + loreW, 388, wordSize, ACCENT, { letterSpacing: spacing })}
  <rect x="${LEFT + 4}" y="428" width="120" height="6" rx="3" fill="${ACCENT}"/>
  ${textPath(hanken, "Every internet story ends with your verdict.", LEFT, 508, 36, MUTED)}
</svg>`;

  await sharp(Buffer.from(svg)).png().toFile(path.join(OUT, "og.png"));
  console.info("[brand assets] wrote public/og.png", { W, H });
}

async function buildLogo(archivo) {
  const S = 1024;
  const text = "LW";
  const textSize = 430;
  const spacing = -0.04;
  const tw = textWidth(archivo, text, textSize, { letterSpacing: spacing });
  const tx = (S - tw) / 2;
  const ty = S / 2 + textSize * 0.36;
  // Dot proportions from the app badge (4/26 of the box, top 3 right 4).
  const s = S / 26;
  const dotR = 2 * s;
  const dotCx = S - 4 * s - dotR;
  const dotCy = 3 * s + dotR;

  const svg = `<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}" xmlns="http://www.w3.org/2000/svg">
  <rect width="${S}" height="${S}" rx="200" fill="${BG}"/>
  ${textPath(archivo, text, tx, ty, textSize, INK, { letterSpacing: spacing })}
  <circle cx="${dotCx}" cy="${dotCy}" r="${dotR}" fill="${ACCENT}"/>
</svg>`;

  await sharp(Buffer.from(svg)).png().toFile(path.join(OUT, "logo.png"));
  console.info("[brand assets] wrote public/logo.png", { S });
}

const archivo = await loadFont("archivo-black", FONTS.archivo);
const hanken = await loadFont("hanken-grotesk", FONTS.hanken);
await buildOgCard(archivo, hanken);
await buildLogo(archivo);
console.info("[brand assets] done");
