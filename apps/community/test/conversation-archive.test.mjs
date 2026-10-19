import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startCommunity } from '../server.mjs';

const DAY = 24 * 60 * 60 * 1000;
async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'community-archive-'));
  const app = await startCommunity({ dataDir: dir, port: 0, env: { COMMUNITY_BOOTSTRAP_TOKEN: 'bootstrap' },
    llm: { complete: async () => 'SendMessage: {"content":"완료"}' } });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  async function call(path, auth, body, options = {}) {
    const response = await fetch(app.url + path, {
      method: options.method || (body === undefined ? 'GET' : 'POST'),
      headers: { 'content-type': 'application/json', ...(auth ? { cookie: auth.cookie,
        ...(options.csrf === false ? {} : { 'x-csrf-token': auth.csrf }) } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
    return { status: response.status, data, response };
  }
  async function register(username, owner) {
    const inviteToken = owner ? (await call('/api/admin/invites', owner, {})).data.token : 'bootstrap';
    const result = await call('/api/register', null, { username, displayName: username, password: 'archive-fixture-password', inviteToken });
    assert.equal(result.status, 201);
    return { id: result.data.user.id, csrf: result.data.csrfToken, cookie: result.response.headers.get('set-cookie').split(';')[0] };
  }
  async function room(owner) {
    const result = await call('/api/rooms', owner, { name: 'Archive fixture' });
    assert.equal(result.status, 201);
    return result.data.room.id;
  }
  async function joinRoom(owner, member, id) {
    const invite = await call(`/api/rooms/${id}/invites`, owner, {});
    assert.equal(invite.status, 201);
    assert.equal((await call('/api/rooms/join', member, { token: invite.data.token })).status, 200);
  }
  const key = (user, id) => `room-ui:${user.id}:${id}`;
  const read = (user, id) => JSON.parse(app.db.prepare('SELECT value FROM settings WHERE key=?').get(key(user, id))?.value || '{}');
  const write = (user, id, value) => app.db.prepare('INSERT OR REPLACE INTO settings(key,value) VALUES(?,?)').run(key(user, id), JSON.stringify(value));
  function age(id, users) {
    const old = Date.now() - 15 * DAY;
    app.db.prepare('UPDATE rooms SET created_at=? WHERE id=?').run(old, id);
    app.db.prepare('UPDATE messages SET created_at=? WHERE room_id=?').run(old, id);
    for (const user of users) write(user, id, { ...read(user, id), lastTouchedAt: old });
    return old;
  }
  return { app, call, register, room, joinRoom, read, write, age };
}

test('room listing archives old conversations per user while explicit opening protects only its actor', async t => {
  const f = await fixture(t), owner = await f.register('archive_owner'), member = await f.register('archive_member', owner);
  const room = await f.room(owner);
  await f.joinRoom(owner, member, room);
  const message = randomUUID();
  f.app.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)').run(message, room, 'human', owner.id, 'Owner', 'Keep this history', null, Date.now());
  f.age(room, [owner, member]);
  const beforeTouch = Date.now();
  assert.deepEqual((await f.call(`/api/rooms/${room}/touch`, owner, {})).data, { ok: true });
  const ownerList = await f.call('/api/rooms', owner);
  assert.equal(ownerList.status, 200);
  assert.notEqual(ownerList.data.rooms.find(item => item.id === room).archived, true);
  assert.ok(f.read(owner, room).lastTouchedAt >= beforeTouch);
  assert.notEqual(f.read(member, room).archived, true);
  const memberList = await f.call('/api/rooms', member);
  assert.equal(memberList.status, 200);
  assert.equal(memberList.data.rooms.find(item => item.id === room).archived, true);
  assert.equal(f.read(member, room).archiveReason, 'inactive');
  assert.notEqual(f.read(owner, room).archived, true);
  const history = await f.call(`/api/rooms/${room}`, member);
  assert.equal(history.status, 200);
  assert.equal(history.data.messages[0].id, message);
  assert.equal(history.data.messages[0].text, 'Keep this history');
});

test('polling conversation, progress, activity and room lists never extends inactivity', async t => {
  const f = await fixture(t), owner = await f.register('archive_polling'), room = await f.room(owner);
  const old = f.age(room, [owner]);
  for (let pass = 0; pass < 2; pass++) {
    for (const path of [`/api/rooms/${room}`, `/api/rooms/${room}/progress`, '/api/rooms/activity'])
      assert.equal((await f.call(path, owner)).status, 200);
    assert.equal(f.read(owner, room).lastTouchedAt, old);
  }
  const listed = await f.call('/api/rooms', owner);
  assert.equal(listed.status, 200);
  assert.equal(listed.data.rooms.find(item => item.id === room).archived, true);
  const archivedAt = f.read(owner, room).archivedAt;
  await f.call('/api/rooms', owner);
  await f.call(`/api/rooms/${room}`, owner);
  assert.equal(f.read(owner, room).lastTouchedAt, old);
  assert.equal(f.read(owner, room).archivedAt, archivedAt);
});

test('restoring and changing preferences preserve unknown metadata and grant fresh activity', async t => {
  const f = await fixture(t), owner = await f.register('archive_restore'), room = await f.room(owner);
  f.write(owner, room, { color: '#aabbcc', futureSetting: { keep: ['one', 'two'] } });
  f.age(room, [owner]);
  await f.call('/api/rooms', owner);
  assert.equal(f.read(owner, room).archived, true);
  const beforeRestore = Date.now();
  const restored = await f.call(`/api/rooms/${room}/preferences`, owner, { archived: false });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.archived, false);
  assert.equal(f.read(owner, room).archiveReason, undefined);
  assert.equal(f.read(owner, room).archivedAt, undefined);
  assert.ok(f.read(owner, room).lastTouchedAt >= beforeRestore);
  assert.equal(f.read(owner, room).color, '#aabbcc');
  assert.deepEqual(f.read(owner, room).futureSetting, { keep: ['one', 'two'] });
  assert.notEqual((await f.call('/api/rooms', owner)).data.rooms.find(item => item.id === room).archived, true);
  const changed = await f.call(`/api/rooms/${room}/preferences`, owner, { color: '#123456' });
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.data.futureSetting, { keep: ['one', 'two'] });
  assert.ok(changed.data.lastTouchedAt >= beforeRestore);
});

