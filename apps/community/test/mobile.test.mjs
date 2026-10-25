import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import https from "node:https";
import { once } from "node:events";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createMobileHub, MOBILE_TOOL_DEFINITIONS, MOBILE_TOOL_PROMPT, validateMobileInput } from "../mobile.mjs";

const ROOM = "12345678-1234-4234-8234-123456789abc";
const OTHER = "87654321-4321-4321-8321-cba987654321";
const TOKEN = "test-mobile-broker-credential";
const json = (response, value, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(value)); };
const observation = () => ({ width: 720, height: 1560, nodes: [{ text: "Settings", description: "Open settings", resourceId: "android:id/settings", className: "android.widget.Button", bounds: { left: 10, top: 20, right: 100, bottom: 100 }, clickable: true, enabled: true }] });

async function fixture(t, options = {}) {
  const requests = [];
  let handler = (request, response) => json(response, request.url.endsWith("/observe") ? observation() : { device: { roomId: ROOM, state: "running" }, capacity: { slots: 1, maxSlots: 10, running: 1, maxRunning: 2 } });
  const server = http.createServer(async (request, response) => {
    let text = "";
    for await (const chunk of request) text += chunk;
    requests.push({ url: request.url, method: request.method, authorization: request.headers.authorization, body: text ? JSON.parse(text) : null });
    handler(request, response);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  let settings = { endpoint: `http://127.0.0.1:${server.address().port}`, token: TOKEN };
  const hub = createMobileHub({ getConfig: () => settings, allowInsecureLoopback: true, log: () => {}, ...options });
  t.after(async () => { await hub.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  return { hub, requests, server, setHandler: value => { handler = value; }, setConfig: value => { settings = value; }, settings: () => settings };
}

test("mobile tools are disabled by default and never accept a caller-selected room", async () => {
  const hub = createMobileHub({ env: {} });
  assert.equal(hub.configured(), false);
  await assert.rejects(hub.status(ROOM), error => error.status === 503 && error.code === "MOBILE_NOT_CONFIGURED");
  assert.equal(MOBILE_TOOL_DEFINITIONS.length, 6);
  for (const { function: tool } of MOBILE_TOOL_DEFINITIONS) {
    assert.equal(tool.parameters.additionalProperties, false);
    assert.equal(Object.hasOwn(tool.parameters.properties, "roomId"), false);
  }
  assert.match(MOBILE_TOOL_PROMPT, /untrusted/);
  assert.match(MOBILE_TOOL_PROMPT, /Android, not iOS/);
  await hub.close();
});

test("broker endpoints reject public cleartext, credential URLs and redirects", async t => {
  const f = await fixture(t);
  for (const endpoint of ["http://example.com", "http://169.254.169.254", "https://user:pass@example.com", "https://example.com/?key=secret", "https://example.com/#secret", "file:///tmp/broker", "https://example.com/%2felsewhere", "not a URL"]) {
    f.setConfig({ endpoint, token: TOKEN });
    assert.equal(f.hub.configured(), false);
    await assert.rejects(f.hub.status(ROOM), error => error.status === 503 && error.code === "MOBILE_CONFIG_INVALID");
  }
  assert.equal(f.requests.length, 0);
  f.setConfig({ endpoint: `http://127.0.0.1:${f.server.address().port}/api`, token: TOKEN });
  f.setHandler((request, response) => { response.writeHead(302, { Location: "http://example.com/private" }); response.end(); });
  await assert.rejects(f.hub.status(ROOM), error => error.code === "MOBILE_REDIRECT_REJECTED");
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].url, `/api/devices/${ROOM}`);
});

test("internal HTTP is opt-in and restricted to the named mobile-broker sidecar", async () => {
  for (const endpoint of ["http://mobile-broker:8080", "http://127.0.0.1:8080"]) {
    const hub = createMobileHub({ getConfig: () => ({ endpoint, token: TOKEN }), env: { NODE_ENV: "production" } });
    assert.equal(hub.configured(), false);
    await hub.close();
  }
  for (const [endpoint, allowed] of [["http://mobile-broker:8080", true], ["http://mobile-broker.evil.test", false], ["http://other-service:8080", false], ["http://192.168.0.10:8080", false]]) {
    const hub = createMobileHub({ getConfig: () => ({ endpoint, token: TOKEN }), allowInternalHttp: true, allowInsecureLoopback: false });
    assert.equal(hub.configured(), allowed, endpoint);
    await hub.close();
  }
});

test("production Unix socket transport authenticates requests without creating a TCP listener", async t => {
  // Unix-domain sockets on macOS have a small path length limit.
  const directory = mkdtempSync("/tmp/mobile-hub-socket-");
  const socket = path.join(directory, "broker.sock");
  const requests = [];
  const server = http.createServer(async (request, response) => {
    let body = "";
    for await (const chunk of request) body += chunk;
    requests.push({ url: request.url, authorization: request.headers.authorization, remoteAddress: request.socket.remoteAddress, body: body ? JSON.parse(body) : null });
    if (request.headers.authorization !== `Bearer ${TOKEN}`) return json(response, { error: "unauthorized" }, 401);
    json(response, { ok: true });
  });
  const env = { NODE_ENV: "production", MOBILE_BROKER_SOCKET: socket, MOBILE_BROKER_TOKEN: TOKEN };
  const hub = createMobileHub({ env });
  t.after(async () => { await hub.close(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true, force: true }); });
  server.listen(socket); await once(server, "listening");
  assert.equal(server.address(), socket, "broker listens on the local file, not a network port");
  assert.equal(hub.configured(), true);
  assert.deepEqual(await hub.health(), { ok: true });
  await hub.input(ROOM, { type: "key", key: "HOME" });
  assert.deepEqual(requests.map(request => request.url), ["/health", `/devices/${ROOM}/input`]);
  assert.ok(requests.every(request => request.remoteAddress === undefined && request.authorization === `Bearer ${TOKEN}`));
  assert.deepEqual(requests[1].body, { type: "key", key: "HOME" });
  env.MOBILE_BROKER_TOKEN = "wrong-local-socket-token";
  await assert.rejects(hub.health(), error => error.code === "MOBILE_AUTH_FAILED");
});

test("Unix socket configuration rejects missing credentials, relative paths, NULs and mixed endpoints", async () => {
  for (const config of [
    { socket: "/run/community-mobile/mobile.sock" },
    { socket: "relative/broker.sock", token: TOKEN },
    { socket: "/run/broker\0.sock", token: TOKEN },
    { socket: {}, token: TOKEN },
    { socket: "/run/community-mobile/mobile.sock", endpoint: "https://example.com", token: TOKEN },
    { socket: "/run/community-mobile/mobile.sock", token: "short" },
  ]) {
    const hub = createMobileHub({ getConfig: () => config, env: { NODE_ENV: "production" } });
    assert.equal(hub.configured(), false);
    await assert.rejects(hub.health(), error => error.status === 503 && ["MOBILE_NOT_CONFIGURED", "MOBILE_CONFIG_INVALID"].includes(error.code));
    await hub.close();
  }
});

test("each request uses current private credentials and scope is fixed by trusted room argument", async t => {
  const f = await fixture(t);
  await f.hub.status(ROOM);
  f.setConfig({ ...f.settings(), token: "rotated-mobile-credential" });
  await f.hub.input(OTHER, { type: "tap", x: 30, y: 40 });
  assert.equal(f.requests[0].authorization, `Bearer ${TOKEN}`);
  assert.equal(f.requests[1].authorization, "Bearer rotated-mobile-credential");
  assert.equal(f.requests[1].url, `/devices/${OTHER}/input`);
  assert.deepEqual(f.requests[1].body, { type: "tap", x: 30, y: 40 });
  for (const room of ["../health", "room", `${ROOM}/../${OTHER}`, "", null]) assert.throws(() => f.hub.status(room), error => error.code === "MOBILE_ROOM_INVALID");
  const before = f.requests.length;
  await assert.rejects(f.hub.execute(ROOM, "mobile_tap", { x: 1, y: 2, roomId: OTHER }), error => error.code === "MOBILE_TOOL_INVALID");
  assert.equal(f.requests.length, before);
});

test("reserved personal room hashes retain their exact mobile route and reject malformed IDs", async t => {
  const f=await fixture(t),id='f6f6cd49-10f4-6102-2f64-da6554d8dba8';
  await f.hub.status(id.toUpperCase());await f.hub.wake(id);await f.hub.input(id,{type:'key',key:'HOME'});
  assert.deepEqual(f.requests.map(request=>request.url),[`/devices/${id}`,`/devices/${id}/wake`,`/devices/${id}/input`]);
  const count=f.requests.length;
  for(const invalid of [id+'\n',id+'\r',id+'/',id+'%2f',id.slice(1),id.replace('-','/'),'../'+id])
    assert.throws(()=>f.hub.status(invalid),error=>error.code==='MOBILE_ROOM_INVALID');
  assert.equal(f.requests.length,count);
});

test("input validates coordinates, durations, keys, text and rejects arbitrary execution", () => {
  for (const input of [null, [], { type: "shell", command: "id" }, { type: "tap", x: -1, y: 1 }, { type: "tap", x: 0, y: 8192 }, { type: "tap", x: NaN, y: 1 }, { type: "tap", x: "1", y: 2 }, { type: "tap", x: 1.5, y: 2 }, { type: "swipe", x1: 1, y1: 2, x2: 3, y2: 4, duration: 99 }, { type: "swipe", x1: 1, y1: 2, x2: 3, y2: 4, duration: 3001 }, { type: "key", key: "HOME; reboot" }, { type: "text", text: "line\nnext" }, { type: "text", text: "x".repeat(2001) }, { type: "text", text: 12 }, { type: "text", text: "hello", roomId: OTHER }]) assert.throws(() => validateMobileInput(input), error => error.status === 400);
  assert.deepEqual(validateMobileInput({ type: "text", text: "안녕하세요 🙂" }), { type: "text", text: "안녕하세요 🙂" });
  assert.deepEqual(validateMobileInput({ type: "swipe", x1: 10, y1: 200, x2: 10, y2: 30 }), { type: "swipe", x1: 10, y1: 200, x2: 10, y2: 30, duration: 400 });
});

test("read-only guards block every mutation before reaching the broker", async t => {
  const guards = [];
  const f = await fixture(t, { assertWritable: async (room, user) => { guards.push([room, user]); throw Object.assign(new Error("Room is read only"), { code: "ROOM_READ_ONLY", status: 409 }); } });
  const options = { userId: "owner" };
  for (const operation of [() => f.hub.wake(ROOM, options), () => f.hub.sleep(ROOM, options), () => f.hub.input(ROOM, { type: "key", key: "HOME" }, options), () => f.hub.launch(ROOM, "com.android.settings", options), () => f.hub.startTask(ROOM, options), () => f.hub.execute(ROOM, "mobile_observe", {}, options)]) await assert.rejects(operation, error => error.code === "ROOM_READ_ONLY");
  assert.ok(guards.every(([room, user]) => room === ROOM && user === "owner"));
  assert.equal(f.requests.length, 0);
  await f.hub.status(ROOM);
  await f.hub.observe(ROOM);
  assert.equal(f.requests.length, 2, "read-only source can still inspect its device");
});

test("a room frozen while wake is pending cannot receive the queued AI input", async t => {
  let readOnly = false;
  const f = await fixture(t, { assertWritable: async () => { if (readOnly) throw Object.assign(new Error("Frozen"), { code: "ROOM_READ_ONLY" }); } });
  f.setHandler((request, response) => { if (request.url.endsWith("/wake")) readOnly = true; json(response, { ok: true }); });
  await assert.rejects(f.hub.execute(ROOM, "mobile_tap", { x: 1, y: 2 }), error => error.code === "ROOM_READ_ONLY");
  assert.deepEqual(f.requests.map(item => item.url), [`/devices/${ROOM}`, `/devices/${ROOM}/wake`]);
});

test("a room frozen while running-device status is pending cannot use the no-wake fast path to send input", async t => {
  let readOnly = false;
  const f = await fixture(t, { assertWritable: async () => { if (readOnly) throw Object.assign(new Error("Frozen"), { code: "ROOM_READ_ONLY" }); } });
  f.setHandler((_request, response) => { readOnly = true; json(response, { device: { state: 'running' } }); });
  await assert.rejects(f.hub.execute(ROOM, 'mobile_tap', { x: 1, y: 2 }), error => error.code === 'ROOM_READ_ONLY');
  assert.deepEqual(f.requests.map(item => item.url), [`/devices/${ROOM}`]);
});

test("AI tools inspect readiness, execute a validated action and read bounded untrusted UI", async t => {
  const f = await fixture(t);
  const output = await f.hub.execute(ROOM, "mobile_tap", { x: 50, y: 60 });
  assert.match(output, /^\[UNTRUSTED ANDROID SCREEN\]/);
  assert.match(output, /Settings/);
  assert.deepEqual(f.requests.map(item => [item.method, item.url]), [["GET", `/devices/${ROOM}`], ["POST", `/devices/${ROOM}/input`], ["GET", `/devices/${ROOM}/observe`]]);
  const before = f.requests.length;
  for (const pkg of ["com.android.settings;id", "https://example.com/app.apk", "../app", "", "a".repeat(201)]) await assert.rejects(f.hub.execute(ROOM, "mobile_launch", { package: pkg }), error => error.code === "MOBILE_PACKAGE_INVALID");
  assert.equal(f.requests.length, before, "invalid tools must not wake a device");
  await f.hub.execute(ROOM, "mobile_launch", { package: "com.android.settings" });
  assert.deepEqual(f.requests.at(-2).body, { package: "com.android.settings" });
});

test("AI can observe and control a running Android with an IME warning without repeatedly retrying keyboard setup", async t => {
  const f = await fixture(t);
  f.setHandler((request, response) => {
    if (request.url.endsWith('/observe')) return json(response, observation());
    json(response, { device: { roomId: ROOM, state: 'running', lastError: 'device_keyboard_timeout' } });
  });
  await f.hub.startTask(ROOM);
  for (const [name, args] of [['mobile_observe', {}], ['mobile_launch', { package: 'com.android.settings' }], ['mobile_tap', { x: 50, y: 60 }]]) {
    const output = await f.hub.execute(ROOM, name, args);
    assert.match(output, /Settings/);
  }
  assert.equal(f.requests.filter(item => item.url.endsWith('/wake')).length, 0);
  assert.equal(f.requests.filter(item => item.url.endsWith('/launch')).length, 1);
  assert.equal(f.requests.filter(item => item.url.endsWith('/input')).length, 1);
  assert.equal(f.requests.filter(item => item.url.endsWith('/lease') && item.body.active).length, 4, 'ready-device use still renews the active task lease');
  await f.hub.wake(ROOM);
  assert.equal(f.requests.filter(item => item.url.endsWith('/wake')).length, 1, 'explicit UI wake still retries keyboard setup');
  await f.hub.endTask(ROOM);
});

for (const initial of ['unallocated', 'sleeping', 'starting', 'booting']) test(`AI still wakes or joins its ${initial} Android before sending input`, async t => {
  const f = await fixture(t, { readyPollMs: 1 });
  let woke = false, polls = 0;
  f.setHandler((request, response) => {
    if (request.url.endsWith('/observe')) return json(response, observation());
    if (request.url.endsWith('/wake')) { woke = true; return json(response, { device: { state: 'starting' } }); }
    if (request.method === 'GET') return json(response, { device: { state: woke ? ++polls < 2 ? 'starting' : 'running' : initial } });
    assert.ok(woke && polls >= 2, 'input cannot precede real Android readiness');
    json(response, { ok: true });
  });
  await f.hub.execute(ROOM, 'mobile_key', { key: 'HOME' });
  assert.equal(f.requests.filter(item => item.url.endsWith('/wake')).length, 1);
  assert.equal(f.requests.filter(item => item.url.endsWith('/input')).length, 1);
});

test("UI wake returns preparing immediately while AI waits for Android before sending input", async t => {
  const f = await fixture(t, { readyPollMs: 1 });
  let polls = 0;
  f.setHandler((request, response) => {
    if (request.url.endsWith('/observe')) return json(response, observation());
    if (request.url.endsWith('/wake')) return json(response, { device: { state: 'starting' } });
    if (request.method === 'GET') return json(response, { device: { state: ++polls < 3 ? 'starting' : 'running' } });
    assert.ok(polls >= 3, 'input must wait for the actual Android readiness reply');
    json(response, { ok: true });
  });
  assert.equal((await f.hub.wake(ROOM)).device.state, 'starting');
  assert.equal(f.requests.length, 1, 'the UI wake does not wait through boot');
  await f.hub.execute(ROOM, 'mobile_key', { key: 'HOME' });
  assert.equal(polls, 3);
  assert.deepEqual(f.requests.slice(1).map(request => request.url), [
    `/devices/${ROOM}`, `/devices/${ROOM}/wake`, `/devices/${ROOM}`, `/devices/${ROOM}`,
    `/devices/${ROOM}/input`, `/devices/${ROOM}/observe`,
  ]);
});

test("failed or slow Android startup never sends an AI action or treats a VM process as ready", async t => {
  const f = await fixture(t, { readyPollMs: 1, readyTimeoutMs: 20 });
  let failed = true;
  f.setHandler((request, response) => json(response, { device: {
    state: request.url.endsWith('/wake') || !failed ? 'starting' : 'error', lastError: 'vm_boot_timeout',
  } }));
  await assert.rejects(f.hub.execute(ROOM, 'mobile_key', { key: 'HOME' }), error => error.code === 'vm_boot_timeout');
  failed = false;
  await assert.rejects(f.hub.execute(ROOM, 'mobile_key', { key: 'HOME' }), error => error.code === 'MOBILE_PREPARING');
  assert.ok(f.requests.every(request => !request.url.endsWith('/input') && !request.url.endsWith('/observe')));
  assert.equal(f.requests.filter(request => request.url.endsWith('/wake')).length, 2, 'status polling does not repeatedly wake the VM');
});

test("cancelling an AI wait stops polling and retry stays on the same room", async t => {
  const f = await fixture(t, { readyPollMs: 1 });
  const controller = new AbortController();
  f.setHandler((request, response) => {
    json(response, { device: { state: 'starting' } });
    if (!request.url.endsWith('/wake')) controller.abort();
  });
  await assert.rejects(f.hub.execute(ROOM, 'mobile_observe', {}, { signal: controller.signal }), error => error.code === 'MOBILE_CANCELLED');
  const count = f.requests.length;
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.requests.length, count);
  f.setHandler((request, response) => json(response, request.url.endsWith('/observe') ? observation() : { device: { state: 'running' } }));
  await f.hub.execute(ROOM, 'mobile_observe');
  assert.ok(f.requests.every(request => request.url.startsWith(`/devices/${ROOM}`)));
});

