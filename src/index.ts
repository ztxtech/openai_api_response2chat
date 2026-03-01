interface Env {
  OPENAI_API_KEY?: string;
  OPENAI_BASE_URL?: string;
  OUTBOUND_ACCEPT?: string;
  OUTBOUND_USER_AGENT?: string;
  OUTBOUND_ACCEPT_ENCODING?: string;
  OUTBOUND_ACCEPT_LANGUAGE?: string;
  OUTBOUND_HTTP_REFERER?: string;
  OUTBOUND_X_TITLE?: string;
  OUTBOUND_SEC_CH_UA?: string;
  OUTBOUND_SEC_CH_UA_MOBILE?: string;
  OUTBOUND_SEC_CH_UA_PLATFORM?: string;
  OUTBOUND_SEC_FETCH_DEST?: string;
  OUTBOUND_SEC_FETCH_MODE?: string;
  OUTBOUND_SEC_FETCH_SITE?: string;
  OUTBOUND_PRIORITY?: string;
  OUTBOUND_EXTRA_HEADERS?: string;
  FORWARD_BROWSER_HINT_HEADERS?: string;
  FORWARD_X_API_KEY?: string;
  ALLOWED_ORIGINS?: string;
}

type JsonObject = Record<string, unknown>;

interface ChatCompletionRequest {
  model?: string;
  messages?: unknown[];
  stream?: boolean;
  stream_options?: JsonObject;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  stop?: string | string[];
  tools?: unknown[];
  tool_choice?: unknown;
  response_format?: unknown;
  user?: string;
  n?: number;
}

interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

const DEFAULT_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) CherryStudio/1.7.21 Chrome/140.0.7339.249 Electron/38.7.0 Safari/537.36";
const DEFAULT_ACCEPT = "*/*";
const DEFAULT_ACCEPT_ENCODING = "gzip, deflate, br, zstd";
const DEFAULT_ACCEPT_LANGUAGE = "zh-CN";
const DEFAULT_HTTP_REFERER = "https://cherry-ai.com";
const DEFAULT_X_TITLE = "Cherry Studio";
const DEFAULT_SEC_CH_UA = "\"Not=A?Brand\";v=\"24\", \"Chromium\";v=\"140\"";
const DEFAULT_SEC_CH_UA_MOBILE = "?0";
const DEFAULT_SEC_CH_UA_PLATFORM = "\"Windows\"";
const DEFAULT_SEC_FETCH_DEST = "empty";
const DEFAULT_SEC_FETCH_MODE = "cors";
const DEFAULT_SEC_FETCH_SITE = "cross-site";
const DEFAULT_PRIORITY = "u=1, i";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const corsHeaders = buildCorsHeaders(request, env);
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method === "GET" && url.pathname === "/") {
      return jsonResponse(
        {
          ok: true,
          service: "responses-to-chat-completions-adapter",
          endpoints: ["/v1/chat/completions", "/v1/models"],
        },
        200,
        corsHeaders,
      );
    }

    if (request.method === "GET" && url.pathname === "/v1/models") {
      return proxyModels(request, env, corsHeaders);
    }

    if (request.method === "POST" && url.pathname === "/v1/chat/completions") {
      return handleChatCompletions(request, env, corsHeaders);
    }

    return jsonResponse(
      {
        error: {
          message: "Not Found",
          type: "invalid_request_error",
        },
      },
      404,
      corsHeaders,
    );
  },
};

async function proxyModels(
  request: Request,
  env: Env,
  corsHeaders: Headers,
): Promise<Response> {
  const authHeader = resolveAuthorization(env);
  if (!authHeader) {
    return jsonResponse(
      {
        error: {
          message:
            "Missing OPENAI_API_KEY secret in Worker.",
          type: "invalid_request_error",
        },
      },
      401,
      corsHeaders,
    );
  }

  const upstreamBaseUrl = resolveRequiredUpstreamBaseUrl(env);
  if (!upstreamBaseUrl) {
    return jsonResponse(
      {
        error: {
          message: "Missing OPENAI_BASE_URL variable in Worker configuration.",
          type: "invalid_request_error",
        },
      },
      500,
      corsHeaders,
    );
  }

  const upstreamUrl = buildUpstreamUrl(upstreamBaseUrl, "/v1/models");

  try {
    const upstreamRes = await fetchUpstreamWithRetry(env, {
      upstreamUrl,
      method: "GET",
      authorization: authHeader,
      stream: false,
    });
    if (!upstreamRes.ok) {
      return mapUpstreamErrorResponse(upstreamRes, corsHeaders, upstreamUrl);
    }
    return withCors(upstreamRes, corsHeaders);
  } catch (error) {
    return jsonResponse(
      {
        error: {
          message: `Failed to fetch upstream models: ${getErrorMessage(error)}`,
          type: "api_connection_error",
        },
      },
      502,
      corsHeaders,
    );
  }
}

