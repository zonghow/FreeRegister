# FreeRegister

FreeRegister 是一个 TypeScript/Node.js 自动化工具，用于按邮箱池租约执行手机号注册、绑定邮箱、完成 Codex OAuth，并在成功后保存对应的 CPA JSON。

项目内置一个极简 Web 后台，可用于编辑 `config.toml`、导入邮箱、启动/暂停任务、查看实时日志、查看 HeroSMS 余额和每个 key 的实时 API RPS，以及导出成功邮箱和对应 CPA JSON 压缩包。

## 功能

- 手机号注册：通过 HeroSMS 获取手机号和短信验证码。
- 邮箱租约：从 `email.txt` 安全租用邮箱，并发场景下通过文件锁保护移动操作。
- 邮箱 OTP：使用 Hotmail/Outlook refresh token 读取 OpenAI 邮箱验证码。
- Codex OAuth：OAuth 成功后保存账号凭证 JSON 到 `cpa_json/`。
- Web 后台：支持登录、配置编辑、邮箱导入、成功结果导出、任务控制、实时日志和成功账号成本统计。
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
api_keys = ["your-hero-sms-api-key"]
api_key_strategy = "round_robin"
rps_limit = 40
proxy_strategy = "direct"
proxy_urls = []

[proxies]
mode = "pool"
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
# 默认 fixed；需要自适应并发时改成 adaptive。
concurrency_mode = "fixed"
adaptive_target_sms_rps_utilization = 0.9
adaptive_control_interval_ms = 5000
# 可选：0 表示按当前 Node heap 自动计算保护线。
memory_soft_limit_mb = 0
memory_hard_limit_mb = 0
```

当 `run_until_empty = true` 时，`total` 会被忽略，任务会按指定并发一直运行到 `email.txt` 没有可租用邮箱。
当 `concurrency_mode = "adaptive"` 时，`concurrency` 是初始目标并发，程序会根据 HeroSMS RPS 利用率、slot 等待队列和内存水位自动扩缩 worker；HeroSMS API 的 `rps_limit` 仍是硬限制，不会被动态并发绕过。
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
- 在“运行模式”里切换 `fixed` / `adaptive` 并发模式；点击“配置操作”里的“保存配置”后下次启动任务生效。
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
后台登录态会持久化到 `config.toml` 同目录下的 `.admin-sessions.json`，因此容器重启后不会要求重新登录；如果修改了 `FREE_REGISTER_ADMIN_PASSWORD`，旧登录态会自动失效。需要自定义位置时可设置 `FREE_REGISTER_SESSION_FILE=/data/.admin-sessions.json`。

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
api_keys = []
api_key_strategy = "round_robin"
rps_limit = 40
# 兼容旧单 key 配置；配置 api_keys 后会忽略 api_key。
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

[cost]
email_unit_cost = 0.05
currency = "USD"
success_ledger = "cost.success.jsonl"
lock = ".cost.lock"

[proxies]
mode = "pool"
urls = []
phone_country_template = "socks5://gqa11186550-region-{code}-sid-{sid}-t-5:ble7bpcl@us.arxlabs.io:3010"
country_code_url = "https://f.cliproxy.com/json/country_code.json"
country_code_cache = ".cache/country-code.json"
```

接码国家只配置 `countries`，单国家也写成一个元素的数组。`acquire_priority` 支持：

- `country`：国家优先，每个国家按价格档位尝试。
- `price_low`：低价优先，每个低价档位按国家顺序尝试。
- `price_high`：高价优先，每个高价档位按国家顺序尝试。

HeroSMS API Key 推荐使用 `api_keys` 数组配置；旧的单 key `api_key` 仍兼容。`api_key_strategy` 支持：

- `round_robin`：取号时按 key 轮询，例如 A、B、A、B。
- `fill_first`：先使用第一个 key，达到 `rps_limit` 后再使用下一个 key。

`rps_limit` 是账号级限制，默认每个 key `40 RPS`；同一个 key 的取号、查码、释放号码、余额和国家列表等 HeroSMS API 请求共享这一个窗口。验证码查码、完成和释放会优先于新取号使用 RPS slot，避免号码已经拿到后被新取号挤压。后台首页会按 key 展示当前 API RPS 和等待 slot 数，后台“接码配置”也可以直接切换 `api_key_strategy`。API key、专用代理、轮询间隔和自动释放等高级字段可在网页的 `config.toml` 编辑器中修改。

