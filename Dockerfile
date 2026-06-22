FROM node:24-bookworm-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
COPY tsconfig.build.json ./
RUN npm ci

COPY src ./src
COPY sdk.js ./sdk.js
COPY config.example.toml ./config.example.toml

RUN npm run build && npm prune --omit=dev

FROM node:24-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/sdk.js ./sdk.js
COPY --from=build /app/config.example.toml ./config.example.toml

EXPOSE 8788

CMD ["node", "dist/admin-server.js"]

FROM runtime AS browser

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV SENTINEL_BROWSER_PATH=/usr/bin/chromium
