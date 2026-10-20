import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
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

async function fixture(t, {beforeFill, afterFill, complete, execute, prepare, providerPool, nextStep = 'submit'} = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'browser-login-api-'));
  const captures = [], prepares = [], fills = [], modelCalls = [], runtime = {target:{...target}};
  let app;
  const browserTools = {
    configured:() => true,
    captureLoginTarget:async (roomId, {signal} = {}) => {
      signal?.throwIfAborted();
      captures.push(roomId);
      return {...runtime.target};
    },
    prepareLoginTarget:async (roomId, {url, expectedOrigin, signal} = {}) => {
      signal?.throwIfAborted();
      prepares.push({roomId, url, expectedOrigin});
      if (prepare) runtime.target = await prepare(roomId, {url, expectedOrigin, signal}, runtime);
      else if (url) {
        const origin = new URL(url).origin;
        runtime.target = {origin, tabRef:'prepared-fixture-tab', siteLabel:new URL(origin).hostname};
      }
      if (expectedOrigin && runtime.target.origin !== expectedOrigin) throw new Error('The current browser is no longer on the requested origin');
      captures.push(roomId);
      return {...runtime.target};
    },
    execute:async (roomId, name, args, {signal} = {}) => {
      signal?.throwIfAborted();
      if (!execute) throw new Error('Unexpected browser operation in login fixture');
      return execute(roomId, name, args);
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
    providerPool:providerPool ?? {configured:false, providers:[], choose:() => null, ensureModels:async () => {}},
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
    const events = await response.text();
    assert.match(events, /event: done/);
    return events;
  };
  const send = async (text, id = roomId) => {
    const result = await call(`/api/rooms/${id}/messages`, {auth:owner, body:{text, botIds:['bot-analyst'], clientNonce:randomUUID()}});
    assert.equal(result.status, 202, JSON.stringify(result.data));
    return {...result, progress:await finish(id)};
  };
  const seedHuman = (text, {id = roomId, author = owner, createdAt = Date.now()} = {}) => {
    const messageId = randomUUID();
    app.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)').run(messageId, id, 'human', author.id, 'Fixture user', text, null, createdAt);
    return messageId;
  };
  return {get app() {return app;}, dir, call, owner, member, roomId, room, request, finish, send, seedHuman, captures, prepares, fills, modelCalls, runtime};
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

test('a current-page login request hands off to Vault without asking a model that could contradict the UI', async t => {
  const refusal = '죄송합니다. 저는 아이디·비밀번호를 받아서 직접 로그인해 드릴 수 없습니다.';
  const f = await fixture(t, {complete:async () => answer(refusal)});
  await f.send('이 브라우저에서 로그인해 줘');
  const listed = await f.call('/api/browser-logins', {auth:f.owner});
  assert.equal(listed.data.requests.length, 1);
  assert.equal(listed.data.requests[0].roomId, f.roomId);
  assert.equal(f.captures.length, 1);
  assert.equal(f.prepares.length, 1);
  assert.equal(f.fills.length, 0);
  assert.equal(f.modelCalls.length, 0);
  const transcript = (await f.call(`/api/rooms/${f.roomId}`, {auth:f.owner})).data.messages;
  const reply = transcript.filter(message => message.kind === 'bot').at(-1)?.text || '';
  assert.match(reply, /Vault/);
  assert.match(reply, /계정/);
  assert.equal(transcript.some(message => message.text.includes(refusal)), false);
  assert.doesNotMatch(reply, /로그인(?:이|을)?\s*완료/);
});

