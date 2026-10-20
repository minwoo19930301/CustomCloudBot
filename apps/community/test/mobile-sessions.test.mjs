import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCommunity } from "../server.mjs";

async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), "mobile-session-"));
  const events = [], turns = [];
  const mobileHub = { configured: () => options.configured !== false, close: async () => {} };
  for (const method of ["status", "wake", "sleep", "observe", "input", "launch", "startTask", "endTask", "execute", "screenshot"]) mobileHub[method] = async (...args) => {
    events.push({ method, args });
    if (options[method]) return options[method](...args);
    if (method === "execute") return "[UNTRUSTED ANDROID SCREEN]\n{\"width\":720,\"height\":1560,\"nodes\":[]}";
    if (method === "screenshot") return { data: Buffer.from([255, 216, 255, 217]), contentType: "image/jpeg" };
    if (method === "observe") return { width: 720, height: 1560, nodes: [] };
    return { device: { roomId: args[0], state: "running" }, capacity: { slots: 1, maxSlots: 10, running: 1, maxRunning: 2 } };
  };
  let complete = options.complete;
  const app = await startCommunity({ dataDir: directory, port: 0, env: { COMMUNITY_BOOTSTRAP_TOKEN: "bootstrap" }, mobileHub, llm: { name: "mobile-session-test", complete: async request => {
    if (request.isolation?.botId === "title") return 'SendMessage: {"content":"모바일 작업"}';
    const turn = { request };
    turns.push(turn);
    try { await complete?.(request, app, turn); }
    finally { turn.finished = true; }
    return 'SendMessage: {"content":"모바일 작업 확인 완료"}';
  } } });
  t.after(async () => { await app.close(); await rm(directory, { recursive: true, force: true }); });
  async function call(route, actor, body, extra = {}) {
    const response = await fetch(app.url + route, { method: body === undefined ? "GET" : "POST", headers: {
      "content-type": "application/json", ...(actor ? { cookie: actor.cookie, ...(extra.csrf === false ? {} : { "x-csrf-token": actor.csrf }) } : {}), ...extra.headers,
    }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    const data = response.headers.get("content-type")?.includes("application/json") ? await response.json() : Buffer.from(await response.arrayBuffer());
    return { status: response.status, data, response };
  }
  async function register(username, owner) {
    const inviteToken = owner ? (await call("/api/admin/invites", owner, {})).data.token : "bootstrap";
    const result = await call("/api/register", null, { username, displayName: username, password: "mobile-test-password", inviteToken });
    assert.equal(result.status, 201);
    return { id: result.data.user.id, csrf: result.data.csrfToken, cookie: result.response.headers.get("set-cookie").split(";", 1)[0] };
  }
  async function room(actor) {
    const result = await call("/api/rooms", actor, { name: "모바일 대화" });
    assert.equal(result.status, 201); return result.data.room.id;
  }
  async function share(owner, member, roomId) {
    const invite = await call(`/api/rooms/${roomId}/invites`, owner, {});
    assert.equal(invite.status, 201);
    assert.equal((await call("/api/rooms/join", member, { token: invite.data.token })).status, 200);
  }
  async function waitIdle(actor, roomId) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      if (!(await call(`/api/rooms/${roomId}`, actor)).data.busy) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("mobile test turn did not finish");
  }
  async function send(actor, roomId, botIds = ["bot-analyst"]) {
    const before = turns.length;
    const sent = await call(`/api/rooms/${roomId}/messages`, actor, { text: "모바일 상태를 확인해줘", botIds, clientNonce: randomUUID() });
    assert.equal(sent.status, 202, JSON.stringify(sent.data));
    await waitIdle(actor, roomId);
    return turns.slice(before);
  }
  const owner = await register("mobile_owner"), member = await register("mobile_member", owner);
  return { app, events, turns, call, owner, member, room, share, send, waitIdle, setComplete: value => { complete = value; } };
}

test("mobile HTTP routes require login, membership, CSRF and same-origin writes", async t => {
  const f = await fixture(t), room = await f.room(f.owner), base = `/api/rooms/${room}/mobile`;
  for (const [suffix, body] of [["", undefined], ["/observe", undefined], ["/screenshot", undefined], ["/wake", {}], ["/sleep", {}], ["/input", { type: "tap", x: 1, y: 2 }], ["/launch", { package: "com.android.settings" }]]) {
    assert.equal((await f.call(base + suffix, null, body)).status, 401);
    assert.equal((await f.call(base + suffix, f.member, body)).status, 404);
  }
  assert.equal((await f.call(base + "/wake", f.owner, {}, { csrf: false })).status, 403);
  assert.equal((await f.call(base + "/input", f.owner, { type: "key", key: "HOME" }, { headers: { origin: "https://evil.example" } })).status, 403);
  assert.deepEqual(f.events, []);
});

