import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startCommunity} from '../server.mjs';

const envelope = content => 'SendMessage: ' + JSON.stringify({type: 'text', content});
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9WQAAAAASUVORK5CYII=', 'base64');

function currentRequestText(request) {
  const boundary = '\n\n현재 인증된 사용자의 요청 (아래 현재 요청에 직접 답하세요):\n';
  const index = request.user.indexOf(boundary);
  assert.ok(index >= 0, 'the current request must be explicitly separated from preceding history');
  return request.user.slice(index + boundary.length);
}

async function until(read, description) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const result = await read();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('Timed out: ' + description);
}

function controlledModel({ignoreAbort = () => false} = {}) {
  const calls = [];
  let active = 0, peak = 0;
  const llm = {name: 'queue-controlled-model', async complete(request, signal) {
    if (request.isolation?.botId === 'title') return envelope('대기열 테스트');
    const completion = Promise.withResolvers();
    const call = {request, signal, finish: text => completion.resolve(envelope(text)), settled: false};
    calls.push(call);
    active++;
    peak = Math.max(active, peak);
    const abort = () => { if (!ignoreAbort(call, calls.length - 1)) completion.reject(signal.reason ?? new Error('aborted')); };
    signal?.addEventListener('abort', abort, {once: true});
    if (signal?.aborted) abort();
    try { return await completion.promise; }
    finally { active--; call.settled = true; signal?.removeEventListener('abort', abort); }
  }};
  return {llm, calls, get peak() { return peak; }, get active() { return active; },
    next: index => until(() => calls[index], 'model call ' + index),
    release: () => { for (const call of calls) call.finish('테스트 종료'); }};
}

async function fixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'community-message-queue-'));
  let model = controlledModel(options), app;
  const start = async () => { app = await startCommunity({dataDir: dir, port: 0, env: {COMMUNITY_BOOTSTRAP_TOKEN: 'bootstrap'}, llm: model.llm}); };
  await start();
  t.after(async () => { model.release(); await app.close(); await rm(dir, {recursive: true, force: true}); });
  async function call(path, {auth, body, method = body === undefined ? 'GET' : 'POST', csrf = true} = {}) {
    const response = await fetch(app.url + path, {method, headers: {'content-type': 'application/json',
      ...(auth ? {cookie: auth.cookie, ...(csrf ? {'x-csrf-token': auth.csrf} : {})} : {})},
      body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(5000)});
    return {status: response.status, data: await response.json(), response};
  }
  async function register(username, owner) {
    const inviteToken = owner ? (await call('/api/admin/invites', {auth: owner, body: {}})).data.token : 'bootstrap';
    const result = await call('/api/register', {body: {username, displayName: username, password: 'queue-test-password', inviteToken}});
    assert.equal(result.status, 201);
    return {id: result.data.user.id, csrf: result.data.csrfToken, cookie: result.response.headers.get('set-cookie').split(';')[0]};
  }
  async function room(auth) {
    const result = await call('/api/rooms', {auth, body: {name: '메시지 대기열'}});
    assert.equal(result.status, 201); return result.data.room.id;
  }
  async function joinRoom(owner, member, id) {
    const token = (await call(`/api/rooms/${id}/invites`, {auth: owner, body: {}})).data.token;
    assert.equal((await call('/api/rooms/join', {auth: member, body: {token}})).status, 200);
  }
  async function send(auth, id, text, extra = {}) {
    return call(`/api/rooms/${id}/messages`, {auth, body: {text, clientNonce: randomUUID(), botIds: ['bot-analyst'], queueIfBusy: true, ...extra}});
  }
  const detail = async (auth, id) => (await call(`/api/rooms/${id}`, {auth})).data;
  const idle = (auth, id) => until(async () => { const value = await detail(auth, id); return !value.busy && !value.queue?.length && value; }, 'empty queue and idle room');
  const restart = async () => { await app.close(); model = controlledModel(); await start(); };
  async function upload(auth, id) {
    const form = new FormData(); form.append('file', new Blob([PNG], {type: 'image/png'}), 'queued-image.png');
    const response = await fetch(app.url + `/api/rooms/${id}/attachments`, {method: 'POST', headers: {cookie: auth.cookie, 'x-csrf-token': auth.csrf}, body: form});
    assert.equal(response.status, 201); return (await response.json()).attachment;
  }
  return {get app() { return app; }, get model() { return model; }, call, register, room, joinRoom, send, detail, idle, restart, upload};
}

