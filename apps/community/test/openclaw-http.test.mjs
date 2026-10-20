import test from "node:test";
import assert from "node:assert/strict";
import { OpenClawHttpAdapter, createOpenClawFromEnv } from "../lib/backend/openclaw-http.mjs";

test("OpenClaw adapter uses documented OpenResponses shape and isolated server session key", async () => {
  let captured;
  const adapter = new OpenClawHttpAdapter({ baseUrl: "http://127.0.0.1:18789", token: "gateway-secret-token", agentId: "community", fetchImpl: async (url, init) => {
    captured = { url, init };
    return new Response(JSON.stringify({ output_text: "safe answer" }), { status: 200, headers: { "content-type": "application/json" } });
  } });
  const result = await adapter.complete({ system: "system", context: "room history", user: "hello", isolation: { userId: "user-a", roomId: "room-a", botId: "bot-1" } });
  assert.equal(result, 'SendMessage: {"type":"text","content":"safe answer"}');
  assert.equal(String(captured.url), "http://127.0.0.1:18789/v1/responses");
  assert.equal(captured.init.headers.authorization, "Bearer gateway-secret-token");
  assert.equal(captured.init.headers["x-openclaw-agent-id"], "community");
  assert.match(captured.init.headers["x-openclaw-session-key"], /^community:[a-f0-9]{64}$/);
  const body = JSON.parse(captured.init.body);
  assert.equal(body.model, "openclaw/community");
  assert.equal(body.max_output_tokens, 4096);
  assert.deepEqual(body.tools, []);
  assert.equal(body.tool_choice, "none");
  assert.ok(body.input.every((item) => item.type === "message"));
  const keyA = adapter.sessionKey({ userId: "user-a", roomId: "room-a", botId: "bot-1" });
  const keyB = adapter.sessionKey({ userId: "user-a", roomId: "room-b", botId: "bot-1" });
  const keyC = adapter.sessionKey({ userId: "user-b", roomId: "room-a", botId: "bot-1" });
  assert.notEqual(keyA, keyB);
  assert.notEqual(keyA, keyC);
});

test("adapter rejects unsafe endpoints, weak credentials, and missing isolation", () => {
  assert.throws(() => new OpenClawHttpAdapter({ baseUrl: "http://gateway.example", token: "gateway-secret-token" }), /HTTPS/);
  assert.throws(() => new OpenClawHttpAdapter({ baseUrl: "http://127.0.0.1:18789", token: "short" }), /token/);
  const adapter = new OpenClawHttpAdapter({ baseUrl: "http://127.0.0.1:18789", token: "gateway-secret-token" });
  assert.throws(() => adapter.sessionKey({ userId: "u", roomId: "r" }), /identifiers/);
});

test("environment factory stays disabled unless server-only OpenClaw credentials are explicit", () => {
  assert.equal(createOpenClawFromEnv({}), null);
  assert.equal(createOpenClawFromEnv({ COMMUNITY_OPENCLAW_BASE_URL: "http://127.0.0.1:18789", COMMUNITY_OPENCLAW_TOKEN: "gateway-secret-token" }).name, "openclaw:default");
});

test("environment factory accepts only a bounded gateway timeout and keeps the default", () => {
  const env = { COMMUNITY_OPENCLAW_BASE_URL:"http://127.0.0.1:18789", COMMUNITY_OPENCLAW_TOKEN:"gateway-secret-token" };
  assert.equal(createOpenClawFromEnv(env).timeoutMs, 60000);
  assert.equal(createOpenClawFromEnv({...env,COMMUNITY_OPENCLAW_TIMEOUT_MS:""}).timeoutMs, 60000);
  for (const value of ["1000", "120000", "180000"]) assert.equal(createOpenClawFromEnv({...env,COMMUNITY_OPENCLAW_TIMEOUT_MS:value}).timeoutMs, Number(value));
  for (const value of ["0", "999", "180001", "1000.5", "Infinity", "NaN", "not-a-number", " ", null]) {
    assert.throws(()=>createOpenClawFromEnv({...env,COMMUNITY_OPENCLAW_TIMEOUT_MS:value}),/COMMUNITY_OPENCLAW_TIMEOUT_MS/);
  }
});

test("OpenResponses client browser tools are bounded and quota callback precedes continuation", async () => {
  const requests = [];
  const replies = [
    { output: [{ type: "function_call", call_id: "call-1", name: "browser_snapshot", arguments: "{}" }] },
    { output_text: "SendMessage: {\"type\":\"text\",\"content\":\"done\"}" },
  ];
  const adapter = new OpenClawHttpAdapter({ baseUrl: "http://127.0.0.1:18789", token: "gateway-secret-token", fetchImpl: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return new Response(JSON.stringify(replies.shift()), { status: 200 });
  } });
  let quotaCalls = 0;
  const result = await adapter.complete({
    system: "system", user: "hello", isolation: { userId: "u", roomId: "r", botId: "b" },
    browser: async (name) => `${name} result`,
    beforeAdditionalModelCall: async () => { quotaCalls += 1; },
  });
  assert.match(result, /done/);
  assert.equal(requests.length, 2);
  assert.equal(quotaCalls, 1);
  assert.equal(requests[0].tools.length, 6);
  assert.equal(requests[1].input.at(-1).type, "function_call_output");
});