如果希望更贴近 HeroSMS RPS 上限，可以在 `config.toml` 里开启：

```toml
[run]
concurrency_mode = "adaptive"
concurrency = 100
adaptive_target_sms_rps_utilization = 0.9
adaptive_control_interval_ms = 5000
```

自适应模式会 warm-up 分批启动 worker，并按内存估算最大并发；缩容时只是不再给多余 worker 派新 job，不会中断已经开始的注册流程。

当某个 key 的取号请求返回余额不足类错误，或后台余额刷新发现该 key 余额 `<= 0` 时，程序会在当前进程内停用这个 key 并继续尝试其它 key。后续如果充值了，手动刷新余额且余额大于 0，会自动恢复因 `no_balance` 停用的 key；`BAD_KEY` 这类错误不会被余额刷新自动恢复。

网页后台的国家选项会优先从 HeroSMS `getCountries` 接口获取，并永久缓存到 `.cache/hero-sms-countries.json`；接口失败时会继续使用旧缓存，没有缓存时才切换到内置兜底列表。点击“重新加载”会主动刷新这份缓存。

`auto_release_on_timeout = true` 时，如果一个号码在固定轮询窗口内仍未收到验证码，会主动调用 HeroSMS 取消/释放该号码，然后换新号。最多轮询次数不支持配置，程序会按 `poll_interval_ms` 自动计算到超过 2 分钟；默认 `3000ms` 间隔下是 42 次。

HeroSMS 的取号、查码、释放号码、余额和国家列表接口都按 `proxy_strategy` 走网络：

- `hero_sms`：使用 `[hero_sms].proxy_urls` 专用代理池，注册任务中按 worker 轮询代理，后台余额和国家列表使用第一个专用代理。
- `proxies`：复用 `[proxies].urls` 代理池。
- `direct`：HeroSMS 接口不走代理。

注册链路的 OpenAI/邮箱代理由 `[proxies].mode` 决定：

- `pool`：保持旧逻辑，从 `[proxies].urls` 按 worker 轮询取代理；留空表示直连。
- `phone_country`：先按现有 HeroSMS 逻辑取号，取到手机号后按该手机号国家生成代理；此模式不使用 `[proxies].urls` 作为注册代理。

`phone_country_template` 支持 `{code}` 和 `{sid}` 两个占位符，`code` 来自 `country_code.json` 的 ISO alpha-2 国家码，`sid` 是每次换手机号新生成的 8 位数字+大小写字母：

```toml
[hero_sms]
proxy_strategy = "hero_sms"
proxy_urls = [
  "socks5://127.0.0.1:7891"
]

[proxies]
mode = "phone_country"
urls = [
  "socks5://127.0.0.1:7890",
  "http://127.0.0.1:8080"
]
phone_country_template = "socks5://gqa11186550-region-{code}-sid-{sid}-t-5:ble7bpcl@us.arxlabs.io:3010"
country_code_url = "https://f.cliproxy.com/json/country_code.json"
country_code_cache = ".cache/country-code.json"
```

上面的 `urls` 仍可被 `hero_sms.proxy_strategy = "proxies"` 复用；在 `mode = "phone_country"` 下，OpenAI 手机注册、Codex OAuth 和邮箱 OTP 会使用手机号国家生成的代理。Docker 中的 `127.0.0.1` 指容器本身。如果代理运行在宿主机上，通常需要使用 `host.docker.internal`。

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
- 匹配成功邮箱的 `cost.success.jsonl` 成本流水
- 如果有缺失，会附带 `cpa_json_missing.txt`

导出成功后会清空已导出的成功邮箱行和对应成本流水，CPA JSON 文件会保留在本地目录。

## 成本统计

后台“成功”卡片会展示当前成功邮箱池里的总花费和平均花费。成本写入 `cost.success.jsonl`，每个成功账号一行 JSON，默认按 `[cost].email_unit_cost = 0.05` 计算邮箱成本，并叠加该账号成功前实际取过的 HeroSMS 号码净成本。

短信成本会同时记录：

- `smsGrossCost`：成功前取过的号码毛成本。
- `smsRefundCost`：`cancelAndWithdraw` 或超时自动释放成功后抵扣的退款成本。
- `smsCost`：最终计入账号成本的净短信成本。

如果已有成功邮箱是在成本流水功能上线前生成的，后台会按邮箱单价估算这些账号的成本，短信成本记为 `0`。

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