test('a completed private handoff publishes complete, not exhausted, when an API model was selected', async t => {
  const apiRequests = [];
  const provider = createServer(async (req, res) => {
    for await (const _chunk of req) { /* Drain any unexpected request. */ }
    apiRequests.push(req.url);
    res.writeHead(200, {'content-type':'application/json'});
    res.end(JSON.stringify({choices:[{message:{role:'assistant', content:'Unexpected model answer'}}]}));
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  t.after(async () => {provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve));});
  const choice = {
    name:'login-api-fixture', provider:'login-api-fixture', model:'fixture-model',
    baseUrl:`http://127.0.0.1:${provider.address().port}/v1`, apiKey:'synthetic-provider-private-key',
  };
  const f = await fixture(t, {providerPool:{
    configured:true, providers:[choice], ensureModels:async () => {},
    choose:() => ({...choice, automatic:true, attempts:[choice]}),
  }});
  const sent = await f.send('이 브라우저에서 로그인해 줘');
  const state = (await f.call(`/api/rooms/${f.roomId}`, {auth:f.owner})).data;
  assert.equal(state.busy, false);
  assert.equal(state.modelControl.phase, 'complete');
  assert.equal(state.modelControl.visible, false);
  assert.equal(state.modelControl.canControl, false);
  assert.match(sent.progress, /event: model-control/);
  assert.match(sent.progress, /"phase":"complete"/);
  assert.doesNotMatch(sent.progress, /"phase":"(?:exhausted|waiting|switching)"/);
  assert.doesNotMatch(JSON.stringify(state), /synthetic-provider-private-key|Unexpected model answer/);
  assert.equal((await f.call('/api/browser-logins', {auth:f.owner})).data.requests.length, 1);
  assert.deepEqual(apiRequests, [], 'a completed private handoff makes no model HTTP request');
  assert.deepEqual(f.modelCalls, []);
  assert.deepEqual(f.fills, []);
});

test('an explicit different-site login prepares the new target before opening Vault, without using the old page or model', async t => {
  const f = await fixture(t, {complete:async () => answer('죄송합니다. 지원하지 않습니다.')});
  f.runtime.target = {origin:'https://nid.naver.com', tabRef:'naver-old-tab', siteLabel:'Naver'};
  await f.request();
  f.captures.length = 0;
  await f.send('https://github.com/login 에 로그인하려고 하니까 해당 사이트로 이동하고 Vault 창을 열어 줘');
  assert.equal(f.prepares.length, 1);
  assert.equal(f.prepares[0].url, 'https://github.com/login');
  assert.deepEqual(f.captures, [f.roomId]);
  assert.equal(f.modelCalls.length, 0);
  const listed = (await f.call('/api/browser-logins', {auth:f.owner})).data.requests;
  assert.equal(listed.length, 1);
  assert.equal(listed[0].origin, 'https://github.com');
  assert.equal(f.fills.length, 0);
});

test('a real three-turn Naver login conversation consistently opens the same private handoff even if the model would refuse', async t => {
  const f = await fixture(t, {
    complete:async () => answer('죄송합니다. 해당 요청은 지원 범위를 벗어납니다.'),
    prepare:async () => ({origin:'https://nid.naver.com', tabRef:'naver-login-fixture-tab', siteLabel:'네이버'}),
  });
  const texts = [
    '브라우저로 naver.com 들어가서 로그인 좀 해줘',
    '너가 로그인해줘 내가 아이디비번 줄게',
    '아니 직접 해줘 내가 알려줄테니',
  ];
  for (const [index, text] of texts.entries()) {
    await f.send(text);
    const requests = (await f.call('/api/browser-logins', {auth:f.owner})).data.requests;
    assert.equal(requests.length, 1);
    assert.equal(requests[0].roomId, f.roomId);
    assert.equal(requests[0].origin, 'https://nid.naver.com');
    assert.equal(f.prepares.length, index + 1);
    assert.equal(f.modelCalls.length, 0, 'a prepared handoff must not solicit a contradictory generated refusal');
    assert.equal(f.fills.length, 0, 'a login request never supplies or types credentials itself');
  }
  assert.ok(f.prepares[0].url, 'the named site must be resolved before capture');
  const messages = (await f.call(`/api/rooms/${f.roomId}`, {auth:f.owner})).data.messages;
  assert.equal(messages.filter(message => message.kind === 'human').length, 3);
  const replies = messages.filter(message => message.kind === 'bot');
  assert.equal(replies.length, 3);
  for (const reply of replies) {
    assert.match(reply.text, /Vault/);
    assert.doesNotMatch(reply.text, /지원 범위를 벗어|아이디.*(?:알려|보내)|로그인(?:이|을)?\s*완료/);
  }
});

