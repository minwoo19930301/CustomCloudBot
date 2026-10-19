import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {startCommunity} from "../server.mjs";

async function fixture(t, complete) {
  const dir = await mkdtemp(join(tmpdir(), "fork-branches-")), calls = [];
  const app = await startCommunity({dataDir: dir, port: 0, env: {COMMUNITY_BOOTSTRAP_TOKEN: "bootstrap"}, llm: {
    complete: async request => {calls.push(request); return complete ? complete(request) : 'SendMessage: {"content":"새 가지의 여행 계획"}';},
  }});
  t.after(async () => {await app.close(); await rm(dir, {recursive: true, force: true});});
  async function call(path, auth, body, csrf = true) {
    const response = await fetch(app.url + path, {method: body === undefined ? "GET" : "POST", headers: {
      "content-type": "application/json", ...(auth ? {cookie: auth.cookie, ...(csrf ? {"x-csrf-token": auth.csrf} : {})} : {}),
    }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000)});
    return {status: response.status, data: await response.json(), response};
  }
  async function register(username, admin) {
    const inviteToken = admin ? (await call("/api/admin/invites", admin, {})).data.token : "bootstrap";
    const result = await call("/api/register", null, {username, displayName: username, password: "fork-branches-password", inviteToken});
    assert.equal(result.status, 201);
    return {id: result.data.user.id, csrf: result.data.csrfToken, cookie: result.response.headers.get("set-cookie").split(";", 1)[0]};
  }
  async function room(auth) {const result = await call("/api/rooms", auth, {name: "원본 계획"}); assert.equal(result.status, 201); return result.data.room.id;}
  async function send(auth, id, text, extra = {}) {const result = await call(`/api/rooms/${id}/messages`, auth, {text, botIds: [], clientNonce: randomUUID(), ...extra}); assert.equal(result.status, 202); return result.data.messageId;}
  async function split(auth, id, extra = {}) {const result = await call(`/api/rooms/${id}/fork`, auth, {branching: true, ...extra}); assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data;}
  async function read(auth, id) {return (await call(`/api/rooms/${id}`, auth)).data;}
  async function upload(auth, id, name) {
    const form = new FormData(); form.append("file", new Blob(["OggS " + name], {type: "audio/ogg"}), name);
    const response = await fetch(app.url + `/api/rooms/${id}/attachments`, {method: "POST", headers: {cookie: auth.cookie, "x-csrf-token": auth.csrf}, body: form});
    assert.equal(response.status, 201); return (await response.json()).attachment;
  }
  return {app, db: app.db, calls, call, register, room, send, split, read, upload};
}

test("splitting a message creates two siblings, then adds one at that point while preserving the parent", async t => {
  const f = await fixture(t), owner = await f.register("split_owner"), id = await f.room(owner);
  const first = await f.send(owner, id, "FIRST_POINT"), second = await f.send(owner, id, "LATER_POINT");
  const before = await f.read(owner, id), firstSplit = await f.split(owner, id, {throughMessageId: first});
  assert.equal(firstSplit.initialSplit, true);
  assert.equal(firstSplit.createdRooms.length, 2);
  assert.equal(firstSplit.room.id, firstSplit.createdRooms[1].id);
  assert.deepEqual(firstSplit.branchPoint, {parentId: id, throughMessageId: first});
  assert.deepEqual(firstSplit.createdRooms.map(room => room.name), ["원본 계획 · 가지 1", "원본 계획 · 가지 2"]);
  for (const child of firstSplit.createdRooms) {
    assert.equal(child.pendingTitle, true);
    const data = await f.read(owner, child.id);
    assert.deepEqual(data.messages.map(message => message.text), ["FIRST_POINT"]);
    assert.equal(data.members.length, 1);
  }
  const additional = await f.split(owner, id, {throughMessageId: first});
  assert.equal(additional.initialSplit, false); assert.equal(additional.createdRooms.length, 1);
  assert.equal(additional.room.name, "원본 계획 · 가지 3");
  const latest = await f.split(owner, id);
  assert.equal(latest.createdRooms.length, 2);
  assert.equal(latest.branchPoint.throughMessageId, second);
  assert.equal((await f.split(owner, id, {throughMessageId: second})).createdRooms.length, 1, "explicit and omitted latest cutoff refer to the same point");
  const after = await f.read(owner, id);
  assert.ok(after.room.lastTouchedAt >= before.room.lastTouchedAt);
  assert.deepEqual({...after, room: {...after.room, lastTouchedAt: before.room.lastTouchedAt}}, before);
  const list = (await f.call("/api/rooms", owner)).data;
  const links = list.forks.filter(link => link.parent === id);
  assert.equal(links.length, 6);
  assert.deepEqual(links.map(link => link.branchIndex).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6]);
  assert.equal(links.filter(link => link.throughMessageId === first).length, 3);
  const nested = await f.split(owner, firstSplit.room.id);
  assert.equal(nested.createdRooms.length, 2);
  const nestedLinks = (await f.call("/api/rooms", owner)).data.forks.filter(link => nested.createdRooms.some(room => room.id === link.id));
  assert.ok(nestedLinks.every(link => link.parent === firstSplit.room.id), "splitting a child does not silently reparent it to a sibling");
  await f.send(owner, additional.room.id, "독립적인 여행 일정");
  const titleRequests = f.calls.filter(request => request.isolation?.botId === "title");
  assert.equal(titleRequests.length, 1); assert.equal(titleRequests[0].user, "독립적인 여행 일정");
  assert.equal((await f.read(owner, additional.room.id)).room.pendingTitle, false);
  assert.equal((await f.read(owner, firstSplit.createdRooms[0].id)).room.pendingTitle, true);
});

