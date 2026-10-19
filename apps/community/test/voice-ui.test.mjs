import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {callReply, speechText, callLink, createSpeechGate} from '../public/voice-session.mjs';

const source = readFileSync(new URL('../public/voice-call.js', import.meta.url), 'utf8')
  .replace(/^import .*?;\s*/m, '').replace('export function createVoiceCall', 'function createVoiceCall');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return {promise, resolve, reject}; };
function setup({apiResult, acquire, resume, native = false} = {}) {
  class Element {
    constructor(tag) { this.tagName = tag; this.dataset = {}; this.handlers = {}; this.attributes = {}; this.nodes = new Map(); this.hidden = false; this.disabled = false; this.textContent = ''; this.classList = {add() {}, remove() {}}; this.style = {setProperty() {}}; }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, action) { this.handlers[name] = action; }
    querySelector(selector) { if (!this.nodes.has(selector)) this.nodes.set(selector, new Element(selector)); return this.nodes.get(selector); }
    showModal() { this.open = true; } close() { this.open = false; }
  }
  const body = new Element('body'), children = []; body.append = (...nodes) => children.push(...nodes);
  const document = {body, hidden: false, handlers: {}, createElement: tag => new Element(tag), querySelectorAll: () => [], addEventListener(name, action) { this.handlers[name] = action; }};
  let userId = 'owner', now = 0, nonce = 0, timerId = 0;
  const timers = new Map(), calls = [], updates = [], toasts = [], streams = [], recorders = [], contexts = [], spoken = [], nativeMessages = [];
  const rooms = [{id: 'one', name: '서버 관리'}, {id: 'two', name: '여행 계획'}];
  const stream = () => { const track = {stops: 0, stop() { this.stops++; }}; const value = {track, getTracks: () => [track]}; streams.push(value); return value; };
  class AudioContext {
    constructor() { contexts.push(this); this.closed = false; this.rms = 0; }
    resume() { return resume ? resume(this) : Promise.resolve(); }
    close() { this.closed = true; return Promise.resolve(); }
    createMediaStreamSource() { return {connect() {}, disconnect() {}}; }
    createAnalyser() { return {fftSize: 2048, getFloatTimeDomainData: values => values.fill(this.rms)}; }
  }
  class MediaRecorder {
    static isTypeSupported(type) { return type.includes('webm'); }
    constructor(stream, options) { this.stream = stream; this.state = 'inactive'; this.mimeType = options?.mimeType || 'audio/webm'; recorders.push(this); }
    start() { this.state = 'recording'; }
    stop() { if (this.state !== 'recording') throw new Error('already stopped'); this.state = 'inactive'; queueMicrotask(() => { this.ondataavailable?.({data: new Blob(['audio'], {type: this.mimeType})}); this.onstop?.(); }); }
  }
  const speechSynthesis = {cancels: 0, getVoices: () => [{lang: 'ko-KR'}], cancel() { this.cancels++; }, speak(value) { if (!value.text.trim()) return; spoken.push(value); }};
  const window = {handlers: {}, AudioContext, MediaRecorder, speechSynthesis, addEventListener(name, action) { this.handlers[name] = action; }};
  if (native) window.webkit = {messageHandlers: {cloudbotCall: {postMessage: value => nativeMessages.push(value)}}};
  if (native === 2) window.cloudbotNativeVoice = {version: 2};
  const navigator = {mediaDevices: {getUserMedia: () => acquire ? acquire(stream) : Promise.resolve(stream())}, clipboard: {writeText: async () => {}}};
  const context = {window, document, navigator, location: {origin: 'https://bots.example.org', href: 'https://bots.example.org/'}, history: {replaceState() {}}, callReply, speechText, callLink, createSpeechGate, AudioContext, MediaRecorder, speechSynthesis, SpeechSynthesisUtterance: class {constructor(text) {this.text = text;}}, crypto: {randomUUID: () => `id-${++nonce}`}, AbortController, AbortSignal, DOMException, FormData, Blob, URL, Date, Float32Array, performance: {now: () => now}, setTimeout: (fn, ms) => { timers.set(++timerId, {fn, ms}); return timerId; }, clearTimeout: id => timers.delete(id), setInterval: (fn, ms) => { timers.set(++timerId, {fn, ms, interval: true}); return timerId; }, clearInterval: id => timers.delete(id)};
  vm.runInNewContext(source + '\nthis.createVoiceCall = createVoiceCall;', context);
  let responseNumber = 0;
  const defaultApi = async (path, options) => {
    if (path === '/api/voice') return {configured: true, maxSeconds: 30, maxBytes: 100000};
    if (path.endsWith('/voice/transcribe')) return {text: '서버 상태 알려줘'};
    if (path.endsWith('/messages')) return {messageId: `accepted-${++responseNumber}`};
    return {room: rooms[0], busy: false, messages: responseNumber ? [{id: `accepted-${responseNumber}`, kind: 'human'}, {id: `reply-${responseNumber}`, kind: 'bot', text: '서버는 정상이에요.'}] : []};
  };
  const ui = context.createVoiceCall({api: async (path, options) => { calls.push({path, options}); return apiResult ? apiResult(path, options, defaultApi) : defaultApi(path, options); }, getSession: () => userId ? {user: {id: userId}} : null, getRoom: id => rooms.find(room => room.id === id), getSelection: () => ({botIds: ['assistant'], model: 'selected-model', effort: 'high'}), onMessages: id => updates.push(id), toast: text => toasts.push(text)});
  const dialog = children[0];
  return {ui, rooms, calls, updates, streams, recorders, contexts, spoken, nativeMessages, timers, toasts, document, window, location: context.location, dialog, pill: children[1], node: selector => dialog.querySelector(selector), get stage() { return dialog.dataset.stage; }, async start(room = rooms[0]) { ui.open(room); await tick(); }, click(selector) { dialog.querySelector(selector).onclick(); }, setUser(id) { userId = id; }, sample(rms, elapsed = 60) { now += elapsed; contexts.at(-1).rms = rms; for (const timer of [...timers.values()]) if (timer.interval && timer.ms === 60) timer.fn(); }, phrase() { for (let i = 0; i < 3; i++) this.sample(0.1); }, async endPhrase() { this.phrase(); this.click('.voice-send'); await tick(); }, emitNative(detail) { window.handlers['cloudbot:native-call']({detail}); }, nativeEvent(action, roomId = 'one') { window.handlers['cloudbot:native-call']({detail: {action, roomId}}); }};
}