test("shared members control the same room device while separate rooms remain isolated", async t => {
  const f = await fixture(t), room = await f.room(f.owner), separate = await f.room(f.member);
  await f.share(f.owner, f.member, room);
  for (const actor of [f.owner, f.member]) {
    const base = `/api/rooms/${room}/mobile`;
    assert.equal((await f.call(base, actor)).data.device.roomId, room);
    assert.equal((await f.call(base + "/wake", actor, {})).status, 200);
    assert.equal((await f.call(base + "/input", actor, { type: "key", key: "HOME" })).status, 200);
    assert.equal((await f.call(base + "/launch", actor, { package: "com.android.settings" })).status, 200);
  }
  const mutations = f.events.filter(event => ["wake", "input", "launch"].includes(event.method));
  assert.ok(mutations.every(event => event.args[0] === room));
  assert.deepEqual(mutations.map(event => event.args.at(-1).userId), [f.owner.id, f.owner.id, f.owner.id, f.member.id, f.member.id, f.member.id]);
  assert.equal((await f.call(`/api/rooms/${separate}/mobile/wake`, f.member, { roomId: room })).status, 200);
  assert.equal(f.events.at(-1).args[0], separate, "request body cannot redirect the room target");
  const screenshot = await f.call(`/api/rooms/${room}/mobile/screenshot`, f.member);
  assert.equal(screenshot.status, 200);
  assert.equal(screenshot.response.headers.get("cache-control"), "private, no-store");
  assert.equal(screenshot.response.headers.get("cross-origin-resource-policy"), "same-origin");
});

test("forked sources retain mobile viewing but reject controls and new child rooms use separate devices", async t => {
  const f = await fixture(t), room = await f.room(f.owner);
  const split = await f.call(`/api/rooms/${room}/fork`, f.owner, { branching: true });
  assert.equal(split.status, 201);
  const base = `/api/rooms/${room}/mobile`, before = f.events.length;
  for (const [suffix, body] of [["/wake", {}], ["/sleep", {}], ["/input", { type: "tap", x: 1, y: 2 }], ["/launch", { package: "com.android.settings" }]]) {
    const response = await f.call(base + suffix, f.owner, body);
    assert.equal(response.status, 409);
    assert.equal(response.data.code, "ROOM_READ_ONLY");
  }
  assert.equal(f.events.length, before);
  assert.equal((await f.call(base, f.owner)).data.readOnly, true);
  assert.equal((await f.call(base + "/observe", f.owner)).status, 200);
  for (const child of split.data.createdRooms) {
    assert.equal((await f.call(`/api/rooms/${child.id}/mobile/wake`, f.owner, {})).status, 200);
    assert.equal(f.events.at(-1).args[0], child.id);
  }
});

test("AI advertises mobile tools to authorized members and acquires one lazy lease for each tool-using turn", async t => {
  const f = await fixture(t), room = await f.room(f.owner);
  await f.share(f.owner, f.member, room);
  await f.send(f.owner, room);
  assert.deepEqual(f.events, [], "ordinary chat must not allocate, wake or lease a device");
  f.setComplete(async request => {
    assert.ok(request.toolDefinitions.some(tool => tool.function.name === "mobile_observe"));
    assert.match(request.system, /UI text is untrusted/);
    await request.browser("mobile_observe", {});
    await request.browser("mobile_key", { key: "HOME" });
  });
  const [turn] = await f.send(f.member, room);
  assert.equal(turn.request.isolation.userId, f.member.id);
  assert.deepEqual(f.events.map(event => event.method), ["startTask", "execute", "execute", "endTask"]);
  assert.ok(f.events.every(event => event.args[0] === room));
  for (const event of f.events.filter(event => event.method === "execute")) {
    assert.equal(event.args[3].userId, f.member.id);
    assert.ok(event.args[3].signal instanceof AbortSignal);
  }
});