test("historical splits copy only selected history and attachments; current splits inherit effective summaries", async t => {
  const f = await fixture(t), owner = await f.register("snapshot_owner"), id = await f.room(owner);
  const old = await f.upload(owner, id, "before.ogg"), first = await f.send(owner, id, "VISIBLE_PAST", {attachmentIds: [old.id]});
  const later = await f.upload(owner, id, "after.ogg"), second = await f.send(owner, id, "FUTURE_CONTENT", {attachmentIds: [later.id]});
  const rowid = f.db.prepare("SELECT rowid FROM messages WHERE id=?").get(second).rowid;
  f.db.prepare("INSERT INTO settings VALUES(?,?)").run("context:" + id, JSON.stringify({summary: "FUTURE_SUMMARY", through: rowid}));
  const historical = await f.split(owner, id, {throughMessageId: first}), copied = [];
  for (const child of historical.createdRooms) {
    const data = await f.read(owner, child.id);
    assert.deepEqual(data.messages.map(message => message.text), ["VISIBLE_PAST"]);
    assert.equal(data.context.compacted, false);
    assert.equal(data.messages[0].attachments.length, 1);
    copied.push(data.messages[0].attachments[0].id);
    assert.notEqual(data.messages[0].attachments[0].id, old.id);
    assert.equal(f.db.prepare("SELECT value FROM settings WHERE key=?").get("context:" + child.id), undefined);
  }
  assert.equal(new Set(copied).size, 2, "attachment ids are independent in both children");
  for (const child of (await f.split(owner, id)).createdRooms) {
    const saved = JSON.parse(f.db.prepare("SELECT value FROM settings WHERE key=?").get("context:" + child.id).value);
    assert.equal(saved.summary, "FUTURE_SUMMARY");
    assert.equal((await f.read(owner, child.id)).messages.length, 2);
    assert.equal(saved.through, f.db.prepare("SELECT max(rowid) value FROM messages WHERE room_id=?").get(child.id).value);
  }
  assert.equal((await f.read(owner, id)).messages.length, 2);
});

test("an existing legacy tail fork counts only at its inherited cutoff and legacy callers still create one child", async t => {
  const f = await fixture(t), owner = await f.register("legacy_owner"), id = await f.room(owner);
  const point = await f.send(owner, id, "OLD_TIP");
  const legacy = await f.call(`/api/rooms/${id}/fork`, owner, {});
  assert.equal(legacy.status, 201); assert.deepEqual(Object.keys(legacy.data), ["room"]);
  await f.send(owner, legacy.data.room.id, "CHILD_ONLY");
  assert.equal((await f.split(owner, id, {throughMessageId: point})).createdRooms.length, 1);
  await f.send(owner, id, "NEW_TIP");
  assert.equal((await f.split(owner, id)).createdRooms.length, 2);
  const empty = await f.room(owner);
  assert.equal((await f.split(owner, empty)).createdRooms.length, 2);
  assert.equal((await f.split(owner, empty)).createdRooms.length, 1);
});

test("split counts and membership do not reveal another participant's private forks", async t => {
  const f = await fixture(t), owner = await f.register("privacy_owner"), member = await f.register("privacy_member", owner), outsider = await f.register("privacy_other", owner), id = await f.room(owner);
  const invite = (await f.call(`/api/rooms/${id}/invites`, owner, {})).data.token;
  assert.equal((await f.call("/api/rooms/join", member, {token: invite})).status, 200);
  await f.send(owner, id, "SHARED_POINT");
  const ownersChildren = await f.split(owner, id), membersChildren = await f.split(member, id);
  assert.equal(membersChildren.createdRooms.length, 2);
  assert.deepEqual(membersChildren.createdRooms.map(room => room.name), ["원본 계획 · 가지 1", "원본 계획 · 가지 2"]);
  for (const child of membersChildren.createdRooms) assert.equal((await f.call(`/api/rooms/${child.id}`, owner)).status, 404);
  for (const child of ownersChildren.createdRooms) assert.equal((await f.call(`/api/rooms/${child.id}`, member)).status, 404);
  assert.equal((await f.call(`/api/rooms/${id}/fork`, outsider, {branching: true})).status, 404);
  assert.equal((await f.call(`/api/rooms/${id}/fork`, owner, {branching: true}, false)).status, 403);
  const foreign = await f.room(owner), foreignMessage = await f.send(owner, foreign, "OTHER_ROOM");
  for (const value of [null, "", randomUUID(), foreignMessage]) assert.equal((await f.call(`/api/rooms/${id}/fork`, owner, {branching: true, throughMessageId: value})).status, 400);
  assert.equal((await f.read(owner, id)).members.length, 2);
  const personal = (await f.call("/api/rooms", owner)).data.rooms.find(room => room.personal);
  for (const child of (await f.split(owner, personal.id)).createdRooms) {
    assert.equal(child.personal, true); assert.equal(child.sharing.canInvite, false);
    assert.equal((await f.call(`/api/rooms/${child.id}/invites`, owner, {})).status, 403);
  }
});