test('phone button starts once immediately; reopening its screen does not acquire a second microphone', async () => {
  const app = setup();
  app.ui.open(app.rooms[0]);
  assert.equal(app.dialog.open, true);
  assert.equal(app.stage, 'connecting');
  assert.equal(app.node('.voice-start').hidden, true);
  app.ui.open(app.rooms[0]);
  await tick();
  assert.equal(app.stage, 'listening');
  assert.equal(app.calls.filter(call => call.path === '/api/voice').length, 1);
  assert.equal(app.streams.length, 1);
  assert.equal(app.node('h2').textContent, '서버 관리');
  assert.match(app.node('.voice-call-time').textContent, /^0:0[0-9]$/);
  app.ui.reset();
});

test('opening a phone screen without a signed-in user never starts audio or a request', async () => {
  const app = setup(); app.setUser(null); app.ui.open(app.rooms[0]); await tick();
  assert.equal(app.dialog.open, undefined); assert.equal(app.ui.roomId, null);
  assert.equal(app.calls.length, 0); assert.equal(app.streams.length, 0);
  assert.match(app.toasts.at(-1), /로그인/);
});

test('an external call link waits for an audio gesture but preserves the exact linked conversation', async () => {
  const app = setup(); app.location.href = 'https://bots.example.org/?room=two&call=1';
  app.ui.handleLink(); await tick();
  assert.equal(app.dialog.open, true);
  assert.equal(app.stage, 'ready');
  assert.equal(app.node('.voice-start').hidden, false);
  assert.equal(app.calls.length, 0); assert.equal(app.streams.length, 0);
  app.click('.voice-start'); await tick();
  assert.equal(app.ui.roomId, 'two');
  assert.equal(app.calls.some(call => call.path === '/api/rooms/two'), true);
  app.ui.reset();
});

