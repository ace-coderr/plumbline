# Plumbline public deployment: one service running the dashboard, the indexer API (/api) and the
# indexer's sync loops. SQLite lives on a persistent volume mounted at /data.

FROM node:20-bookworm-slim AS build
# Toolchain for native modules (better-sqlite3) in case no prebuilt binary matches.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable && corepack prepare pnpm@9.15.9 --activate
WORKDIR /app
COPY . .
# Only the web app and what it depends on (shared, indexer); contracts and bots are not built.
RUN pnpm install --frozen-lockfile --filter "@plumbline/web..."
RUN pnpm --filter "@plumbline/web..." build

FROM node:20-bookworm-slim
# IBM Plex for the rendered link-preview cards.
RUN apt-get update \
  && apt-get install -y --no-install-recommends fonts-ibm-plex fontconfig ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production \
  EMBED_INDEXER=true \
  KEEPER_URL=off \
  INDEXER_DB=/data/indexer-99801.sqlite \
  INDEXER_RPC_URL=https://rpc-elysium-testnet.t.conduit.xyz \
  INDEXER_RPC_PER_SECOND=2 \
  INDEXER_POLL_MS=3000 \
  INDEXER_SAMPLE_MS=30000
EXPOSE 8080
CMD ["node", "apps/web/dist-server/server/index.js"]
