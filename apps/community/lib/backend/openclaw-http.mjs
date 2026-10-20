import { createHash, randomUUID } from "node:crypto";
import { BROWSER_TOOL_DEFINITIONS } from "../../browser-tools.mjs";
import { normalizeBotOutput } from "../../model-output.mjs";
import { usageEvent } from "../../usage.mjs";

const MAX_TEXT = 8000;
const MAX_USER_TEXT = 48000;
const DEFAULT_TIMEOUT_MS = 60000;
const LARGE_ARGUMENT_TOOLS = new Set(['host_exec','create_drawing']);

/**
 * Small server-only adapter for OpenClaw's documented OpenResponses endpoint.
 * It deliberately exposes no Gateway session listing, tools, files, or browser
 * access. Each turn has a fresh session key scoped to user, room, and bot.
 * Only advertised application-owned client tools can be dispatched.
 * The dedicated Gateway must separately deny its built-in tools.
 */
export class OpenClawHttpAdapter {
  constructor({ baseUrl, token, agentId = "default", fetchImpl = fetch, timeoutMs = DEFAULT_TIMEOUT_MS, allowPrivateHttp = false } = {}) {
    if (typeof baseUrl !== "string" || !baseUrl) throw new Error("OpenClaw base URL is required");
    const endpoint = new URL(baseUrl.replace(/\/+$/, "") + "/v1/responses");
    if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
        (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" &&
        (["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname) || (allowPrivateHttp && endpoint.hostname === "openclaw"))))) {
      throw new Error("OpenClaw endpoint must use HTTPS");
    }
    if (typeof token !== "string" || token.length < 16) throw new Error("OpenClaw gateway token is required");
    if (!/^[\w.-]{1,80}$/.test(agentId)) throw new Error("OpenClaw agent id is invalid");
    this.name = `openclaw:${agentId}`;
    this.endpoint = endpoint;
    this.token = token;
    this.agentId = agentId;
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  sessionKey({ userId, roomId, botId, turnNonce = randomUUID() }) {
    if (![userId, roomId, botId].every((value) => typeof value === "string" && value.length > 0)) {
      throw new Error("OpenClaw isolation identifiers are required");
    }
    const digest = createHash("sha256").update(`${userId}\0${roomId}\0${botId}\0${turnNonce}`).digest("hex");
    return `community:${digest}`;
  }

  async complete(request, signal) {
    if (signal?.aborted) throw new Error("OpenClaw request was cancelled");
    const isolation = request?.isolation;
    const sessionKey = this.sessionKey({ ...(isolation ?? {}), turnNonce: randomUUID() });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const userText=String(request.user ?? "");
      // Steering checkpoints include completed side effects. Silently dropping
      // their tail could make a resumed agent repeat or omit work.
      if(userText.length>MAX_USER_TEXT) throw new Error('OpenClaw user input exceeds 48000 characters; nothing was submitted');
      const input = [
        ...(request.system ? [{ type: "message", role: "system", content: String(request.system).slice(0, MAX_TEXT) }] : []),
        ...(request.context ? [{ type: "message", role: "developer", content: String(request.context).slice(0, MAX_TEXT) }] : []),
        { type: "message", role: "user", content: userText },
      ];
      const browser = request?.browser;
      const definitions = request.toolDefinitions === undefined ? BROWSER_TOOL_DEFINITIONS : request.toolDefinitions;
      if (!Array.isArray(definitions) || definitions.some((tool) => tool?.type !== "function" || typeof tool.function?.name !== "string" || !/^[a-zA-Z0-9_-]{1,64}$/.test(tool.function.name))) {
        throw new Error("Invalid OpenClaw client tool definitions");
      }
      const outputTokens=(browser && definitions.length) || request.effort ? 8192 : 4096;
      let actions = 0;
      for (let callCount = 0; callCount < 5; callCount += 1) {
      controller.signal.throwIfAborted();
      const tools = browser && actions < 4 && callCount < 4 ? definitions.map((tool) => ({ type: "function", name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters })) : [];
      const allowedNames = new Set(tools.map((tool) => tool.name));
      request.onProgress?.("model",callCount?"조회 결과 정리 중":"답변 작성 중");
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: { "content-type": "application/json", authorization: `Bearer ${this.token}`, "x-openclaw-agent-id": this.agentId, "x-openclaw-session-key": sessionKey },
        body: JSON.stringify({ model: `openclaw/${this.agentId}`, input, max_output_tokens: outputTokens, store: false, tools, tool_choice: tools.length ? "auto" : "none" }),
      });
      if (!response.ok) {
        request.onUsage?.(usageEvent({provider:"openclaw",keySlot:request.keySlot,model:`openclaw/${this.agentId}`,status:response.status,headers:response.headers}));
        await response.body?.cancel?.(); throw new Error("OpenClaw gateway rejected request");
      }
      request.onProgress?.("receiving","응답 수신 중");
      let payload;
      try { payload = await readJsonLimited(response, 128 * 1024); }
      finally {
        request.onUsage?.(usageEvent({provider:"openclaw",keySlot:request.keySlot,model:typeof payload?.model==="string"?payload.model:`openclaw/${this.agentId}`,status:response.status,headers:response.headers,usage:payload?.usage}));
      }
      const refusals=Array.isArray(payload?.output)?payload.output.flatMap(item=>Array.isArray(item?.content)?item.content:[]).filter(part=>part?.type==='refusal'):[];
      if(refusals.length || payload?.incomplete_details?.reason==='content_filter') {
        return normalizeBotOutput(refusals.map(part=>typeof part.refusal==='string'?part.refusal:'').join('\n').trim() || '이 요청에 대한 응답은 제공자 정책에 따라 제한되었습니다.');
      }
      // A capped response can contain plausible text or valid but incomplete
      // function arguments. Never expose or execute that partial output.
      if(payload?.status==='incomplete' || payload?.incomplete_details?.reason==='max_output_tokens') throw new Error('OpenClaw gateway response was incomplete');
      const calls = Array.isArray(payload?.output) ? payload.output.filter((item) => item?.type === "function_call") : [];
      if (calls.length) {
        if (!browser || calls.length > 4 - actions) throw new Error("OpenClaw client tool action budget exceeded");
        if (callCount >= 4 || typeof request.beforeAdditionalModelCall !== "function") throw new Error("OpenClaw continuation quota is unavailable");
        const parsedCalls = calls.map((call) => {
          if (typeof call.call_id !== "string" || call.call_id.length > 200 || typeof call.name !== "string" || !allowedNames.has(call.name) || typeof call.arguments !== "string" || (LARGE_ARGUMENT_TOOLS.has(call.name)?Buffer.byteLength(call.arguments)>32768:call.arguments.length>10000)) throw new Error("Invalid OpenClaw client tool call");
          let args; try { args = JSON.parse(call.arguments); } catch { throw new Error("Invalid OpenClaw client tool arguments"); }
          return { call, args };
        });
        input.push(...(Array.isArray(payload.output) ? payload.output : []));
        for (const { call, args } of parsedCalls) {
          controller.signal.throwIfAborted();
          actions += 1;
          let output;
          try { output = await browser(call.name, args, { signal: controller.signal }); }
          catch (error) {
            controller.signal.throwIfAborted();
            output = error?.status ? error.message : "The requested tool action failed.";
          }
          controller.signal.throwIfAborted();
          input.push({ type: "function_call_output", call_id: call.call_id, output: String(output).slice(0, 8000) });
        }
        await request.beforeAdditionalModelCall();
        continue;
      }
      const text = extractText(payload);
      if (!text) throw new Error("OpenClaw gateway returned no text");
      return normalizeBotOutput(text);
      }
      throw new Error("OpenClaw client tool turn budget exhausted");
    } catch (error) {
      if (controller.signal.aborted && !signal?.aborted) throw new Error("OpenClaw gateway request timed out");
      throw error;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
}

async function readJsonLimited(response, maxBytes) {
  if (!response.body) {
    const raw = await response.arrayBuffer();
    if (raw.byteLength > maxBytes) throw new Error("OpenClaw response too large");
    return JSON.parse(Buffer.from(raw).toString("utf8"));
  }
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
      if (bytes > maxBytes) throw new Error("OpenClaw response too large");
      chunks.push(Buffer.from(next.value));
    }
  } finally { await reader.cancel().catch(() => {}); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function extractText(payload) {
  if (typeof payload?.output_text === "string") return payload.output_text;
  if (!Array.isArray(payload?.output)) return "";
  return payload.output.flatMap((item) => Array.isArray(item?.content) ? item.content : [])
    .map((part) => typeof part?.text === "string" ? part.text : "")
    .join("");
}

export function createOpenClawFromEnv(env = process.env, fetchImpl = fetch) {
  if (!(env.COMMUNITY_OPENCLAW_BASE_URL && env.COMMUNITY_OPENCLAW_TOKEN)) return null;
  const configuredTimeout = env.COMMUNITY_OPENCLAW_TIMEOUT_MS;
  const timeoutMs = configuredTimeout === undefined || configuredTimeout === "" ? DEFAULT_TIMEOUT_MS : Number(configuredTimeout);
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 180_000) throw new Error("COMMUNITY_OPENCLAW_TIMEOUT_MS must be an integer between 1000 and 180000");
  return new OpenClawHttpAdapter({ baseUrl: env.COMMUNITY_OPENCLAW_BASE_URL, token: env.COMMUNITY_OPENCLAW_TOKEN, agentId: env.COMMUNITY_OPENCLAW_AGENT_ID ?? "default", fetchImpl, timeoutMs, allowPrivateHttp: env.COMMUNITY_OPENCLAW_ALLOW_PRIVATE_HTTP === "1" });
}
