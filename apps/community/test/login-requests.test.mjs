import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLoginRequests, loginOrigin } from '../login-requests.mjs';

const USER = '11111111-1111-4111-8111-111111111111', OTHER = '22222222-2222-4222-8222-222222222222';
const ROOM = '33333333-3333-4333-8333-333333333333', SECOND_ROOM = '44444444-4444-4444-8444-444444444444';
const SECRET = ' private-fixture-password ', USERNAME = 'fixture.private@example.com';
const target = { userId: USER, roomId: ROOM, origin: 'https://accounts.example.com', tabRef: 'server-captured-tab', siteLabel: 'Example' };
const save = { action: 'save', username: USERNAME, password: SECRET, label: '내 계정', sharedDeviceConfirmed: true };
async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'login-requests-')), calls = [], authorizations = [];
  const options = { dataDir, authorize: async binding => authorizations.push(binding), fill: async input => { await input.assertAuthorized(); calls.push(input); }, ...overrides };
  const hub = createLoginRequests(options);
  t.after(async () => { hub.close(); await rm(dataDir, { recursive: true, force: true }); });
  return { hub, dataDir, calls, authorizations, options };
}
const noSecrets = value => {
  const encoded = JSON.stringify(value);
  assert.ok(!encoded.includes(SECRET), 'password must never be public');
  assert.ok(!encoded.includes(USERNAME), 'full username must never be public');
  assert.ok(!encoded.includes(target.tabRef), 'internal browser target must never be public');
};

test('login targets require a public-shaped exact HTTPS origin, not paths or credential URLs', () => {
  assert.equal(loginOrigin('https://ACCOUNTS.example.com:443/'), target.origin);
  for (const value of ['http://example.com', 'https://127.0.0.1', 'https://[::1]', 'https://localhost',
    'https://host.local', 'https://host.internal', 'https://accounts.example.com/login', 'https://accounts.example.com/?secret=1',
    'https://accounts.example.com/#secret', 'https://user:secret@example.com', 'https://example.com.']) {
    assert.throws(() => loginOrigin(value), { code: 'LOGIN_INPUT_INVALID' });
  }
});

test('requests are actor-owned, room-bound, deduplicated and contain no credential or tab identifiers', async t => {
  const f = await fixture(t), pending = await f.hub.request(target);
  assert.deepEqual(Object.keys(pending).sort(), ['expiresAt', 'id', 'origin', 'roomId', 'siteLabel', 'status']);
  assert.equal(pending.status, 'pending'); noSecrets(pending);
  assert.equal((await f.hub.request(target)).id, pending.id);
  assert.deepEqual(await f.hub.list(OTHER), []);
  await assert.rejects(f.hub.get(OTHER, pending.id), { code: 'LOGIN_REQUEST_NOT_FOUND' });
  await assert.rejects(f.hub.resolve(OTHER, pending.id, save), { code: 'LOGIN_REQUEST_NOT_FOUND' });
  await assert.rejects(f.hub.cancel(OTHER, pending.id), { code: 'LOGIN_REQUEST_NOT_FOUND' });
  assert.ok(f.authorizations.every(binding => binding.userId === USER && binding.roomId === ROOM));
});

test('a newly captured target replaces the same room pending request without accumulating choosers', async t => {
  const f = await fixture(t), previous = await f.hub.request(target);
  const next = await f.hub.request({ ...target, tabRef: 'new-server-tab', origin: 'https://other.example.com' });
  assert.notEqual(next.id, previous.id);
  await assert.rejects(f.hub.get(USER, previous.id), { code: 'LOGIN_REQUEST_NOT_FOUND' });
  assert.deepEqual((await f.hub.list(USER)).map(request => request.id), [next.id]);
  const otherRoom = await f.hub.request({ ...target, roomId: SECOND_ROOM });
  assert.equal((await f.hub.list(USER)).length, 2);
  assert.equal((await f.hub.get(USER, otherRoom.id)).roomId, SECOND_ROOM);
});