test('ambiguous login follow-ups cannot inherit intent outside the current recent original user conversation', async t => {
  const loginText = '브라우저로 naver.com 들어가서 로그인 좀 해줘';
  const cases = [
    ['an unrelated intervening topic', async f => {
      f.seedHuman(loginText);
      f.seedHuman('내일 할 일을 정리해 줘');
    }],
    ['another user', async f => {
      f.seedHuman(loginText);
      f.seedHuman('계속해 줘', {author:f.member});
    }],
    ['another room', async f => {f.seedHuman(loginText, {id:await f.room(f.owner)});}],
    ['a request older than ten minutes', async f => {f.seedHuman(loginText, {createdAt:Date.now() - 11 * 60_000});}],
    ['a fork-copied request', async f => {
      f.seedHuman(loginText);
      const forked = await f.call(`/api/rooms/${f.roomId}/fork`, {auth:f.owner, body:{branching:true}});
      assert.equal(forked.status, 201);
      return forked.data.room.id;
    }],
  ];
  for (const [name, arrange] of cases) await t.test(name, async t => {
    const denied = [];
    const f = await fixture(t, {complete:async request => {
      assert.ok(!request.toolDefinitions.some(tool => tool.function.name === 'request_browser_login'));
      try {await request.browser('request_browser_login', {});} catch (error) {denied.push(error.status);}
      return answer('어떤 작업을 이어서 할지 알려주세요.');
    }});
    const roomId = await arrange(f) || f.roomId;
    await f.send('아니 직접 해줘 내가 알려줄테니', roomId);
    assert.equal(f.modelCalls.length, 1);
    assert.deepEqual(denied, [403]);
    assert.deepEqual(f.prepares, []);
    assert.deepEqual(f.captures, []);
    assert.deepEqual(f.fills, []);
    assert.deepEqual((await f.call('/api/browser-logins', {auth:f.owner})).data.requests, []);
  });
});

test('an existing pending Vault request does not authorize a follow-up after an unrelated topic', async t => {
  const f = await fixture(t, {complete:async request => {
    assert.ok(!request.toolDefinitions.some(tool => tool.function.name === 'request_browser_login'));
    return answer('요청한 작업을 이어서 확인합니다.');
  }});
  await f.send('이 브라우저에서 로그인해 줘');
  const original = (await f.call('/api/browser-logins', {auth:f.owner})).data.requests[0];
  assert.ok(original);
  await f.send('내일 할 일을 정리해 줘');
  await f.send('아니 직접 해줘 내가 알려줄테니');
  assert.equal(f.prepares.length, 1);
  assert.equal(f.modelCalls.length, 2);
  assert.deepEqual(f.fills, []);
  const pending = (await f.call('/api/browser-logins', {auth:f.owner})).data.requests;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, original.id, 'an unrelated request must not refresh or replace the pending login');
});

