# 7709 NAV Watch

一个用于观察南方东英 SK 海力士每日杠杆 2x 产品 `7709.HK` 的实时看板和 JSON API。

页面展示：

- `7709.HK` 最新价、涨跌、成交量
- 韩国正股 `000660.KS` 最新价
- CSOP 官方 HKD NAV
- 以最新官方 NAV 为锚点推算的理论 NAV
- CSOP 官网盘中 iNAV 状态
- TradingView NAV 原始值
- TradingView 折溢价字段反推 NAV
- `7709` 相对各 NAV 口径的折溢价

> 注意：本项目只做数据观察和估算，不构成投资建议。理论 NAV 和代理 iNAV 不是 CSOP、ICE、FactSet 或 TradingView 的官方值。

## 快速运行

需要 Node.js 20 或以上版本。

```powershell
npm install
npm start
```

然后打开：

```text
http://localhost:5173
```

## 局域网访问

手机和电脑连同一个 Wi-Fi 后，在手机浏览器打开电脑的局域网地址，例如：

```text
http://192.168.1.43:5173
```

启动服务时终端会打印 `LAN access: http://...:5173`，使用那一行即可。

如果手机打不开，通常是 Windows 防火墙拦截了 Node.js 入站连接，需要允许当前网络下的 Node.js 或端口 `5173` 入站访问。

## 公网部署

本项目是一个纯 Node.js 服务，既提供静态页面，也提供 `/api/snapshot` 数据接口。部署到 VPS、云服务器、Render、Railway、Fly.io、Docker 主机等都可以。

### Render 一键部署

仓库包含 `render.yaml`，可直接在 Render 中创建 Blueprint。公开站点默认关闭私人手机推送和每日策略推送；如需启用，请只在 Render 的环境变量设置中添加密钥，不要把密钥写入仓库。

