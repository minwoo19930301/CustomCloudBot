import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {createServer} from 'node:http';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startCommunity} from '../server.mjs';
import {OpenClawHttpAdapter} from '../lib/backend/openclaw-http.mjs';

const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const completion = text => ({choices: [{message: {role: 'assistant', content: text}}], usage: {prompt_tokens: 12, completion_tokens: 4}});
async function until(read) {
  for (let attempt = 0; attempt < 250; attempt++) {const value = read(); if (value) return value; await pause(10);}
  assert.fail('Fixture did not receive inference');
}

async function fixture(t, {respond, dailyLimit, gateway} = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'next-prompt-')), chats = [];
  const provider = createServer(async (req, res) => {
    if (req.url === '/v1/models') {res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({data: [{id: 'model-a'}, {id: 'model-b'}]})); return;}
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString()); chats.push(body);
    const result = await respond?.(body) ?? {body: completion('비교표도 만들어줘')};
    if (!res.destroyed) {res.writeHead(result.status ?? 200, {'content-type': 'application/json'}); res.end(JSON.stringify(result.body ?? {}));}
  });
  await new Promise(resolve => provider.listen(0, '127.0.0.1', resolve));
  let app;
  t.after(async () => {await app?.close(); provider.closeAllConnections(); await new Promise(resolve => provider.close(resolve)); await rm(dataDir, {recursive: true, force: true});});
  app = await startCommunity({dataDir, port: 0, dailyLimit, ...(gateway ? {openClaw: gateway} : {}), env: {
    COMMUNITY_BOOTSTRAP_TOKEN: 'bootstrap',
    ...(!gateway ? {COMMUNITY_LLM_PROVIDERS: JSON.stringify([{name: 'fixture', baseUrl: `http://127.0.0.1:${provider.address().port}/v1`, apiKey: 'fixture-secret', model: 'model-a'}])} : {}),
  }});
  async function call(path, {auth, body, csrf = true} = {}) {
    const response = await fetch(app.url + path, {method: body === undefined ? 'GET' : 'POST', headers: {
      'content-type': 'application/json', ...(auth ? {cookie: auth.cookie, ...(csrf ? {'x-csrf-token': auth.csrf} : {})} : {}),
    }, ...(body === undefined ? {} : {body: JSON.stringify(body)}), signal: AbortSignal.timeout(5000)});
    return {status: response.status, data: await response.json(), response};
  }
  async function register(username, owner) {
    const inviteToken = owner ? (await call('/api/admin/invites', {auth: owner, body: {}})).data.token : 'bootstrap';
    const result = await call('/api/register', {body: {username, displayName: username, password: 'suggestion-test-password', inviteToken}});
    assert.equal(result.status, 201);
    return {id: result.data.user.id, cookie: result.response.headers.get('set-cookie').split(';')[0], csrf: result.data.csrfToken};
  }
  async function room(auth) {
    const result = await call('/api/rooms', {auth, body: {name: '추천 검사'}}); assert.equal(result.status, 201); return result.data.room.id;
  }
  function message(id, kind, text = kind === 'human' ? '여행 경로를 추천해줘' : '서울과 부산을 비교할 수 있습니다.') {
    const messageId = randomUUID();
    app.db.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?,?,?)').run(messageId, id, kind, null, kind === 'human' ? '사용자' : 'Agent Bot', text, null, Date.now());
    return messageId;
  }
  return {app, chats, call, register, room, message, suggest: (auth, id, afterMessageId, extra = {}) => call(`/api/rooms/${id}/suggestion`, {auth, body: {afterMessageId, ...extra}})};
}

test('suggestions require authentication, CSRF, current membership, and a settled bot reply', async t => {
  const f = await fixture(t), owner = await f.register('suggestion_owner'), other = await f.register('suggestion_other', owner), id = await f.room(owner);
  const path = `/api/rooms/${id}/suggestion`, fake = randomUUID();
  assert.equal((await f.call(path, {body: {afterMessageId: fake}})).status, 401);
  assert.equal((await f.call(path, {auth: owner, body: {afterMessageId: fake}, csrf: false})).status, 403);
  assert.equal((await f.suggest(other, id, fake)).status, 404);
  assert.equal((await f.suggest(owner, id, 'invalid')).status, 400);
  assert.deepEqual((await f.suggest(owner, id, fake)).data, {suggestion: '', revision: null});
  const human = f.message(id, 'human');
  assert.deepEqual((await f.suggest(owner, id, human)).data, {suggestion: '', revision: human});
  const bot = f.message(id, 'bot');
  assert.equal((await f.suggest(owner, id, human)).data.suggestion, '');
  assert.equal((await f.suggest(owner, id, bot, {effort: 'unknown'})).status, 400);
  assert.equal((await f.suggest(owner, id, bot, {model: 'not-listed'})).data.suggestion, '');
  assert.equal(f.chats.length, 0);
});

