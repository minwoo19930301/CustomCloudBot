import test from "node:test";
import assert from "node:assert/strict";
import {createHash, randomUUID} from "node:crypto";
import {mkdtemp, rm, readFile, readdir, stat} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {startCommunity} from "../server.mjs";

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), "community-sharing-")), calls = [];
  const app = await startCommunity({dataDir: dir, port: 0, env: {COMMUNITY_BOOTSTRAP_TOKEN: "bootstrap"},
    integrations: {list: async () => [{id: "private-fixture", name: "Private", configured: true, actions: ["read"]}]},
    llm: {complete: async request => {calls.push(request); return 'SendMessage: {"content":"완료"}'; }}});
  t.after(async () => {await app.close(); await rm(dir, {recursive: true, force: true});});
  async function call(path, auth, body, csrf = true) {
    const response = await fetch(app.url + path, {method: body === undefined ? "GET" : "POST", headers: {
      "content-type": "application/json", ...(auth ? {cookie: auth.cookie, ...(csrf ? {"x-csrf-token": auth.csrf} : {})} : {})},
      body: body === undefined ? undefined : JSON.stringify(body)});
    return {status: response.status, data: await response.json(), response};
  }
  async function register(username, owner) {
    const inviteToken = owner ? (await call("/api/admin/invites", owner, {})).data.token : "bootstrap";
    const result = await call("/api/register", null, {username, displayName: username, password: "sharing-test-password", inviteToken});
    assert.equal(result.status, 201);
    return {id: result.data.user.id, csrf: result.data.csrfToken, cookie: result.response.headers.get("set-cookie").split(";", 1)[0]};
  }
  async function room(owner) {const result = await call("/api/rooms", owner, {name: "공유 테스트"}); assert.equal(result.status, 201); return result.data.room;}
  async function personal(owner) {return (await call("/api/rooms", owner)).data.rooms.find(item => item.personal);}
  async function send(owner, roomId, text, extra = {}) {const result = await call(`/api/rooms/${roomId}/messages`, owner, {text, botIds: [], clientNonce: randomUUID(), ...extra}); assert.equal(result.status, 202); return result.data;}
  async function joinRoom(owner, member, roomId) {const invite = (await call(`/api/rooms/${roomId}/invites`, owner, {})).data.token; assert.equal((await call("/api/rooms/join", member, {token: invite})).status, 200);}
  return {app, dir, calls, call, register, room, personal, send, joinRoom};
}

test("profile customization persists per account and retains authentication, CSRF, and role boundaries", async t => {
  const f = await fixture(t), owner = await f.register("profile_owner"), member = await f.register("profile_member", owner);
  assert.equal((await f.call("/api/profile", null, {displayName: "changed"})).status, 401);
  assert.equal((await f.call("/api/profile", member, {displayName: "changed"}, false)).status, 403);
  for (const body of [{displayName: " "}, {displayName: "x".repeat(81)}, {displayName: "valid", avatarColor: "url(https://invalid)"}]) assert.equal((await f.call("/api/profile", member, body)).status, 400);
  const changed = await f.call("/api/profile", member, {displayName: "새 이름", avatarColor: "#427f80", avatarLabel: "민우", id: owner.id, role: "admin"});
  assert.equal(changed.status, 200); assert.equal(changed.data.user.id, member.id); assert.equal(changed.data.user.role, "member");
  const session = (await f.call("/api/session", member)).data;
  assert.equal(session.user.displayName, "새 이름"); assert.equal(session.user.avatarColor, "#427f80");
  assert.equal(session.user.avatarLabel, "민우");
  const ownerProfile = (await f.call("/api/session", owner)).data.user;
  assert.equal(ownerProfile.displayName, "profile_owner"); assert.equal(ownerProfile.avatarLabel, "");
  const r = await f.room(member); await f.send(member, r.id, "프로필 확인");
  assert.equal((await f.call(`/api/rooms/${r.id}`, member)).data.messages[0].author, "새 이름");
});