test('busy sends enter a FIFO queue and later messages never leak into an earlier model request', async t => {
  const f = await fixture(t), owner = await f.register('fifo_owner'), id = await f.room(owner);
  const first = await f.send(owner, id, 'FIRST_REQUEST_MARKER');
  assert.equal(first.status, 202); assert.ok(first.data.messageId);
  const active = await f.model.next(0);
  const second = await f.send(owner, id, 'SECOND_REQUEST_MARKER');
  const third = await f.send(owner, id, 'THIRD_REQUEST_MARKER');
  for (const result of [second, third]) { assert.equal(result.status, 202); assert.equal(result.data.queued, true); assert.ok(result.data.queueId); }
  const waiting = await f.detail(owner, id);
  assert.deepEqual(waiting.messages.map(item => item.text), ['FIRST_REQUEST_MARKER']);
  assert.deepEqual(waiting.queue.map(item => item.id), [second.data.queueId, third.data.queueId]);
  assert.doesNotMatch(active.request.user, /SECOND_REQUEST_MARKER|THIRD_REQUEST_MARKER/);
  active.finish('FIRST_ANSWER_MARKER');
  const secondCall = await f.model.next(1);
  assert.match(secondCall.request.user, /FIRST_ANSWER_MARKER/);
  assert.match(secondCall.request.user, /SECOND_REQUEST_MARKER/);
  assert.doesNotMatch(secondCall.request.user, /THIRD_REQUEST_MARKER/);
  secondCall.finish('SECOND_ANSWER_MARKER');
  const thirdCall = await f.model.next(2);
  assert.match(thirdCall.request.user, /SECOND_ANSWER_MARKER/);
  assert.match(thirdCall.request.user, /THIRD_REQUEST_MARKER/);
  thirdCall.finish('THIRD_ANSWER_MARKER');
  const done = await f.idle(owner, id);
  assert.deepEqual(done.messages.map(item => item.text), ['FIRST_REQUEST_MARKER', 'FIRST_ANSWER_MARKER', 'SECOND_REQUEST_MARKER', 'SECOND_ANSWER_MARKER', 'THIRD_REQUEST_MARKER', 'THIRD_ANSWER_MARKER']);
  assert.equal(f.model.peak, 1);
});

test('simultaneous queue retries preserve one nonce and its attachment through dispatch', async t => {
  const f = await fixture(t), owner = await f.register('nonce_owner'), id = await f.room(owner);
  await f.send(owner, id, 'running'); const first = await f.model.next(0);
  const attachment = await f.upload(owner, id);
  const payload = {clientNonce: 'same-queued-request', attachmentIds: [attachment.id]};
  const attempts = await Promise.all(Array.from({length: 3}, () => f.send(owner, id, 'ATTACHMENT_REQUEST_MARKER', payload)));
  for (const attempt of attempts) { assert.equal(attempt.status, 202); assert.equal(attempt.data.queued, true); }
  assert.equal(new Set(attempts.map(item => item.data.queueId)).size, 1);
  const queued = (await f.detail(owner, id)).queue;
  assert.equal(queued.length, 1); assert.deepEqual(queued[0].attachmentNames, ['queued-image.png']);
  const stolen = await f.send(owner, id, 'second use of reserved attachment', {attachmentIds: [attachment.id]});
  assert.equal(stolen.status, 400);
  first.finish('running done'); const next = await f.model.next(1);
  next.finish('attachment handled'); const done = await f.idle(owner, id);
  const human = done.messages.find(item => item.text === 'ATTACHMENT_REQUEST_MARKER');
  assert.deepEqual(human.attachments.map(item => item.id), [attachment.id]);
  const retry = await f.send(owner, id, 'ATTACHMENT_REQUEST_MARKER', payload);
  assert.equal(retry.status, 202); assert.equal(retry.data.messageId, human.id);
  assert.equal(f.model.calls.length, 2);
  assert.equal((await f.detail(owner, id)).messages.filter(item => item.text === 'ATTACHMENT_REQUEST_MARKER').length, 1);
});

