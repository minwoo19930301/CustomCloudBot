import test from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash, randomUUID} from 'node:crypto';
import {once} from 'node:events';
import WebSocket, {WebSocketServer} from 'ws';
import {createDesktopMediaHub} from '../desktop-media.mjs';

const READY = {type:'ready', format:'s16le', sampleRate:48000, channels:1};
const STATUS = {ok:true, microphone:{supported:true, available:true, connected:false, muted:true}, camera:{supported:true, available:true}};
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fixture(t, options = {}) {
  const room = randomUUID(), user = {id:randomUUID(), sessionHash:'session-one'};
  const state = {owner:true, member:true, readOnly:false, user, status:STATUS, frames:[], requests:[], ready:true};
  const clients = new Set();
  const upstream = createServer((req, res) => {
    state.requests.push({url:req.url, headers:req.headers});
    res.setHeader('content-type', 'application/json');
    // Every fixture reuses the fixed internal port; avoid a pooled stale socket.
    res.setHeader('connection', 'close');
    res.end(JSON.stringify(state.status));
  });
  const bridge = new WebSocketServer({noServer:true, perMessageDeflate:false});
  upstream.on('upgrade', (req, socket, head) => {
    state.requests.push({url:req.url, headers:req.headers});
    bridge.handleUpgrade(req, socket, head, ws => {
      ws.on('error', () => {});
      ws.on('message', (data, binary) => state.frames.push({data, binary}));
      if (state.ready) ws.send(JSON.stringify(READY));
    });
  });
  await new Promise((resolve, reject) => { upstream.once('error', reject); upstream.listen(6084, '127.0.0.1', resolve); });
  const server = createServer();
  const desktops = new Map([[room, {cdpUrl:'http://127.0.0.1:9222/'}]]);
  let origin;
  const hub = createDesktopMediaHub({
    server, desktops,
    userFor:req => req.headers.cookie === 'session=one' ? state.user : null,
    roomFor:id => { if (!state.member || id !== room) throw Object.assign(new Error('Not a member'), {status:404}); return {id, readOnly:state.readOnly}; },
    originFor:() => origin,
    isOwner:account => state.owner && account.id === user.id,
    ...options,
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  function socket(path, overrides = {}) {
    const ws = new WebSocket(origin.replace('http:', 'ws:') + path, {headers:{origin, cookie:'session=one', ...overrides}});
    clients.add(ws); ws.on('error', () => {}); return ws;
  }
  async function connect(ticket) {
    const ws = socket((ticket || await hub.ticket(user, room)).websocketPath);
    const [data, binary] = await once(ws, 'message');
    assert.equal(binary, false); assert.deepEqual(JSON.parse(data.toString()), READY);
    return ws;
  }
  async function rejected(path, headers) {
    const ws = socket(path, headers);
    return new Promise((resolve, reject) => {
      ws.on('unexpected-response', (_request, response) => { const code = response.statusCode; response.resume(); ws.terminate(); resolve(code); });
      ws.on('open', () => reject(new Error('Connection unexpectedly accepted')));
      ws.on('error', error => { if (!String(error.message).includes('closed before')) reject(error); });
    });
  }
  t.after(async () => {
    hub.close();
    for (const ws of clients) ws.terminate();
    for (const ws of bridge.clients) ws.terminate();
    await new Promise(resolve => bridge.close(resolve));
    await new Promise(resolve => server.close(resolve));
    await new Promise(resolve => upstream.close(resolve));
  });
  return {room, user, state, hub, server, bridge, origin, desktops, socket, connect, rejected};
}

test('desktop media status uses only the internal bridge and exposes no unsupported camera', async t => {
  const f = await fixture(t);
  const result = await f.hub.status(f.user, f.room);
  assert.equal(result.configured, true);
  assert.equal(result.microphone.available, true);
  assert.equal(result.microphone.sampleRate, 48000);
  assert.deepEqual(result.camera, {supported:false, available:false, reason:'camera-transport-not-implemented'});
  assert.deepEqual(result.audioOutput, {supported:false});
  assert.equal(f.state.requests[0].url, '/status');
  assert.equal(f.state.requests[0].headers.cookie, undefined);
  assert.equal(f.state.requests[0].headers.authorization, undefined);
  f.desktops.set(f.room, {cdpUrl:'http://169.254.169.254/'});
  await assert.rejects(f.hub.status(f.user, f.room), {status:503});
  assert.equal(f.state.requests.length, 1);
});

test('status and tickets require an owner, membership and a writable room', async t => {
  const f = await fixture(t);
  await assert.rejects(f.hub.status(null, f.room), {status:401});
  f.state.owner = false;
  await assert.rejects(f.hub.ticket(f.user, f.room), {status:403});
  f.state.owner = true; f.state.member = false;
  await assert.rejects(f.hub.ticket(f.user, f.room), {status:404});
  f.state.member = true; f.state.readOnly = true;
  await assert.rejects(f.hub.ticket(f.user, f.room), {status:409});
  assert.equal(f.state.requests.length, 0);
});

test('tickets are cookie, origin, room and session bound and single use', async t => {
  const f = await fixture(t), ticket = await f.hub.ticket(f.user, f.room);
  assert.equal(ticket.maxFrameBytes, 8192);
  assert.equal(await f.rejected(ticket.websocketPath, {origin:'https://foreign.example'}), 403);
  assert.equal(await f.rejected(ticket.websocketPath, {cookie:'session=other'}), 401);
  assert.equal(await f.rejected(ticket.websocketPath.replace(f.room, randomUUID())), 404);
  f.state.user = {...f.user, sessionHash:'different-session'};
  assert.equal(await f.rejected(ticket.websocketPath), 403);
  f.state.user = f.user;
  const ws = await f.connect(ticket), close = once(ws, 'close');
  ws.close(); await close;
  assert.equal(await f.rejected(ticket.websocketPath), 403);
});

test('expired tickets cannot open the microphone', async t => {
  const f = await fixture(t), ticket = await f.hub.ticket(f.user, f.room);
  const originalNow = Date.now;
  Date.now = () => ticket.expiresAt + 1;
  try { assert.equal(await f.rejected(ticket.websocketPath), 403); }
  finally { Date.now = originalNow; }
  assert.equal(f.bridge.clients.size, 0);
});

test('PCM frames travel only to a hashed internal session without browser credentials', async t => {
  const f = await fixture(t), ws = await f.connect();
  const pcm = Buffer.alloc(1920); pcm.writeInt16LE(200, 0);
  ws.send(pcm);
  for (let attempt = 0; attempt < 50 && !f.state.frames.length; attempt++) await pause(5);
  assert.equal(f.state.frames.length, 1); assert.equal(f.state.frames[0].binary, true);
  assert.deepEqual(f.state.frames[0].data, pcm);
  const request = f.state.requests.find(row => row.url.startsWith('/microphone'));
  const session = createHash('sha256').update(f.user.id + '\0' + f.room).digest('hex');
  assert.equal(request.url, '/microphone?session=' + session);
  assert.equal(request.headers.cookie, undefined); assert.equal(request.headers.origin, undefined);
  assert.equal(request.headers.authorization, undefined);
  await assert.rejects(f.hub.ticket(f.user, f.room), {status:409});
});

for (const [name, change] of [
  ['owner revocation', state => { state.owner = false; }],
  ['membership revocation', state => { state.member = false; }],
  ['session revocation', state => { state.user = null; }],
  ['read-only transition', state => { state.readOnly = true; }],
]) test(`microphone stops before forwarding PCM after ${name}`, async t => {
  const f = await fixture(t), ws = await f.connect(), close = once(ws, 'close');
  change(f.state); ws.send(Buffer.alloc(1920)); await close;
  assert.equal(f.state.frames.length, 0);
  for (let attempt = 0; attempt < 50 && f.bridge.clients.size; attempt++) await pause(5);
  assert.equal(f.bridge.clients.size, 0);
});

test('an idle connection notices revoked access within the 10 second monitor', async t => {
  const f = await fixture(t), ws = await f.connect(), close = once(ws, 'close');
  f.state.member = false;
  const start = performance.now(); await close;
  assert.ok(performance.now() - start < 11000);
  assert.equal(f.state.frames.length, 0);
});

for (const [name, data, options] of [
  ['oversized frame', Buffer.alloc(8194), undefined],
  ['odd PCM frame', Buffer.alloc(3), undefined],
  ['text frame', 'not pcm', {binary:false}],
]) test(`microphone rejects ${name}`, async t => {
  const f = await fixture(t), ws = await f.connect(), close = once(ws, 'close');
  ws.send(data, options); await close;
  assert.equal(f.state.frames.length, 0);
});

test('excessive PCM bursts are cut off', async t => {
  const f = await fixture(t), ws = await f.connect(), close = once(ws, 'close');
  for (let i = 0; i < 80; i++) ws.send(Buffer.alloc(8192));
  await close;
  assert.ok(f.state.frames.length < 80);
});

test('upstream must announce readiness and unavailable startup is bounded', async t => {
  const f = await fixture(t), ticket = await f.hub.ticket(f.user, f.room);
  f.state.ready = false;
  const start = performance.now();
  assert.equal(await f.rejected(ticket.websocketPath), 500);
  assert.ok(performance.now() - start < 3000);
  assert.equal(await f.rejected(ticket.websocketPath), 403);
});

test('status rejects oversized or stalled bridge responses within two seconds', async t => {
  let stalled = false;
  const f = await fixture(t, {fetchImpl:async () => stalled ? new Promise(() => {}) : new Response('x'.repeat(4097))});
  await assert.rejects(f.hub.status(f.user, f.room), {status:500});
  stalled = true;
  const start = performance.now();
  await assert.rejects(f.hub.status(f.user, f.room), {status:500});
  assert.ok(performance.now() - start < 3000);
});

test('unknown upgrade routes are left for other handlers and close stops the microphone', async t => {
  const f = await fixture(t), other = new WebSocketServer({noServer:true});
  f.server.on('upgrade', (req, socket, head) => { if (req.url === '/other') other.handleUpgrade(req, socket, head, ws => ws.send('other')); });
  const unknown = f.socket('/other');
  assert.equal((await once(unknown, 'message'))[0].toString(), 'other');
  unknown.terminate();
  for (const ws of other.clients) ws.terminate();
  await new Promise(resolve => other.close(resolve));
  const ws = await f.connect(), closed = once(ws, 'close');
  f.hub.close(); await closed;
  assert.equal(f.server.listenerCount('upgrade'), 1);
  await assert.rejects(f.hub.ticket(f.user, f.room), {status:503});
});