1. 登录 [Render](https://dashboard.render.com/)。
2. 选择 `New` -> `Blueprint`。
3. 连接本 GitHub 仓库并确认部署。

Render 完成部署后会提供一个 `https://...onrender.com` 公网网址，访问者无需登录即可查看。

云平台通常会注入 `PORT` 环境变量，本项目已支持。若同时设置 `DASHBOARD_PORT`，则以 `DASHBOARD_PORT` 为准：

```text
PORT=8080
```

也可以本地指定：

```powershell
$env:DASHBOARD_PORT=8080
npm start
```

## Docker

构建镜像：

```powershell
docker build -t 7709-nav-watch .
```

运行：

```powershell
docker run --rm -p 5173:5173 7709-nav-watch
```

打开：

```text
http://localhost:5173
```

## API

### `GET /api/snapshot`

返回当前看板使用的完整快照数据。接口允许跨域读取，方便其他网页或脚本使用。

示例：

```powershell
Invoke-RestMethod http://localhost:5173/api/snapshot
```

关键字段：

- `navViews`：官方 NAV、理论 NAV、CSOP iNAV、TradingView NAV 等口径
- `quotes.product`：`7709.HK` 行情
- `quotes.underlying`：`000660.KS` 行情
- `calculation`：理论 NAV 计算过程和锚点
- `metrics`：折溢价等核心指标
- `sources`：数据源状态
- `cache`：服务端缓存状态

### `GET /api/health`

健康检查接口：

```powershell
Invoke-RestMethod http://localhost:5173/api/health
```

### `GET /api/preopen-strategy`

生成一份 7709 开盘前交易预案，结合当前 7709/理论 NAV 折溢价、正股价格、半导体市场情绪和新闻标题。报告是情景预案，不是确定性买卖建议。

```powershell
Invoke-RestMethod http://localhost:5173/api/preopen-strategy
```

测试手机推送：

```text
http://localhost:5173/api/preopen-strategy/test
```

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DASHBOARD_PORT` | `5173` | 本地运行端口，优先级最高 |
| `PORT` | 空 | 云平台常用端口变量 |
| `DASHBOARD_HOST` | `0.0.0.0` | 监听地址 |
| `SNAPSHOT_CACHE_MS` | `15000` | `/api/snapshot` 服务端缓存时间，避免多人访问时频繁请求上游 |
| `ADMIN_TOKEN` | 空 | 公网调用两个推送测试接口时需要的 Bearer Token；本机访问不需要 |
| `DISCOUNT_ALERT_THRESHOLD_PCT` | `2` | 服务端手机推送起始阈值，按理论 NAV 折溢价绝对值计算 |
| `DISCOUNT_ALERT_STEP_PCT` | `1` | 服务端手机推送档位步长；默认 2%、3%、4% 逐档提醒 |
| `DISCOUNT_ALERT_CONFIRM_REFRESHES` | `2` | 服务端手机推送确认次数；同一档位连续满足几次刷新后才推送 |
| `DISCOUNT_ALERT_CHECK_MS` | `30000` | 服务端手机推送检查间隔 |
| `DISCOUNT_ALERT_COOLDOWN_MS` | `300000` | 服务端手机推送冷却时间 |
| `PREOPEN_STRATEGY_ENABLED` | `1` | 是否开启每日开盘前策略报告，需已配置手机推送通道 |
| `PREOPEN_STRATEGY_TIME` | `08:55` | 开盘前报告开始推送时间 |
| `PREOPEN_STRATEGY_UNTIL` | `09:20` | 若服务启动稍晚，在该时间前仍可补发一次 |
| `PREOPEN_STRATEGY_TIMEZONE` | `Asia/Hong_Kong` | 开盘前报告时间所属时区 |
| `TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID` | 空 | Telegram Bot 推送 |
| `BARK_DEVICE_KEY` / `BARK_PUSH_URL` | 空 | Bark iPhone 推送 |
| `PUSHPLUS_TOKEN` | 空 | PushPlus 推送 |
| `SERVERCHAN_SENDKEY` | 空 | Server酱推送 |
| `DISCOUNT_ALERT_WEBHOOK_URL` | 空 | 通用 Webhook 推送 |

## 数据源

- 官方 NAV：`https://website-api.csopasset.com/cmsApi/NAV/product`
- 官方产品页：`https://www.csopasset.com/en/products/hk-skhy-2l`
- CSOP 盘中 iNAV：CSOP 产品页嵌入的 FactSet / ICE Data Indices 组件
- TradingView NAV：`https://scanner.tradingview.com/hongkong/scan`
- 7709 行情：腾讯港股实时源，代码 `hk07709`
- 正股行情：Naver Pay Securities / KRX 分钟线，代码 `000660`
- 行情备用：Yahoo Finance chart endpoint，包含 `7709.HK`、`000660.KS`、`KRWHKD=X`；TradingView scanner 作为 NAV/折溢价参考

CSOP 盘中 iNAV 位于官网内嵌的 FactSet 跨域组件里。浏览器可以显示，但本地服务直连可能缺少会话或来源校验，前端脚本也不能跨域读取 iframe 内容。若直接值不可用，页面会明确标记为“代理估算”。

`7709.HK` 最新价优先使用腾讯港股实时源，减少 Yahoo Finance / TradingView 免费源约 15 分钟延迟造成的折价率偏差；如果腾讯接口短暂不可用，则自动回退到 Yahoo。

韩国正股 `000660.KS` 盘中价格优先使用 Naver Pay Securities / KRX 分钟线，减少 Yahoo Finance 对韩股可能出现的延迟；如果 Naver 接口短暂不可用，则自动回退到 Yahoo。

## 理论 NAV 口径

```text
理论 NAV = 最新 CSOP 官方 HKD NAV
         x 官方 NAV 日期之后每个完整交易日 (1 + 2 x SK hynix 日涨跌幅) 的滚动乘积
         x 当前盘中交易日 (1 + 2 x SK hynix 盘中涨跌幅)
         x KRW/HKD 汇率修正
```

最新官方 NAV 是唯一锚点。比如最新官方 NAV 是 7 月 7 日，如果 7 月 8 日没有新的官方 NAV，那么 7 月 9 日盘中理论 NAV 会从 7 月 7 日官方 NAV 出发，先滚动 7 月 8 日完整交易日涨跌，再叠加 7 月 9 日盘中实时涨跌。

如果最新官方 NAV 的日期已经等于韩国正股当前交易日，页面的理论 NAV 会回到官方 NAV 锚点，不再继续用当天正股涨跌滚动，避免重复计算同一天行情。

## 折溢价口径

```text
7709 折溢价 = 7709 最新市价 / 各口径有效 NAV - 1
```

其中“有效 NAV”优先使用直接来源值。如果 CSOP / FactSet 盘中 iNAV 直连失败，则使用本地理论 NAV 做代理值，并在状态列标注为“代理估算”。

TradingView 可能出现 `nav` 字段与 `nav_discount_premium` 字段互不一致的情况，因此页面同时展示原始 NAV 和折溢价反推 NAV，避免把其中一个字段误认为唯一口径。

## 折价提醒

页面顶部提供折价提醒开关，默认阈值为 `2.0%`。开启后，页面会在自动刷新时监控理论 NAV 折溢价：

当理论 NAV 口径满足：

```text
abs(7709 市价 / 理论 NAV - 1) >= 2%
```

页面会显示提醒横幅，并在浏览器允许时发送系统通知、播放提示音。网页内提醒会按当前档位冷却，避免每次刷新重复提醒。

如果需要提醒直接到手机，而不是只在网页里提醒，可以配置服务端推送。服务端推送不依赖浏览器通知权限，只要 Node 服务在运行，就会检查理论 NAV 折价或溢价，并按档位发送手机通知。

服务端手机推送按档位逐条发送，但为了过滤价格快速跳动造成的误报，同一档位必须连续满足 `DISCOUNT_ALERT_CONFIRM_REFRESHES` 次刷新后才会推送。默认是连续 2 次刷新确认。

```text
理论 NAV 折价连续两次达到 -2%：发送一条
理论 NAV 折价连续两次达到 -3%：再发送一条
理论 NAV 折价连续两次达到 -4%：再发送一条
理论 NAV 溢价连续两次达到 +2%：发送一条
理论 NAV 溢价连续两次达到 +3%：再发送一条
```

示例：Telegram Bot

```powershell
$env:TELEGRAM_BOT_TOKEN="你的 bot token"
$env:TELEGRAM_CHAT_ID="你的 chat id"
npm start
```

示例：Bark for iPhone

```powershell
$env:BARK_DEVICE_KEY="你的 Bark key"
npm start
```

也可以复制 `.env.example` 作为部署平台的环境变量清单。配置后可访问：

```text
http://localhost:5173/api/alert/status
http://localhost:5173/api/alert/test
```

`/api/alert/test` 会向已配置的手机通道发送一条测试消息。

公网部署时，两个测试接口必须使用管理员令牌：

```powershell
$headers = @{ Authorization = "Bearer 你的ADMIN_TOKEN" }
Invoke-RestMethod https://你的域名/api/alert/test -Headers $headers
```

## 开盘策略报告

服务端会在工作日 `PREOPEN_STRATEGY_TIME` 到 `PREOPEN_STRATEGY_UNTIL` 之间生成并推送一次开盘前策略报告。报告包含：

- 7709 最新价、理论 NAV、折溢价
- SK hynix 常规盘/盘后价格和涨跌幅
- 纳指、费半、英伟达、美光、AMD 等半导体情绪
- SK hynix / HBM / ADR / 存储芯片相关新闻标题评分
- 开盘计划、低吸区、做 T 卖出区、风控条件

默认推送时间为香港时间 `08:55`，如果你想提前或推迟，可以在 `.env` 里改：

```text
PREOPEN_STRATEGY_TIME=08:50
PREOPEN_STRATEGY_UNTIL=09:20
```

## 开源许可证

MIT License。详见 [LICENSE](LICENSE)。