test('a shared revision makes one selected text-only model call and accounts for its usage without sending chat', async t => {
  const gate = deferred(), f = await fixture(t, {respond: async () => {await gate.promise; return {body: completion('"여행 비용도 비교해줘"')};}});
  const owner = await f.register('cached_owner'), member = await f.register('cached_member', owner), id = await f.room(owner);
  f.app.db.prepare('INSERT INTO room_members(room_id,user_id,role) VALUES(?,?,?)').run(id, member.id, 'member');
  f.message(id, 'human'); const bot = f.message(id, 'bot');
  const first = f.suggest(owner, id, bot, {model: 'model-b', effort: 'low'});
  await until(() => f.chats.length);
  const second = f.suggest(member, id, bot, {model: 'model-a'});
  const detail = await f.call(`/api/rooms/${id}`, {auth: owner});
  assert.equal(detail.data.busy, false, 'a suggestion never claims the chat job');
  gate.resolve();
  for (const result of await Promise.all([first, second])) assert.deepEqual(result.data, {suggestion: '여행 비용도 비교해줘', revision: bot});
  assert.equal((await f.suggest(owner, id, bot)).data.suggestion, '여행 비용도 비교해줘');
  assert.equal(f.chats.length, 1);
  assert.equal(f.chats[0].model, 'model-b');
  assert.equal(f.chats[0].tools, undefined); assert.equal(f.chats[0].tool_choice, undefined);
  assert.match(f.chats[0].messages[0].content, /도구를 사용하지 마세요/);
  assert.match(f.chats[0].messages[1].content, /여행 경로/);
  assert.equal(f.app.db.prepare('SELECT count(*) n FROM messages WHERE room_id=?').get(id).n, 2);
  assert.equal(f.app.db.prepare('SELECT turns FROM usage WHERE user_id=?').get(owner.id).turns, 1);
  assert.equal(f.app.db.prepare('SELECT turns FROM usage WHERE user_id=?').get(member.id), undefined);
  const usage = (await f.call(`/api/rooms/${id}/usage`, {auth: owner})).data;
  assert.equal(usage.requests, 1); assert.equal(usage.inputTokens, 12); assert.equal(usage.outputTokens, 4);
});

test('a new chat message can proceed during suggestion inference and discards the stale draft', async t => {
  const gate = deferred(), f = await fixture(t, {respond: async () => {await gate.promise; return {body: completion('낡은 제안')};}});
  const owner = await f.register('stale_owner'), id = await f.room(owner);
  f.message(id, 'human'); const bot = f.message(id, 'bot');
  const pending = f.suggest(owner, id, bot); await until(() => f.chats.length);
  const sent = await f.call(`/api/rooms/${id}/messages`, {auth: owner, body: {text: '다른 일을 시작할게', botIds: [], clientNonce: randomUUID()}});
  assert.equal(sent.status, 202);
  gate.resolve(); const result = await pending;
  assert.equal(result.data.suggestion, ''); assert.notEqual(result.data.revision, bot);
  assert.equal((await f.suggest(owner, id, bot)).data.suggestion, ''); assert.equal(f.chats.length, 1);
});

test('membership is checked again after inference before disclosing a draft', async t => {
  const gate = deferred(), f = await fixture(t, {respond: async () => {await gate.promise; return {body: completion('비공개 다음 작업')};}});
  const owner = await f.register('revoked_owner'), member = await f.register('revoked_member', owner), id = await f.room(owner);
  f.app.db.prepare('INSERT INTO room_members(room_id,user_id,role) VALUES(?,?,?)').run(id, member.id, 'member');
  f.message(id, 'human'); const bot = f.message(id, 'bot');
  const pending = f.suggest(member, id, bot); await until(() => f.chats.length);
  f.app.db.prepare('DELETE FROM room_members WHERE room_id=? AND user_id=?').run(id, member.id);
  gate.resolve(); const result = await pending;
  assert.equal(result.status, 404); assert.equal(result.data.suggestion, undefined);
});