async function handleChatCompletions(
  request: Request,
  env: Env,
  corsHeaders: Headers,
): Promise<Response> {
  const authHeader = resolveAuthorization(env);
  if (!authHeader) {
    return jsonResponse(
      {
        error: {
          message:
            "Missing OPENAI_API_KEY secret in Worker.",
          type: "invalid_request_error",
        },
      },
      401,
      corsHeaders,
    );
  }

  const upstreamBaseUrl = resolveRequiredUpstreamBaseUrl(env);
  if (!upstreamBaseUrl) {
    return jsonResponse(
      {
        error: {
          message: "Missing OPENAI_BASE_URL variable in Worker configuration.",
          type: "invalid_request_error",
        },
      },
      500,
      corsHeaders,
    );
  }

  let chatRequest: ChatCompletionRequest;
  try {
    chatRequest = (await request.json()) as ChatCompletionRequest;
  } catch {
    return jsonResponse(
      {
        error: {
          message: "Request body must be valid JSON.",
          type: "invalid_request_error",
        },
      },
      400,
      corsHeaders,
    );
  }

  if (!chatRequest || typeof chatRequest.model !== "string" || !chatRequest.model) {
    return jsonResponse(
      {
        error: {
          message: "Field 'model' is required.",
          type: "invalid_request_error",
        },
      },
      400,
      corsHeaders,
    );
  }

  if (!Array.isArray(chatRequest.messages)) {
    return jsonResponse(
      {
        error: {
          message: "Field 'messages' must be an array.",
          type: "invalid_request_error",
        },
      },
      400,
      corsHeaders,
    );
  }

  if (typeof chatRequest.n === "number" && chatRequest.n !== 1) {
    return jsonResponse(
      {
        error: {
          message:
            "This adapter supports n=1 only because Responses API returns a single output.",
          type: "invalid_request_error",
        },
      },
      400,
      corsHeaders,
    );
  }

  let responsesPayload: JsonObject;
  try {
    responsesPayload = chatToResponsesPayload(chatRequest);
  } catch (error) {
    return jsonResponse(
      {
        error: {
          message: getErrorMessage(error),
          type: "invalid_request_error",
        },
      },
      400,
      corsHeaders,
    );
  }

  const upstreamUrl = buildUpstreamUrl(upstreamBaseUrl, "/v1/responses");
  const stream = Boolean(chatRequest.stream);

  let upstreamRes: Response;
  try {
    upstreamRes = await fetchUpstreamWithRetry(env, {
      upstreamUrl,
      method: "POST",
      authorization: authHeader,
      stream,
      body: JSON.stringify(responsesPayload),
    });
  } catch (error) {
    return jsonResponse(
      {
        error: {
          message: `Failed to reach upstream Responses API: ${getErrorMessage(error)}`,
          type: "api_connection_error",
        },
      },
      502,
      corsHeaders,
    );
  }

  if (!stream) {
    if (!upstreamRes.ok) {
      return mapUpstreamErrorResponse(upstreamRes, corsHeaders, upstreamUrl);
    }

    let responsesBody: JsonObject;
    try {
      responsesBody = (await upstreamRes.json()) as JsonObject;
    } catch {
      return jsonResponse(
        {
          error: {
            message: "Upstream returned non-JSON body for non-stream request.",
            type: "api_error",
          },
        },
        502,
        corsHeaders,
      );
    }

    const chatBody = mapResponsesToChatCompletion(responsesBody, chatRequest);
    return jsonResponse(chatBody, 200, corsHeaders);
  }

  const contentType = upstreamRes.headers.get("content-type") ?? "";
  if (!upstreamRes.ok) {
    return mapUpstreamErrorResponse(upstreamRes, corsHeaders, upstreamUrl);
  }
  if (!contentType.includes("text/event-stream")) {
    return jsonResponse(
      {
        error: {
          message: `Expected upstream SSE response for stream=true, got content-type: ${contentType || "unknown"}.`,
          type: "api_error",
        },
      },
      502,
      corsHeaders,
    );
  }

  return convertResponsesStreamToChatStream(upstreamRes, chatRequest, corsHeaders);
}

function resolveAuthorization(env: Env): string | null {
  if (env.OPENAI_API_KEY && env.OPENAI_API_KEY.trim().length > 0) {
    return `Bearer ${env.OPENAI_API_KEY.trim()}`;
  }
  return null;
}

interface UpstreamFetchOptions {
  upstreamUrl: string;
  method: "GET" | "POST";
  authorization: string;
  stream: boolean;
  body?: string;
}

interface UpstreamAttemptResult {
  response: Response | null;
  errorMessage: string | null;
}

interface RandomHeaderProfile {
  userAgent: string;
  acceptEncoding: string;
  acceptLanguage: string;
  secChUa: string;
  secChUaMobile: string;
  secChUaPlatform: string;
  secFetchDest: string;
  secFetchMode: string;
  secFetchSite: string;
  priority: string;
  httpReferer: string;
  xTitle: string;
}

async function fetchUpstreamWithRetry(env: Env, options: UpstreamFetchOptions): Promise<Response> {
  const firstAttempt = await fetchUpstreamOnce(env, options, false);
  if (isUsableUpstreamResponse(firstAttempt.response, options.stream)) {
    return firstAttempt.response as Response;
  }

  const secondAttempt = await fetchUpstreamOnce(env, options, true);
  if (secondAttempt.response) {
    return secondAttempt.response;
  }
  if (firstAttempt.response) {
    return firstAttempt.response;
  }

  const details = [firstAttempt.errorMessage, secondAttempt.errorMessage]
    .filter((item): item is string => Boolean(item && item.trim().length > 0))
    .join("; ");
  throw new Error(details.length > 0 ? details : "Both upstream attempts failed.");
}

async function fetchUpstreamOnce(
  env: Env,
  options: UpstreamFetchOptions,
  useRandomizedHeaders: boolean,
): Promise<UpstreamAttemptResult> {
  const headers = buildUpstreamHeaders(env, options.authorization, options.stream, useRandomizedHeaders);
  try {
    const response = await fetch(options.upstreamUrl, {
      method: options.method,
      headers,
      body: options.body,
      redirect: "follow",
    });
    return { response, errorMessage: null };
  } catch (error) {
    return {
      response: null,
      errorMessage: `Attempt ${useRandomizedHeaders ? "2" : "1"} failed: ${getErrorMessage(error)}`,
    };
  }
}

