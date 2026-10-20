import {createHash, randomBytes} from 'node:crypto';
import WebSocket, {WebSocketServer} from 'ws';

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message) => Object.assign(new Error(message), {status});
const roomPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const microphonePath = /^\/api\/rooms\/([a-f0-9-]{36})\/workspace\/media\/microphone\/ws$/;
const MAX_FRAME = 8192, MAX_BUFFER = 128 * 1024, BYTE_RATE = 192 * 1024;
const FORMAT = Object.freeze({format:'s16le', sampleRate:48000, channels:1});
const CAMERA = Object.freeze({supported:false, available:false, reason:'camera-transport-not-implemented'});

function endpoint(config) {
  if (!config?.cdpUrl) throw fail(503, '이 대화에 연결된 컴퓨터가 없습니다.');
  let base;
  try { base = new URL(config.cdpUrl); } catch { throw fail(503, '컴퓨터 연결 설정을 확인해 주세요.'); }
  if (base.protocol !== 'http:' || !(['127.0.0.1', '[::1]'].includes(base.hostname) || /^desktop-[a-f0-9-]{36}$/.test(base.hostname)) || base.username || base.password || base.search || base.hash || base.pathname !== '/') {
    throw fail(503, '컴퓨터 연결 설정을 확인해 주세요.');
  }
  base.port = '6084';
  return base;
}