test('encrypted accounts survive restart, expose only masked metadata and are available in another owned room', async t => {
  const f = await fixture(t), pending = await f.hub.request(target);
  const result = await f.hub.resolve(USER, pending.id, save);
  assert.equal(result.status, 'filled'); noSecrets(result);
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].password, SECRET);
  assert.deepEqual([f.calls[0].userId, f.calls[0].roomId, f.calls[0].origin, f.calls[0].tabRef], [USER, ROOM, target.origin, target.tabRef]);
  const disk = await readFile(join(f.dataDir, 'browser-login-vault.json'), 'utf8');
  assert.ok(!disk.includes(SECRET)); assert.ok(!disk.includes(USERNAME)); assert.ok(!disk.includes(target.origin));
  for (const filename of ['browser-login-vault.json', 'browser-login-vault.key'])
    assert.equal((await stat(join(f.dataDir, filename))).mode & 0o777, 0o600);
  assert.deepEqual(await f.hub.list(USER), []);
  f.hub.close();
  const reopened = createLoginRequests(f.options); t.after(() => reopened.close());
  const second = await reopened.request({ ...target, roomId: SECOND_ROOM });
  const view = await reopened.get(USER, second.id); noSecrets(view);
  assert.equal(view.accounts.length, 1); assert.equal(view.accounts[0].label, '내 계정');
  assert.equal(view.accounts[0].maskedUsername, 'fi••••@example.com');
  await reopened.resolve(USER, second.id, { accountId: view.accounts[0].id, sharedDeviceConfirmed: true });
  assert.equal(f.calls.at(-1).roomId, SECOND_ROOM);
});

test('stored accounts cannot cross owners, hosts, subdomains or ports', async t => {
  const f = await fixture(t), pending = await f.hub.request(target);
  await f.hub.resolve(USER, pending.id, save);
  const accountId = (await f.hub.get(USER, pending.id)).accounts[0].id;
  for (const next of [{ userId: OTHER }, { origin: 'https://example.com' }, { origin: 'https://accounts.example.com:8443' }, { origin: 'https://evil.example.com' }]) {
    const request = await f.hub.request({ ...target, ...next });
    assert.deepEqual((await f.hub.get(next.userId || USER, request.id)).accounts, []);
    await assert.rejects(f.hub.resolve(next.userId || USER, request.id, { accountId, sharedDeviceConfirmed: true }), { code: 'LOGIN_ACCOUNT_NOT_FOUND' });
  }
  assert.equal(f.calls.length, 1);
});

test('shared computer confirmation is literal true and clients cannot override the captured destination', async t => {
  const f = await fixture(t), pending = await f.hub.request(target);
  for (const sharedDeviceConfirmed of [undefined, false, 'true', 1])
    await assert.rejects(f.hub.resolve(USER, pending.id, { ...save, sharedDeviceConfirmed }), { code: 'LOGIN_SHARED_DEVICE_CONFIRMATION' });
  await assert.rejects(f.hub.resolve(USER, pending.id, { ...save, origin: 'https://evil.example.com' }), { code: 'LOGIN_INPUT_INVALID' });
  await assert.rejects(f.hub.resolve(USER, pending.id, { ...save, userId: OTHER }), { code: 'LOGIN_INPUT_INVALID' });
  assert.equal(f.calls.length, 0);
  assert.equal((await f.hub.get(USER, pending.id)).status, 'pending');
});

test('authorization is rechecked for request, listing, resolution and immediately before private typing', async t => {
  let allowed = true;
  const f = await fixture(t, {
    authorize: async () => { if (!allowed) throw Object.assign(new Error('No longer authorized'), { status: 403 }); },
    fill: async input => { allowed = false; await input.assertAuthorized(); assert.fail('must not type after revocation'); },
  });
  const pending = await f.hub.request(target);
  await assert.rejects(f.hub.resolve(USER, pending.id, save), { status: 403, code: 'LOGIN_FILL_FAILED' });
  await assert.rejects(f.hub.get(USER, pending.id), { status: 403 });
  await assert.rejects(f.hub.request({ ...target, roomId: SECOND_ROOM }), { status: 403 });
  assert.deepEqual(await f.hub.list(USER), []);
});

test('concurrent resolutions and completed request replays cannot type twice', async t => {
  let release, entered;
  const ready = new Promise(resolve => { entered = resolve; }), wait = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { fill: async input => { entered(); await wait; await input.assertAuthorized(); } });
  const pending = await f.hub.request(target), first = f.hub.resolve(USER, pending.id, save);
  await ready;
  await assert.rejects(f.hub.resolve(USER, pending.id, save), { code: 'LOGIN_REQUEST_USED' });
  await assert.rejects(f.hub.request({ ...target, tabRef: 'new-tab-during-fill' }), { code: 'LOGIN_REQUEST_BUSY' });
  assert.equal((await f.hub.get(USER, pending.id)).status, 'filling');
  release(); assert.equal((await first).status, 'filled');
  await assert.rejects(f.hub.resolve(USER, pending.id, save), { code: 'LOGIN_REQUEST_USED' });
});

