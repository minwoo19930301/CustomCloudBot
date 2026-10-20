import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {startCommunity} from '../server.mjs';
import {createConversationDeletion} from '../conversation-delete.mjs';
import {MONITOR_ROOM} from '../monitor.mjs';

async function fixture(t, complete) {
  const dir = await mkdtemp(join(tmpdir(), 'conversation-delete-'));
  const options = {dataDir: dir, port: 0, env: {COMMUNITY_BOOTSTRAP_TOKEN: 'delete-test'},
    llm: {complete: complete || (async () => 'SendMessage: {"content":"완료했습니다."}')}};
  let app = await startCommunity(options);
  t.after(async () => {await app.close(); await rm(dir, {recursive: true, force: true});});
  async function call(path, auth, body, {csrf = true, method = body === undefined ? 'GET' : 'POST'} = {}) {
    const response = await fetch(app.url + path, {method, headers: {
      'content-type': 'application/json', ...(auth ? {cookie: auth.cookie, ...(csrf ? {'x-csrf-token': auth.csrf} : {})} : {}),
    }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000)});
    return {status: response.status, data: await response.json(), response};
  }
  async function register(username, admin) {
    const inviteToken = admin ? (await call('/api/admin/invites', admin, {})).data.token : 'delete-test';
    const result = await call('/api/register', null, {username, displayName: username, password: 'conversation-delete-password', inviteToken});
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return {id: result.data.user.id, csrf: result.data.csrfToken, cookie: result.response.headers.get('set-cookie').split(';', 1)[0]};
  }
  async function room(auth, name = '삭제할 대화') {
    const result = await call('/api/rooms', auth, {name});
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data.room.id;
  }
  async function share(owner, roomId, member) {
    const invitation = await call(`/api/rooms/${roomId}/invites`, owner, {});
    assert.equal(invitation.status, 201, JSON.stringify(invitation.data));
    const joined = await call('/api/rooms/join', member, {token: invitation.data.token});
    assert.equal(joined.status, 200, JSON.stringify(joined.data));
  }
  async function send(auth, roomId, text, extra = {}) {
    const result = await call(`/api/rooms/${roomId}/messages`, auth, {text, botIds: [], clientNonce: randomUUID(), ...extra});
    assert.equal(result.status, 202, JSON.stringify(result.data));
    return result.data;
  }
  async function upload(auth, roomId, name) {
    const form = new FormData();
    form.append('file', new Blob(['OggS ' + name], {type: 'audio/ogg'}), name);
    const response = await fetch(app.url + `/api/rooms/${roomId}/attachments`, {method: 'POST',
      headers: {cookie: auth.cookie, 'x-csrf-token': auth.csrf}, body: form, signal: AbortSignal.timeout(10000)});
    const data = await response.json();
    assert.equal(response.status, 201, JSON.stringify(data));
    return data.attachment;
  }
  const preview = async auth => {
    const result = await call('/api/conversations/delete-preview', auth);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    return result.data;
  };
  return {get app() {return app;}, get db() {return app.db;}, dir, call, register, room, share, send, upload, preview,
    deleteAll: (auth, fingerprint) => call('/api/conversations/delete-all', auth, {fingerprint}),
    restart: async () => {await app.close(); app = await startCommunity(options);}};
}