function isUsableUpstreamResponse(response: Response | null, stream: boolean): boolean {
  if (!response || !response.ok) {
    return false;
  }
  if (!stream) {
    return true;
  }
  const contentType = response.headers.get("content-type") ?? "";
  return contentType.includes("text/event-stream");
}

function buildUpstreamHeaders(
  env: Env,
  authorization: string,
  stream: boolean,
  useRandomizedHeaders: boolean,
): Headers {
  const headers = new Headers();
  const randomProfile = useRandomizedHeaders ? buildRandomHeaderProfile() : null;

  headers.set("authorization", authorization);
  headers.set("content-type", "application/json");
  headers.set("accept", stream ? "text/event-stream" : pickConfiguredOrDefault(env.OUTBOUND_ACCEPT, DEFAULT_ACCEPT));
  headers.set(
    "accept-encoding",
    randomProfile?.acceptEncoding ??
      pickConfiguredOrDefault(env.OUTBOUND_ACCEPT_ENCODING, DEFAULT_ACCEPT_ENCODING),
  );
  headers.set(
    "user-agent",
    randomProfile?.userAgent ?? pickConfiguredOrDefault(env.OUTBOUND_USER_AGENT, DEFAULT_USER_AGENT),
  );
  headers.set(
    "accept-language",
    randomProfile?.acceptLanguage ??
      pickConfiguredOrDefault(env.OUTBOUND_ACCEPT_LANGUAGE, DEFAULT_ACCEPT_LANGUAGE),
  );
  headers.set(
    "http-referer",
    randomProfile?.httpReferer ??
      pickConfiguredOrDefault(env.OUTBOUND_HTTP_REFERER, DEFAULT_HTTP_REFERER),
  );
  headers.set(
    "x-title",
    randomProfile?.xTitle ?? pickConfiguredOrDefault(env.OUTBOUND_X_TITLE, DEFAULT_X_TITLE),
  );

  if (normalizeBooleanWithDefault(env.FORWARD_BROWSER_HINT_HEADERS, true)) {
    headers.set("sec-ch-ua", randomProfile?.secChUa ?? pickConfiguredOrDefault(env.OUTBOUND_SEC_CH_UA, DEFAULT_SEC_CH_UA));
    headers.set(
      "sec-ch-ua-mobile",
      randomProfile?.secChUaMobile ??
        pickConfiguredOrDefault(env.OUTBOUND_SEC_CH_UA_MOBILE, DEFAULT_SEC_CH_UA_MOBILE),
    );
    headers.set(
      "sec-ch-ua-platform",
      randomProfile?.secChUaPlatform ??
        pickConfiguredOrDefault(env.OUTBOUND_SEC_CH_UA_PLATFORM, DEFAULT_SEC_CH_UA_PLATFORM),
    );
    headers.set(
      "sec-fetch-dest",
      randomProfile?.secFetchDest ??
        pickConfiguredOrDefault(env.OUTBOUND_SEC_FETCH_DEST, DEFAULT_SEC_FETCH_DEST),
    );
    headers.set(
      "sec-fetch-mode",
      randomProfile?.secFetchMode ??
        pickConfiguredOrDefault(env.OUTBOUND_SEC_FETCH_MODE, DEFAULT_SEC_FETCH_MODE),
    );
    headers.set(
      "sec-fetch-site",
      randomProfile?.secFetchSite ??
        pickConfiguredOrDefault(env.OUTBOUND_SEC_FETCH_SITE, DEFAULT_SEC_FETCH_SITE),
    );
    headers.set(
      "priority",
      randomProfile?.priority ?? pickConfiguredOrDefault(env.OUTBOUND_PRIORITY, DEFAULT_PRIORITY),
    );
  }

  const xApiKey = pickOutgoingXApiKey(env, authorization);
  if (xApiKey) {
    headers.set("x-api-key", xApiKey);
  }

  for (const [key, value] of parseExtraHeaders(env.OUTBOUND_EXTRA_HEADERS)) {
    if (key.toLowerCase() === "host" || key.toLowerCase() === "content-length") {
      continue;
    }
    headers.set(key, value);
  }

  return headers;
}

function pickConfiguredOrDefault(configuredValue: string | undefined, fallbackValue: string): string {
  if (configuredValue && configuredValue.trim().length > 0) {
    return configuredValue.trim();
  }
  return fallbackValue;
}

function pickOutgoingXApiKey(env: Env, authorization: string): string | null {
  if (!normalizeBooleanWithDefault(env.FORWARD_X_API_KEY, true)) {
    return null;
  }
  return extractBearerToken(authorization);
}

function extractBearerToken(authorization: string): string | null {
  const match = authorization.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return null;
  }
  const token = match[1].trim();
  return token.length > 0 ? token : null;
}