test('minimizing keeps the same call; hangup returns to chat and releases capture', async () => {
  const app = setup(); await app.start();
  app.click('.voice-minimize');
  assert.equal(app.dialog.open, false); assert.equal(app.pill.hidden, false);
  assert.equal(app.ui.roomId, 'one'); assert.equal(app.streams[0].track.stops, 0);
  app.pill.onclick();
  assert.equal(app.dialog.open, true); assert.equal(app.pill.hidden, true);
  app.click('.voice-end');
  assert.equal(app.dialog.open, false); assert.equal(app.pill.hidden, true);
  assert.equal(app.ui.roomId, null); assert.equal(app.streams[0].track.stops, 1);
  assert.equal(app.timers.size, 0);
});

test('automatic start preserves microphone permission failures and offers an explicit retry', async () => {
  let attempts = 0;
  const app = setup({acquire: create => ++attempts === 1 ? Promise.reject(new DOMException('Denied', 'NotAllowedError')) : Promise.resolve(create())});
  await app.start();
  assert.equal(app.stage, 'ended'); assert.equal(app.ui.roomId, null);
  assert.equal(app.dialog.open, true); assert.equal(app.node('.voice-start').hidden, false);
  assert.match(app.node('.voice-call-status').textContent, /마이크 권한/);
  assert.equal(app.calls.some(call => call.path.endsWith('/messages')), false);
  app.click('.voice-start'); await tick();
  assert.equal(app.stage, 'listening'); assert.equal(attempts, 2);
  app.click('.voice-mute');
  assert.equal(app.node('.voice-mute').attributes['aria-label'], '마이크 켜기');
  assert.equal(app.node('.voice-mute').attributes['aria-pressed'], 'true');
  app.ui.reset();
});

test('unavailable capabilities or room access never request microphone capture', async () => {
  for (const failure of ['busy', 'forbidden', 'not-configured']) {
    const app = setup({apiResult: (path, options, fallback) => {
      if (failure === 'not-configured' && path === '/api/voice') return {configured: false};
      if (path === '/api/rooms/one' && failure === 'busy') return {busy: true};
      if (path === '/api/rooms/one' && failure === 'forbidden') throw Object.assign(new Error('권한이 없어요'), {status: 403});
      return fallback(path, options);
    }});
    await app.start();
    assert.equal(app.stage, 'ended'); assert.equal(app.ui.roomId, null);
    assert.equal(app.streams.length, 0); assert.equal(app.timers.size, 0);
    app.ui.reset();
  }
});

test('navigation keeps the call, transcript, message request and spoken reply bound to its original room', async () => {
  const app = setup(); await app.start();
  assert.equal(app.stage, 'listening');
  app.ui.open(app.rooms[1]);
  assert.equal(app.ui.roomId, 'one');
  assert.match(app.toasts.at(-1), /서버 관리/);
  await app.endPhrase();
  const message = app.calls.find(call => call.path.endsWith('/messages'));
  assert.equal(message.path, '/api/rooms/one/messages');
  const payload = JSON.parse(message.options.body);
  assert.equal(payload.model, 'selected-model'); assert.equal(payload.effort, 'high');
  assert.deepEqual(payload.botIds, ['assistant']); assert.match(payload.clientNonce, /^call:id-1:1$/);
  assert.equal(app.calls.some(call => call.path.includes('/two')), false);
  assert.deepEqual(app.updates, ['one', 'one']); assert.equal(app.spoken[0].text, '서버는 정상이에요.');
  app.ui.reset(); assert.equal(app.timers.size, 0);
});

test('each completed utterance sends once, ignores repeated finish clicks, and gets a distinct nonce', async () => {
  const app = setup(); await app.start(); app.phrase(); app.click('.voice-send'); app.click('.voice-send'); await tick();
  assert.equal(app.calls.filter(call => call.path.endsWith('/messages')).length, 1);
  app.spoken[0].onend(); await tick(); await app.endPhrase();
  const requests = app.calls.filter(call => call.path.endsWith('/messages')).map(call => JSON.parse(call.options.body));
  assert.equal(requests.length, 2); assert.notEqual(requests[0].clientNonce, requests[1].clientNonce);
  assert.equal(requests.every(item => item.text === '서버 상태 알려줘'), true); app.ui.reset();
});