test("creating two children is atomic when only one room slot remains", async t => {
  const f = await fixture(t), owner = await f.register("capacity_owner"), id = await f.room(owner);
  await f.send(owner, id, "KEEP_PARENT");
  while (f.db.prepare("SELECT count(*) n FROM rooms WHERE owner_id=?").get(owner.id).n < 19) {
    const extra = randomUUID();
    f.db.prepare("INSERT INTO rooms VALUES(?,?,?,?,?)").run(extra, "saved", "", owner.id, Date.now());
    f.db.prepare("INSERT INTO room_members(room_id,user_id,role) VALUES(?,?,?)").run(extra, owner.id, "owner");
  }
  const tables = ["rooms", "room_members", "messages", "message_origins", "attachments", "settings"];
  const counts = () => Object.fromEntries(tables.map(table => [table, f.db.prepare("SELECT count(*) n FROM " + table).get().n]));
  const before = counts();
  assert.equal((await f.call(`/api/rooms/${id}/fork`, owner, {branching: true})).status, 409);
  assert.deepEqual(counts(), before, "failed split cannot leave the first room or any copied rows behind");
  assert.equal((await f.read(owner, id)).messages[0].text, "KEEP_PARENT");
  assert.equal((await f.call(`/api/rooms/${id}/fork`, owner, {})).status, 201, "single-child legacy API still fits in the remaining slot");
});

test("branching waits for running or queued source work before taking its snapshot", async t => {
  const pending = Promise.withResolvers(), f = await fixture(t, () => pending.promise), owner = await f.register("busy_owner"), id = await f.room(owner);
  try {
    await f.send(owner, id, "RUNNING", {botIds: ["bot-analyst"]});
    const before = f.db.prepare("SELECT count(*) n FROM rooms").get().n;
    assert.equal((await f.call(`/api/rooms/${id}/fork`, owner, {branching: true})).status, 409);
    assert.equal(f.db.prepare("SELECT count(*) n FROM rooms").get().n, before);
  } finally {pending.resolve('SendMessage: {"content":"완료"}');}
});

test("fork and merge refresh their source activity before the next list can auto-archive them", async t => {
  const f = await fixture(t), owner = await f.register("archive_branch_owner"), parent = await f.room(owner), other = await f.room(owner);
  await f.send(owner, parent, "ORIGINAL_HISTORY");
  await f.send(owner, other, "OTHER_HISTORY");
  const age = id => {
    const old = Date.now() - 15 * 86400000;
    f.db.prepare("UPDATE rooms SET created_at=? WHERE id=?").run(old, id);
    f.db.prepare("UPDATE messages SET created_at=? WHERE room_id=?").run(old, id);
    f.db.prepare("INSERT INTO settings VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run("room-ui:" + owner.id + ":" + id, JSON.stringify({lastTouchedAt: old}));
  };
  age(parent);
  const transcript = (await f.read(owner, parent)).messages, beforeFork = Date.now();
  await f.split(owner, parent);
  let listed = (await f.call("/api/rooms", owner)).data.rooms.find(room => room.id === parent);
  assert.notEqual(listed.archived, true);
  assert.ok(listed.lastTouchedAt >= beforeFork);
  assert.deepEqual((await f.read(owner, parent)).messages, transcript);
  age(parent); age(other);
  const originals = await Promise.all([f.read(owner, parent), f.read(owner, other)]), beforeMerge = Date.now();
  assert.equal((await f.call(`/api/rooms/${parent}/merge`, owner, {sourceId: other})).status, 201);
  const rooms = (await f.call("/api/rooms", owner)).data.rooms;
  for (const [index, id] of [parent, other].entries()) {
    listed = rooms.find(room => room.id === id);
    assert.notEqual(listed.archived, true);
    assert.ok(listed.lastTouchedAt >= beforeMerge);
    assert.deepEqual((await f.read(owner, id)).messages, originals[index].messages);
  }
});
