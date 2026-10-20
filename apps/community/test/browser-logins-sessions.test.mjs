import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startCommunity} from '../server.mjs';

const target = {origin:'https://accounts.example.com', tabRef:'private-fixture-tab', siteLabel:'Example'};
const credentials = {action:'save', username:'vault-owner@example.com', password:'synthetic-private-password', label:'Work account', sharedDeviceConfirmed:true};
const answer = content => 'SendMessage: ' + JSON.stringify({type:'text', content});
function deferred() {
  let resolve;
  const promise = new Promise(done => {resolve = done;});
  return {promise, resolve};
}

async function fixture(t, {beforeFill, afterFill, complete, nextStep = 'submit'} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'browser-login-api-'));
  const captures = [], fills = [], modelCalls = [], runtime = {target:{...target}};
  let app;
  const browserTools = {
    configured:() => true,
    captureLoginTarget:async (roomId, {signal} = {}) => {
      signal?.throwIfAborted();
      captures.push(roomId);
      return {...runtime.target};
    },
    fillLogin:async args => {
      try {
        await beforeFill?.(args);
        args.signal?.throwIfAborted();
        // Match the browser queue boundary: authorization is rechecked just
        // before any synthetic field write, never only when HTTP begins.
        await args.authorize();
        args.signal?.throwIfAborted();
        fills.push({roomId:args.roomId, origin:args.origin, tabRef:args.tabRef, username:args.username, password:args.password});
        return {status:'filled', nextStep, ignoredSecret:'must-not-leave-browser'};
      } finally { afterFill?.(); }
    },
    close:async () => {},
  };
  const start = extra => startCommunity({
    dataDir:dir, port:0, env:{COMMUNITY_BOOTSTRAP_TOKEN:'bootstrap', ...extra}, browserTools,
    providerPool:{configured:false, providers:[], choose:() => null, ensureModels:async () => {}},
    llm:{name:'private-login-fixture', complete:async request => {
      if (request.isolation?.botId === 'title') return answer('로그인 테스트');
      modelCalls.push(request);
      return complete ? complete(request) : answer('Vault 계정 선택을 기다립니다.');
    }},
  });
  t.after(async () => {await app?.close(); await rm(dir, {recursive:true, force:true});});
  app = await start({});
  const call = async (path, {auth, body, method = body === undefined ? 'GET' : 'POST', csrf = true, signal = AbortSignal.timeout(10_000)} = {}) => {
    const response = await fetch(app.url + path, {
      method, headers:{'content-type':'application/json', ...(auth ? {cookie:auth.cookie, ...(csrf ? {'x-csrf-token':auth.csrf} : {})} : {})},
      body:body === undefined ? undefined : JSON.stringify(body), signal,
    });
    return {status:response.status, response, data:await response.json().catch(() => null)};
  };
  const register = async (username, admin) => {
    const inviteToken = admin ? (await call('/api/admin/invites', {auth:admin, body:{}})).data.token : 'bootstrap';
    const result = await call('/api/register', {body:{username, displayName:username, password:'login-http-fixture-password', inviteToken}});
    assert.equal(result.status, 201);
    return {id:result.data.user.id, cookie:result.response.headers.get('set-cookie').split(';')[0], csrf:result.data.csrfToken};
  };
  const owner = await register('owner'), member = await register('member', owner);
  await app.close();
  app = await start({COMMUNITY_HOST_ADMIN_SOCKET:'/tmp/nonexistent-login-fixture.sock', COMMUNITY_HOST_ADMIN_USER_IDS:owner.id});
  const room = async auth => {
    const result = await call('/api/rooms', {auth, body:{name:'Vault login test'}});
    assert.equal(result.status, 201); return result.data.room.id;
  };
  const roomId = await room(owner);
  const request = async (id = roomId) => {
    const result = await call(`/api/rooms/${id}/browser-login`, {auth:owner, body:{}});
    assert.equal(result.status, 201, JSON.stringify(result.data)); return result.data;
  };
  const finish = async id => {
    const response = await fetch(app.url + `/api/rooms/${id}/progress`, {headers:{cookie:owner.cookie}, signal:AbortSignal.timeout(10_000)});
    assert.equal(response.status, 200);
    assert.match(await response.text(), /event: done/);
  };
  return {get app() {return app;}, dir, call, owner, member, roomId, room, request, finish, captures, fills, modelCalls, runtime};
}