test("observations trim node data, clamp bounds and discard non-UI broker fields", async t => {
  const f = await fixture(t);
  f.setHandler((request, response) => {
    const value = observation();
    value.secret = "must not escape";
    value.nodes = Array.from({ length: 400 }, (_, index) => ({ ...value.nodes[0], text: "x".repeat(300), description: `Node ${index}`, secret: "must not escape", bounds: { left: -5, top: -5, right: 900, bottom: 2000 } }));
    json(response, value);
  });
  const result = await f.hub.observe(ROOM);
  assert.ok(result.nodes.length > 0 && result.nodes.length <= 120);
  assert.equal(result.truncated, true);
  assert.ok(JSON.stringify(result).length < 18000);
  assert.equal(result.nodes[0].text.length, 256);
  assert.deepEqual(result.nodes[0].bounds, { left: 0, top: 0, right: 720, bottom: 1560 });
  assert.equal(JSON.stringify(result).includes("must not escape"), false);
  f.setHandler((request, response) => json(response, { width: 0, height: 1560, nodes: [] }));
  await assert.rejects(f.hub.observe(ROOM), error => error.code === "MOBILE_RESPONSE_INVALID");
});

test("transport bounds bodies, rejects nonimages and does not expose broker errors or credentials", async t => {
  const f = await fixture(t);
  f.setHandler((request, response) => json(response, { data: "x".repeat(256 * 1024) }));
  await assert.rejects(f.hub.status(ROOM), error => error.code === "MOBILE_RESPONSE_TOO_LARGE");
  f.setHandler((request, response) => { response.writeHead(200, { "Content-Type": "image/png" }); response.end("not a screenshot"); });
  await assert.rejects(f.hub.screenshot(ROOM), error => error.code === "MOBILE_IMAGE_INVALID");
  f.setHandler((request, response) => json(response, { error: "internal_failure", message: TOKEN }, 500));
  await assert.rejects(f.hub.status(ROOM), error => error.status === 502 && !error.message.includes(TOKEN));
  f.setHandler((request, response) => json(response, { error: "unauthorized", message: TOKEN }, 401));
  await assert.rejects(f.hub.status(ROOM), error => error.status === 503 && error.code === "MOBILE_AUTH_FAILED" && !error.message.includes(TOKEN));
  f.setHandler((request, response) => json(response, { error: "device_capacity_busy" }, 409));
  await assert.rejects(f.hub.wake(ROOM), error => error.status === 409 && error.code === "device_capacity_busy");
});