test('touch requires authentication, CSRF and current membership, and cannot restore archived rooms', async t => {
  const f = await fixture(t), owner = await f.register('archive_access'), outsider = await f.register('archive_outsider', owner);
  const room = await f.room(owner), path = `/api/rooms/${room}/touch`;
  f.age(room, [owner]);
  const before = f.read(owner, room);
  assert.equal((await f.call(path, null, {})).status, 401);
  assert.equal((await f.call(path, owner, {}, { csrf: false })).status, 403);
  assert.equal((await f.call(path, outsider, {})).status, 404);
  assert.deepEqual(f.read(owner, room), before);
  assert.deepEqual(f.read(outsider, room), {});
  await f.call('/api/rooms', owner);
  assert.equal((await f.call(path, owner, {})).status, 200);
  assert.equal(f.read(owner, room).archived, true);
});

test('pinned conversations remain active and edits and sent messages refresh explicit use', async t => {
  const f = await fixture(t), owner = await f.register('archive_actions');
  const pinned = await f.room(owner), edited = await f.room(owner), sent = await f.room(owner);
  for (const id of [pinned, edited, sent]) f.age(id, [owner]);
  f.write(owner, pinned, { ...f.read(owner, pinned), pinned: true });
  const beforeActions = Date.now();
  const renamed = await f.call(`/api/rooms/${edited}`, owner, { name: 'Keep working here' }, { method: 'PATCH' });
  assert.equal(renamed.status, 200);
  assert.ok(f.read(owner, edited).lastTouchedAt >= beforeActions);
  const message = await f.call(`/api/rooms/${sent}/messages`, owner, { text: 'Continue work', botIds: [], clientNonce: randomUUID() });
  assert.equal(message.status, 202);
  assert.ok(f.read(owner, sent).lastTouchedAt >= beforeActions);
  const list = await f.call('/api/rooms', owner);
  for (const id of [pinned, edited, sent]) assert.notEqual(list.data.rooms.find(item => item.id === id).archived, true);
});
