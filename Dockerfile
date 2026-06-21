FROM node:24-bookworm-slim AS app

WORKDIR /app

COPY package.json package-lock.json tsconfig.json ./
RUN npm ci

COPY src ./src
COPY test ./test
COPY sdk.js ./sdk.js
COPY config.example.toml ./config.example.toml

EXPOSE 8788

CMD ["npm", "run", "admin", "--"]

FROM app AS browser

RUN apt-get update \
    && apt-get install -y --no-install-recommends chromium ca-certificates \
    && rm -rf /var/lib/apt/lists/*

ENV SENTINEL_BROWSER_PATH=/usr/bin/chromium

FROM app AS runtime