test("avatar labels count emoji as displayed characters, retain omitted values, and support resetting", async t => {
  const f = await fixture(t), owner = await f.register("avatar_owner");
  for (const avatarLabel of [null, 1, {}, "abcd", "가나다라", "x".repeat(65), "a\nb", "a\u202eb"])
    assert.equal((await f.call("/api/profile", owner, {displayName: "이름", avatarLabel})).status, 400);
  const label = "👩🏽‍💻☁️";
  const changed = await f.call("/api/profile", owner, {displayName: "이름", avatarLabel: " " + label + " "});
  assert.equal(changed.status, 200); assert.equal(changed.data.user.avatarLabel, label);
  assert.equal(f.app.db.prepare("SELECT value FROM settings WHERE key=?").get("profile-label:" + owner.id).value, label);
  const renamed = await f.call("/api/profile", owner, {displayName: "새 이름"});
  assert.equal(renamed.data.user.avatarLabel, label);
  assert.equal((await f.call("/api/session", owner)).data.user.avatarLabel, label);
  const cleared = await f.call("/api/profile", owner, {displayName: "새 이름", avatarLabel: "   "});
  assert.equal(cleared.status, 200); assert.equal(cleared.data.user.avatarLabel, "");
  assert.equal((await f.call("/api/session", owner)).data.user.avatarLabel, "");
});

test("profile photos persist per user, render in shared chats, and require authentication and CSRF", async t => {
  const f = await fixture(t), owner = await f.register("photo_owner"), member = await f.register("photo_member", owner);
  const bytes = await readFile(new URL("../public/icons/cloud-agent-v1-48.png", import.meta.url));
  const upload = async (auth, image = bytes, type = "image/png", csrf = true) => {
    const body = new FormData(); body.append("file", new Blob([image], {type}), "../../photo.png");
    return fetch(f.app.url + "/api/profile/avatar", {method: "POST", headers: auth ? {cookie: auth.cookie, ...(csrf ? {"x-csrf-token": auth.csrf} : {})} : {}, body});
  };
  assert.equal((await upload(null)).status, 401);
  assert.equal((await upload(owner, bytes, "image/png", false)).status, 403);
  for (const [image, type, expected] of [[Buffer.from("<svg onload='alert(1)'/>"), "image/svg+xml", 415], [Buffer.from("89504e470d0a1a0a", "hex"), "image/png", 415], [Buffer.alloc(2 * 1024 * 1024 + 1), "image/png", 413]])
    assert.equal((await upload(owner, image, type)).status, expected);
  assert.deepEqual(await readdir(join(f.dir, "avatars")), []);
  await f.call("/api/profile", owner, {displayName: "사진 사용자", avatarLabel: "MW", avatarColor: "#427f80"});
  const result = await upload(owner); assert.equal(result.status, 200);
  const photo = (await result.json()).user;
  assert.match(photo.avatarUrl, new RegExp(`^/api/avatars/${owner.id}/[a-f0-9-]{36}$`));
  assert.equal(photo.avatarLabel, "MW"); assert.equal(photo.avatarColor, "#427f80");
  assert.equal((await f.call("/api/session", owner)).data.user.avatarUrl, photo.avatarUrl);
  assert.equal((await f.call("/api/session", member)).data.user.avatarUrl, null);
  assert.equal((await fetch(f.app.url + photo.avatarUrl)).status, 401);
  const read = await fetch(f.app.url + photo.avatarUrl, {headers: {cookie: member.cookie}});
  assert.equal(read.status, 200); assert.equal(read.headers.get("content-type"), "image/png");
  assert.equal(read.headers.get("x-content-type-options"), "nosniff"); assert.match(read.headers.get("cache-control"), /no-store/);
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), bytes);
  const file = join(f.dir, "avatars", photo.avatarUrl.split("/").at(-1));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const room = await f.room(owner); await f.joinRoom(owner, member, room.id); await f.send(owner, room.id, "사진 확인");
  const conversation = (await f.call(`/api/rooms/${room.id}`, member)).data;
  assert.equal(conversation.members.find(item => item.id === owner.id).avatarUrl, photo.avatarUrl);
  assert.equal(conversation.messages[0].avatarUrl, photo.avatarUrl); assert.equal(conversation.messages[0].avatarLabel, "MW");
  for (const [path, type] of [["media/agent/idle-poster.jpg", "image/jpeg"], ["media/agent/idle-poster.webp", "image/webp"]]) {
    const replacement = await upload(owner, await readFile(new URL("../public/" + path, import.meta.url)), type);
    assert.equal(replacement.status, 200); assert.notEqual((await replacement.json()).user.avatarUrl, photo.avatarUrl);
    assert.equal((await readdir(join(f.dir, "avatars"))).length, 1);
  }
  assert.equal((await fetch(f.app.url + photo.avatarUrl, {headers: {cookie: owner.cookie}})).status, 404);
  assert.equal((await fetch(f.app.url + "/api/profile/avatar", {method: "DELETE", headers: {cookie: owner.cookie}})).status, 403);
  const removed = await fetch(f.app.url + "/api/profile/avatar", {method: "DELETE", headers: {cookie: owner.cookie, "x-csrf-token": owner.csrf}});
  assert.equal(removed.status, 200); assert.equal((await removed.json()).user.avatarUrl, null);
  assert.deepEqual(await readdir(join(f.dir, "avatars")), []);
});

