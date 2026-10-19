import test from "node:test";
import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {mkdtemp, rm} from "node:fs/promises";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {startCommunity} from "../server.mjs";

async function fixture(t, complete, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), "fork-branches-")), calls = [];
  const app = await startCommunity({dataDir: dir, port: 0, env: {COMMUNITY_BOOTSTRAP_TOKEN: "bootstrap"}, ...options, llm: {
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

test("every split creates two siblings while preserving the read-only parent's history", async t => {
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
  assert.equal(additional.initialSplit, true); assert.equal(additional.createdRooms.length, 2);
  assert.deepEqual(additional.createdRooms.map(room => room.name), ["원본 계획 · 가지 3", "원본 계획 · 가지 4"]);
  const latest = await f.split(owner, id);
  assert.equal(latest.createdRooms.length, 2);
  assert.equal(latest.branchPoint.throughMessageId, second);
  assert.equal((await f.split(owner, id, {throughMessageId: second})).createdRooms.length, 2, "a repeated cutoff still creates two new children");
  const after = await f.read(owner, id);
  assert.ok(after.room.lastTouchedAt >= before.room.lastTouchedAt);
  assert.equal(after.room.readOnly, true); assert.equal(after.room.readOnlyReason, "forked");
  assert.deepEqual({...after, room: {...after.room, lastTouchedAt: before.room.lastTouchedAt, readOnly: false, readOnlyReason: null}}, before);
  const list = (await f.call("/api/rooms", owner)).data;
  const links = list.forks.filter(link => link.parent === id);
  assert.equal(links.length, 8);
  assert.deepEqual(links.map(link => link.branchIndex).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(links.filter(link => link.throughMessageId === first).length, 4);
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

test("legacy callers still create one writable child while explicit splits always create two", async t => {
  const f = await fixture(t), owner = await f.register("legacy_owner"), id = await f.room(owner);
  const point = await f.send(owner, id, "OLD_TIP");
  const legacy = await f.call(`/api/rooms/${id}/fork`, owner, {});
  assert.equal(legacy.status, 201); assert.deepEqual(Object.keys(legacy.data), ["room"]);
  await f.send(owner, legacy.data.room.id, "CHILD_ONLY");
  await f.send(owner, id, "NEW_TIP");
  assert.equal((await f.split(owner, id, {throughMessageId: point})).createdRooms.length, 2);
  assert.equal((await f.split(owner, id)).createdRooms.length, 2);
  const empty = await f.room(owner);
  assert.equal((await f.split(owner, empty)).createdRooms.length, 2);
  assert.equal((await f.split(owner, empty)).createdRooms.length, 2);
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
  assert.equal((await f.read(owner, id)).room.readOnly, false, "failed split must not lock its source");
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

test("forked sources reject chat, queued chat, uploads, voice and context changes while children stay writable", async t => {
  const f = await fixture(t), owner = await f.register("readonly_owner"), id = await f.room(owner);
  await f.send(owner, id, "KEEP_THIS_HISTORY", {clientNonce:"original"});
  const original = (await f.read(owner, id)).messages, split = await f.split(owner, id);
  assert.equal(split.sourceRoom.readOnly, true); assert.equal(split.sourceRoom.readOnlyReason, "forked");
  assert.ok(split.createdRooms.every(room => room.readOnly === false && room.readOnlyReason === null));
  for (const [path, body] of [
    ["messages", {text:"NO_NEW_CHAT",clientNonce:"blocked",botIds:[]}],
    ["messages", {text:"NO_NEW_QUEUE",clientNonce:"queued",botIds:["bot-analyst"],queueIfBusy:true}],
    ["messages", {text:"model",clientNonce:"models",botIds:[]}],
    ["attachments", {}], ["voice/transcribe", {}], ["compact", {}], ["context-reset", {}],
  ]) {
    const result = await f.call(`/api/rooms/${id}/${path}`, owner, body);
    assert.equal(result.status, 409, path); assert.equal(result.data.code, "ROOM_READ_ONLY", path);
  }
  assert.equal((await f.call(`/api/rooms/${id}/messages`, owner, {text:"KEEP_THIS_HISTORY",clientNonce:"original",botIds:[]})).status, 202, "an accepted message retry remains idempotent");
  assert.deepEqual((await f.read(owner, id)).messages, original);
  const listed = (await f.call("/api/rooms", owner)).data.rooms;
  assert.equal(listed.find(room => room.id === id).readOnly, true);
  await f.send(owner, split.room.id, "CHILD_CONTINUES");
  assert.equal((await f.split(owner, id)).createdRooms.length, 2, "read-only source can be forked repeatedly");
  const merged = await f.call(`/api/rooms/${id}/merge`, owner, {sourceId: split.room.id});
  assert.equal(merged.status, 201); assert.equal(merged.data.room.readOnly, false);
});

test("member forks lock only their actor and pause only that actor's routines; owner forks lock the shared source", async t => {
  const f = await fixture(t), owner = await f.register("readonly_shared_owner"), member = await f.register("readonly_shared_member", owner), id = await f.room(owner);
  const token = (await f.call(`/api/rooms/${id}/invites`, owner, {})).data.token;
  assert.equal((await f.call("/api/rooms/join", member, {token})).status, 200);
  const createRoutine = async actor => {
    const result = await f.call(`/api/rooms/${id}/routines`, actor, {title:"Daily work",prompt:"Continue this session",enabled:true,schedule:{type:"daily",time:"09:00",timezone:"UTC"}});
    assert.equal(result.status, 201); return result.data.routine;
  };
  const ownerRoutine = await createRoutine(owner), memberRoutine = await createRoutine(member);
  const split = await f.split(member, id);
  assert.equal(split.pausedRoutineCount, 1);
  assert.equal((await f.read(member, id)).room.readOnly, true);
  assert.equal((await f.read(owner, id)).room.readOnly, false);
  const routineRow = routine => f.db.prepare("SELECT enabled,next_run_at,deleted_at FROM routines WHERE id=?").get(routine.id);
  assert.equal(routineRow(memberRoutine).enabled, 0); assert.equal(routineRow(memberRoutine).next_run_at, null);
  assert.equal(routineRow(ownerRoutine).enabled, 1);
  assert.equal((await f.call(`/api/rooms/${id}/routines`, member)).status, 200, "paused routine history remains readable");
  const blockedRun = await f.call(`/api/routines/${memberRoutine.id}/run`, member, {requestId:"readonly"});
  assert.equal(blockedRun.status, 409); assert.equal(blockedRun.data.code, "ROOM_READ_ONLY");
  const blockedChat = await f.call(`/api/rooms/${id}/messages`, member, {text:"NO_MEMBER_CHAT",clientNonce:"member",botIds:[]});
  assert.equal(blockedChat.data.code, "ROOM_READ_ONLY");
  await f.send(owner, id, "OWNER_CAN_CONTINUE");
  const ownerSplit = await f.split(owner, id);
  assert.equal(ownerSplit.pausedRoutineCount, 1);
  assert.equal(routineRow(ownerRoutine).enabled, 0); assert.equal(routineRow(ownerRoutine).deleted_at, null);
  assert.equal((await f.read(owner, id)).room.readOnly, true);
  assert.equal((await f.read(member, id)).room.readOnly, true);
  assert.equal((await f.read(member, split.room.id)).room.readOnly, false);
});

test("a source locked during awaited model discovery cannot accept a late message", async t => {
  const discovery = Promise.withResolvers(), entered = Promise.withResolvers();
  const f = await fixture(t, undefined, {providerPool:{configured:false,providers:[],choose:()=>null,
    ensureModels:async()=>{entered.resolve();await discovery.promise;}}});
  const owner = await f.register("readonly_race_owner"), id = await f.room(owner);
  const pending = f.call(`/api/rooms/${id}/messages`, owner, {text:"LATE_MESSAGE",clientNonce:"race",botIds:["bot-analyst"]});
  await entered.promise;
  try {
    await f.split(owner, id);
  } finally {discovery.resolve();}
  const result = await pending;
  assert.equal(result.status, 409); assert.equal(result.data.code, "ROOM_READ_ONLY");
  assert.equal((await f.read(owner, id)).messages.length, 0);
  assert.equal(f.calls.length, 0);
});