test('login HTTP routes enforce owner allowlist, room membership, writable state and CSRF', async t => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/browser-logins')).status, 401);
  assert.equal((await f.call('/api/browser-logins', {auth:f.member})).status, 403);
  // Being an application administrator alone must not grant private Vault access.
  f.app.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(f.member.id);
  assert.equal((await f.call('/api/browser-logins', {auth:f.member})).status, 403);
  assert.equal((await f.call(`/api/rooms/${f.roomId}/browser-login`, {auth:f.member, body:{}})).status, 403);
  const otherRoom = await f.room(f.member);
  assert.equal((await f.call(`/api/rooms/${otherRoom}/browser-login`, {auth:f.owner, body:{}})).status, 404);
  assert.equal((await f.call(`/api/rooms/${f.roomId}/browser-login`, {auth:f.owner, body:{}, csrf:false})).status, 403);
  assert.equal(f.captures.length, 0);
  const request = await f.request(), path = `/api/browser-logins/${request.id}`;
  assert.equal((await f.call(path, {auth:f.member})).status, 403);
  assert.equal((await f.call(path + '/resolve', {auth:f.owner, body:credentials, csrf:false})).status, 403);
  assert.equal((await f.call(path, {auth:f.owner, method:'DELETE', csrf:false})).status, 403);
  assert.equal(f.fills.length, 0);
  assert.equal((await f.call(`/api/rooms/${f.roomId}/fork`, {auth:f.owner, body:{branching:true}})).status, 201);
  assert.equal((await f.call(`/api/rooms/${f.roomId}/browser-login`, {auth:f.owner, body:{}})).status, 409);
  assert.equal((await f.call(path + '/resolve', {auth:f.owner, body:credentials})).status, 409);
  assert.equal(f.fills.length, 0);
  assert.equal(f.captures.length, 1);
});

test('manual requests capture the actual tab and reject HTTP target overrides', async t => {
  const f = await fixture(t), route = `/api/rooms/${f.roomId}/browser-login`;
  for (const body of [{origin:'https://other.example'}, {tabRef:'other'}, {url:'https://other.example/login'}, {roomId:randomUUID()}]) {
    assert.equal((await f.call(route, {auth:f.owner, body})).status, 400);
  }
  assert.equal(f.captures.length, 0);
  const request = await f.request();
  assert.equal(request.origin, target.origin);
  assert.equal(request.tabRef, undefined);
  const list = await f.call('/api/browser-logins', {auth:f.owner});
  assert.equal(list.data.requests.length, 1);
  assert.match(list.response.headers.get('cache-control'), /no-store/);
  const path = `/api/browser-logins/${request.id}`;
  assert.equal((await f.call(path + '/resolve', {auth:f.owner, body:{...credentials, origin:'https://other.example'}})).status, 400);
  assert.equal(f.fills.length, 0);
  assert.equal((await f.call(path, {auth:f.owner, method:'DELETE'})).status, 200);
  assert.deepEqual((await f.call('/api/browser-logins', {auth:f.owner})).data.requests, []);
  assert.equal((await f.call(path + '/resolve', {auth:f.owner, body:credentials})).status, 409);
});

test('save and reuse expose only same-origin masked accounts and never write secrets into chat or model context', async t => {
  const f = await fixture(t, {nextStep:'continue'});
  const request = await f.request(), path = `/api/browser-logins/${request.id}`;
  const first = await f.call(path, {auth:f.owner});
  assert.deepEqual(first.data.accounts, []);
  assert.match(first.response.headers.get('cache-control'), /no-store/);
  const saved = await f.call(path + '/resolve', {auth:f.owner, body:credentials});
  assert.equal(saved.status, 200);
  assert.equal(saved.data.status, 'filled');
  assert.equal(saved.data.nextStep, 'continue');
  assert.equal(saved.data.ignoredSecret, undefined);
  assert.deepEqual(f.fills, [{roomId:f.roomId, origin:target.origin, tabRef:target.tabRef, username:credentials.username, password:credentials.password}]);
  const second = await f.request();
  const accounts = await f.call(`/api/browser-logins/${second.id}`, {auth:f.owner});
  assert.equal(accounts.data.accounts.length, 1);
  const account = accounts.data.accounts[0];
  assert.deepEqual(Object.keys(account).sort(), ['id', 'label', 'maskedUsername']);
  assert.equal(account.label, credentials.label);
  assert.notEqual(account.maskedUsername, credentials.username);
  const reused = await f.call(`/api/browser-logins/${second.id}/resolve`, {auth:f.owner, body:{accountId:account.id, sharedDeviceConfirmed:true}});
  assert.equal(reused.status, 200);
  assert.equal(f.fills.length, 2);
  f.runtime.target = {...target, origin:'https://other.example.com', tabRef:'other-fixture-tab'};
  const other = await f.request();
  assert.deepEqual((await f.call(`/api/browser-logins/${other.id}`, {auth:f.owner})).data.accounts, []);
  assert.equal((await f.call(`/api/rooms/${f.roomId}/messages`, {auth:f.owner, body:{text:'현재 작업 상태를 정리해 줘', botIds:['bot-analyst'], clientNonce:randomUUID()}})).status, 202);
  await f.finish(f.roomId);
  assert.equal(f.modelCalls.length, 1, 'inspect a real following model request, not an empty fixture');
  const transcript = await f.call(`/api/rooms/${f.roomId}`, {auth:f.owner});
  const publicData = JSON.stringify([saved.data, accounts.data, reused.data, transcript.data, f.modelCalls, f.app.db.prepare('SELECT text FROM messages').all()]);
  for (const privateValue of [credentials.username, credentials.password, target.tabRef, 'must-not-leave-browser']) assert.equal(publicData.includes(privateValue), false);
  const stored = await readFile(join(f.dir, 'browser-login-vault.json'), 'utf8');
  assert.equal(stored.includes(credentials.username), false);
  assert.equal(stored.includes(credentials.password), false);
  for (const asset of ['/browser-logins.mjs', '/browser-logins.css']) assert.equal((await fetch(f.app.url + asset)).status, 200);
});