test("screenshots coalesce for viewers and return only supported bounded image bytes", async t => {
  const f = await fixture(t);
  const image = Buffer.from([255, 216, 255, 217]);
  f.setHandler((request, response) => { response.writeHead(200, { "Content-Type": "image/jpeg" }); response.end(image); });
  const first = f.hub.screenshot(ROOM), second = f.hub.screenshot(ROOM);
  assert.equal(first, second);
  const result = await first;
  assert.deepEqual(result, { data: image, contentType: "image/jpeg" });
  assert.equal(f.requests.length, 1);
  f.setHandler((request, response) => { response.writeHead(200, { "Content-Type": "image/jpeg", "Content-Length": 4 * 1024 * 1024 + 1 }); response.end(); });
  await assert.rejects(f.hub.screenshot(ROOM), error => error.code === "MOBILE_RESPONSE_TOO_LARGE");
});

test("concurrent viewer observations coalesce per room but never reuse a read across a later action", async t => {
  const f = await fixture(t);
  const first = f.hub.observe(ROOM), second = f.hub.observe(ROOM), other = f.hub.observe(OTHER);
  assert.equal(first, second); assert.notEqual(first, other);
  await Promise.all([first, second, other]);
  assert.equal(f.requests.filter(request => request.url === `/devices/${ROOM}/observe`).length, 1);
  await f.hub.input(ROOM, { type: "key", key: "HOME" });
  await f.hub.observe(ROOM);
  assert.equal(f.requests.filter(request => request.url === `/devices/${ROOM}/observe`).length, 2, "the next view reads the screen after the action");
});

