# OpenAI Responses -> Chat Completions 适配 Worker

这个项目提供一个 Cloudflare Worker，把 OpenAI `Responses API` 转成兼容 `Chat Completions API` 的接口，便于 Cherry Studio / 旧 SDK 继续使用 `POST /v1/chat/completions`。

## 设计目标

- 输入：OpenAI Chat Completions 请求
- 上游：OpenAI Responses API (`/v1/responses`)
- 输出：Chat Completions 响应（包含非流式和流式 SSE）
- 部署：Cloudflare Worker，避免 NAS 自建转发常见的出口/IP/头部指纹问题

## 已实现接口

- `POST /v1/chat/completions`
- `GET /v1/models`（透传上游）
- `GET /`（健康检查）
- `OPTIONS *`（CORS）

## 反封锁相关策略

适配器做了以下处理，尽量减少“家宽/NAS转发器”常见特征：

- 默认只转发必要头部，不透传杂项代理头（如 `x-forwarded-*` 之类）。
- 出站 `User-Agent / Accept / Accept-Language / Accept-Encoding` 默认优先复用客户端值。
- 可启用浏览器提示头透传（`sec-ch-ua* / sec-fetch-* / priority`）。
- 默认补充 `http-referer: https://cherry-ai.com` 与 `x-title: Cherry Studio`。
- 可自动补充 `x-api-key`（优先用客户端 `x-api-key`，否则从 Bearer Token 提取）。
- 可通过 `OUTBOUND_EXTRA_HEADERS` 注入额外固定头部（JSON）。

## 快速开始

### 1) 安装依赖

```bash
npm install
```

### 2) 配置 OpenAI Key（推荐作为 Worker Secret）

```bash
npx wrangler secret put OPENAI_API_KEY
```

也可以不设 secret，直接由客户端传 `Authorization: Bearer ...`。

### 3) 本地调试

```bash
npm run dev
```

### 4) 部署

```bash
npm run deploy
```

## 环境变量

`wrangler.toml` 里已经带了基础默认值，可按需覆盖：

- `UPSTREAM_BASE_URL`：上游 API Base，默认 `https://api.openai.com`
- `FORWARD_CLIENT_UA`：是否转发客户端 UA，默认 `true`
- `FORWARD_CLIENT_ACCEPT`：是否转发客户端 `accept`，默认 `true`
- `FORWARD_CLIENT_ACCEPT_ENCODING`：是否转发客户端 `accept-encoding`，默认 `true`
- `FORWARD_ACCEPT_LANGUAGE`：是否转发客户端 `accept-language`，默认 `true`
- `FORWARD_BROWSER_HINT_HEADERS`：是否转发/注入 `sec-*` 与 `priority`，默认 `true`
- `FORWARD_X_API_KEY`：是否发送 `x-api-key`，默认 `true`
- `OUTBOUND_USER_AGENT`：强制固定出站 UA（优先级高于默认值）
- `OUTBOUND_ACCEPT`：强制固定出站 `accept`
- `OUTBOUND_ACCEPT_ENCODING`：强制固定出站 `accept-encoding`
- `OUTBOUND_ACCEPT_LANGUAGE`：强制固定出站语言
- `OUTBOUND_HTTP_REFERER`：固定 `http-referer`（默认 `https://cherry-ai.com`）
- `OUTBOUND_X_TITLE`：固定 `x-title`（默认 `Cherry Studio`）
- `OUTBOUND_SEC_CH_UA`：固定 `sec-ch-ua`
- `OUTBOUND_SEC_CH_UA_MOBILE`：固定 `sec-ch-ua-mobile`
- `OUTBOUND_SEC_CH_UA_PLATFORM`：固定 `sec-ch-ua-platform`
- `OUTBOUND_SEC_FETCH_DEST`：固定 `sec-fetch-dest`
- `OUTBOUND_SEC_FETCH_MODE`：固定 `sec-fetch-mode`
- `OUTBOUND_SEC_FETCH_SITE`：固定 `sec-fetch-site`
- `OUTBOUND_PRIORITY`：固定 `priority`
- `X_API_KEY_VALUE`：固定 `x-api-key` 的值（优先级最高）
- `OUTBOUND_EXTRA_HEADERS`：JSON 字符串，额外注入头部
- `ALLOWED_ORIGINS`：CORS 白名单，逗号分隔，默认 `*`

`OUTBOUND_EXTRA_HEADERS` 示例：

```json
{"x-my-header":"abc","openai-project":"proj_xxx"}
```

## Cherry Studio 接入建议

1. API Base 填 Worker 地址，例如：`https://xxx.your-subdomain.workers.dev`
2. 模型列表会走 `GET /v1/models`，可直接读取上游模型。
3. 聊天走 `POST /v1/chat/completions`，内部自动转为 `Responses API`。
4. 若你要复刻“本机可用”的头部行为，建议保持以下开关为 `true`：`FORWARD_CLIENT_UA`、`FORWARD_CLIENT_ACCEPT`、`FORWARD_CLIENT_ACCEPT_ENCODING`、`FORWARD_ACCEPT_LANGUAGE`、`FORWARD_BROWSER_HINT_HEADERS`、`FORWARD_X_API_KEY`。

## 当前映射范围（说明）

已覆盖常用字段：`model/messages/temperature/top_p/max_tokens/stop/tools/tool_choice/response_format/stream`。

注意点：

- `n` 目前仅支持 `1`（Responses API 单输出语义）。
- 多模态消息已支持文本和 `image_url` 到 `input_image` 的映射。
- 工具调用支持基础映射（包括流式工具参数 delta）。

## 免责声明

本项目仅用于协议适配与工程可用性优化。请确保你的使用方式符合 OpenAI 以及网络服务商的使用条款与当地法律法规。