function buildRandomHeaderProfile(): RandomHeaderProfile {
  const uaProfiles = [
    {
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      secChUa: "\"Not=A?Brand\";v=\"24\", \"Chromium\";v=\"140\", \"Google Chrome\";v=\"140\"",
      secChUaPlatform: "\"Windows\"",
    },
    {
      userAgent:
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",
      secChUa: "\"Not=A?Brand\";v=\"24\", \"Chromium\";v=\"139\", \"Google Chrome\";v=\"139\"",
      secChUaPlatform: "\"Linux\"",
    },
    {
      userAgent:
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 13_7) AppleWebKit/537.36 " +
        "(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      secChUa: "\"Not=A?Brand\";v=\"24\", \"Chromium\";v=\"141\", \"Google Chrome\";v=\"141\"",
      secChUaPlatform: "\"macOS\"",
    },
  ];

  const selected = randomFromArray(uaProfiles);
  return {
    userAgent: selected.userAgent,
    acceptEncoding: randomFromArray(["gzip, deflate, br", "gzip, br", "gzip, deflate, br, zstd"]),
    acceptLanguage: randomFromArray(["en-US,en;q=0.9", "zh-CN,zh;q=0.9,en;q=0.8", "ja-JP,ja;q=0.9,en;q=0.7"]),
    secChUa: selected.secChUa,
    secChUaMobile: "?0",
    secChUaPlatform: selected.secChUaPlatform,
    secFetchDest: randomFromArray(["empty", "document"]),
    secFetchMode: randomFromArray(["cors", "navigate", "no-cors"]),
    secFetchSite: randomFromArray(["cross-site", "same-site", "none"]),
    priority: randomFromArray(["u=1, i", "u=0, i", "u=1"]),
    httpReferer: randomFromArray(["https://cherry-ai.com", "https://platform.openai.com", "https://chat.openai.com"]),
    xTitle: randomFromArray(["Cherry Studio", "Cline", "OpenAI Client"]),
  };
}

function randomFromArray<T>(items: T[]): T {
  return items[Math.floor(Math.random() * items.length)];
}

function normalizeBooleanWithDefault(value: string | undefined, defaultValue: boolean): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["false", "0", "no", "off"].includes(normalized)) {
    return false;
  }
  return defaultValue;
}

function parseExtraHeaders(raw: string | undefined): Array<[string, string]> {
  if (!raw || raw.trim().length === 0) {
    return [];
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isObject(parsed)) {
      return [];
    }

    const pairs: Array<[string, string]> = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string" && key.trim().length > 0) {
        pairs.push([key.trim(), value]);
      }
    }
    return pairs;
  } catch {
    return [];
  }
}

function buildUpstreamUrl(baseUrl: string, path: string): string {
  const normalizedBase = baseUrl.trim().replace(/\/+$/, "");
  if (normalizedBase.endsWith("/v1")) {
    return `${normalizedBase}${path.replace(/^\/v1/, "")}`;
  }
  return `${normalizedBase}${path}`;
}

function resolveRequiredUpstreamBaseUrl(env: Env): string | null {
  if (!env.OPENAI_BASE_URL || env.OPENAI_BASE_URL.trim().length === 0) {
    return null;
  }
  return env.OPENAI_BASE_URL.trim();
}

async function mapUpstreamErrorResponse(
  upstreamRes: Response,
  corsHeaders: Headers,
  upstreamUrl: string,
): Promise<Response> {
  const status = upstreamRes.status >= 400 ? upstreamRes.status : 502;
  const contentType = (upstreamRes.headers.get("content-type") ?? "").toLowerCase();
  const upstreamHost = safeHostFromUrl(upstreamUrl);

  if (contentType.includes("application/json")) {
    try {
      const parsed = (await upstreamRes.json()) as unknown;
      const upstreamMessage = extractUpstreamJsonErrorMessage(parsed);
      return jsonResponse(
        {
          error: {
            message:
              upstreamMessage ??
              `Upstream request failed: ${status}${upstreamHost ? ` from ${upstreamHost}` : ""}.`,
            type: "upstream_error",
            upstream_status: status,
          },
        },
        status,
        corsHeaders,
      );
    } catch {
      // Fall through to plain-text summarization below.
    }
  }

  let bodyText = "";
  try {
    bodyText = await upstreamRes.text();
  } catch {
    bodyText = "";
  }
  const bodySummary = summarizeUpstreamErrorBody(bodyText);

  return jsonResponse(
    {
      error: {
        message:
          bodySummary.length > 0
            ? `Upstream request failed: ${status}${upstreamHost ? ` from ${upstreamHost}` : ""}. ${bodySummary}`
            : `Upstream request failed: ${status}${upstreamHost ? ` from ${upstreamHost}` : ""}.`,
        type: "upstream_error",
        upstream_status: status,
      },
    },
    status,
    corsHeaders,
  );
}

function extractUpstreamJsonErrorMessage(payload: unknown): string | null {
  if (!isObject(payload)) {
    return null;
  }
  if (isObject(payload.error) && typeof payload.error.message === "string") {
    return payload.error.message;
  }
  if (typeof payload.message === "string") {
    return payload.message;
  }
  return null;
}

function summarizeUpstreamErrorBody(rawBody: string): string {
  const trimmed = rawBody.trim();
  if (trimmed.length === 0) {
    return "";
  }
  if (trimmed.toLowerCase().includes("<html")) {
    return "Upstream returned an HTML error page (likely proxy/CDN host failure).";
  }
  const compact = trimmed.replace(/\s+/g, " ");
  if (compact.length <= 240) {
    return `Body: ${compact}`;
  }
  return `Body: ${compact.slice(0, 240)}...`;
}

function safeHostFromUrl(rawUrl: string): string | null {
  try {
    return new URL(rawUrl).host;
  } catch {
    return null;
  }
}

