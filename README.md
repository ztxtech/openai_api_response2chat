# OpenAI Responses -> Chat Completions 适配 Worker

这个项目提供一个 Cloudflare Worker，把 OpenAI `Responses API` 转成兼容 `Chat Completions API` 的接口，便于 Cherry Studio / 旧 SDK 继续使用 `POST /v1/chat/completions`。

## 设计目标

- 输入：OpenAI Chat Completions 请求
- 上游：OpenAI Responses API（`/v1/responses`）
- 输出：Chat Completions 响应（支持非流式和流式 SSE）
- 部署：Cloudflare Worker（优先面向 GitHub 自动构建场景）

## 已实现接口

- `POST /v1/chat/completions`
- `GET /v1/models`（透传上游）
- `GET /`（健康检查）
- `OPTIONS *`（CORS）

## 出站策略（当前版本）

- 透传发起端真实请求头到上游（保留客户端上下文）。
- 仅过滤协议/边缘相关头（如 `host/content-length/connection/cf-*`）。
- 认证仅使用发起端提供的 secret（`Authorization` 或 `x-api-key`）。
- 不再注入 Cherry Studio 默认头，也不再随机化请求头。
- 会透传部分上游响应头到客户端（如 `cf-ray/cf-cache-status/alt-svc/server/cache-control`）便于排障。
- 502 JSON 与流式响应默认使用“上一次调用缓存的上游响应头”；首次无缓存时使用当前上游头。
- 不配置账号/网关回退，不使用备用上游地址。

## Cloudflare 部署（GitHub 自动构建，推荐）

以下流程按你截图中的场景编写：代码从 GitHub 导入，配置在 Cloudflare 面板填写，密钥由发起端请求头传入。

### 1) 准备 GitHub 仓库

1. 在 GitHub 上 fork 或复制本仓库。
2. 确保仓库根目录包含 `wrangler.toml`。
3. 把 `wrangler.toml` 的 `name` 改成你在 Cloudflare 上的 Worker 名称（必须一致）。

示例：

```toml
name = "response2chat"
main = "src/index.ts"
compatibility_date = "2026-03-01"
workers_dev = true
```

如果 `name` 不一致，Cloudflare Git 构建页会出现“请更新仓库中的 wrangler.toml”提示，且可能导致构建失败。

### 2) Cloudflare 控制台连接 GitHub

1. 打开 Cloudflare Dashboard -> `Workers & Pages`。
2. 选择 `创建` -> `导入现有 Git 存储库`（或类似入口）。
3. 连接你的 GitHub 仓库，选择生产分支（通常 `main`）。
4. 构建配置建议如下：
   - 构建命令：留空
   - 部署命令：`npx wrangler deploy`
   - 版本命令（如果界面有该项）：`npx wrangler versions upload`
   - 根目录：`/`

### 3) 在“变量和机密”里配置变量

在 Cloudflare Worker 的 `变量和机密` 面板中，至少添加以下变量：

- `OPENAI_BASE_URL` = `https://api.openai.com`

说明：

- 这是必填变量名，不再支持旧变量回退。
- Worker 会透传客户端请求头到上游（仅剔除少量协议/边缘头）。

### 4) 客户端侧传 secret（关键步骤）

不需要在 Worker 配置任何 `OPENAI_API_KEY` secret。  
请在发起端（例如 Cline/Cherry Studio/你的 SDK）设置 API Key，并确保请求包含其一：

```bash
-H "Authorization: Bearer <YOUR_OPENAI_KEY>"
```

```powershell
-H "x-api-key: <YOUR_OPENAI_KEY>"
```

注意：

- Worker 不保存你的 Key；Key 只由发起端携带。

### 5) 触发部署

- GitHub 自动部署：推送到 `main` 后，Cloudflare 自动构建并发布。
- 本地手动部署（可选）：`npx wrangler deploy --name response2chat`

### 6) 部署后验证

健康检查：

```bash
curl -i https://<你的worker域名>/
```

模型列表：

```bash
curl -i https://<你的worker域名>/v1/models \
  -H "Authorization: Bearer <YOUR_OPENAI_KEY>"
```

聊天接口：

```bash
curl -i https://<你的worker域名>/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer <YOUR_OPENAI_KEY>" \
  -d '{
    "model": "gpt-4.1-mini",
    "messages": [{"role":"user","content":"hello"}]
  }'
```

## 常用环境变量

推荐优先配置：

- `OPENAI_BASE_URL`：上游 API Base（推荐）
- `ALLOWED_ORIGINS`：CORS 白名单，逗号分隔，默认 `*`

## Cherry Studio 接入建议

1. API Base 填 Worker 地址，例如：`https://xxx.your-subdomain.workers.dev`
2. 模型列表走 `GET /v1/models`，可直接读取上游模型
3. 聊天走 `POST /v1/chat/completions`，内部自动转为 `Responses API`
4. Cline/代理链路场景下，需要在客户端配置 API Key，让请求带上 `Authorization` 或 `x-api-key`

## 当前映射范围（说明）

已覆盖常用字段：`model/messages/temperature/top_p/max_tokens/stop/tools/tool_choice/response_format/stream`。

注意点：

- `n` 目前仅支持 `1`（Responses API 单输出语义）
- 多模态消息已支持文本和 `image_url` 到 `input_image` 的映射
- 工具调用支持基础映射（包括流式工具参数 delta）

## 常见问题

1. 构建页提示 `请更新仓库中的 wrangler.toml`：
   - 原因：`wrangler.toml` 的 `name` 与 Cloudflare Worker 名不一致。
   - 处理：改成一致后重新推送。
2. 返回 `Missing client secret. Provide Authorization: Bearer <token> or x-api-key.`：
   - 原因：发起端没有携带 `Authorization` 或 `x-api-key`。
   - 处理：在客户端配置 API Key，并确认请求头中带上 secret。
3. 返回 `502` 且 body 是 Cloudflare HTML 页面：
   - 原因：上游主机本身故障（例如你的 `OPENAI_BASE_URL` 指向的域名返回 5xx）。
   - 处理：检查 `OPENAI_BASE_URL` 指向的上游可用性与区域连通性，并核对发起端携带的真实请求头是否完整。

## 免责声明

本项目仅用于协议适配与工程可用性优化。请确保你的使用方式符合 OpenAI 以及网络服务商的使用条款与当地法律法规。