test('silence never posts a message and a natural pause submits a voiced phrase', async () => {
  const app = setup(); await app.start(); app.sample(0); app.sample(0, 30000); await tick();
  assert.equal(app.calls.some(call => call.path.endsWith('/voice/transcribe')), false);
  assert.equal(app.stage, 'listening'); app.phrase(); app.sample(0, 1200); await tick();
  assert.equal(app.calls.filter(call => call.path.endsWith('/messages')).length, 1); app.ui.reset();
});

test('logout or explicit hangup prevents late transcription from submitting privileged commands', async () => {
  for (const stop of ['logout', 'hangup']) {
    const pending = deferred();
    const app = setup({apiResult: (path, options, fallback) => path.endsWith('/voice/transcribe') ? pending.promise : fallback(path, options)});
    await app.start(); await app.endPhrase();
    const upload = app.calls.find(call => call.path.endsWith('/voice/transcribe'));
    if (stop === 'logout') { app.setUser(null); app.ui.reset(); } else app.click('.voice-end');
    pending.resolve({text: '서버 파일을 삭제해'}); await tick();
    assert.equal(upload.options.signal.aborted, true); assert.equal(app.calls.some(call => call.path.endsWith('/messages')), false);
    assert.equal(app.spoken.length, 0); assert.equal(app.timers.size, 0); assert.equal(app.streams.every(stream => stream.track.stops > 0), true);
  }
});

test('account replacement discards an old transcription even before the integration resets UI', async () => {
  const pending = deferred(), app = setup({apiResult: (path, options, fallback) => path.endsWith('/voice/transcribe') ? pending.promise : fallback(path, options)});
  await app.start(); await app.endPhrase(); app.setUser('invited-user'); pending.resolve({text: 'root 명령'}); await tick();
  assert.equal(app.calls.some(call => call.path.endsWith('/messages')), false); assert.equal(app.spoken.length, 0); app.ui.reset();
});

test('ending during microphone acquisition stops the late stream without starting a recorder', async () => {
  const pending = deferred(); let makeStream;
  const app = setup({acquire: create => {makeStream = create; return pending.promise;}});
  await app.start(); app.ui.reset(); const stream = makeStream(); pending.resolve(stream); await tick();
  assert.equal(stream.track.stops, 1); assert.equal(app.recorders.length, 0); assert.equal(app.ui.roomId, null); assert.equal(app.timers.size, 0);
});

test('mute/unmute during acquisition cannot create simultaneous recorders or leak a stale microphone', async () => {
  const acquisitions = [];
  const app = setup({acquire: create => {const result = deferred(); acquisitions.push({result, stream: create()}); return result.promise;}});
  await app.start(); assert.equal(acquisitions.length, 1);
  app.click('.voice-mute'); app.click('.voice-mute'); await tick();
  // Either serialization or generation cancellation is valid, but at most one capture may remain active.
  for (const item of acquisitions) item.result.resolve(item.stream); await tick();
  assert.equal(app.recorders.filter(recorder => recorder.state === 'recording').length, 1);
  assert.equal(app.streams.filter(stream => stream.track.stops === 0).length, 1);
  app.ui.reset(); assert.equal(app.streams.every(stream => stream.track.stops > 0), true);
});

test('mute during AudioContext resume cannot resume recording or render listening', async () => {
  const pending = deferred(); let resumes = 0;
  const app = setup({resume: () => ++resumes === 1 ? Promise.resolve() : pending.promise});
  await app.start(); app.click('.voice-mute'); pending.resolve(); await tick();
  assert.equal(app.stage, 'muted'); assert.equal(app.recorders.filter(recorder => recorder.state === 'recording').length, 0);
  assert.equal(app.streams.every(stream => stream.track.stops > 0), true); app.ui.reset();
});

test('mute/unmute during initial capability checks does not acquire audio before setup is complete', async () => {
  const pending = deferred();
  const app = setup({apiResult: (path, options, fallback) => path === '/api/voice' ? pending.promise : fallback(path, options)});
  await app.start(); app.click('.voice-mute'); app.click('.voice-mute'); await tick();
  assert.equal(app.streams.length, 0);
  pending.resolve({configured: true, maxSeconds: 30, maxBytes: 100000}); await tick();
  assert.equal(app.recorders.filter(recorder => recorder.state === 'recording').length, 1); app.ui.reset();
});