function chatToResponsesPayload(chatRequest: ChatCompletionRequest): JsonObject {
  const input = mapMessagesToResponsesInput(chatRequest.messages ?? []);
  if (input.length === 0) {
    throw new Error("No convertible messages found in 'messages'.");
  }

  const payload: JsonObject = {
    model: chatRequest.model as string,
    input,
    stream: Boolean(chatRequest.stream),
  };

  if (typeof chatRequest.temperature === "number") {
    payload.temperature = chatRequest.temperature;
  }
  if (typeof chatRequest.top_p === "number") {
    payload.top_p = chatRequest.top_p;
  }
  if (typeof chatRequest.max_tokens === "number") {
    payload.max_output_tokens = chatRequest.max_tokens;
  }
  if (chatRequest.stop !== undefined) {
    payload.stop = chatRequest.stop;
  }
  if (Array.isArray(chatRequest.tools)) {
    const tools = mapTools(chatRequest.tools);
    if (tools.length > 0) {
      payload.tools = tools;
    }
  }

  const toolChoice = mapToolChoice(chatRequest.tool_choice);
  if (toolChoice !== undefined) {
    payload.tool_choice = toolChoice;
  }

  const text = mapResponseFormat(chatRequest.response_format);
  if (text !== undefined) {
    payload.text = text;
  }

  return payload;
}

function mapMessagesToResponsesInput(messages: unknown[]): unknown[] {
  const input: unknown[] = [];
  let autoToolCallCounter = 0;

  for (const rawMessage of messages) {
    if (!isObject(rawMessage)) {
      continue;
    }

    const role = typeof rawMessage.role === "string" ? rawMessage.role : "";
    if (role === "tool") {
      const output = collapseMessageContentToText(rawMessage.content);
      const callId =
        typeof rawMessage.tool_call_id === "string" && rawMessage.tool_call_id.length > 0
          ? rawMessage.tool_call_id
          : `call_${autoToolCallCounter++}`;
      input.push({
        type: "function_call_output",
        call_id: callId,
        output,
      });
      continue;
    }

    if (!["system", "user", "assistant", "developer"].includes(role)) {
      continue;
    }

    const content = mapMessageContent(rawMessage.content);
    if (content.length > 0) {
      input.push({
        type: "message",
        role,
        content,
      });
    }

    if (role === "assistant" && Array.isArray(rawMessage.tool_calls)) {
      for (const toolCall of rawMessage.tool_calls) {
        if (!isObject(toolCall) || toolCall.type !== "function") {
          continue;
        }
        const callId =
          typeof toolCall.id === "string" && toolCall.id.length > 0
            ? toolCall.id
            : `call_${autoToolCallCounter++}`;
        const fn = isObject(toolCall.function) ? toolCall.function : {};
        const name = typeof fn.name === "string" ? fn.name : "";
        if (!name) {
          continue;
        }

        let args = "{}";
        if (typeof fn.arguments === "string") {
          args = fn.arguments;
        } else if (fn.arguments !== undefined) {
          args = JSON.stringify(fn.arguments);
        }

        input.push({
          type: "function_call",
          call_id: callId,
          name,
          arguments: args,
        });
      }
    }
  }

  return input;
}

function mapMessageContent(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") {
    return content.length > 0 ? [{ type: "input_text", text: content }] : [];
  }

  if (!Array.isArray(content)) {
    return [];
  }

  const mapped: Array<Record<string, unknown>> = [];
  for (const rawPart of content) {
    if (!isObject(rawPart) || typeof rawPart.type !== "string") {
      continue;
    }

    if (
      (rawPart.type === "text" || rawPart.type === "input_text" || rawPart.type === "output_text") &&
      typeof rawPart.text === "string"
    ) {
      mapped.push({ type: "input_text", text: rawPart.text });
      continue;
    }

    if (rawPart.type === "image_url" && isObject(rawPart.image_url) && typeof rawPart.image_url.url === "string") {
      const imagePart: Record<string, unknown> = {
        type: "input_image",
        image_url: rawPart.image_url.url,
      };
      if (typeof rawPart.image_url.detail === "string") {
        imagePart.detail = rawPart.image_url.detail;
      }
      mapped.push(imagePart);
      continue;
    }

    if (rawPart.type === "input_image" && typeof rawPart.image_url === "string") {
      const imagePart: Record<string, unknown> = {
        type: "input_image",
        image_url: rawPart.image_url,
      };
      if (typeof rawPart.detail === "string") {
        imagePart.detail = rawPart.detail;
      }
      mapped.push(imagePart);
    }
  }

  return mapped;
}

function collapseMessageContentToText(content: unknown): string {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return "";
  }

  const chunks: string[] = [];
  for (const part of content) {
    if (!isObject(part)) {
      continue;
    }
    if (typeof part.text === "string") {
      chunks.push(part.text);
    } else if (typeof part.content === "string") {
      chunks.push(part.content);
    }
  }
  return chunks.join("");
}

function mapTools(tools: unknown[]): unknown[] {
  const mapped: unknown[] = [];
  for (const rawTool of tools) {
    if (!isObject(rawTool)) {
      continue;
    }

    if (rawTool.type === "function" && isObject(rawTool.function)) {
      const fn = rawTool.function;
      if (typeof fn.name !== "string" || fn.name.length === 0) {
        continue;
      }
      const tool: JsonObject = {
        type: "function",
        name: fn.name,
      };
      if (typeof fn.description === "string" && fn.description.length > 0) {
        tool.description = fn.description;
      }
      if (fn.parameters !== undefined) {
        tool.parameters = fn.parameters;
      }
      if (typeof fn.strict === "boolean") {
        tool.strict = fn.strict;
      }
      mapped.push(tool);
      continue;
    }

    mapped.push(rawTool);
  }
  return mapped;
}