test("private rooms offer an explicit empty shared copy with isolated tools and real multi-user conversation", async t => {
  const f = await fixture(t), owner = await f.register("sharing_owner"), member = await f.register("sharing_member", owner);
  const source = await f.personal(owner);
  assert.equal(source.sharing.canInvite, false); assert.equal(source.sharing.canCreateSharedCopy, true);
  await f.send(owner, source.id, "PRIVATE_HISTORY_MARKER");
  const path = `/api/rooms/${source.id}/shared-copy`;
  assert.equal((await f.call(path, member, {confirmed: true, includeHistory: false})).status, 404);
  assert.equal((await f.call(path, owner, {includeHistory: false})).status, 400);
  assert.equal((await f.call(path, owner, {confirmed: true, includeHistory: false}, false)).status, 403);
  const copy = await f.call(path, owner, {confirmed: true, includeHistory: false}); assert.equal(copy.status, 201);
  const id = copy.data.room.id;
  assert.equal(copy.data.room.personal, false); assert.equal(copy.data.room.sharing.canInvite, true);
  assert.equal((await f.call(`/api/rooms/${id}`, owner)).data.messages.length, 0);
  assert.equal((await f.call(`/api/rooms/${source.id}`, owner)).data.messages[0].text, "PRIVATE_HISTORY_MARKER");
  await f.joinRoom(owner, member, id);
  assert.equal((await f.call(`/api/rooms/${source.id}`, member)).status, 404);
  assert.equal((await f.call(`/api/rooms/${id}/invites`, member, {})).status, 403);
  await f.send(owner, id, "첫 번째 참여자"); await f.send(member, id, "두 번째 참여자");
  const conversation = (await f.call(`/api/rooms/${id}`, member)).data;
  assert.equal(conversation.members.length, 2); assert.deepEqual(conversation.messages.map(item => item.text), ["첫 번째 참여자", "두 번째 참여자"]);
  await f.send(owner, id, "shared bot request", {botIds: ["bot-analyst"]});
  const response = await fetch(`${f.app.url}/api/rooms/${id}/progress`, {headers: {cookie: owner.cookie}}); await response.text();
  const request = f.calls.find(item => item.isolation?.roomId === id && item.isolation?.botId !== "title");
  assert.ok(request); assert.deepEqual(request.toolDefinitions.map(tool=>tool.function.name), ["create_drawing"]); assert.equal(typeof request.browser, "function");
  await assert.rejects(request.browser("read_connected_service", {id:"mail",action:"list"}), error=>error.status===403);
  assert.doesNotMatch(request.user, /PRIVATE_HISTORY_MARKER/); assert.match(request.system, /공동 대화에서는 개인 메일과 캘린더를 조회하지 않습니다/);
});