test('global capacity queues another room and starts it only after a model slot is freed', async t => {
  const f = await fixture(t), owner = await f.register('capacity_owner');
  const ids = await Promise.all([f.room(owner), f.room(owner), f.room(owner)]);
  await f.send(owner, ids[0], 'room one'); await f.model.next(0);
  await f.send(owner, ids[1], 'room two'); await f.model.next(1);
  const third = await f.send(owner, ids[2], 'room three');
  assert.equal(third.status, 202); assert.equal(third.data.queued, true);
  assert.equal(f.model.calls.length, 2); assert.equal(f.model.active, 2);
  assert.deepEqual((await f.detail(owner, ids[2])).messages, []);
  f.model.calls[0].finish('one done');
  const next = await f.model.next(2);
  assert.equal(next.request.isolation.roomId, ids[2]);
  assert.equal(f.model.peak, 2);
  f.model.calls[1].finish('two done'); next.finish('three done');
  await Promise.all(ids.map(id => f.idle(owner, id)));
});

test('racing initial sends admit one room job and keep the repeated nonce idempotent', async t => {
  const f = await fixture(t), owner = await f.register('race_owner'), id = await f.room(owner);
  const repeated = {clientNonce: 'racing-initial-nonce'};
  const results = await Promise.all([
    f.send(owner, id, 'RACING_DUPLICATE_MARKER', repeated),
    f.send(owner, id, 'RACING_DUPLICATE_MARKER', repeated),
    f.send(owner, id, 'RACING_DISTINCT_MARKER'),
  ]);
  for (const result of results) assert.equal(result.status, 202);
  const first = await f.model.next(0);
  const active = await f.detail(owner, id);
  assert.equal(active.messages.filter(item => item.kind === 'human').length, 1);
  assert.equal(active.queue.length, 1);
  assert.equal(f.model.calls.length, 1);
  first.finish('first done');
  const second = await f.model.next(1); second.finish('second done');
  const done = await f.idle(owner, id);
  assert.deepEqual(done.messages.filter(item => item.kind === 'human').map(item => item.text).sort(), ['RACING_DISTINCT_MARKER', 'RACING_DUPLICATE_MARKER']);
  assert.equal(f.model.peak, 1);
});

test('queue controls enforce membership, CSRF and actor ownership without granting another user an interrupt', async t => {
  const f = await fixture(t), owner = await f.register('access_owner'), member = await f.register('access_member', owner), outsider = await f.register('access_outsider', owner), id = await f.room(owner);
  await f.joinRoom(owner, member, id);
  await f.send(owner, id, 'owner is working'); await f.model.next(0);
  const queued = await f.send(member, id, 'member queued message', {clientNonce: 'cancelled-request-nonce'});
  assert.equal(queued.status, 202);
  const path = `/api/rooms/${id}/queue/${queued.data.queueId}`;
  const ownView = (await f.detail(member, id)).queue[0];
  assert.equal(ownView.canCancel, true); assert.equal(ownView.canSendNow, false);
  assert.equal((await f.call(path, {method: 'DELETE'})).status, 401);
  assert.equal((await f.call(path, {auth: member, method: 'DELETE', csrf: false})).status, 403);
  assert.equal((await f.call(path, {auth: outsider, method: 'DELETE'})).status, 404);
  assert.equal((await f.call(path + '/send-now', {auth: member, body: {}})).status, 403);
  assert.equal(f.model.calls[0].signal.aborted, false);
  assert.equal((await f.call(path, {auth: member, method: 'DELETE'})).status, 200);
  assert.deepEqual((await f.detail(owner, id)).queue, []);
  assert.equal((await f.send(member, id, 'member queued message', {clientNonce: 'cancelled-request-nonce'})).status, 409, 'a network retry must not resurrect a deliberately cancelled request');
  f.model.calls[0].finish('owner finished');
  const done = await f.idle(owner, id);
  assert.ok(!done.messages.some(item => item.text === 'member queued message'));
  assert.equal(f.model.calls.length, 1);
  await f.send(member, id, 'member is working'); await f.model.next(1);
  const ownerQueued = await f.send(owner, id, 'owner instruction');
  const ownerQueue = (await f.detail(owner, id)).queue[0];
  assert.equal(ownerQueue.canSendNow, false, 'room ownership must not merge another actor request into owner privileges');
  assert.equal((await f.call(`/api/rooms/${id}/queue/${ownerQueued.data.queueId}/send-now`, {auth: owner, body: {}})).status, 403);
  assert.equal(f.model.calls[1].signal.aborted, false);
});