function mapToolChoice(toolChoice: unknown): unknown {
  if (toolChoice === undefined) {
    return undefined;
  }
  if (typeof toolChoice === "string") {
    return toolChoice;
  }
  if (!isObject(toolChoice)) {
    return undefined;
  }
  if (toolChoice.type === "function" && isObject(toolChoice.function) && typeof toolChoice.function.name === "string") {
    return {
      type: "function",
      name: toolChoice.function.name,
    };
  }
  return undefined;
}

function mapResponseFormat(responseFormat: unknown): unknown {
  if (!isObject(responseFormat) || typeof responseFormat.type !== "string") {
    return undefined;
  }

  if (responseFormat.type === "json_object") {
    return { format: { type: "json_object" } };
  }

  if (responseFormat.type === "json_schema" && isObject(responseFormat.json_schema)) {
    const schema = responseFormat.json_schema;
    const format: JsonObject = { type: "json_schema" };
    if (typeof schema.name === "string" && schema.name.length > 0) {
      format.name = schema.name;
    }
    if (schema.schema !== undefined) {
      format.schema = schema.schema;
    }
    if (typeof schema.strict === "boolean") {
      format.strict = schema.strict;
    }
    return { format };
  }

  return undefined;
}

function mapResponsesToChatCompletion(
  responsesBody: JsonObject,
  chatRequest: ChatCompletionRequest,
): JsonObject {
  const output = Array.isArray(responsesBody.output) ? responsesBody.output : [];
  const content = extractOutputText(output);
  const toolCalls = extractToolCalls(output);
  const created =
    typeof responsesBody.created_at === "number"
      ? responsesBody.created_at
      : Math.floor(Date.now() / 1000);
  const model =
    typeof responsesBody.model === "string" ? responsesBody.model : chatRequest.model ?? "unknown";

  const message: JsonObject = {
    role: "assistant",
    content: content.length > 0 ? content : null,
  };
  if (toolCalls.length > 0) {
    message.tool_calls = toolCalls;
  }

  const choice: JsonObject = {
    index: 0,
    message,
    finish_reason: inferFinishReason(responsesBody, toolCalls.length > 0),
  };

  const body: JsonObject = {
    id: toChatCompletionId(typeof responsesBody.id === "string" ? responsesBody.id : undefined),
    object: "chat.completion",
    created,
    model,
    choices: [choice],
  };

  const usage = mapUsage(responsesBody.usage);
  if (usage) {
    body.usage = usage;
  }

  return body;
}

function extractOutputText(output: unknown[]): string {
  const chunks: string[] = [];
  for (const item of output) {
    if (!isObject(item)) {
      continue;
    }
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (!isObject(part)) {
          continue;
        }
        if (typeof part.text === "string" && (part.type === "output_text" || part.type === "text")) {
          chunks.push(part.text);
        }
      }
      continue;
    }
    if (item.type === "output_text" && typeof item.text === "string") {
      chunks.push(item.text);
    }
  }
  return chunks.join("");
}

function extractToolCalls(output: unknown[]): ToolCall[] {
  const calls: ToolCall[] = [];
  for (const item of output) {
    if (!isObject(item) || item.type !== "function_call") {
      continue;
    }
    if (typeof item.name !== "string" || item.name.length === 0) {
      continue;
    }

    let argumentsText = "{}";
    if (typeof item.arguments === "string") {
      argumentsText = item.arguments;
    } else if (item.arguments !== undefined) {
      argumentsText = JSON.stringify(item.arguments);
    }

    calls.push({
      id:
        typeof item.call_id === "string" && item.call_id.length > 0
          ? item.call_id
          : `call_${calls.length}`,
      type: "function",
      function: {
        name: item.name,
        arguments: argumentsText,
      },
    });
  }
  return calls;
}

function inferFinishReason(responsesBody: JsonObject, hasToolCalls: boolean): string {
  if (hasToolCalls) {
    return "tool_calls";
  }

  const status = typeof responsesBody.status === "string" ? responsesBody.status : "";
  if (status === "incomplete") {
    const reason =
      isObject(responsesBody.incomplete_details) &&
      typeof responsesBody.incomplete_details.reason === "string"
        ? responsesBody.incomplete_details.reason
        : "";
    if (reason === "max_output_tokens") {
      return "length";
    }
    if (reason === "content_filter") {
      return "content_filter";
    }
    return "stop";
  }

  return "stop";
}

function mapUsage(rawUsage: unknown): JsonObject | null {
  if (!isObject(rawUsage)) {
    return null;
  }

  const promptTokens = typeof rawUsage.input_tokens === "number" ? rawUsage.input_tokens : 0;
  const completionTokens = typeof rawUsage.output_tokens === "number" ? rawUsage.output_tokens : 0;
  const totalTokens =
    typeof rawUsage.total_tokens === "number" ? rawUsage.total_tokens : promptTokens + completionTokens;

  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
  };
}

function toChatCompletionId(rawId: string | undefined): string {
  if (rawId && rawId.startsWith("chatcmpl-")) {
    return rawId;
  }
  if (rawId && rawId.startsWith("resp_")) {
    return `chatcmpl-${rawId.slice(5)}`;
  }
  if (rawId && rawId.length > 0) {
    return `chatcmpl-${rawId}`;
  }
  return `chatcmpl-${crypto.randomUUID()}`;
}