test("raw OpenClaw text is normalized and oversized responses are rejected", async () => {
  const adapter = (body) => new OpenClawHttpAdapter({ baseUrl: "http://127.0.0.1:18789", token: "gateway-secret-token", fetchImpl: async () => new Response(body, { status: 200 }) });
  const result = await adapter(JSON.stringify({ output_text: "plain" })).complete({ user: "hi", isolation: { userId: "u", roomId: "r", botId: "b" } });
  assert.equal(result, 'SendMessage: {"type":"text","content":"plain"}');
  await assert.rejects(() => adapter("x".repeat(128 * 1024 + 1)).complete({ user: "hi", isolation: { userId: "u", roomId: "r", botId: "b" } }), /too large/);
});

const hostTool = { type: "function", function: { name: "host_exec", description: "Run an authorized host command.", parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"], additionalProperties: false } } };
const toolRequest = (overrides = {}) => ({
  user: "check host", isolation: { userId: "owner", roomId: "shared-room", botId: "bot" },
  toolDefinitions: [hostTool], beforeAdditionalModelCall: async () => {}, ...overrides,
});
const toolCall = (name = "host_exec", id = "host-1") => ({ type: "function_call", call_id: id, name, arguments: '{"command":"id -u"}' });

test("gateway advertises and dispatches supplied host tools with isolated session and bounded results", async () => {
  const requests = [], keys = [], order = [];
  const adapter = new OpenClawHttpAdapter({ baseUrl: "http://127.0.0.1:18789", token: "gateway-secret-token", fetchImpl: async (_url, init) => {
    requests.push(JSON.parse(init.body)); keys.push(init.headers["x-openclaw-session-key"]); order.push("model");
    return Response.json(requests.length === 1 ? { output: [toolCall()] } : { output_text: "done" });
  } });
  const result = await adapter.complete(toolRequest({
    browser: async (name, args, {signal}) => {
      order.push("tool"); assert.equal(name, "host_exec"); assert.deepEqual(args, {command:"id -u"});
      assert.ok(signal instanceof AbortSignal); return "0".repeat(9000);
    }, beforeAdditionalModelCall: async () => { order.push("quota"); },
  }));
  assert.match(result, /done/);
  assert.deepEqual(requests[0].tools, [{ type:"function", ...hostTool.function }]);
  assert.deepEqual(order, ["model", "tool", "quota", "model"]);
  assert.equal(requests[1].input.at(-1).output.length, 8000);
  assert.equal(keys[0], keys[1]);
  assert.match(keys[0], /^community:[a-f0-9]{64}$/);
});

test("gateway rejects an unadvertised tool before dispatching any calls in that response", async () => {
  let actions = 0;
  const adapter = new OpenClawHttpAdapter({ baseUrl: "http://127.0.0.1:18789", token: "gateway-secret-token", fetchImpl: async () => Response.json({ output:[toolCall(), toolCall("browser_snapshot", "unadvertised")] }) });
  await assert.rejects(adapter.complete(toolRequest({ browser:async()=>{ actions++; return "ok"; } })), /Invalid OpenClaw client tool call/);
  assert.equal(actions, 0);
});

test("an explicitly empty tool list disables tools without falling back to browser access", async () => {
  let body, actions = 0;
  const adapter = new OpenClawHttpAdapter({ baseUrl:"http://127.0.0.1:18789", token:"gateway-secret-token", fetchImpl:async(_url,init)=>{
    body=JSON.parse(init.body);return Response.json({output:[toolCall("browser_snapshot")]});
  }});
  await assert.rejects(adapter.complete(toolRequest({toolDefinitions:[],browser:async()=>{actions++;return "ok";}})), /Invalid OpenClaw client tool call/);
  assert.deepEqual(body.tools, []);
  assert.equal(body.tool_choice, "none");
  assert.equal(actions, 0);
});

test("external cancellation reaches an active tool and prevents continuation", async () => {
  const controller = new AbortController(); let modelCalls = 0, quotaCalls = 0, toolSignal;
  const adapter = new OpenClawHttpAdapter({baseUrl:"http://127.0.0.1:18789",token:"gateway-secret-token",fetchImpl:async()=>{modelCalls++;return Response.json({output:[toolCall()]});}});
  const result = adapter.complete(toolRequest({
    browser:async(_name,_args,{signal})=>{
      toolSignal=signal;
      const aborted = new Promise((_,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}));
      controller.abort(new Error("owner cancelled"));
      return aborted;
    },beforeAdditionalModelCall:async()=>{quotaCalls++;},
  }),controller.signal);
  await assert.rejects(result,error=>error.name==="AbortError");
  assert.equal(toolSignal.aborted, true);
  assert.equal(modelCalls, 1);
  assert.equal(quotaCalls, 0);
});

test("gateway deadline cancels an active tool and reports timeout without a retry", async () => {
  let modelCalls = 0, quotaCalls = 0, toolSignal;
  const adapter = new OpenClawHttpAdapter({baseUrl:"http://127.0.0.1:18789",token:"gateway-secret-token",timeoutMs:25,fetchImpl:async()=>{modelCalls++;return Response.json({output:[toolCall()]});}});
  const result = adapter.complete(toolRequest({
    browser:(_name,_args,{signal})=>{toolSignal=signal;return new Promise((_,reject)=>signal.addEventListener("abort",()=>reject(signal.reason),{once:true}));},
    beforeAdditionalModelCall:async()=>{quotaCalls++;},
  }));
  await assert.rejects(result,/OpenClaw gateway request timed out/);
  assert.equal(toolSignal.aborted, true);
  assert.equal(modelCalls, 1);
  assert.equal(quotaCalls, 0);
});
