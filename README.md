# FreeRegister

FreeRegister 是一个 TypeScript/Node.js 自动化工具，用于按邮箱池租约执行手机号注册、绑定邮箱、完成 Codex OAuth，并在成功后保存对应的 CPA JSON。

项目内置一个极简 Web 后台，可用于编辑 `config.toml`、导入邮箱、启动/暂停任务、查看实时日志、查看 HeroSMS 余额，以及导出成功邮箱和对应 CPA JSON 压缩包。

## 功能

- 手机号注册：通过 HeroSMS 获取手机号和短信验证码。
- 邮箱租约：从 `email.txt` 安全租用邮箱，并发场景下通过文件锁保护移动操作。
- 邮箱 OTP：使用 Hotmail/Outlook refresh token 读取 OpenAI 邮箱验证码。
- Codex OAuth：OAuth 成功后保存账号凭证 JSON 到 `cpa_json/`。
- Web 后台：支持登录、配置编辑、邮箱导入、成功结果导出、任务控制、实时日志。
- 并发运行：支持固定总量和 `run_until_empty` 模式。
- Docker 部署：默认以 Web 后台方式启动。

## 环境要求

- Node.js 24+
- npm
- Docker / Docker Compose 可选
- HeroSMS API key
- 可用邮箱池，格式为：

```text
email----password----clientId----refreshToken
```

## 初始化

```bash
npm install
cp config.example.toml config.toml
```

编辑 `config.toml`，至少填写：

```toml
[hero_sms]
api_key = "your-hero-sms-api-key"
proxy_strategy = "direct"
proxy_urls = []

[proxies]
urls = []
```

将邮箱放入 `email.txt`：

```text
user1@outlook.com----password----clientId----refreshToken
user2@outlook.com----password----clientId----refreshToken
```

`config.toml`、`email*.txt`、`.email.lock`、`cpa_json/` 都是本地运行状态或敏感数据，默认不会提交到 git。

## CLI 运行

按配置运行：

```bash
npm run register
```

覆盖运行数量和并发：

```bash
npm run register -- --total 100 --concurrency 10
```

一直运行到邮箱池为空：

```bash
npm run register -- --run-until-empty
```

也可以在 `config.toml` 中配置：

```toml
[run]
concurrency = 10
run_until_empty = true
# 可选：0 表示按当前 Node heap 自动计算保护线。
memory_soft_limit_mb = 0
memory_hard_limit_mb = 0
```

当 `run_until_empty = true` 时，`total` 会被忽略，任务会按指定并发一直运行到 `email.txt` 没有可租用邮箱。
内存达到软阈值时会停止派发新任务，达到硬阈值时会强制暂停，避免长时间高并发直接触发 Node OOM。

## Web 后台

本地启动：

```bash
FREE_REGISTER_ADMIN_PASSWORD='change-this-password' npm run admin
```

打开：

```text
http://localhost:8788
```

后台支持：

- 查看邮箱池数量、任务状态、HeroSMS 余额。
- 导入邮箱到 `email.txt`。
- 导出并清空 `email.success.txt`，同时打包对应 `cpa_json/*.json`。
- 启动/暂停任务。
- 查看实时日志。
- 使用轻量 TOML 编辑器编辑 `config.toml`。保存后的配置会在下一次启动任务时生效。

## Docker

启动 Web 后台：

```bash
FREE_REGISTER_ADMIN_PASSWORD='change-this-password' docker compose up --build -d
```

默认映射：

```text
http://localhost:8788
```

如果要修改宿主机端口：

```bash
FREE_REGISTER_ADMIN_PASSWORD='change-this-password' \
FREE_REGISTER_ADMIN_PORT=8789 \
docker compose up --build -d
```

Docker 运行时会把项目目录挂载到 `/data`，因此 `config.toml`、邮箱池和 `cpa_json/` 都保存在宿主机项目目录中。
Compose 默认通过 `NODE_OPTIONS=--max-old-space-size=12288` 给 Node 12GB heap；可以用 `FREE_REGISTER_NODE_HEAP_MB=8192` 这类环境变量调整。