interface StreamState {
  id: string;
  model: string;
  created: number;
  sentRole: boolean;
  sawTextDelta: boolean;
  sawToolCall: boolean;
  done: boolean;
  toolIndexByItemId: Map<string, number>;
  toolMetaByIndex: Map<number, { id: string; name: string }>;
  toolInitSent: Set<number>;
}

async function convertResponsesStreamToChatStream(
  upstreamRes: Response,
  originalRequest: ChatCompletionRequest,
  corsHeaders: Headers,
): Promise<Response> {
  if (!upstreamRes.body) {
    return jsonResponse(
      {
        error: {
          message: "Upstream stream body is empty.",
          type: "api_error",
        },
      },
      502,
      corsHeaders,
    );
  }

  const includeUsage =
    isObject(originalRequest.stream_options) && originalRequest.stream_options.include_usage === true;
  const reader = upstreamRes.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const state: StreamState = {
    id: toChatCompletionId(undefined),
    model: typeof originalRequest.model === "string" ? originalRequest.model : "unknown",
    created: Math.floor(Date.now() / 1000),
    sentRole: false,
    sawTextDelta: false,
    sawToolCall: false,
    done: false,
    toolIndexByItemId: new Map<string, number>(),
    toolMetaByIndex: new Map<number, { id: string; name: string }>(),
    toolInitSent: new Set<number>(),
  };

  let buffer = "";

  const sendRaw = async (text: string): Promise<void> => {
    await writer.write(encoder.encode(text));
  };

  const sendChunk = async (
    delta: JsonObject,
    finishReason: string | null = null,
    usage: JsonObject | undefined = undefined,
  ): Promise<void> => {
    const chunk: JsonObject = {
      id: state.id,
      object: "chat.completion.chunk",
      created: state.created,
      model: state.model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: finishReason,
        },
      ],
    };
    if (usage) {
      chunk.usage = usage;
    }
    await sendRaw(`data: ${JSON.stringify(chunk)}\n\n`);
  };

  const ensureRoleChunk = async (): Promise<void> => {
    if (state.sentRole) {
      return;
    }
    state.sentRole = true;
    await sendChunk({ role: "assistant" }, null);
  };

  const sendToolInit = async (index: number): Promise<void> => {
    if (state.toolInitSent.has(index)) {
      return;
    }
    state.toolInitSent.add(index);
    state.sawToolCall = true;
    await ensureRoleChunk();
    const meta = state.toolMetaByIndex.get(index) ?? {
      id: `call_${index}`,
      name: "",
    };
    await sendChunk(
      {
        tool_calls: [
          {
            index,
            id: meta.id,
            type: "function",
            function: {
              name: meta.name,
              arguments: "",
            },
          },
        ],
      },
      null,
    );
  };

  const sendToolArgumentsDelta = async (index: number, deltaText: string): Promise<void> => {
    if (!deltaText) {
      return;
    }
    await sendToolInit(index);
    await sendChunk(
      {
        tool_calls: [
          {
            index,
            function: {
              arguments: deltaText,
            },
          },
        ],
      },
      null,
    );
  };

  const processParsedEvent = async (eventName: string, dataText: string): Promise<void> => {
    const trimmed = dataText.trim();
    if (!trimmed) {
      return;
    }
    if (trimmed === "[DONE]") {
      if (!state.done) {
        await sendChunk({}, state.sawToolCall ? "tool_calls" : "stop");
        await sendRaw("data: [DONE]\n\n");
        state.done = true;
      }
      return;
    }

    let payload: unknown;
    try {
      payload = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (!isObject(payload)) {
      return;
    }

    const type = typeof payload.type === "string" ? payload.type : eventName;

    if (type === "response.created" && isObject(payload.response)) {
      hydrateStreamStateFromResponse(payload.response, state);
      return;
    }

    if (type === "response.output_text.delta" && typeof payload.delta === "string") {
      await ensureRoleChunk();
      await sendChunk({ content: payload.delta }, null);
      state.sawTextDelta = true;
      return;
    }

    if (type === "response.output_text.done" && !state.sawTextDelta && typeof payload.text === "string") {
      await ensureRoleChunk();
      await sendChunk({ content: payload.text }, null);
      state.sawTextDelta = true;
      return;
    }

    if (type === "response.output_item.added" && isObject(payload.item) && payload.item.type === "function_call") {
      const itemId = streamToolItemKey(payload.item, payload);
      const index = getOrCreateToolIndex(state, itemId);
      const callId =
        typeof payload.item.call_id === "string" && payload.item.call_id.length > 0
          ? payload.item.call_id
          : `call_${index}`;
      const name = typeof payload.item.name === "string" ? payload.item.name : "";
      state.toolMetaByIndex.set(index, { id: callId, name });
      await sendToolInit(index);
      return;
    }

    if (type === "response.function_call_arguments.delta") {
      const key = streamToolItemKey(payload, payload);
      const index = getOrCreateToolIndex(state, key);
      if (!state.toolMetaByIndex.has(index)) {
        state.toolMetaByIndex.set(index, { id: `call_${index}`, name: "" });
      }
      const deltaText = typeof payload.delta === "string" ? payload.delta : "";
      await sendToolArgumentsDelta(index, deltaText);
      return;
    }

    if (type === "response.completed") {
      if (isObject(payload.response)) {
        hydrateStreamStateFromResponse(payload.response, state);

        if (!state.sawTextDelta) {
          const output = Array.isArray(payload.response.output) ? payload.response.output : [];
          const text = extractOutputText(output);
          if (text.length > 0) {
            await ensureRoleChunk();
            await sendChunk({ content: text }, null);
            state.sawTextDelta = true;
          }
        }

        if (!state.sawToolCall) {
          const output = Array.isArray(payload.response.output) ? payload.response.output : [];
          const calls = extractToolCalls(output);
          for (let index = 0; index < calls.length; index += 1) {
            const call = calls[index];
            state.toolMetaByIndex.set(index, {
              id: call.id,
              name: call.function.name,
            });
            await sendToolInit(index);
            if (call.function.arguments.length > 0) {
              await sendToolArgumentsDelta(index, call.function.arguments);
            }
          }
        }

        const usage = includeUsage ? mapUsage(payload.response.usage) ?? undefined : undefined;
        await sendChunk({}, inferFinishReason(payload.response, state.sawToolCall), usage);
      } else {
        await sendChunk({}, state.sawToolCall ? "tool_calls" : "stop");
      }

      await sendRaw("data: [DONE]\n\n");
      state.done = true;
      return;
    }

    if (type === "response.error" || type === "error") {
      await sendRaw(`data: ${JSON.stringify({ error: payload.error ?? payload })}\n\n`);
      await sendRaw("data: [DONE]\n\n");
      state.done = true;
    }
  };

  const pump = async (): Promise<void> => {
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, "\n");

        while (true) {
          const boundary = buffer.indexOf("\n\n");
          if (boundary === -1) {
            break;
          }
          const rawEvent = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          if (!rawEvent.trim()) {
            continue;
          }

          let eventName = "message";
          const dataLines: string[] = [];
          for (const line of rawEvent.split("\n")) {
            if (line.startsWith("event:")) {
              eventName = line.slice(6).trim();
              continue;
            }
            if (line.startsWith("data:")) {
              dataLines.push(line.slice(5).trimStart());
            }
          }

          const dataText = dataLines.join("\n");
          await processParsedEvent(eventName, dataText);
        }
      }

      if (!state.done) {
        await sendChunk({}, state.sawToolCall ? "tool_calls" : "stop");
        await sendRaw("data: [DONE]\n\n");
        state.done = true;
      }
    } catch (error) {
      if (!state.done) {
        await sendRaw(
          `data: ${JSON.stringify({
            error: {
              message: `Stream conversion error: ${getErrorMessage(error)}`,
              type: "api_error",
            },
          })}\n\n`,
        );
        await sendRaw("data: [DONE]\n\n");
        state.done = true;
      }
    } finally {
      reader.releaseLock();
      await writer.close();
    }
  };

  void pump();

  const streamHeaders = new Headers();
  streamHeaders.set("content-type", "text/event-stream; charset=utf-8");
  streamHeaders.set("cache-control", "no-cache, no-transform");
  streamHeaders.set("connection", "keep-alive");
  streamHeaders.set("x-accel-buffering", "no");
  applyCorsToHeaders(streamHeaders, corsHeaders);

  return new Response(readable, {
    status: 200,
    headers: streamHeaders,
  });
}

