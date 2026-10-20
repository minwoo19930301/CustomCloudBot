import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startCommunity} from '../server.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'request-rate-http-'));
  const app = await startCommunity({dataDir: dir, port: 0, env: {COMMUNITY_BOOTSTRAP_TOKEN: 'rate-test'}});
  t.after(async () => {await app.close(); await rm(dir, {recursive: true, force: true});});
  async function call(path, auth, body, {csrf = true} = {}) {
    const response = await fetch(app.url + path, {method: body === undefined ? 'GET' : 'POST',
      headers: {'content-type': 'application/json', ...(auth ? {cookie: auth.cookie, ...(csrf ? {'x-csrf-token': auth.csrf} : {})} : {})},
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000)});
    return {status: response.status, data: await response.json(), response};
  }
  async function register(username, admin) {
    const inviteToken = admin ? (await call('/api/admin/invites', admin, {})).data.token : 'rate-test';
    const result = await call('/api/register', null, {username, displayName: username, password: 'request-rate-test-password', inviteToken});
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return {id: result.data.user.id, csrf: result.data.csrfToken, cookie: result.response.headers.get('set-cookie').split(';')[0]};
  }
  async function room(auth) {
    const result = await call('/api/rooms', auth, {name: '요청 한도 검증'});
    assert.equal(result.status, 201, JSON.stringify(result.data));
    return result.data.room.id;
  }
  return {app, call, register, room};
}

test('split-view polling cannot consume chat/deletion capacity, but its shared per-user budget remains bounded', {timeout: 20000}, async t => {
  const f = await fixture(t), owner = await f.register('rate_owner'), other = await f.register('rate_other', owner);
  const first = await f.room(owner), second = await f.room(owner);
  const paths = [`/api/rooms/${first}`, `/api/rooms/${second}`, '/api/rooms/activity', '/api/notifications?after=0', '/api/sidebar', '/api/notifications/settings'];
  assert.equal((await f.call(paths[0])).status, 401, 'the read budget does not bypass authentication');
  async function poll(count) {
    for (let offset = 0; offset < count; offset += paths.length) {
      const responses = await Promise.all(paths.slice(0, Math.min(paths.length, count - offset)).map(path => f.call(path, owner)));
      for (const result of responses) assert.equal(result.status, 200, JSON.stringify(result.data));
    }
  }
  await poll(240); // More reads than the previous 180/minute shared allowance.
  const send = () => f.call(`/api/rooms/${first}/messages`, owner, {text: '자동 새로고침 이후 전송', botIds: [], clientNonce: randomUUID()});
  assert.equal((await send()).status, 202);
  await poll(360);
  assert.equal((await f.call(`/api/rooms/${first}`, owner)).status, 429, 'the 601st read is limited');
  assert.equal((await f.call('/api/sidebar', owner)).status, 429, 'switching read endpoints does not reset the budget');
  assert.equal((await f.call('/api/notifications', other)).status, 200, 'another account has its own budget');
  assert.equal((await f.call(`/api/rooms/${first}/messages`, owner, {text: 'CSRF 거부', botIds: [], clientNonce: randomUUID()}, {csrf: false})).status, 403);
  assert.equal((await send()).status, 202, 'even an exhausted poll budget leaves mutation capacity available');
  const preview = await f.call('/api/conversations/delete-preview', owner);
  assert.equal(preview.status, 200);
  const deleted = await f.call('/api/conversations/delete-all', owner, {fingerprint: preview.data.fingerprint});
  assert.equal(deleted.status, 200, JSON.stringify(deleted.data));
  assert.equal(deleted.data.deleted, 2);
  assert.equal(f.app.db.prepare('SELECT count(*) n FROM rooms WHERE id IN (?,?)').get(first, second).n, 0);
});

test('the default mutation budget is still 180 and does not consume the read allowance', {timeout: 20000}, async t => {
  const f = await fixture(t), owner = await f.register('mutation_rate_owner');
  await f.room(owner); // One authenticated default-bucket request.
  for (let index = 0; index < 179; index++) {
    const result = await f.call('/api/notifications/settings', owner, {soundEnabled: index % 2 === 0});
    assert.equal(result.status, 200, `default request ${index + 2}: ${JSON.stringify(result.data)}`);
  }
  assert.equal((await f.call('/api/notifications/settings', owner, {soundEnabled: true})).status, 429);
  assert.equal((await f.call('/api/notifications/settings', owner)).status, 200, 'GET polling and POST settings share a path, not a budget');
});
