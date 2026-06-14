# LoreWire video render service — Cloud Run container.
#
# Phase 1 of _plans/2026-06-14-cloud-run-render.md. Two-stage build:
#
#   builder  → installs every dep (incl. devDeps), compiles TypeScript
#              for the Express server, prunes node_modules to runtime
#              deps only.
#   runtime  → node:22-slim + headless Chromium that Remotion drives,
#              plus the built server + the composition sources copied
#              from the builder stage. Slim image keeps the cold-start
#              fast (~500 MB on disk, ~3-5s container boot on Cloud Run).
#
# The composition lives at src/Root.tsx and is rendered headless by
# @remotion/renderer's selectComposition + renderMedia (added in Phase 2
# of package.json). We do NOT use @remotion/cli at runtime — the CLI
# spins up a dev server, which is wrong for a request-driven service.
#
# Build locally:
#   docker build -t lorewire-render:dev video/
#
# Build + deploy to Cloud Run:
#   See video/README-cloud-run-setup.md.

# ── builder stage ────────────────────────────────────────────────────────────
FROM node:22-slim AS builder

WORKDIR /app

# Copy manifest first so the npm cache layer survives source changes.
COPY package.json package-lock.json* ./

# `npm ci` requires a lockfile and fails on drift — that's the contract
# we want for a deploy image. devDeps stay so we can `tsc` the server.
RUN npm ci

# Copy everything else AFTER deps install so a touch to src/ doesn't
# bust the npm cache layer.
COPY tsconfig.json tsconfig.server.json remotion.config.ts ./
COPY src ./src
COPY server ./server
COPY public ./public

# Compile the Express server's TypeScript to plain JS. The Remotion
# composition stays as TSX — @remotion/renderer's selectComposition
# bundles + transpiles it at request time via Webpack 5, so we don't
# pre-compile it here. (Pre-compiling would require also pre-bundling
# the composition's whole React tree, which Remotion expects to do
# itself.)
RUN npx tsc -p tsconfig.server.json

# Strip devDeps so the runtime image carries only what it needs at
# request time. Keeping the same node_modules tree avoids a second
# `npm ci` round-trip.
RUN npm prune --omit=dev


# ── runtime stage ────────────────────────────────────────────────────────────
FROM node:22-slim AS runtime

# Chromium + the minimum X / font / freetype shared libraries Remotion's
# headless render needs. We deliberately pin chromium (the package
# stream Debian slim provides) instead of letting puppeteer pull its
# own — sharing a single Chromium binary keeps the image lean and the
# version stable.
#
# `fonts-liberation` covers most Latin glyphs; LoreWire's composition
# uses Google Fonts loaded at render time so the local set is just for
# fallback rendering of system text.
RUN apt-get update && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        fonts-noto-color-emoji \
        libnss3 \
        libxss1 \
        libgtk-3-0 \
        libasound2 \
        libdrm2 \
        libxkbcommon0 \
        libgbm1 \
        libxcomposite1 \
        libxdamage1 \
        libxrandr2 \
        libxshmfence1 \
        ca-certificates \
        tini \
        ffmpeg \
    && rm -rf /var/lib/apt/lists/*

# Tell @remotion/renderer where the Chromium binary lives. Without this
# Remotion falls back to puppeteer's downloaded Chrome, which we don't
# bundle — saving ~150 MB of duplicate binary.
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium
ENV REMOTION_CHROME_EXECUTABLE=/usr/bin/chromium

# Cloud Run runs as a non-root user when available — match.
RUN useradd --create-home --shell /bin/bash render
USER render
WORKDIR /home/render/app

# Bring across runtime deps + the compiled server + the composition
# sources Remotion will bundle at render time.
COPY --from=builder --chown=render:render /app/node_modules ./node_modules
COPY --from=builder --chown=render:render /app/dist ./dist
COPY --from=builder --chown=render:render /app/src ./src
COPY --from=builder --chown=render:render /app/remotion.config.ts ./remotion.config.ts
COPY --from=builder --chown=render:render /app/public ./public
COPY --from=builder --chown=render:render /app/package.json ./package.json

# Cloud Run injects PORT; default to 8080 locally so `docker run -p 8080:8080`
# works without extra flags.
ENV PORT=8080
EXPOSE 8080

# tini reaps zombie Chromium processes when a render times out — important
# because long-tail Remotion render failures can leave headless Chrome
# orphaned, and a Cloud Run instance is reused across requests.
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/server/start.js"]