function hydrateStreamStateFromResponse(response: JsonObject, state: StreamState): void {
  if (typeof response.id === "string" && response.id.length > 0) {
    state.id = toChatCompletionId(response.id);
  }
  if (typeof response.model === "string" && response.model.length > 0) {
    state.model = response.model;
  }
  if (typeof response.created_at === "number") {
    state.created = response.created_at;
  }
}

function streamToolItemKey(item: JsonObject, payload: JsonObject): string {
  if (typeof item.id === "string" && item.id.length > 0) {
    return item.id;
  }
  if (typeof item.item_id === "string" && item.item_id.length > 0) {
    return item.item_id;
  }
  if (typeof payload.item_id === "string" && payload.item_id.length > 0) {
    return payload.item_id;
  }
  if (typeof payload.id === "string" && payload.id.length > 0) {
    return payload.id;
  }
  return `item_${crypto.randomUUID()}`;
}

function getOrCreateToolIndex(state: StreamState, itemId: string): number {
  const existing = state.toolIndexByItemId.get(itemId);
  if (existing !== undefined) {
    return existing;
  }
  const index = state.toolIndexByItemId.size;
  state.toolIndexByItemId.set(itemId, index);
  return index;
}

function jsonResponse(body: unknown, status: number, corsHeaders: Headers): Response {
  const headers = new Headers({ "content-type": "application/json; charset=utf-8" });
  applyCorsToHeaders(headers, corsHeaders);
  return new Response(JSON.stringify(body), { status, headers });
}

function withCors(response: Response, corsHeaders: Headers): Response {
  const headers = new Headers(response.headers);
  applyCorsToHeaders(headers, corsHeaders);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function buildCorsHeaders(request: Request, env: Env): Headers {
  const headers = new Headers();
  const configured = env.ALLOWED_ORIGINS?.trim() || "*";
  const origin = request.headers.get("origin");

  let allowOrigin = "*";
  if (configured !== "*") {
    const allowList = configured
      .split(",")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
    if (origin && allowList.includes(origin)) {
      allowOrigin = origin;
    } else if (allowList.length > 0) {
      allowOrigin = allowList[0];
    }
  }

  headers.set("access-control-allow-origin", allowOrigin);
  headers.set(
    "access-control-allow-headers",
    "authorization,content-type,openai-organization,openai-project",
  );
  headers.set("access-control-allow-methods", "GET,POST,OPTIONS");
  headers.set("access-control-max-age", "86400");
  return headers;
}

function applyCorsToHeaders(target: Headers, corsHeaders: Headers): void {
  corsHeaders.forEach((value, key) => {
    target.set(key, value);
  });
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null;
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
