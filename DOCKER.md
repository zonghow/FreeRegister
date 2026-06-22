# Docker Usage

Build the image:

```bash
docker build -t free-register:local .
```

Build the optional browser-capable image:

```bash
docker build --target browser -t free-register:browser .
```

Run one registration:

```bash
docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -e FREE_REGISTER_CONFIG=/data/config.toml \
  -e FREE_REGISTER_EMAIL_POOL_DIR=/data \
  -e FREE_REGISTER_SENTINEL_SDK_FILE=/data/sdk.js \
  -v "$PWD:/data" \
  free-register:local \
  npm run register -- --total 1 --concurrency 1
```

Run the web admin:

```bash
FREE_REGISTER_ADMIN_PASSWORD='change-this-password' \
docker compose up
```

Open http://localhost:8788 and log in with `FREE_REGISTER_ADMIN_PASSWORD`.

Run with Compose:

```bash
docker compose run --rm free-register npm run register -- --total 2 --concurrency 2
```

Compose 默认给后台进程设置 `NODE_OPTIONS=--max-old-space-size=12288`，降低长时间高并发撞到 Node 默认 4GB heap 的概率。可以按机器内存调整：

```bash
FREE_REGISTER_NODE_HEAP_MB=8192 docker compose up -d --build
```

To keep running until `email.txt` is empty, set this in `config.toml`:

```toml
[run]
concurrency = 10
run_until_empty = true
```

When `run_until_empty = true`, `total` is ignored and workers stop only after no source email can be leased.
The runner also monitors process memory. Leave `memory_soft_limit_mb` and `memory_hard_limit_mb` as `0` to derive thresholds from the current Node heap, or set explicit MB values in `[run]`.

Update `sdk.js` from Docker:

```bash
docker run --rm \
  --add-host=host.docker.internal:host-gateway \
  -e FREE_REGISTER_CONFIG=/data/config.toml \
  -e FREE_REGISTER_SENTINEL_SDK_FILE=/data/sdk.js \
  -v "$PWD:/data" \
  free-register:local \
  npm run update:sdk
```

Notes:

- Proxy URLs are configured only in `config.toml` under `[proxies].urls`; leave the array empty for direct connections.
- HeroSMS API calls use proxies only when `[hero_sms].use_proxy = true`.
- Inside Docker, `127.0.0.1` means the container itself. Use `host.docker.internal` in `config.toml` for a proxy running on the host machine.
- The image does not bake in `config.toml` or `email*.txt`; mount the project directory at `/data` so secrets and pool state stay on the host.
- Mounting the whole pool directory also keeps `.email.lock` shared, so concurrent containers still serialize email moves correctly.
- The Compose default starts the web admin on port `8788`; set `FREE_REGISTER_ADMIN_PASSWORD` before exposing it beyond localhost.
- The default image is for `use_browser_sentinel = false`. If you enable browser sentinel, build with `--target browser` and set `[sentinel_browser].path = "/usr/bin/chromium"`.
