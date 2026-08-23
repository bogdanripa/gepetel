# Gepetel on the Pi. Built for linux/arm64 by .github/workflows/deploy.yml.
#
# Two stages so the runtime image carries no TypeScript toolchain: the builder
# installs everything and compiles src/ -> dist/, the runtime installs only the
# production dependencies and copies the compiled output across.

# ---------- build ----------
FROM node:22-slim AS build
WORKDIR /srv
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
RUN npx tsc

# ---------- runtime ----------
FROM node:22-slim
# curl is what the healthcheck runs; node:*-slim does not ship it.
RUN apt-get update && apt-get install -y --no-install-recommends curl \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /srv

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /srv/dist ./dist
# src/prompts.ts resolves prompts/ as a sibling of dist/, so the layout has to match
# the repo's: /srv/dist and /srv/prompts.
COPY prompts ./prompts

# Reported by /api/health, so a deploy can be confirmed rather than assumed.
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA

# Port 80 needs root, so no USER line. app.ts binds '::' (dual-stack in Node) —
# the healthcheck below reaches it over IPv6 localhost, the proxy over IPv4.
ENV PORT=80
ENV NODE_ENV=production
EXPOSE 80

# Same path as the app's configured health_path. --start-interval is kept because
# Coolify cannot express it, and it is what makes a cold start resolve in ~0.5s
# instead of waiting out Docker's 5s default before the first probe.
HEALTHCHECK --interval=10s --timeout=3s --start-period=15s \
  --start-interval=250ms \
  CMD curl -fsS http://localhost:80/api/health || exit 1

CMD ["node", "dist/app.js"]