test("a separately cancellable viewer cannot cancel a coalesced room observation", async t => {
  const f = await fixture(t);
  const controller = new AbortController();
  const cancelled = f.hub.observe(ROOM, { signal: controller.signal });
  const shared = f.hub.observe(ROOM), second = f.hub.observe(ROOM);
  controller.abort();
  await assert.rejects(cancelled, error => error.code === "MOBILE_CANCELLED");
  assert.equal(shared, second); assert.deepEqual(await shared, { ...observation(), truncated: false, nodes: [{ ...observation().nodes[0], editable: false, focused: false }] });
  assert.equal(f.requests.length, 1);
});

test("device operations have a longer total deadline than lightweight health and status checks", async t => {
  const f = await fixture(t, { timeoutMs: 20, operationTimeoutMs: 200 });
  f.setHandler((request, response) => setTimeout(() => {
    if (request.url.endsWith('/screenshot')) { response.writeHead(200, { 'Content-Type': 'image/jpeg' }); response.end(Buffer.from([255, 216, 255, 217])); }
    else json(response, request.url.endsWith('/observe') ? observation() : { ok: true });
  }, 60));
  await assert.rejects(f.hub.health(), error => error.code === 'MOBILE_TIMEOUT');
  await assert.rejects(f.hub.status(ROOM), error => error.code === 'MOBILE_TIMEOUT');
  await f.hub.startTask(ROOM);
  await f.hub.input(ROOM, { type: 'key', key: 'HOME' });
  await f.hub.launch(ROOM, 'com.android.settings');
  await f.hub.observe(ROOM);
  await f.hub.screenshot(ROOM);
  await f.hub.endTask(ROOM);
  await f.hub.sleep(ROOM);
  assert.equal(f.requests.length, 9);
});