test('a competing human turn stops the call instead of reading their reply aloud', async () => {
  let submitted = false;
  const app = setup({apiResult: (path, options, fallback) => {
    if (path.endsWith('/messages')) {submitted = true; return {messageId: 'mine'};}
    if (path === '/api/rooms/one' && submitted) return {room: {name: '서버 관리'}, messages: [{id: 'mine', kind: 'human'}, {id: 'other', kind: 'human'}, {kind: 'bot', text: '다른 사람의 비밀'}]};
    return fallback(path, options);
  }});
  await app.start(); await app.endPhrase(); assert.equal(app.spoken.length, 0); assert.equal(app.stage, 'ended'); assert.match(app.node('.voice-call-status').textContent, /다른 메시지/); app.ui.reset();
});

test('native setup stays on the chosen room and waits for the matching call activation', async () => {
  const app = setup({native: true}); await app.start();
  assert.equal(app.streams.length, 0); assert.equal(app.nativeMessages[0].action, 'start'); assert.equal(app.nativeMessages[0].roomId, 'one'); assert.equal(app.nativeMessages[0].roomTitle, '서버 관리');
  app.nativeEvent('active', 'two'); await tick(); assert.equal(app.streams.length, 0);
  app.nativeEvent('active'); await tick(); assert.equal(app.stage, 'listening');
  app.ui.reset(); assert.equal(app.nativeMessages.at(-1).action, 'end'); assert.equal(app.timers.size, 0);
});

test('page hiding immediately hangs up and closes all active microphone tracks', async () => {
  const app = setup(); await app.start(); app.document.hidden = true; app.document.handlers.visibilitychange();
  assert.equal(app.ui.roomId, null); assert.equal(app.stage, 'ended'); assert.equal(app.streams.every(stream => stream.track.stops > 0), true); assert.equal(app.timers.size, 0);
});

test('errors from a discarded capture cannot terminate its replacement microphone', async () => {
  const app = setup(); await app.start(); const discarded = app.recorders.at(-1), queuedError = discarded.onerror;
  app.click('.voice-mute'); app.click('.voice-mute'); await tick();
  assert.notEqual(app.recorders.at(-1), discarded); assert.equal(app.stage, 'listening');
  queuedError(); await tick();
  assert.equal(app.ui.roomId, 'one'); assert.equal(app.stage, 'listening');
  assert.equal(app.recorders.at(-1).state, 'recording'); app.ui.reset();
});

test('native mute events operate on the active room only and cannot restart audio during reply playback', async () => {
  const app = setup({native: true}); await app.start(); app.nativeEvent('active'); await tick();
  app.nativeEvent('muted', 'two'); assert.equal(app.stage, 'listening');
  app.nativeEvent('muted'); assert.equal(app.stage, 'muted'); assert.equal(app.streams.every(stream => stream.track.stops > 0), true);
  app.nativeEvent('unmuted'); await tick(); await app.endPhrase(); assert.equal(app.stage, 'speaking');
  const count = app.streams.length;
  app.nativeEvent('muted'); app.nativeEvent('unmuted'); await tick();
  assert.equal(app.streams.length, count); assert.equal(app.stage, 'speaking');
  app.spoken[0].onend(); await tick(); assert.equal(app.stage, 'listening'); app.ui.reset();
});

test('hangup while a reply is playing cancels speech and never reacquires the microphone', async () => {
  const app = setup(); await app.start(); await app.endPhrase(); const count = app.streams.length;
  assert.equal(app.stage, 'speaking'); app.click('.voice-end'); app.spoken[0].onend(); await tick();
  assert.equal(app.streams.length, count); assert.equal(app.ui.roomId, null); assert.equal(app.timers.size, 0);
});

test('one transport retry preserves the exact message and nonce without duplicating a new turn', async () => {
  let attempts = 0;
  const app = setup({apiResult: (path, options, fallback) => {
    if (path.endsWith('/messages') && ++attempts === 1) throw new TypeError('Failed to fetch');
    return fallback(path, options);
  }});
  await app.start(); await app.endPhrase();
  const requests = app.calls.filter(call => call.path.endsWith('/messages'));
  assert.equal(requests.length, 2); assert.equal(requests[0].options.body, requests[1].options.body);
  assert.equal(JSON.parse(requests[1].options.body).clientNonce, 'call:id-1:1');
  assert.equal(app.spoken.length, 1); app.ui.reset();
});