test('queue dispatch rechecks the original actor membership and skips revoked work before the next valid message', async t => {
  const f = await fixture(t), owner = await f.register('revoke_owner'), member = await f.register('revoke_member', owner), id = await f.room(owner);
  await f.joinRoom(owner, member, id);
  await f.send(owner, id, 'running'); await f.model.next(0);
  assert.equal((await f.send(member, id, 'REVOKED_REQUEST_MARKER')).data.queued, true);
  assert.equal((await f.send(owner, id, 'VALID_NEXT_MARKER')).data.queued, true);
  f.app.db.prepare('DELETE FROM room_members WHERE room_id=? AND user_id=?').run(id, member.id);
  f.model.calls[0].finish('first done');
  const next = await f.model.next(1);
  assert.equal(next.request.isolation.userId, owner.id);
  assert.match(next.request.user, /VALID_NEXT_MARKER/);
  assert.doesNotMatch(next.request.user, /REVOKED_REQUEST_MARKER/);
  next.finish('valid done');
  const done = await f.idle(owner, id);
  assert.ok(!done.messages.some(item => item.text === 'REVOKED_REQUEST_MARKER'));
  assert.equal(f.model.calls.length, 2);
});

test('send now preserves the original task, waits for it to settle, suppresses its late reply and prioritizes the added instruction', async t => {
  const f = await fixture(t, {ignoreAbort: (_call, index) => index === 0}), owner = await f.register('interrupt_owner'), id = await f.room(owner);
  await f.send(owner, id, 'FIRST_ACTIVE_MARKER'); const active = await f.model.next(0);
  const older = await f.send(owner, id, 'OLDER_QUEUED_MARKER');
  const selected = await f.send(owner, id, 'SEND_NOW_MARKER');
  const path = `/api/rooms/${id}/queue/${selected.data.queueId}/send-now`;
  const promoted = await f.call(path, {auth: owner, body: {}});
  assert.equal(promoted.status, 202); assert.equal(promoted.data.interrupting, true);
  assert.equal(active.signal.aborted, true); assert.equal(active.settled, false);
  const pending = await f.detail(owner, id);
  assert.equal(pending.busy, true);
  assert.equal(pending.queue[0].id, selected.data.queueId);
  assert.equal(f.model.calls.length, 1, 'aborting the signal does not mean the old operation has actually stopped');
  active.finish('LATE_CANCELLED_REPLY_MARKER');
  const now = await f.model.next(1);
  assert.match(currentRequestText(now.request), /FIRST_ACTIVE_MARKER/);
  assert.match(currentRequestText(now.request), /SEND_NOW_MARKER/);
  assert.match(now.request.user, /SEND_NOW_MARKER/);
  assert.doesNotMatch(now.request.user, /OLDER_QUEUED_MARKER|LATE_CANCELLED_REPLY_MARKER/);
  now.finish('send now done');
  const later = await f.model.next(2);
  assert.match(later.request.user, /OLDER_QUEUED_MARKER/); later.finish('older done');
  const done = await f.idle(owner, id);
  assert.ok(!done.messages.some(item => item.text === 'LATE_CANCELLED_REPLY_MARKER'));
  assert.ok(!done.messages.some(item => item.kind === 'system' && /완료하지 못|반환하지 않았/.test(item.text)), 'intentional interruption is not a model error');
  assert.deepEqual(done.messages.filter(item => item.kind === 'human').map(item => item.text), ['FIRST_ACTIVE_MARKER', 'SEND_NOW_MARKER', 'OLDER_QUEUED_MARKER']);
  assert.equal(f.model.peak, 1);
  assert.notEqual(older.data.queueId, selected.data.queueId);
});