test("copying private history is explicit and attachments are scoped to the new shared room", async t => {
  const f = await fixture(t), owner = await f.register("history_owner"), member = await f.register("history_member", owner);
  const source = await f.personal(owner);
  const bytes = Buffer.from("OggSreviewed shared attachment");
  const form = new FormData(); form.append("file", new Blob([bytes], {type: "audio/ogg"}), "note.ogg");
  const upload = await fetch(`${f.app.url}/api/rooms/${source.id}/attachments`, {method: "POST", headers: {cookie: owner.cookie, "x-csrf-token": owner.csrf}, body: form});
  assert.equal(upload.status, 201); const attachment = (await upload.json()).attachment;
  await f.send(owner, source.id, "선택해서 공유한 내용", {attachmentIds: [attachment.id]});
  const copy = (await f.call(`/api/rooms/${source.id}/shared-copy`, owner, {confirmed: true, includeHistory: true})).data.room;
  await f.joinRoom(owner, member, copy.id);
  const copied = (await f.call(`/api/rooms/${copy.id}`, member)).data.messages;
  assert.equal(copied[0].text, "선택해서 공유한 내용"); assert.notEqual(copied[0].attachments[0].id, attachment.id);
  assert.equal((await fetch(f.app.url + attachment.url, {headers: {cookie: member.cookie}})).status, 404);
  const read = await fetch(f.app.url + copied[0].attachments[0].url, {headers: {cookie: member.cookie}});
  assert.equal(read.status, 200); assert.deepEqual(Buffer.from(await read.arrayBuffer()), bytes);
});

test("forking at a message excludes future messages, attachments, and summaries", async t => {
  const f = await fixture(t), owner = await f.register("fork_owner"), outsider = await f.register("fork_outsider", owner);
  const source = await f.room(owner), other = await f.room(owner);
  const first = await f.send(owner, source.id, "FIRST_MARKER"), second = await f.send(owner, source.id, "FUTURE_MARKER");
  const foreign = await f.send(owner, other.id, "FOREIGN_MARKER");
  const future = f.app.db.prepare("SELECT rowid FROM messages WHERE id=?").get(second.messageId);
  f.app.db.prepare("INSERT INTO settings VALUES(?,?)").run("context:" + source.id, JSON.stringify({summary: "FUTURE_SUMMARY_MARKER", through: future.rowid}));
  const forkPath = `/api/rooms/${source.id}/fork`;
  assert.equal((await f.call(forkPath, outsider, {throughMessageId: first.messageId})).status, 404);
  for (const value of ["", foreign.messageId, randomUUID(), null]) assert.equal((await f.call(forkPath, owner, {throughMessageId: value})).status, 400);
  const created = await f.call(forkPath, owner, {throughMessageId: first.messageId}); assert.equal(created.status, 201);
  const child = (await f.call(`/api/rooms/${created.data.room.id}`, owner)).data;
  assert.deepEqual(child.messages.map(item => item.text), ["FIRST_MARKER"]); assert.equal(child.context.compacted, false); assert.equal(child.members.length, 1);
  assert.equal(f.app.db.prepare("SELECT value FROM settings WHERE key=?").get("context:" + child.room.id), undefined);
  const latest = await f.call(forkPath, owner, {throughMessageId: second.messageId});
  assert.equal((await f.call(`/api/rooms/${latest.data.room.id}`, owner)).data.context.compacted, true);
  assert.equal((await f.call(`/api/rooms/${source.id}`, owner)).data.messages.length, 2);
});

test("optimistic sends reconcile by a stable message id and own-account nonce only", async t => {
  const f = await fixture(t), owner = await f.register("nonce_owner"), member = await f.register("nonce_member", owner), room = await f.room(owner);
  await f.joinRoom(owner, member, room.id);
  const first = await f.send(owner, room.id, "message", {clientNonce: "same-request"});
  const retry = await f.send(owner, room.id, "message", {clientNonce: "same-request"});
  assert.match(first.messageId, /^[a-f0-9-]{36}$/); assert.equal(retry.messageId, first.messageId);
  const own = (await f.call(`/api/rooms/${room.id}`, owner)).data.messages;
  assert.equal(own.length, 1); assert.equal(own[0].clientNonceHash, createHash("sha256").update(owner.id + ":same-request").digest("hex"));
  assert.equal(Object.hasOwn((await f.call(`/api/rooms/${room.id}`, member)).data.messages[0], "clientNonceHash"), false);
});