test('an account change during failed message transport prevents retry under the new actor', async () => {
  const pending = deferred();
  const app = setup({apiResult: (path, options, fallback) => path.endsWith('/messages') ? pending.promise : fallback(path, options)});
  await app.start(); await app.endPhrase(); app.setUser('different-user'); pending.reject(new TypeError('Failed to fetch')); await tick();
  assert.equal(app.calls.filter(call => call.path.endsWith('/messages')).length, 1);
  assert.equal(app.ui.roomId, null); assert.equal(app.spoken.length, 0); assert.equal(app.timers.size, 0);
});

test('message retries are bounded and never repeat rejected, aborted or timed-out requests', async () => {
  for (const error of [Object.assign(new Error('forbidden'), {status: 403}), new DOMException('ended', 'AbortError'), new DOMException('timeout', 'TimeoutError'), new TypeError('Failed to fetch')]) {
    const app = setup({apiResult: (path, options, fallback) => { if (path.endsWith('/messages')) throw error; return fallback(path, options); }});
    await app.start(); await app.endPhrase();
    assert.equal(app.calls.filter(call => call.path.endsWith('/messages')).length, error instanceof TypeError ? 2 : 1);
    assert.equal(app.stage, 'ended'); assert.equal(app.spoken.length, 0); assert.equal(app.timers.size, 0);
  }
});

test('a superseded microphone acquisition rejection cannot end the replacement capture', async () => {
  const pending = deferred(); let acquisitions = 0;
  const app = setup({acquire: create => ++acquisitions === 1 ? pending.promise : Promise.resolve(create())});
  await app.start(); app.click('.voice-mute'); app.click('.voice-mute'); await tick();
  assert.equal(app.stage, 'listening'); assert.equal(app.recorders.at(-1).state, 'recording');
  pending.reject(new DOMException('old permission request failed', 'NotAllowedError')); await tick();
  assert.equal(app.ui.roomId, 'one'); assert.equal(app.stage, 'listening');
  assert.equal(app.recorders.at(-1).state, 'recording'); app.ui.reset();
});

test('native v2 owns all audio and requests; web buttons send only room-bound controls', async () => {
  const app = setup({native: 2});
  // Native calling also works when the WebView offers no browser recording or TTS APIs.
  delete app.window.MediaRecorder; delete app.window.AudioContext; delete app.window.speechSynthesis;
  await app.start();
  assert.equal(app.calls.length, 0); assert.equal(app.streams.length, 0); assert.equal(app.contexts.length, 0);
  assert.equal(app.nativeMessages[0].action, 'start'); assert.equal(app.nativeMessages[0].model, 'selected-model');
  assert.equal(app.nativeMessages[0].effort, 'high'); assert.equal(app.nativeMessages[0].roomId, 'one');
  app.emitNative({action: 'state', roomId: 'two', userId: 'owner', state: 'listening'});
  assert.equal(app.stage, 'connecting');
  app.emitNative({action: 'state', roomId: 'one', userId: 'owner', title: '서버 관리', state: 'listening', startedAt: Date.now()});
  assert.equal(app.stage, 'listening'); app.ui.open(app.rooms[1]); assert.equal(app.ui.roomId, 'one');
  app.click('.voice-send'); assert.equal(app.nativeMessages.at(-1).action, 'finish');
  app.click('.voice-mute'); assert.equal(app.nativeMessages.at(-1).action, 'mute'); assert.equal(app.nativeMessages.at(-1).muted, true);
  app.emitNative({action: 'state', roomId: 'one', userId: 'owner', state: 'muted', muted: true});
  assert.equal(app.node('.voice-mute').attributes['aria-label'], '마이크 켜기');
  assert.equal(app.recorders.length, 0); assert.equal(app.spoken.length, 0); assert.equal(app.calls.length, 0);
  app.ui.reset(); assert.equal(app.nativeMessages.some(item => item.action === 'logout'), true); assert.equal(app.timers.size, 0);
});