test("device deadlines stay bounded and log only safe action, code and duration", async t => {
  const events = [], secret = 'private typed password', f = await fixture(t, { timeoutMs: 10, operationTimeoutMs: 50, log: entry => events.push(entry) });
  f.setHandler(() => {});
  await assert.rejects(f.hub.input(ROOM, { type: 'text', text: secret }), error => error.code === 'MOBILE_TIMEOUT');
  assert.equal(events.length, 1);assert.deepEqual(Object.keys(events[0]).sort(), ['action', 'code', 'durationMs', 'event']);
  assert.equal(events[0].action, 'input');assert.equal(events[0].code, 'MOBILE_TIMEOUT');assert.equal(events[0].event, 'mobile_operation_failed');
  assert.ok(events[0].durationMs >= 40 && events[0].durationMs < 2000);
  f.setHandler((request, response) => json(response, { error: 'guest_request_timeout', message: secret }, 503));
  await assert.rejects(f.hub.launch(ROOM, 'com.private.application'), error => error.code === 'guest_request_timeout');
  assert.equal(events[1].action, 'launch');assert.equal(events[1].code, 'guest_request_timeout');
  f.setHandler((request, response) => json(response, { error: 'private_broker_echo', message: secret }, 502));
  await assert.rejects(f.hub.observe(ROOM));assert.equal(events[2].code, 'MOBILE_BROKER_ERROR');
  const logged = JSON.stringify(events);
  for (const privateValue of [secret, TOKEN, ROOM, 'com.private.application', 'private_broker_echo', '127.0.0.1']) assert.equal(logged.includes(privateValue), false);
});