for (const afterHandoff of ['refusal', 'error']) test(`a model ${afterHandoff} after a successful login tool cannot contradict the verified Vault handoff`, async t => {
  const toolResults = [], navigations = [];
  let loginFormVisible = false;
  const f = await fixture(t, {
    prepare:async (_roomId, _options, runtime) => {
      if (!loginFormVisible) throw new Error('No login form visible');
      return {...runtime.target};
    },
    execute:async (_roomId, name, args) => {
      assert.equal(name, 'browser_navigate');
      assert.equal(args.url, target.origin + '/login');
      navigations.push(args.url);
      loginFormVisible = true;
      return JSON.stringify({url:args.url, title:'Sign in'});
    },
    complete:async request => {
      assert.ok(request.toolDefinitions.some(tool => tool.function.name === 'request_browser_login'));
      assert.match(request.system, /전용 Vault/);
      await request.browser('browser_navigate', {url:target.origin + '/login'});
      toolResults.push(JSON.parse(await request.browser('request_browser_login', {})));
      if (afterHandoff === 'error') throw new Error('Synthetic provider disconnected after tool');
      return answer('죄송합니다. 저는 로그인 작업을 지원하지 않습니다.');
    },
  });
  await f.send('이 브라우저에서 로그인해 줘');
  assert.equal(f.prepares.length, 2);
  assert.equal(f.captures.length, 1);
  assert.deepEqual(navigations, [target.origin + '/login']);
  assert.equal(f.modelCalls.length, 1);
  assert.equal(toolResults[0].status, 'awaiting_private_login');
  assert.equal((await f.call('/api/browser-logins', {auth:f.owner})).data.requests.length, 1);
  assert.deepEqual(f.fills, []);
  const messages = (await f.call(`/api/rooms/${f.roomId}`, {auth:f.owner})).data.messages;
  const replies = messages.filter(message => message.kind === 'bot');
  assert.equal(replies.length, 1);
  assert.match(replies[0].text, /Vault 로그인 창을 열었습니다/);
  assert.doesNotMatch(replies[0].text, /지원하지|완료하지 못|disconnected|로그인(?:이|을)?\s*완료/);
});

test('a model cannot open the old site after preparing an explicitly different login target fails', async t => {
  const rejected = [];
  const f = await fixture(t, {
    prepare:async () => {throw new Error('The requested site is unavailable');},
    complete:async request => {
      assert.ok(request.toolDefinitions.some(tool => tool.function.name === 'request_browser_login'));
      try {await request.browser('request_browser_login', {});} catch {rejected.push(true);}
      return answer('요청한 로그인 페이지에 연결하지 못했습니다.');
    },
  });
  f.runtime.target = {origin:'https://nid.naver.com', tabRef:'old-naver-page', siteLabel:'네이버'};
  await f.send('https://github.com/login 에서 로그인해 줘');
  assert.equal(f.modelCalls.length, 1);
  assert.equal(f.prepares.length, 2);
  assert.ok(f.prepares.every(item => item.url === 'https://github.com/login'));
  assert.deepEqual(rejected, [true]);
  assert.deepEqual(f.captures, []);
  assert.deepEqual(f.fills, []);
  assert.deepEqual((await f.call('/api/browser-logins', {auth:f.owner})).data.requests, []);
});

test('a generic login follow-up keeps the pending origin restriction even when a model invokes the tool after the browser changes', async t => {
  const rejected = [];
  const f = await fixture(t, {complete:async request => {
    assert.ok(request.toolDefinitions.some(tool => tool.function.name === 'request_browser_login'));
    try {await request.browser('request_browser_login', {});} catch {rejected.push(true);}
    return answer('기존 로그인 화면이 바뀌어서 다시 확인해야 합니다.');
  }});
  f.runtime.target = {origin:'https://nid.naver.com', tabRef:'naver-login-page', siteLabel:'네이버'};
  await f.send('이 브라우저에서 로그인해 줘');
  const original = (await f.call('/api/browser-logins', {auth:f.owner})).data.requests[0];
  assert.equal(original.origin, 'https://nid.naver.com');
  assert.equal(f.captures.length, 1);
  assert.equal(f.modelCalls.length, 0);
  f.runtime.target = {origin:'https://github.com', tabRef:'other-shared-page', siteLabel:'GitHub'};
  await f.send('아니 직접 해줘 내가 알려줄테니');
  assert.equal(f.modelCalls.length, 1);
  assert.deepEqual(rejected, [true]);
  assert.equal(f.prepares.length, 3, 'preflight and the model tool both revalidate the previous target');
  assert.ok(f.prepares.slice(1).every(item => item.expectedOrigin === 'https://nid.naver.com' && item.url === undefined));
  assert.equal(f.captures.length, 1, 'neither attempt can capture a new login target from the changed page');
  assert.deepEqual(f.fills, []);
  const pending = (await f.call('/api/browser-logins', {auth:f.owner})).data.requests;
  assert.equal(pending.length, 1);
  assert.equal(pending[0].id, original.id);
  assert.equal(pending[0].origin, original.origin);
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