test('native v2 survives page hide and lock; foreground asks for authoritative state', async () => {
  const app = setup({native: 2}); await app.start();
  app.emitNative({action: 'state', roomId: 'one', userId: 'owner', state: 'listening'});
  app.document.hidden = true; app.document.handlers.visibilitychange(); app.window.handlers.pagehide();
  assert.equal(app.ui.roomId, 'one'); assert.equal(app.nativeMessages.some(item => item.action === 'end'), false);
  app.document.hidden = false; app.document.handlers.visibilitychange();
  assert.equal(app.nativeMessages.at(-1).action, 'status');
  app.emitNative({action: 'state', roomId: 'one', userId: 'owner', state: 'speaking', text: '완료했어요.'});
  assert.equal(app.stage, 'speaking'); assert.equal(app.node('.voice-call-transcript').textContent, '완료했어요.');
  assert.equal(app.spoken.length, 0); app.click('.voice-end'); assert.equal(app.nativeMessages.at(-1).action, 'end');
  assert.equal(app.ui.roomId, null); app.ui.reset();
});

test('native v2 restores a call display after reload only for the authenticated actor', () => {
  const app = setup({native: 2});
  const snapshot = {action: 'state', roomId: 'two', userId: 'owner', title: '여행 계획', state: 'listening', startedAt: Date.now()};
  app.emitNative({...snapshot, userId: 'other'}); assert.equal(app.ui.roomId, null);
  app.emitNative({...snapshot, userId: undefined}); assert.equal(app.ui.roomId, null);
  app.setUser(null); app.emitNative(snapshot); assert.equal(app.ui.roomId, null);
  app.setUser('owner'); app.ui.syncSession(); assert.equal(app.nativeMessages.at(-1).action, 'session');
  app.emitNative(snapshot); assert.equal(app.ui.roomId, 'two'); assert.equal(app.node('h2').textContent, '여행 계획');
  assert.equal(app.calls.length, 0); assert.equal(app.streams.length, 0);
  app.emitNative({action: 'state', roomId: '', state: 'ended'}); assert.equal(app.ui.roomId, null); assert.equal(app.timers.size, 0);
});

test('native v2 logout ends the native call and ignores late state from the old actor', async () => {
  const app = setup({native: 2}); await app.start();
  app.setUser(null); app.ui.reset();
  assert.equal(app.nativeMessages.some(item => item.action === 'logout'), true);
  app.emitNative({action: 'state', roomId: 'one', userId: 'owner', state: 'speaking', text: 'private reply'});
  assert.equal(app.ui.roomId, null); assert.equal(app.node('.voice-call-transcript').textContent, '');
  app.setUser('other'); app.emitNative({action: 'state', roomId: 'one', userId: 'owner', state: 'listening'});
  assert.equal(app.ui.roomId, null); assert.equal(app.spoken.length, 0);
});

test('frozen sources reject phone buttons, external links and native call resume before audio starts', async () => {
  for (const native of [false, 2]) {
    const app = setup({native}); app.rooms[0].readOnly = true;
    await app.start();
    app.location.href = 'https://bots.example.org/?room=one&call=1';
    app.ui.handleLink(); await tick();
    assert.equal(app.ui.roomId, null); assert.equal(app.streams.length, 0);
    assert.equal(app.calls.length, 0); assert.match(app.toasts.at(-1), /새 가지/);
    if (native) {
      app.emitNative({action:'state',roomId:'one',userId:'owner',state:'listening'});
      assert.equal(app.ui.roomId, null);
      assert.equal(app.nativeMessages.at(-1).action, 'end');
    }
  }
});
test('an open call releases its microphone when a refreshed room becomes read only', async () => {
  const app = setup(); await app.start();
  assert.equal(app.streams.length, 1);
  app.rooms[0].readOnly = true; app.ui.handleLink(); await tick();
  assert.equal(app.ui.roomId, null);
  assert.equal(app.streams[0].track.stops, 1);
  assert.equal(app.calls.some(call => call.path.endsWith('/messages')), false);
});
test('a fork discovered by the call preflight never acquires a microphone', async () => {
  const app = setup({apiResult:(path,options,fallback)=>path==='/api/rooms/one'?{room:{id:'one',readOnly:true}}:fallback(path,options)});
  await app.start(); assert.equal(app.ui.roomId, null); assert.equal(app.streams.length, 0);
  assert.match(app.node('.voice-call-status').textContent, /새 가지/);
});