test('the original HTTP session is rechecked after queueing and an aborted request never fills', async t => {
  let sessionActive = true, release, entered, checks = 0, writes = 0;
  const ready = new Promise(resolve => { entered = resolve; }), wait = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { fill: async input => { entered(); await wait; await input.assertAuthorized(); writes++; } });
  const pending = await f.hub.request(target);
  const resolving = f.hub.resolve(USER, pending.id, save, { assertAuthorized: async () => {
    checks++;
    if (!sessionActive) throw Object.assign(new Error('Expired session'), { status: 403 });
  } });
  await ready; sessionActive = false; release();
  await assert.rejects(resolving, { code: 'LOGIN_FILL_FAILED' });
  assert.equal(writes, 0); assert.equal(checks, 2);
  const another = await f.hub.request(target), controller = new AbortController(); controller.abort();
  await assert.rejects(f.hub.resolve(USER, another.id, save, { signal: controller.signal }), { code: 'LOGIN_FILL_FAILED' });
  assert.equal(writes, 0);
});

test('only the fixed next-step hint may accompany a completed private fill', async t => {
  const f = await fixture(t, { fill: async () => ({ nextStep: 'continue', username: USERNAME, password: SECRET, rawHtml: SECRET }) });
  const pending = await f.hub.request(target), result = await f.hub.resolve(USER, pending.id, save);
  assert.equal(result.nextStep, 'continue'); noSecrets(result);
  assert.equal('rawHtml' in result, false);
});

test('expiry prevents later access or typing while cancellation aborts an in-flight browser fill', async t => {
  let time = 1000, release, entered, privateInput;
  const ready = new Promise(resolve => { entered = resolve; }), wait = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { now: () => time, ttlMs: 1000, fill: async input => { privateInput = input; entered(); await wait; await input.assertAuthorized(); } });
  const expired = await f.hub.request(target); time += 1001;
  await assert.rejects(f.hub.get(USER, expired.id), { code: 'LOGIN_REQUEST_NOT_FOUND' });
  await assert.rejects(f.hub.resolve(USER, expired.id, save), { code: 'LOGIN_REQUEST_NOT_FOUND' });
  const pending = await f.hub.request(target), resolving = f.hub.resolve(USER, pending.id, save);
  await ready; assert.equal((await f.hub.cancel(USER, pending.id)).status, 'cancelled');
  assert.equal(privateInput.signal.aborted, true); release();
  await assert.rejects(resolving, { code: 'LOGIN_FILL_FAILED' });
  assert.equal((await f.hub.get(USER, pending.id)).status, 'cancelled');
});

test('browser failures and callback return values cannot leak credentials into public responses', async t => {
  const f = await fixture(t, { fill: async () => { throw new Error('Could not type ' + SECRET + USERNAME); } });
  const pending = await f.hub.request(target);
  await assert.rejects(f.hub.resolve(USER, pending.id, save), error => {
    assert.equal(error.code, 'LOGIN_FILL_FAILED'); noSecrets({ message: error.message }); return true;
  });
  noSecrets(await f.hub.get(USER, pending.id));
  const safe = createLoginRequests({ ...f.options, fill: async () => ({ password: SECRET, username: USERNAME }) });
  t.after(() => safe.close());
  const other = await safe.request(target);
  noSecrets(await safe.resolve(USER, other.id, save));
});

test('a corrupt vault fails closed without replacing credentials, and closing aborts pending operations', async t => {
  const f = await fixture(t), pending = await f.hub.request(target);
  await f.hub.resolve(USER, pending.id, save); f.hub.close();
  await assert.rejects(f.hub.request(target), { code: 'LOGIN_UNAVAILABLE' });
  const before = await readFile(join(f.dataDir, 'browser-login-vault.json'));
  await writeFile(join(f.dataDir, 'browser-login-vault.key'), Buffer.alloc(32));
  assert.throws(() => createLoginRequests(f.options), { code: 'LOGIN_VAULT_UNAVAILABLE' });
  assert.deepEqual(await readFile(join(f.dataDir, 'browser-login-vault.json')), before);
});