test('repeated send-now instructions retain the original request and each preceding steering instruction', async t => {
  const f = await fixture(t, {ignoreAbort: () => true}), owner = await f.register('steering_owner'), id = await f.room(owner);
  await f.send(owner, id, 'ORIGINAL_TASK_MARKER'); await f.model.next(0);
  const firstSteer = await f.send(owner, id, 'FIRST_STEER_MARKER');
  assert.equal((await f.call(`/api/rooms/${id}/queue/${firstSteer.data.queueId}/send-now`, {auth: owner, body: {}})).status, 202);
  f.model.calls[0].finish('discard first late output');
  await f.model.next(1);
  const secondSteer = await f.send(owner, id, 'SECOND_STEER_MARKER');
  assert.equal((await f.call(`/api/rooms/${id}/queue/${secondSteer.data.queueId}/send-now`, {auth: owner, body: {}})).status, 202);
  f.model.calls[1].finish('discard second late output');
  const continued = await f.model.next(2);
  const currentRequest = currentRequestText(continued.request);
  for (const marker of ['ORIGINAL_TASK_MARKER', 'FIRST_STEER_MARKER', 'SECOND_STEER_MARKER']) assert.match(currentRequest, new RegExp(marker));
  assert.ok(currentRequest.indexOf('ORIGINAL_TASK_MARKER') < currentRequest.indexOf('FIRST_STEER_MARKER'));
  assert.ok(currentRequest.indexOf('FIRST_STEER_MARKER') < currentRequest.indexOf('SECOND_STEER_MARKER'));
  continued.finish('combined task done');
  const done = await f.idle(owner, id);
  assert.deepEqual(done.messages.filter(item => item.kind === 'bot').map(item => item.text), ['combined task done']);
  assert.equal(f.model.peak, 1);
});

for (const scenario of [
  {name: 'an added instruction with no selected bot inherits the active bot', text: 'ALSO_DO_THIS_MARKER', botIds: []},
  {name: 'a literal model instruction steers the active task instead of opening the model list', text: 'model', botIds: ['bot-analyst']},
]) test(scenario.name, async t => {
  const f = await fixture(t), owner = await f.register('steer_selection_owner'), id = await f.room(owner);
  await f.send(owner, id, 'KEEP_ORIGINAL_TASK_MARKER', {botIds: ['bot-creative']});
  await f.model.next(0);
  const queued = await f.send(owner, id, scenario.text, {botIds: scenario.botIds});
  assert.equal(queued.status, 202); assert.equal(queued.data.queued, true);
  const promoted = await f.call(`/api/rooms/${id}/queue/${queued.data.queueId}/send-now`, {auth: owner, body: {}});
  assert.equal(promoted.status, 202); assert.equal(promoted.data.interrupting, true);
  const continued = await f.model.next(1);
  assert.equal(continued.request.isolation.botId, 'bot-creative');
  const currentRequest = currentRequestText(continued.request);
  assert.match(currentRequest, /KEEP_ORIGINAL_TASK_MARKER/);
  assert.ok(currentRequest.includes(scenario.text));
  continued.finish('original task with instruction completed');
  const done = await f.idle(owner, id);
  assert.deepEqual(done.messages.filter(item => item.kind === 'bot').map(item => item.text), ['original task with instruction completed']);
  assert.deepEqual(done.messages.filter(item => item.kind === 'human').map(item => item.text), ['KEEP_ORIGINAL_TASK_MARKER', scenario.text]);
  assert.equal(f.model.peak, 1);
});

test('restart resumes only unstarted queue entries and never replays the operation already dispatched', async t => {
  const f = await fixture(t), owner = await f.register('restart_owner'), id = await f.room(owner);
  await f.send(owner, id, 'INITIAL_REQUEST_MARKER');
  await f.model.next(0);
  const dispatchedPayload = {clientNonce: 'dispatched-before-restart'};
  const before = await f.send(owner, id, 'ALREADY_DISPATCHED_MARKER', dispatchedPayload);
  assert.equal(before.data.queued, true);
  const payload = {clientNonce: 'waiting-through-restart'};
  const queued = await f.send(owner, id, 'WAITING_RESTART_MARKER', payload);
  assert.equal(queued.data.queued, true);
  f.model.calls[0].finish('initial done');
  await f.model.next(1);
  await f.restart();
  const resumed = await f.model.next(0);
  assert.match(currentRequestText(resumed.request), /WAITING_RESTART_MARKER/);
  assert.doesNotMatch(currentRequestText(resumed.request), /ALREADY_DISPATCHED_MARKER/);
  resumed.finish('resumed once');
  const done = await f.idle(owner, id);
  assert.equal(f.model.calls.length, 1);
  assert.deepEqual(done.messages.filter(item => item.kind === 'human').map(item => item.text), ['INITIAL_REQUEST_MARKER', 'ALREADY_DISPATCHED_MARKER', 'WAITING_RESTART_MARKER']);
  const dispatchedRetry = await f.send(owner, id, 'ALREADY_DISPATCHED_MARKER', dispatchedPayload);
  assert.equal(dispatchedRetry.status, 202);
  assert.equal(dispatchedRetry.data.messageId, done.messages.find(item => item.text === 'ALREADY_DISPATCHED_MARKER').id);
  const retry = await f.send(owner, id, 'WAITING_RESTART_MARKER', payload);
  assert.equal(retry.status, 202);
  assert.equal(retry.data.messageId, done.messages.find(item => item.text === 'WAITING_RESTART_MARKER').id);
  assert.equal(f.model.calls.length, 1);
});

