# syntax=docker/dockerfile:1

FROM node:24.13.0-bookworm-slim AS build

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/crdt/package.json packages/crdt/tsconfig.json ./packages/crdt/
COPY packages/protocol/package.json packages/protocol/tsconfig.json ./packages/protocol/
COPY apps/server/package.json apps/server/tsconfig.json ./apps/server/
COPY apps/web/package.json ./apps/web/
COPY packages/crdt/src ./packages/crdt/src
COPY packages/protocol/src ./packages/protocol/src
COPY apps/server/src ./apps/server/src

RUN npm ci \
  && npm run build -w @lfcw/crdt \
  && npm run build -w @lfcw/protocol \
  && npm run build -w @lfcw/server \
  && npm prune --omit=dev

FROM node:24.13.0-bookworm-slim

WORKDIR /app

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=3001 \
    SQLITE_PATH=/data/lfcw.sqlite

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/crdt ./packages/crdt
COPY --from=build /app/packages/protocol ./packages/protocol
COPY --from=build /app/apps/server/package.json ./apps/server/package.json
COPY --from=build /app/apps/server/dist ./apps/server/dist

EXPOSE 3001

CMD ["node", "apps/server/dist/index.js"]