function put(db, key, value) {
  db.prepare('INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
    .run(key, typeof value === 'string' ? value : JSON.stringify(value));
}

function seedRoomRecords(db, roomId, userId) {
  const now = Date.now(), routineId = randomUUID(), runId = randomUUID(), queueId = randomUUID(), mailId = randomUUID();
  db.prepare('INSERT INTO routines(id,owner_id,room_id,title,prompt,schedule,model,effort,enabled,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(routineId, userId, roomId, '보존된 루틴', '루틴의 비공개 요청', '{}', '', '', 0, now, now);
  db.prepare('INSERT INTO routine_runs(id,routine_id,occurrence_key,kind,scheduled_at,status,payload,created_at,ready_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(runId, routineId, randomUUID(), 'manual', now, 'succeeded', '{}', now, now + 86400000);
  db.prepare('INSERT INTO message_queue(id,room_id,author_id,author,nonce,payload,state,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(queueId, roomId, userId, '사용자', randomUUID(), JSON.stringify({text: '예전 대기 메시지', attachmentIds: []}), 'cancelled', now);
  db.prepare('INSERT INTO notification_events(id,user_id,room_id,kind,title,created_at,email_request_id,email_next_attempt_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(randomUUID(), userId, roomId, 'bot', '알림', now, randomUUID(), now + 86400000);
  db.prepare('INSERT INTO model_usage_totals(room_id,requests,input_tokens,output_tokens,last_json) VALUES(?,?,?,?,?)')
    .run(roomId, 2, 123, 456, '{}');
  db.prepare('INSERT INTO mail_agent_jobs(id,user_id,sender,subject,received_at,received_ms,status,room_id,reply_text,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
    .run(mailId, userId, 'sender@example.test', '보존할 수신 메일', new Date(now).toISOString(), now, 'replied', roomId, '삭제할 대화 응답', now, now);
  return {routineId, runId, queueId, mailId};
}

test('deletion endpoints require authentication and CSRF, and a preview cannot authorize another account', async t => {
  const f = await fixture(t), owner = await f.register('delete_owner'), other = await f.register('delete_other', owner);
  const ownRoom = await f.room(owner), foreignRoom = await f.room(other, '다른 사용자의 대화');
  const snapshot = await f.preview(owner);
  assert.equal((await f.call('/api/conversations/delete-preview')).status, 401);
  assert.equal((await f.call('/api/conversations/delete-all', null, {fingerprint: snapshot.fingerprint})).status, 401);
  assert.equal((await f.call('/api/conversations/delete-all', owner, {fingerprint: snapshot.fingerprint}, {csrf: false})).status, 403);
  assert.equal((await f.deleteAll({...owner, csrf: 'wrong'}, snapshot.fingerprint)).status, 403);
  assert.equal((await f.call('/api/conversations/delete-all', owner, {})).status, 400);
  assert.equal((await f.deleteAll(other, snapshot.fingerprint)).status, 409);
  assert.ok(f.db.prepare('SELECT 1 FROM rooms WHERE id=?').get(ownRoom));
  assert.ok(f.db.prepare('SELECT 1 FROM rooms WHERE id=?').get(foreignRoom));
  const deleted = await f.deleteAll(owner, snapshot.fingerprint);
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.deepEqual(deleted.data.roomIds, [ownRoom]);
  assert.equal(f.db.prepare('SELECT 1 FROM rooms WHERE id=?').get(ownRoom), undefined);
  assert.equal((await f.call(`/api/rooms/${foreignRoom}`, other)).status, 200);
});

test('delete-all removes owned active and archived chats and their records, preserving foreign forks, files and account state after restart', async t => {
  const f = await fixture(t), owner = await f.register('delete_records_owner'), other = await f.register('delete_records_other', owner);
  const active = await f.room(owner, '공동 대화'), archived = await f.room(owner, '보관된 대화'), foreign = await f.room(other, '다른 소유자의 대화');
  await f.share(owner, active, other);
  await f.share(other, foreign, owner);
  const sharedFile = await f.upload(owner, active, 'shared.ogg');
  const sourceMessage = await f.send(owner, active, '원본 대화', {attachmentIds: [sharedFile.id]});
  const forked = await f.call(`/api/rooms/${active}/fork`, other, {});
  assert.equal(forked.status, 201, JSON.stringify(forked.data));
  const fork = forked.data.room.id;
  const retainedAttachment = f.db.prepare('SELECT * FROM attachments WHERE room_id=?').get(fork);
  assert.notEqual(retainedAttachment.id, sharedFile.id);
  assert.equal(retainedAttachment.path, f.db.prepare('SELECT path FROM attachments WHERE id=?').get(sharedFile.id).path);
  const uniqueFile = await f.upload(owner, archived, 'unreferenced.ogg');
  await f.send(owner, archived, '보관된 메시지', {attachmentIds: [uniqueFile.id]});
  const uniquePath = f.db.prepare('SELECT path FROM attachments WHERE id=?').get(uniqueFile.id).path;
  const ownRecords = [seedRoomRecords(f.db, active, owner.id), seedRoomRecords(f.db, archived, owner.id)];
  const foreignRecords = seedRoomRecords(f.db, foreign, other.id);
  for (const id of [active, archived]) {
    for (const prefix of ['context:', 'manual-title:', 'pending-title:', 'private-fork:', 'mail-room:', 'fork-readonly:']) put(f.db, prefix + id, '{}');
    put(f.db, 'room-ui:' + owner.id + ':' + id, {archived: id === archived});
    put(f.db, 'room-ui:' + other.id + ':' + id, {pinned: true});
    put(f.db, 'fork-readonly:' + other.id + ':' + id, '1');
  }
  put(f.db, 'lineage:' + archived, {parent: active, parents: [active], operation: 'fork'});
  put(f.db, 'context:' + foreign, {summary: '외부 대화 맥락', through: 0});
  const foreignLineage = JSON.stringify({parent: fork, parents: [fork], operation: 'fork', throughMessageId: 'foreign-cutoff'});
  put(f.db, 'lineage:' + foreign, foreignLineage);
  put(f.db, 'sidebar:' + owner.id, {roomOrder: [active, foreign, archived, fork], collapsed: false});
  put(f.db, 'profile-label:' + owner.id, '나');
  put(f.db, 'notification-preferences:' + owner.id, {sound: false});
  f.db.prepare('INSERT INTO notification_preferences(user_id,sound_enabled,email_enabled) VALUES(?,0,0)').run(owner.id);
  f.db.prepare('INSERT INTO model_usage_providers(provider,key_slot,last_json) VALUES(?,?,?)').run('example', 0, '{}');
  f.db.prepare('INSERT INTO push_subscriptions(endpoint,user_id,session_hash,room_id,p256dh,auth,created_at) VALUES(?,?,?,?,?,?,?)')
    .run('https://push.example.test/retained', owner.id, 'session', active, 'key', 'auth', Date.now());
  f.db.prepare('INSERT INTO message_origins(message_id,origin_id) VALUES(?,?)').run(sourceMessage.messageId, 'historical-origin');
  const preview = await f.preview(owner);
  assert.deepEqual(new Set(preview.rooms.map(room => room.id)), new Set([active, archived]));
  assert.equal(preview.count, 2);
  assert.equal(preview.messages, 2);
  assert.equal(preview.attachments, 2);
  assert.equal(preview.shared, 1);
  const foreignCounts = Object.fromEntries(['rooms', 'messages', 'attachments', 'room_members', 'room_invites', 'routines', 'message_queue', 'notification_events', 'model_usage_totals'].map(table => {
    const column = table === 'rooms' ? 'id' : 'room_id';
    return [table, f.db.prepare(`SELECT count(*) n FROM ${table} WHERE ${column} IN (?,?)`).get(foreign, fork).n];
  }));
  const result = await f.deleteAll(owner, preview.fingerprint);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.deleted, 2);
  assert.equal(result.data.pendingFiles, 0);
  for (const table of ['rooms', 'messages', 'attachments', 'room_members', 'room_invites', 'routines', 'message_queue', 'notification_events', 'model_usage_totals']) {
    const column = table === 'rooms' ? 'id' : 'room_id';
    assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table} WHERE ${column} IN (?,?)`).get(active, archived).n, 0, table);
    assert.equal(f.db.prepare(`SELECT count(*) n FROM ${table} WHERE ${column} IN (?,?)`).get(foreign, fork).n, foreignCounts[table], 'preserved ' + table);
  }
  assert.equal(f.db.prepare('SELECT count(*) n FROM message_attachments WHERE attachment_id IN (?,?)').get(sharedFile.id, uniqueFile.id).n, 0);
  assert.equal(f.db.prepare('SELECT 1 FROM message_origins WHERE message_id=?').get(sourceMessage.messageId), undefined);
  for (const record of ownRecords) {
    assert.equal(f.db.prepare('SELECT 1 FROM routine_runs WHERE id=?').get(record.runId), undefined);
    const mail = f.db.prepare('SELECT room_id,reply_text,status FROM mail_agent_jobs WHERE id=?').get(record.mailId);
    assert.deepEqual({...mail}, {room_id: null, reply_text: null, status: 'replied'}, 'mail delivery deduplication survives without deleted chat contents');
  }
  assert.ok(f.db.prepare('SELECT 1 FROM routine_runs WHERE id=?').get(foreignRecords.runId));
  assert.ok(f.db.prepare('SELECT 1 FROM message_attachments WHERE attachment_id=?').get(retainedAttachment.id));
  assert.equal(f.db.prepare('SELECT room_id FROM push_subscriptions WHERE endpoint=?').get('https://push.example.test/retained').room_id, null);
  assert.equal(f.db.prepare('SELECT value FROM settings WHERE key=?').get('lineage:' + foreign).value, foreignLineage);
  assert.equal(f.db.prepare('SELECT 1 FROM settings WHERE key=?').get('lineage:' + fork), undefined, 'foreign fork loses only the deleted parent edge');
  const settings = f.db.prepare('SELECT key FROM settings').all().map(row => row.key);
  assert.ok(!settings.some(key => key.endsWith(active) || key.endsWith(archived)), 'no deleted-room settings remain');
  assert.deepEqual(JSON.parse(f.db.prepare('SELECT value FROM settings WHERE key=?').get('sidebar:' + owner.id).value).roomOrder, [foreign, fork]);
  assert.equal(f.db.prepare('SELECT value FROM settings WHERE key=?').get('profile-label:' + owner.id).value, '나');
  assert.equal(f.db.prepare('SELECT sound_enabled FROM notification_preferences WHERE user_id=?').get(owner.id).sound_enabled, 0);
  assert.equal(f.db.prepare('SELECT count(*) n FROM model_usage_providers').get().n, 1);
  assert.equal((await readFile(retainedAttachment.path)).toString(), 'OggS shared.ogg');
  await assert.rejects(readFile(uniquePath), {code: 'ENOENT'});
  assert.equal((await f.call(`/api/rooms/${active}`, owner)).status, 404);
  assert.equal((await f.call(`/api/rooms/${fork}`, other)).status, 200);
  await f.restart();
  assert.equal((await f.preview(owner)).count, 0);
  assert.equal((await f.call(`/api/rooms/${fork}`, other)).status, 200);
  assert.equal((await readFile(retainedAttachment.path)).toString(), 'OggS shared.ogg');
  assert.ok(f.db.prepare('SELECT 1 FROM sessions WHERE user_id=?').get(owner.id), 'deleting conversations does not log the account out');
});

for (const mutation of ['message', 'attachment', 'rename', 'membership']) {
  test(`a ${mutation} change after preview rejects deletion without removing any room`, async t => {
    const f = await fixture(t), owner = await f.register('stale_owner'), other = await f.register('stale_other', owner);
    const roomId = await f.room(owner), snapshot = await f.preview(owner);
    if (mutation === 'message') await f.send(owner, roomId, '미리보기 이후 새 메시지');
    if (mutation === 'attachment') await f.upload(owner, roomId, 'later.ogg');
    if (mutation === 'rename') assert.equal((await f.call(`/api/rooms/${roomId}`, owner, {name: '확인 후 변경한 제목'}, {method: 'PATCH'})).status, 200);
    if (mutation === 'membership') await f.share(owner, roomId, other);
    const result = await f.deleteAll(owner, snapshot.fingerprint);
    assert.equal(result.status, 409, JSON.stringify(result.data));
    assert.equal((await f.call(`/api/rooms/${roomId}`, owner)).status, 200);
    const fresh = await f.preview(owner);
    assert.notEqual(fresh.fingerprint, snapshot.fingerprint);
    assert.equal((await f.deleteAll(owner, fresh.fingerprint)).status, 200);
  });
}

test('HTTP deletion rejects live generation and queued work, then succeeds after the run ends', async t => {
  const pending = Promise.withResolvers(), started = Promise.withResolvers();
  const f = await fixture(t, async () => {started.resolve(); return pending.promise;});
  const owner = await f.register('busy_delete_owner'), roomId = await f.room(owner, '진행 중인 작업');
  try {
    await f.send(owner, roomId, '처리 중', {botIds: ['bot-analyst']});
    await started.promise;
    const snapshot = await f.preview(owner);
    const busy = await f.deleteAll(owner, snapshot.fingerprint);
    assert.equal(busy.status, 409, JSON.stringify(busy.data));
    const queued = await f.send(owner, roomId, '다음 작업', {botIds: [], queueIfBusy: true});
    assert.equal(queued.queued, true);
    assert.equal((await f.deleteAll(owner, (await f.preview(owner)).fingerprint)).status, 409);
    assert.ok(f.db.prepare('SELECT 1 FROM rooms WHERE id=?').get(roomId));
  } finally {pending.resolve('SendMessage: {"content":"완료했습니다."}');}
  const deadline = Date.now() + 5000;
  let current;
  do {
    current = await f.call(`/api/rooms/${roomId}`, owner);
    if (!current.data.busy && !current.data.queue.length) break;
    await delay(25);
  } while (Date.now() < deadline);
  assert.equal(current.data.busy, false, 'generation has completed');
  assert.equal(current.data.queue.length, 0, 'the waiting message has been processed');
  const result = await f.deleteAll(owner, (await f.preview(owner)).fingerprint);
  assert.equal(result.status, 200, JSON.stringify(result.data));
});

test('helper rejects running routines and mail delivery, rolls back failures, and never deletes the excluded monitor', async t => {
  const f = await fixture(t), owner = await f.register('guard_delete_owner');
  const first = await f.room(owner), second = await f.room(owner);
  const records = seedRoomRecords(f.db, first, owner.id), removed = [];
  f.db.prepare('INSERT OR IGNORE INTO rooms(id,name,description,owner_id,created_at) VALUES(?,?,?,?,?)').run(MONITOR_ROOM, '서버 모니터', '', owner.id, Date.now());
  const helper = createConversationDeletion({db: f.db, mediaDir: join(f.dir, 'media'), excludedRoomIds: [MONITOR_ROOM], onDeleted: id => removed.push(id)});
  const snapshot = helper.preview(owner.id);
  assert.deepEqual(new Set(snapshot.rooms.map(room => room.id)), new Set([first, second]));
  f.db.prepare("UPDATE routine_runs SET status='running' WHERE id=?").run(records.runId);
  await assert.rejects(helper.removeAll(owner.id, snapshot.fingerprint), {status: 409});
  f.db.prepare("UPDATE routine_runs SET status='succeeded' WHERE id=?").run(records.runId);
  for (const status of ['running', 'reply_pending', 'reply_sending']) {
    f.db.prepare('UPDATE mail_agent_jobs SET status=? WHERE id=?').run(status, records.mailId);
    await assert.rejects(helper.removeAll(owner.id, snapshot.fingerprint), {status: 409});
    assert.equal(f.db.prepare('SELECT count(*) n FROM rooms WHERE id IN (?,?)').get(first, second).n, 2);
  }
  f.db.prepare("UPDATE mail_agent_jobs SET status='replied' WHERE id=?").run(records.mailId);
  // Both room IDs are generated UUIDs, not request input. Abort the final room
  // delete to prove earlier data and settings removals share one transaction.
  const last = [first, second].sort().at(-1);
  f.db.exec(`CREATE TRIGGER reject_last_room BEFORE DELETE ON rooms WHEN OLD.id='${last}' BEGIN SELECT RAISE(ABORT,'injected delete failure'); END;`);
  await assert.rejects(helper.removeAll(owner.id, snapshot.fingerprint), /injected delete failure/);
  assert.equal(f.db.prepare('SELECT count(*) n FROM rooms WHERE id IN (?,?)').get(first, second).n, 2);
  assert.ok(f.db.prepare('SELECT 1 FROM routine_runs WHERE id=?').get(records.runId));
  assert.deepEqual(removed, []);
  f.db.exec('DROP TRIGGER reject_last_room');
  assert.equal((await helper.removeAll(owner.id, snapshot.fingerprint)).deleted, 2);
  assert.deepEqual(new Set(removed), new Set([first, second]));
  assert.ok(f.db.prepare('SELECT 1 FROM rooms WHERE id=?').get(MONITOR_ROOM));
});

test('deletion does not unlink paths outside the media directory and reports pending cleanup', async t => {
  const f = await fixture(t), owner = await f.register('path_delete_owner'), roomId = await f.room(owner);
  const outside = join(f.dir, 'keep-account-data');
  await writeFile(outside, 'outside media storage');
  f.db.prepare('INSERT INTO attachments(id,room_id,uploader_id,name,mime,kind,size,path,created_at) VALUES(?,?,?,?,?,?,?,?,?)')
    .run(randomUUID(), roomId, owner.id, 'outside.ogg', 'audio/ogg', 'audio', 20, outside, Date.now());
  const result = await f.deleteAll(owner, (await f.preview(owner)).fingerprint);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.pendingFiles, 1);
  assert.equal(await readFile(outside, 'utf8'), 'outside media storage');
});

test('a post-commit cleanup callback failure still unlinks media and reports committed deletion', async t => {
  const f = await fixture(t), owner = await f.register('cleanup_delete_owner'), roomId = await f.room(owner);
  const attachment = await f.upload(owner, roomId, 'cleanup.ogg');
  const path = f.db.prepare('SELECT path FROM attachments WHERE id=?').get(attachment.id).path;
  const helper = createConversationDeletion({db: f.db, mediaDir: join(f.dir, 'media'), onDeleted: () => {throw new Error('closed event stream');}});
  const result = await helper.removeAll(owner.id, helper.preview(owner.id).fingerprint);
  assert.equal(result.deleted, 1);
  assert.equal(result.pendingCleanup, 1);
  assert.equal(result.pendingFiles, 0);
  assert.equal(f.db.prepare('SELECT 1 FROM rooms WHERE id=?').get(roomId), undefined);
  await assert.rejects(readFile(path), {code: 'ENOENT'});
});