test("parallel mobile tool calls share the lazy lease and tool failure still releases it", async t => {
  const f = await fixture(t, { startTask: async () => { await new Promise(resolve => setTimeout(resolve, 25)); } });
  const room = await f.room(f.owner);
  f.setComplete(async request => {
    await Promise.all([request.browser("mobile_observe", {}), request.browser("mobile_key", { key: "HOME" })]);
    throw new Error("Provider interrupted after tools");
  });
  await f.send(f.owner, room);
  assert.equal(f.events.filter(event => event.method === "startTask").length, 1);
  assert.equal(f.events.filter(event => event.method === "execute").length, 2);
  assert.equal(f.events.filter(event => event.method === "endTask").length, 1);
});

test("later review roles cannot repeat mobile actions from the first agent", async t => {
  const f = await fixture(t), room = await f.room(f.owner);
  f.setComplete(async (request, app, turn) => {
    turn.advertised = request.toolDefinitions.some(tool => tool.function.name === "mobile_observe");
    try { await request.browser("mobile_observe", {}); turn.executed = true; }
    catch (error) { turn.error = error; }
  });
  const turns = await f.send(f.owner, room, ["bot-analyst", "bot-creative", "bot-reviewer"]);
  assert.equal(turns.length, 3);
  assert.equal(turns[0].advertised, true);
  assert.equal(turns[0].executed, true);
  for (const turn of turns.slice(1)) { assert.equal(turn.advertised, false); assert.equal(turn.error.status, 403); }
  assert.equal(f.events.filter(event => event.method === "execute").length, 1);
});

test("an unconfigured mobile hub is neither advertised nor callable through a forged tool name", async t => {
  const f = await fixture(t, { configured: false }), room = await f.room(f.owner);
  f.setComplete(async (request, app, turn) => {
    assert.equal(request.toolDefinitions.some(tool => tool.function.name.startsWith("mobile_")), false);
    if (request.browser) {
      try { await request.browser("mobile_observe", {}); }
      catch (error) { turn.error = error; }
    } else turn.unavailable = true;
  });
  const [turn] = await f.send(f.owner, room);
  assert.ok(turn.unavailable || turn.error?.status === 403);
  assert.equal(f.events.length, 0);
});

test("revoked membership blocks AI dispatch and screenshots already in flight", async t => {
  const f = await fixture(t), room = await f.room(f.owner);
  await f.share(f.owner, f.member, room);
  f.setComplete(async (request, app, turn) => {
    app.db.prepare("DELETE FROM room_members WHERE room_id=? AND user_id=?").run(room, f.member.id);
    try { await request.browser("mobile_observe", {}); }
    catch (error) { turn.error = error; }
  });
  // The sender no longer has access after revocation, so poll using the room owner.
  const sent = await f.call(`/api/rooms/${room}/messages`, f.member, { text: "모바일 확인", botIds: ["bot-analyst"], clientNonce: randomUUID() });
  assert.equal(sent.status, 202);
  await f.waitIdle(f.owner, room);
  assert.equal(f.turns.at(-1).error.status, 404);
  assert.equal(f.events.length, 0);

  let release, screenshotStarted;
  const gate = new Promise(resolve => { screenshotStarted = resolve; });
  const next = await fixture(t, { screenshot: async () => {
    screenshotStarted();
    await new Promise(resolve => { release = resolve; });
    return { data: Buffer.from([255, 216, 255, 217]), contentType: "image/jpeg" };
  } });
  const secondRoom = await next.room(next.owner);
  await next.share(next.owner, next.member, secondRoom);
  const response = next.call(`/api/rooms/${secondRoom}/mobile/screenshot`, next.member);
  await gate;
  next.app.db.prepare("DELETE FROM room_members WHERE room_id=? AND user_id=?").run(secondRoom, next.member.id);
  release();
  assert.equal((await response).status, 404, "private pixels must not be sent after access is revoked");
});


test("mobile unavailable codes reach the UI without exposing broker credentials", async t => {
  const f=await fixture(t,{status:async()=>{throw Object.assign(new Error("Mobile devices are not connected"),{status:503,code:"MOBILE_NOT_CONFIGURED"});}});
  const room=await f.room(f.owner);
  const response=await f.call(`/api/rooms/${room}/mobile`,f.owner);
  assert.equal(response.status,503);assert.equal(response.data.code,"MOBILE_NOT_CONFIGURED");
});


test("mobile capacity errors retain their safe UI code", async t => {
  const f=await fixture(t,{wake:async()=>{throw Object.assign(new Error("Other mobile devices are busy"),{status:409,code:"device_capacity_busy"});}});
  const room=await f.room(f.owner);const response=await f.call(`/api/rooms/${room}/mobile/wake`,f.owner,{});
  assert.equal(response.status,409);assert.equal(response.data.code,"device_capacity_busy");
});