test("device timeout, cancellation and queue errors preserve their safe code and HTTP status", async t => {
  const events = [], f = await fixture(t, { log: entry => events.push(entry) });
  for (const [code, status, message] of [['device_operation_timeout', 504, /took too long/], ['device_operation_cancelled', 409, /cancelled/], ['device_queue_timeout', 503, /busy/]]) {
    f.setHandler((request, response) => json(response, { error: code, message: 'private Android command output' }, status));
    await assert.rejects(f.hub.input(ROOM, { type: 'key', key: 'HOME' }), error => error.code === code && error.status === status && message.test(error.message));
    assert.equal(events.at(-1).code, code);
  }
  assert.equal(JSON.stringify(events).includes('private Android command output'), false);
});

test("requests respect cancellation and a total timeout even if broker keeps sending bytes", async t => {
  const f = await fixture(t, { timeoutMs: 70 });
  const timers = new Set();
  t.after(() => { for (const timer of timers) clearInterval(timer); });
  f.setHandler((request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" }); response.write("{");
    const timer = setInterval(() => response.write(" "), 10); timers.add(timer);
    response.on("close", () => { clearInterval(timer); timers.delete(timer); });
  });
  await assert.rejects(f.hub.status(ROOM), error => error.code === "MOBILE_TIMEOUT");
  const controller = new AbortController();
  const request = f.hub.status(ROOM, { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, error => error.code === "MOBILE_CANCELLED");
  await assert.rejects(f.hub.input(ROOM, { type: "key", key: "HOME" }, { signal: controller.signal }), error => error.code === "MOBILE_CANCELLED");
});

test("task leases refcount overlapping work, refresh while active and block sleeping", async t => {
  const f = await fixture(t, { leaseIntervalMs: 20 });
  await Promise.all([f.hub.startTask(ROOM), f.hub.startTask(ROOM)]);
  assert.ok(f.requests.every(item => item.url.endsWith("/lease")), "chat task tracking does not allocate or wake devices");
  await assert.rejects(f.hub.sleep(ROOM), error => error.code === "device_busy");
  await f.hub.endTask(ROOM);
  assert.equal(f.requests.some(item => item.body.active === false), false);
  await new Promise(resolve => setTimeout(resolve, 45));
  assert.ok(f.requests.filter(item => item.body?.active).length >= 3, "long tasks renew the broker lease");
  await f.hub.endTask(ROOM);
  assert.equal(f.requests.at(-1).body.active, false);
  const before = f.requests.length;
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(f.requests.length, before, "no renewal after the final task ends");
  await f.hub.sleep(ROOM);
  assert.ok(f.requests.at(-1).url.endsWith("/sleep"));
});

test("per-room work queues are bounded, serialize actions and do not block another room", async t => {
  const f = await fixture(t);
  let release;
  let started;
  const gate = new Promise(resolve => { started = resolve; });
  f.setHandler((request, response) => {
    if (request.url === `/devices/${ROOM}/input` && !release) { release = () => json(response, { ok: true }); started(); }
    else json(response, { ok: true });
  });
  const first = f.hub.input(ROOM, { type: "key", key: "HOME" });
  await gate;
  const pending = Array.from({ length: 7 }, () => f.hub.input(ROOM, { type: "key", key: "BACK" }));
  await assert.rejects(f.hub.input(ROOM, { type: "key", key: "ENTER" }), error => error.status === 429);
  await f.hub.input(OTHER, { type: "key", key: "HOME" });
  assert.equal(f.requests.filter(item => item.url === `/devices/${ROOM}/input`).length, 1);
  release();
  await Promise.all([first, ...pending]);
  assert.equal(f.requests.filter(item => item.url === `/devices/${ROOM}/input`).length, 8);
  await f.hub.input(ROOM, { type: "key", key: "ENTER" });
  assert.equal(f.requests.at(-1).body.key, "ENTER");
});

test("a failed task lease releases local ownership and later tasks can recover", async t => {
  const f = await fixture(t);
  f.setHandler((request, response) => json(response, { error: "broker_busy" }, 503));
  await assert.rejects(f.hub.startTask(ROOM), error => error.status === 503);
  f.setHandler((request, response) => json(response, { ok: true }));
  await f.hub.sleep(ROOM);
  await f.hub.startTask(ROOM);
  await f.hub.endTask(ROOM);
  assert.equal(f.requests.at(-1).body.active, false);
});

test("broker TLS validates trust and accepts an explicit private CA without disabling verification", async t => {
  const directory = mkdtempSync(path.join(tmpdir(), "mobile-ca-test-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path.join(directory, "cert.conf"), "[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=mobile-broker-test\n[extensions]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n");
  try { execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "key.pem", "-out", "cert.pem", "-days", "1", "-config", "cert.conf"], { cwd: directory, stdio: "ignore" }); }
  catch { t.skip("openssl is required for the private-CA transport test"); return; }
  const ca = readFileSync(path.join(directory, "cert.pem"));
  const server = https.createServer({ cert: ca, key: readFileSync(path.join(directory, "key.pem")) }, (request, response) => json(response, { ok: true }));
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const settings = { endpoint: `https://127.0.0.1:${server.address().port}`, token: TOKEN };
  const hub = createMobileHub({ getConfig: () => settings });
  t.after(async () => { await hub.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  await assert.rejects(hub.health(), error => error.code === "MOBILE_UNAVAILABLE");
  settings.ca = ca;
  assert.deepEqual(await hub.health(), { ok: true });
});