test('provider failures produce a cached empty suggestion without fallback calls', async t => {
  const f = await fixture(t, {respond: () => ({status: 429, body: {error: 'quota'}})});
  const owner = await f.register('unavailable_owner'), id = await f.room(owner);
  f.message(id, 'human'); const bot = f.message(id, 'bot');
  for (const model of ['', 'model-a', 'model-b']) assert.deepEqual((await f.suggest(owner, id, bot, {model})).data, {suggestion: '', revision: bot});
  assert.equal(f.chats.length, 1);
  assert.equal(f.app.db.prepare('SELECT turns FROM usage WHERE user_id=?').get(owner.id).turns, 1);
});

test('queued work and a still-running multi-bot turn suppress speculative model calls', async t => {
  const gate = deferred(), f = await fixture(t, {respond: async () => {await gate.promise; return {body: completion('완료했습니다.')};}});
  const owner = await f.register('busy_owner'), id = await f.room(owner);
  f.message(id, 'human'); const bot = f.message(id, 'bot');
  const queueId = randomUUID();
  f.app.db.prepare("INSERT INTO message_queue(id,room_id,author_id,author,nonce,payload,state,created_at) VALUES(?,?,?,?,?,?,'queued',?)")
    .run(queueId, id, owner.id, '사용자', randomUUID(), JSON.stringify({text: '다음 작업', clientNonce: randomUUID(), botIds: [], attachmentIds: [], model: '', effort: ''}), Date.now());
  assert.equal((await f.suggest(owner, id, bot)).data.suggestion, ''); assert.equal(f.chats.length, 0);
  f.app.db.prepare('DELETE FROM message_queue WHERE id=?').run(queueId);
  assert.equal((await f.call(`/api/rooms/${id}/messages`, {auth: owner, body: {text: '다음 답변', botIds: ['bot-analyst'], clientNonce: randomUUID()}})).status, 202);
  await until(() => f.chats.length);
  // One bot's reply may already be visible while another bot is still running.
  const partialBot = f.message(id, 'bot', '앞선 봇의 답변');
  assert.equal((await f.suggest(owner, id, partialBot)).data.suggestion, ''); assert.equal(f.chats.length, 1);
  gate.resolve();
});

test('suggestions respect the ordinary quota and reset context rather than reading discarded history', async t => {
  const f = await fixture(t, {dailyLimit: 1}), owner = await f.register('limited_owner'), id = await f.room(owner);
  f.message(id, 'human'); const bot = f.message(id, 'bot');
  f.app.db.prepare('INSERT INTO usage VALUES(?,?,?)').run(owner.id, new Date().toISOString().slice(0, 10), 1);
  assert.equal((await f.suggest(owner, id, bot)).data.suggestion, ''); assert.equal(f.chats.length, 0);
  f.app.db.prepare('DELETE FROM usage').run();
  assert.equal((await f.call(`/api/rooms/${id}/context-reset`, {auth: owner, body: {}})).status, 200);
  assert.equal((await f.suggest(owner, id, bot)).data.suggestion, ''); assert.equal(f.chats.length, 0);
});

test('gateway suggestions explicitly disable tools and use isolated sessions', async t => {
  const requests = [];
  const gateway = new OpenClawHttpAdapter({baseUrl: 'http://127.0.0.1:9999', token: 'fixture-gateway-token', fetchImpl: async (_url, options) => {
    requests.push({body: JSON.parse(options.body), headers: options.headers});
    return new Response(JSON.stringify({output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text: '다음 단계도 정리해줘'}]}]}), {headers: {'content-type': 'application/json'}});
  }});
  const f = await fixture(t, {gateway}), owner = await f.register('gateway_owner'), id = await f.room(owner);
  f.message(id, 'human'); const bot = f.message(id, 'bot');
  assert.equal((await f.suggest(owner, id, bot)).data.suggestion, '다음 단계도 정리해줘');
  assert.equal(requests.length, 1); assert.deepEqual(requests[0].body.tools, []); assert.equal(requests[0].body.tool_choice, 'none');
  assert.equal(requests[0].body.store, false); assert.match(requests[0].headers['x-openclaw-session-key'], /^community:[a-f0-9]{64}$/);
});