test('queued mobile input preserves its workspace target and exact text only for that request', async t => {
  const f = await fixture(t), owner = await f.register('mobile_fifo'), id = await f.room(owner);
  await f.send(owner, id, '앞선 일반 대화');
  const active = await f.model.next(0);
  const queued = await f.send(owner, id, '설정 열어줘', {workspaceContext:'mobile'});
  assert.equal(queued.data.queued,true);
  const payload=JSON.parse(f.app.db.prepare('SELECT payload FROM message_queue WHERE id=?').get(queued.data.queueId).payload);
  assert.equal(payload.workspaceContext,'mobile');
  assert.equal(payload.text,'설정 열어줘');
  active.finish('앞선 답변');
  const mobile = await f.model.next(1);
  assert.equal(currentRequestText(mobile.request),'설정 열어줘');
  assert.match(mobile.request.system,/작업 공간 맥락:.*현재 대화의 모바일 입력창/);
  mobile.finish('설정 결과');
  await f.idle(owner,id);
  await f.send(owner,id,'뒤의 일반 대화');
  const ordinary = await f.model.next(2);
  assert.doesNotMatch(ordinary.request.system,/작업 공간 맥락:/);
  ordinary.finish('일반 답변');
  const done=await f.idle(owner,id);
  assert.deepEqual(done.messages.filter(message=>message.kind==='human').map(message=>message.text),['앞선 일반 대화','설정 열어줘','뒤의 일반 대화']);
});

for (const mobileFirst of [true,false]) test(`send now retains mobile workspace context when ${mobileFirst?'the original':'the added'} request comes from mobile`, async t => {
  const f = await fixture(t), owner = await f.register('mobile_steer'), id = await f.room(owner);
  await f.send(owner,id,'설정 열어줘',mobileFirst?{workspaceContext:'mobile'}:{});
  await f.model.next(0);
  const queued = await f.send(owner,id,'밝기도 내려줘',mobileFirst?{}:{workspaceContext:'mobile'});
  assert.equal((await f.call(`/api/rooms/${id}/queue/${queued.data.queueId}/send-now`,{auth:owner,body:{}})).status,202);
  const resumed = await f.model.next(1);
  assert.match(resumed.request.system,/작업 공간 맥락:.*현재 대화의 모바일 입력창/);
  assert.match(currentRequestText(resumed.request),/설정 열어줘/);
  assert.match(currentRequestText(resumed.request),/밝기도 내려줘/);
  const second = await f.send(owner,id,'소리도 줄여줘');
  assert.equal((await f.call(`/api/rooms/${id}/queue/${second.data.queueId}/send-now`,{auth:owner,body:{}})).status,202);
  const repeated = await f.model.next(2);
  assert.match(repeated.request.system,/작업 공간 맥락:.*현재 대화의 모바일 입력창/);
  assert.match(currentRequestText(repeated.request),/설정 열어줘/);
  assert.match(currentRequestText(repeated.request),/소리도 줄여줘/);
  repeated.finish('추가 요청 완료');
  await f.idle(owner,id);
});

test('mobile workspace context survives restart of an unstarted queued request', async t => {
  const f = await fixture(t), owner = await f.register('mobile_restart'), id = await f.room(owner);
  await f.send(owner,id,'진행 중');
  await f.model.next(0);
  const queued = await f.send(owner,id,'설정 열어줘',{workspaceContext:'mobile'});
  assert.equal(queued.data.queued,true);
  await f.restart();
  const resumed=await f.model.next(0);
  assert.equal(currentRequestText(resumed.request),'설정 열어줘');
  assert.match(resumed.request.system,/작업 공간 맥락:.*현재 대화의 모바일 입력창/);
  resumed.finish('재시작 후 완료');
  await f.idle(owner,id);
});