for (const revoke of ['logout', 'membership']) test(`queued fill rechecks ${revoke} immediately before typing`, async t => {
  const entered = deferred(), release = deferred();
  t.after(() => release.resolve());
  const f = await fixture(t, {beforeFill:async () => {entered.resolve(); await release.promise;}});
  const request = await f.request();
  const filling = f.call(`/api/browser-logins/${request.id}/resolve`, {auth:f.owner, body:credentials});
  await entered.promise;
  if (revoke === 'logout') assert.equal((await f.call('/api/logout', {auth:f.owner, body:{}})).status, 200);
  else f.app.db.prepare('DELETE FROM room_members WHERE user_id=? AND room_id=?').run(f.owner.id, f.roomId);
  release.resolve();
  const result = await filling;
  assert.equal(result.status, revoke === 'logout' ? 403 : 409);
  assert.equal(f.fills.length, 0);
  assert.equal(JSON.stringify(result.data).includes(credentials.password), false);
});

test('aborting the resolve HTTP connection cancels queued browser input before typing', async t => {
  const entered = deferred(), release = deferred(), serverAborted = deferred(), settled = deferred();
  const timeout = setTimeout(() => serverAborted.resolve(false), 3000);
  t.after(() => {clearTimeout(timeout); release.resolve();});
  const f = await fixture(t, {
    beforeFill:async ({signal}) => {
      signal.addEventListener('abort', () => serverAborted.resolve(true), {once:true});
      entered.resolve();
      await release.promise;
    },
    afterFill:() => settled.resolve(),
  });
  const request = await f.request(), controller = new AbortController();
  const filling = f.call(`/api/browser-logins/${request.id}/resolve`, {auth:f.owner, body:credentials, signal:controller.signal});
  const rejected = assert.rejects(filling, {name:'AbortError'});
  await entered.promise;
  controller.abort();
  await rejected;
  assert.equal(await serverAborted.promise, true, 'HTTP close must reach the queued browser operation');
  release.resolve();
  await settled.promise;
  assert.equal(f.fills.length, 0);
});

test('an explicit login chat request offers Vault even when the model never invokes the tool', async t => {
  const f = await fixture(t);
  const sent = await f.call(`/api/rooms/${f.roomId}/messages`, {auth:f.owner, body:{text:'이 브라우저에서 로그인해 줘', botIds:['bot-analyst'], clientNonce:randomUUID()}});
  assert.equal(sent.status, 202);
  await f.finish(f.roomId);
  const listed = await f.call('/api/browser-logins', {auth:f.owner});
  assert.equal(listed.data.requests.length, 1);
  assert.equal(listed.data.requests[0].roomId, f.roomId);
  assert.equal(f.captures.length, 1);
  assert.equal(f.fills.length, 0);
  assert.equal(f.modelCalls.length, 1);
  assert.ok(f.modelCalls[0].toolDefinitions.some(tool => tool.function.name === 'request_browser_login'));
  assert.match(f.modelCalls[0].system, /로그인 완료라고 주장하지 말고/);
});

test('a model cannot initiate private login when the current user did not request login', async t => {
  const denied = [];
  const f = await fixture(t, {complete:async request => {
    assert.ok(!request.toolDefinitions.some(tool => tool.function.name === 'request_browser_login'));
    try {await request.browser('request_browser_login', {});} catch (error) {denied.push(error.status);}
    return answer('현재 화면의 내용을 요약했습니다.');
  }});
  assert.equal((await f.call(`/api/rooms/${f.roomId}/messages`, {auth:f.owner, body:{text:'현재 페이지 내용을 요약해 줘', botIds:['bot-analyst'], clientNonce:randomUUID()}})).status, 202);
  await f.finish(f.roomId);
  assert.deepEqual(denied, [403]);
  assert.equal(f.captures.length, 0);
  assert.equal(f.fills.length, 0);
  assert.deepEqual((await f.call('/api/browser-logins', {auth:f.owner})).data.requests, []);
});
