import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createConversationActivity, INACTIVE_CONVERSATION_MS } from '../conversation-activity.mjs';

const DAY = 24 * 60 * 60 * 1000;
function fixture(t, options = {}) {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  db.exec(`CREATE TABLE rooms(id TEXT PRIMARY KEY,created_at INTEGER NOT NULL);
    CREATE TABLE room_members(room_id TEXT NOT NULL,user_id TEXT NOT NULL,PRIMARY KEY(room_id,user_id));
    CREATE TABLE messages(id TEXT PRIMARY KEY,room_id TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE TABLE attachments(id TEXT PRIMARY KEY,room_id TEXT NOT NULL);
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
  let time = 30 * DAY;
  const store = createConversationActivity({ db, now: () => time, ...options });
  const set = (user, room, value) => db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(`room-ui:${user}:${room}`, JSON.stringify(value));
  const read = (user, room) => JSON.parse(db.prepare('SELECT value FROM settings WHERE key=?').get(`room-ui:${user}:${room}`)?.value || '{}');
  const room = (id, created = DAY, users = ['alice']) => {
    db.prepare('INSERT INTO rooms VALUES(?,?)').run(id, created);
    for (const user of users) db.prepare('INSERT INTO room_members VALUES(?,?)').run(id, user);
  };
  const message = (id, roomId, created) => db.prepare('INSERT INTO messages VALUES(?,?,?)').run(id, roomId, created);
  return { db, store, set, read, room, message, at: value => { time = value; } };
}

test('archives at exactly fourteen inactive days, preserving preferences and all conversation data', t => {
  const f = fixture(t);
  f.room('old');
  f.message('message', 'old', 2 * DAY);
  f.db.prepare('INSERT INTO attachments VALUES(?,?)').run('photo', 'old');
  const prior = { color: '#123456', groupId: 'group', pinned: false, futureSetting: { version: 2 } };
  f.set('alice', 'old', prior);
  f.at(2 * DAY + INACTIVE_CONVERSATION_MS - 1);
  assert.deepEqual(f.store.archiveInactive('alice'), []);
  assert.deepEqual(f.read('alice', 'old'), prior);
  f.at(2 * DAY + INACTIVE_CONVERSATION_MS);
  assert.deepEqual(f.store.archiveInactive('alice'), ['old']);
  assert.deepEqual(f.read('alice', 'old'), { ...prior, archived: true, archivedAt: 16 * DAY, archiveReason: 'inactive' });
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM messages').get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM attachments').get().n, 1);
  assert.equal(f.db.prepare('SELECT COUNT(*) n FROM rooms').get().n, 1);
  assert.deepEqual(f.store.archiveInactive('alice'), []);
});

test('new rooms and recent messages provide a migration baseline without polling activity', t => {
  const f = fixture(t);
  f.room('new', 29 * DAY);
  f.room('recent');
  f.message('latest', 'recent', 29 * DAY);
  assert.deepEqual(f.store.archiveInactive('alice'), []);
  f.at(42 * DAY);
  assert.deepEqual(f.store.archiveInactive('alice'), []);
  assert.deepEqual(f.read('alice', 'recent'), {});
  f.at(43 * DAY);
  assert.deepEqual(f.store.archiveInactive('alice').sort(), ['new', 'recent']);
});

test('explicit use is per-user, monotonic, and does not restore a manually archived room', t => {
  const f = fixture(t);
  f.room('shared', DAY, ['alice', 'bob']);
  f.set('alice', 'shared', { color: '#aabbcc', archived: false, custom: true });
  assert.equal(f.store.touch('alice', 'shared'), true);
  f.at(29 * DAY);
  assert.equal(f.store.touch('alice', 'shared'), true);
  assert.deepEqual(f.read('alice', 'shared'), { color: '#aabbcc', archived: false, custom: true, lastTouchedAt: 30 * DAY });
  assert.deepEqual(f.store.archiveInactive('alice'), []);
  assert.deepEqual(f.store.archiveInactive('bob'), ['shared']);
  assert.equal(f.read('bob', 'shared').archived, true);
  f.store.touch('bob', 'shared');
  assert.equal(f.read('bob', 'shared').archived, true);
  assert.equal(f.store.touch('outsider', 'shared'), false);
  assert.deepEqual(f.read('outsider', 'shared'), {});
});

test('explicit restore receives a fresh fourteen-day grace period', t => {
  const f = fixture(t);
  f.room('restored');
  f.store.archiveInactive('alice');
  f.set('alice', 'restored', { ...f.read('alice', 'restored'), archived: false });
  f.store.touch('alice', 'restored');
  assert.equal(f.read('alice', 'restored').archiveReason, undefined);
  assert.equal(f.read('alice', 'restored').archivedAt, undefined);
  assert.deepEqual(f.store.archiveInactive('alice'), []);
  f.at(44 * DAY - 1);
  assert.deepEqual(f.store.archiveInactive('alice'), []);
  f.at(44 * DAY);
  assert.deepEqual(f.store.archiveInactive('alice'), ['restored']);
});

test('pinned, running, queued, and excluded rooms remain active until exemptions end', t => {
  const busy = new Set(['running', 'queued']);
  const f = fixture(t, { isBusy: id => busy.has(id), excludedRoomIds: ['monitor'] });
  for (const id of ['pinned', 'running', 'queued', 'monitor', 'ordinary']) f.room(id);
  f.set('alice', 'pinned', { pinned: true });
  assert.deepEqual(f.store.archiveInactive('alice'), ['ordinary']);
  busy.clear();
  assert.deepEqual(f.store.archiveInactive('alice').sort(), ['queued', 'running']);
  assert.equal(f.read('alice', 'pinned').archived, undefined);
  assert.equal(f.read('alice', 'monitor').archived, undefined);
});

test('enabled and pending routines protect their owner only, including tables created after the activity store', t => {
  const f = fixture(t);
  f.db.exec(`CREATE TABLE routines(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,room_id TEXT NOT NULL,enabled INTEGER NOT NULL,deleted_at INTEGER);
    CREATE TABLE routine_runs(id TEXT PRIMARY KEY,routine_id TEXT NOT NULL,status TEXT NOT NULL);`);
  for (const id of ['scheduled', 'paused', 'deleted', 'queued', 'running']) f.room(id, DAY, ['alice', 'bob']);
  const routine = f.db.prepare('INSERT INTO routines VALUES(?,?,?,?,?)');
  routine.run('one', 'alice', 'scheduled', 1, null);
  routine.run('two', 'alice', 'paused', 0, null);
  routine.run('three', 'alice', 'deleted', 1, DAY);
  routine.run('four', 'alice', 'queued', 0, null);
  routine.run('five', 'alice', 'running', 0, null);
  f.db.prepare('INSERT INTO routine_runs VALUES(?,?,?)').run('queue', 'four', 'queued');
  f.db.prepare('INSERT INTO routine_runs VALUES(?,?,?)').run('run', 'five', 'running');
  assert.deepEqual(f.store.archiveInactive('alice').sort(), ['deleted', 'paused']);
  assert.deepEqual(f.store.archiveInactive('bob').sort(), ['deleted', 'paused', 'queued', 'running', 'scheduled']);
});

test('revoked membership and malformed preferences cannot be overwritten', t => {
  const f = fixture(t);
  f.room('revoked');
  f.room('invalid');
  f.set('alice', 'revoked', { pinned: true });
  f.db.prepare('DELETE FROM room_members WHERE room_id=?').run('revoked');
  f.db.prepare('INSERT INTO settings VALUES(?,?)').run('room-ui:alice:invalid', '{broken');
  assert.equal(f.store.touch('alice', 'revoked'), false);
  assert.equal(f.store.touch('alice', 'invalid'), false);
  assert.deepEqual(f.store.archiveInactive('alice'), []);
  assert.deepEqual(f.read('alice', 'revoked'), { pinned: true });
  assert.equal(f.db.prepare('SELECT value FROM settings WHERE key=?').get('room-ui:alice:invalid').value, '{broken');
});

test('optional authorized room IDs exclude expired access without touching other users', t => {
  const f = fixture(t);
  f.room('accessible');
  f.room('expired');
  f.room('other-user', DAY, ['bob']);
  assert.deepEqual(f.store.archiveInactive('alice', { roomIds: [] }), []);
  assert.deepEqual(f.store.archiveInactive('alice', { roomIds: ['accessible', 'other-user'] }), ['accessible']);
  assert.deepEqual(f.read('alice', 'expired'), {});
  assert.deepEqual(f.read('alice', 'other-user'), {});
});

test('an archive failure rolls back every change and preserves an outer transaction', t => {
  let examined = 0;
  const f = fixture(t, { isBusy: () => { if (++examined === 2) throw new Error('busy lookup failed'); return false; } });
  f.room('first');
  f.room('second');
  f.set('alice', 'first', { custom: 'keep' });
  f.db.exec('BEGIN');
  assert.throws(() => f.store.archiveInactive('alice'), /busy lookup failed/);
  assert.deepEqual(f.read('alice', 'first'), { custom: 'keep' });
  assert.deepEqual(f.read('alice', 'second'), {});
  f.db.exec('ROLLBACK');
});