/** Only the application talks to this fixed, internal desktop bridge. */
export function createDesktopMediaHub({server, desktops, userFor, roomFor, originFor, isOwner, fetchImpl = fetch}) {
  const tickets = new Map(), connections = new Set();
  const wss = new WebSocketServer({noServer:true, perMessageDeflate:false, maxPayload:MAX_FRAME});
  let closed = false;

  function authorize(user, roomId) {
    if (closed) throw fail(503, '미디어 연결이 종료되었습니다.');
    if (!user?.id || !user.sessionHash) throw fail(401, '로그인이 필요합니다.');
    if (!isOwner(user)) throw fail(403, '컴퓨터 마이크는 소유자만 연결할 수 있습니다.');
    if (!roomPattern.test(roomId)) throw fail(404, '대화를 찾을 수 없습니다.');
    // The integration callback also checks persistent fork/read-only settings.
    const room = roomFor(roomId, user);
    if (!room) throw fail(404, '대화를 찾을 수 없습니다.');
    if (room.readOnly === true || room.read_only === true) throw fail(409, '읽기 전용 대화에서는 마이크를 연결할 수 없습니다.');
    return room;
  }

  function occupied(base) { return [...connections].some(entry => entry.base === base.href); }

  async function bridgeStatus(base) {
    const controller = new AbortController();
    let reader, timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(fail(500, '컴퓨터의 마이크 연결을 확인하지 못했습니다.')); }, 2000);
      timer.unref?.();
    });
    const request = (async () => {
      const response = await fetchImpl(new URL('/status', base), {redirect:'error', signal:controller.signal});
      if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('Unavailable'); }
      reader = response.body.getReader();
      const parts = []; let size = 0;
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) throw new Error('Oversized media status');
        parts.push(Buffer.from(value));
      }
      const value = JSON.parse(Buffer.concat(parts).toString());
      if (value?.ok !== true || typeof value.microphone?.supported !== 'boolean' || typeof value.microphone?.available !== 'boolean') throw new Error('Invalid media status');
      return value;
    })();
    try { return await Promise.race([request, timeout]); }
    catch { throw fail(500, '컴퓨터의 마이크 연결을 확인하지 못했습니다.'); }
    finally { clearTimeout(timer); controller.abort(); reader?.cancel().catch(() => {}); }
  }

  async function status(user, roomId) {
    authorize(user, roomId);
    if (!desktops.get(roomId)) return {ok:true, configured:false, microphone:{supported:false, available:false, connected:false, muted:true, ...FORMAT}, camera:{...CAMERA}, audioOutput:{supported:false}};
    const base = endpoint(desktops.get(roomId));
    const value = await bridgeStatus(base);
    authorize(user, roomId);
    return {
      ok:true, configured:true,
      microphone:{supported:value.microphone.supported, available:value.microphone.available, connected:value.microphone.connected === true || occupied(base), muted:value.microphone.muted !== false, ...FORMAT},
      camera:{...CAMERA}, audioOutput:{supported:false},
    };
  }

  async function ticket(user, roomId) {
    const state = await status(user, roomId);
    if (!state.microphone.supported || !state.microphone.available) throw fail(500, '컴퓨터의 가상 마이크가 아직 준비되지 않았습니다.');
    if (state.microphone.connected) throw fail(409, '이미 마이크가 연결되어 있습니다. 먼저 기존 연결을 꺼 주세요.');
    const now = Date.now();
    for (const [key, entry] of tickets) if (entry.expiresAt <= now) tickets.delete(key);
    if (tickets.size >= 200) throw fail(429, '마이크 연결 요청이 많습니다. 잠시 후 다시 시도해 주세요.');
    const raw = randomBytes(32).toString('base64url'), expiresAt = now + 60000;
    tickets.set(hash(raw), {userId:user.id, sessionHash:user.sessionHash, roomId, expiresAt});
    return {websocketPath:`/api/rooms/${roomId}/workspace/media/microphone/ws?ticket=${raw}`, expiresAt, ...FORMAT, maxFrameBytes:MAX_FRAME};
  }

  const reject = (socket, code) => socket.end(`HTTP/1.1 ${code} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  function upgrade(req, socket, head) {
    let url;
    try { url = new URL(req.url, 'http://local'); } catch { return; }
    const match = url.pathname.match(microphonePath);
    if (!match) return; // Other hubs own their own upgrade routes.
    let user, roomId, base;
    try {
      const origin = originFor(req);
      if (!origin || req.headers.origin !== origin) return reject(socket, 403);
      user = userFor(req); roomId = match[1];
      authorize(user, roomId);
      base = endpoint(desktops.get(roomId));
      const raw = url.searchParams.get('ticket') || '';
      if (!/^[A-Za-z0-9_-]{43}$/.test(raw)) return reject(socket, 403);
      const key = hash(raw), value = tickets.get(key);
      if (!value || value.expiresAt <= Date.now() || value.userId !== user.id || value.sessionHash !== user.sessionHash || value.roomId !== roomId) return reject(socket, 403);
      tickets.delete(key); // Single use, including a failed upstream connection.
      if (occupied(base)) return reject(socket, 409);
      if (connections.size >= 8) return reject(socket, 429);
    } catch (error) { return reject(socket, [401,403,404,409,503].includes(error.status) ? error.status : 403); }

    const target = new URL('/microphone', base);
    target.protocol = 'ws:';
    target.searchParams.set('session', hash(user.id + '\0' + roomId));
    // No browser cookies, Origin, credentials, or user-selected destinations cross this hop.
    const upstream = new WebSocket(target, {perMessageDeflate:false, maxPayload:4096, handshakeTimeout:2000});
    const entry = {base:base.href, client:null, upstream, stop:null};
    connections.add(entry);
    let stopped = false, ready = false, monitor, timeout;
    let tokens = BYTE_RATE, replenishedAt = performance.now();
    const stop = (code = 1008, reason = 'Microphone disconnected') => {
      if (stopped) return;
      stopped = true; clearTimeout(timeout); clearInterval(monitor); connections.delete(entry);
      upstream.terminate();
      if (entry.client) {
        entry.client.close(code, reason);
        const force = setTimeout(() => entry.client.terminate(), 100); force.unref();
      } else if (!socket.destroyed) socket.destroy();
    };
    entry.stop = stop;
    const deny = code => {
      if (stopped) return;
      if (entry.client) return stop(1011, 'Microphone unavailable');
      stopped = true; clearTimeout(timeout); clearInterval(monitor); connections.delete(entry);
      upstream.terminate();
      if (!socket.destroyed) reject(socket, code);
    };
    const authorized = () => {
      try {
        const current = userFor(req);
        if (!current || current.id !== user.id || current.sessionHash !== user.sessionHash) throw new Error('Session ended');
        authorize(current, roomId);
        if (req.headers.origin !== originFor(req)) throw new Error('Origin changed');
        return true;
      } catch { if (entry.client) stop(); else deny(403); return false; }
    };
    socket.once('close', () => stop());
    timeout = setTimeout(() => deny(500), 2000); timeout.unref();
    upstream.on('unexpected-response', (_req, response) => { response.resume(); deny(response.statusCode === 409 ? 409 : 500); });
    upstream.on('error', () => deny(500));
    upstream.on('close', () => { if (entry.client) stop(1011, 'Microphone unavailable'); else deny(500); });
    upstream.on('message', (data, binary) => {
      if (stopped || !authorized()) return;
      let message;
      try { if (binary || data.byteLength > 1024) throw new Error('Unexpected media message'); message = JSON.parse(data.toString()); }
      catch { return deny(500); }
      if (ready || message?.type !== 'ready' || message.format !== FORMAT.format || message.sampleRate !== FORMAT.sampleRate || message.channels !== FORMAT.channels) return deny(500);
      ready = true; clearTimeout(timeout);
      try {
        wss.handleUpgrade(req, socket, head, client => {
          entry.client = client;
          client.on('error', () => stop());
          client.on('close', () => stop(1000));
          client.on('message', (pcm, binaryFrame) => {
            if (!authorized()) return;
            if (!binaryFrame || pcm.byteLength === 0 || pcm.byteLength > MAX_FRAME || pcm.byteLength % 2) return stop(1008, 'Invalid PCM frame');
            const now = performance.now();
            tokens = Math.min(BYTE_RATE, tokens + Math.max(0, now - replenishedAt) * BYTE_RATE / 1000); replenishedAt = now;
            if (pcm.byteLength > tokens) return stop(1008, 'Microphone rate exceeded');
            tokens -= pcm.byteLength;
            if (upstream.readyState !== WebSocket.OPEN || upstream.bufferedAmount + pcm.byteLength > MAX_BUFFER) return stop(1011, 'Microphone overloaded');
            upstream.send(pcm, {binary:true}, error => { if (error) stop(1011, 'Microphone unavailable'); });
          });
          if (!authorized()) return;
          client.send(JSON.stringify({type:'ready', ...FORMAT}), {binary:false}, error => { if (error) stop(); });
          monitor = setInterval(authorized, 10000); monitor.unref();
        });
      } catch { deny(500); }
    });
  }
  server.on('upgrade', upgrade);
  return {status, ticket, close() {
    if (closed) return;
    closed = true; tickets.clear(); server.off('upgrade', upgrade);
    for (const entry of [...connections]) entry.stop(1001, 'Server closed');
    wss.close();
  }};
}