更多 Docker 命令见 [DOCKER.md](./DOCKER.md)。

## 配置说明

主要配置在 `config.toml`：

```toml
[run]
total = 1
concurrency = 1
use_browser_sentinel = false
run_until_empty = false

[openai]
default_password = "change-this-password"
save_auth_json = false

[hero_sms]
api_key = ""
proxy_strategy = "direct"
proxy_urls = []
countries = [33]
acquire_priority = "country"
min_price = 0.45
max_price = 0.5
price_step = 0.01
poll_interval_ms = 3000
max_phone_tries = 20
auto_release_on_timeout = true

[email_pool]
source = "email.txt"
success = "email.success.txt"
inflight = "email.inflight.txt"
failed = "email.failed.txt"
lock = ".email.lock"

[cpa_json]
dir = "cpa_json"

[proxies]
urls = []
```

接码国家只配置 `countries`，单国家也写成一个元素的数组。`acquire_priority` 支持：

- `country`：国家优先，每个国家按价格档位尝试。
- `price_low`：低价优先，每个低价档位按国家顺序尝试。
- `price_high`：高价优先，每个高价档位按国家顺序尝试。

网页后台的国家选项会优先从 HeroSMS `getCountries` 接口获取，并永久缓存到 `.cache/hero-sms-countries.json`；接口失败时会继续使用旧缓存，没有缓存时才切换到内置兜底列表。点击“重新加载”会主动刷新这份缓存。

`auto_release_on_timeout = true` 时，如果一个号码在固定轮询窗口内仍未收到验证码，会主动调用 HeroSMS 取消/释放该号码，然后换新号。最多轮询次数不支持配置，程序会按 `poll_interval_ms` 自动计算到超过 2 分钟；默认 `3000ms` 间隔下是 42 次。

HeroSMS 的取号、查码、释放号码、余额和国家列表接口都按 `proxy_strategy` 走网络：

- `hero_sms`：使用 `[hero_sms].proxy_urls` 专用代理池，注册任务中按 worker 轮询代理，后台余额和国家列表使用第一个专用代理。
- `proxies`：复用 `[proxies].urls`，和 OpenAI/邮箱链路使用同一套代理池。
- `direct`：HeroSMS 接口不走代理。

OpenAI/邮箱链路仍只从 `[proxies].urls` 读取。留空表示直连；配置多个代理时会按 worker 轮询负载均衡：

```toml
[hero_sms]
proxy_strategy = "hero_sms"
proxy_urls = [
  "socks5://127.0.0.1:7891"
]

[proxies]
urls = [
  "socks5://127.0.0.1:7890",
  "http://127.0.0.1:8080"
]
```

Docker 中的 `127.0.0.1` 指容器本身。如果代理运行在宿主机上，通常需要使用 `host.docker.internal`。

## 邮箱池状态

- `email.txt`：待使用邮箱池。
- `email.inflight.txt`：已被 worker 租用、正在处理的邮箱。
- `email.success.txt`：OAuth 成功后的邮箱完整凭据行。
- `email.failed.txt`：邮箱已使用或状态不确定时移入失败池。
- `.email.lock`：邮箱池文件锁。

并发运行时不要手动编辑这些文件。需要导入邮箱时建议使用 Web 后台导入功能。

## CPA JSON

OAuth 成功后，程序会把对应 auth JSON 保存到：

```text
cpa_json/
```

Web 后台导出成功邮箱时，会生成一个 zip，包含：

- `email.success.txt`
- 匹配成功邮箱的 `cpa_json/*.json`
- 如果有缺失，会附带 `cpa_json_missing.txt`

导出成功后会清空已导出的成功邮箱行，CPA JSON 文件会保留在本地目录。

## 更新 Sentinel SDK

```bash
npm run update:sdk
```

如果下载后的内容没有变化，不会生成新的 `.bak`。

## 测试

```bash
npm run typecheck
npm test
```
