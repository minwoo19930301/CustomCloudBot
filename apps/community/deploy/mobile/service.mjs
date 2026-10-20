import http from 'node:http';
import net from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { chmod, lstat, mkdir, unlink } from 'node:fs/promises';
import { configuration, DevicePool, MobileError } from './device-pool.mjs';

function authorized(request, token) {
  const supplied = Buffer.from(request.headers.authorization || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

async function jsonBody(request) {
  if (!/^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) throw new MobileError('invalid_content_type', 'JSON content is required.', 415);
  const chunks = []; let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16 * 1024) throw new MobileError('body_too_large', 'The request is too large.', 413);
    chunks.push(chunk);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { throw new MobileError('invalid_json', 'The request is not valid JSON.'); }
  if (!result || Array.isArray(result) || typeof result !== 'object') throw new MobileError('invalid_json', 'A JSON object is required.');
  return result;
}

function send(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  response.end(JSON.stringify(data));
}

export function createServer(pool, token) {
  let activeRequests = 0;
  const server = http.createServer(async (request, response) => {
    if (!authorized(request, token)) { send(response, 401, { error: 'unauthorized', message: 'Authentication is required.' }); return; }
    if (activeRequests >= 64) { send(response, 429, { error: 'broker_busy', message: 'The mobile service is busy.' }); return; }
    activeRequests++;
    try {
      const url = new URL(request.url, 'http://mobile.internal');
      if (url.search) throw new MobileError('invalid_request', 'Query parameters are not accepted.');
      if (request.method === 'GET' && url.pathname === '/health') { send(response, 200, await pool.health()); return; }
      const match = /^\/devices\/([^/]+)(?:\/(wake|sleep|lease|screenshot|observe|input|launch))?$/.exec(url.pathname);
      if (!match) throw new MobileError('not_found', 'This route does not exist.', 404);
      const [, room, action] = match;
      if (request.method === 'GET' && !action) { send(response, 200, await pool.status(room)); return; }
      if (request.method === 'GET' && action === 'screenshot') {
        const png = await pool.screenshot(room);
        response.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': png.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
        response.end(png); return;
      }
      if (request.method === 'GET' && action === 'observe') { send(response, 200, await pool.observe(room)); return; }
      if (request.method !== 'POST') throw new MobileError('method_not_allowed', 'This HTTP method is not supported.', 405);
      const body = await jsonBody(request);
      let result;
      if (action === 'wake') result = await pool.wake(room);
      else if (action === 'sleep') result = await pool.sleep(room);
      else if (action === 'lease') result = await pool.lease(room, body.active);
      else if (action === 'input') result = await pool.input(room, body);
      else if (action === 'launch') result = await pool.launch(room, body.package);
      else throw new MobileError('not_found', 'This route does not exist.', 404);
      send(response, 200, result);
    } catch (error) {
      if (response.destroyed) return;
      if (error instanceof MobileError) send(response, error.status, { error: error.code, message: error.message });
      else { console.error(JSON.stringify({ event: 'request_failed', code: 'device_operation_failed' })); send(response, 503, { error: 'device_operation_failed', message: 'The mobile operation could not be completed.' }); }
    } finally { activeRequests--; }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 180_000;
  server.keepAliveTimeout = 5000;
  server.maxRequestsPerSocket = 100;
  return server;
}

export async function listenServer(server, config) {
  if (config.socket) {
    const directory = path.dirname(config.socket);
    await mkdir(directory, { recursive: true, mode: 0o750 });
    if ((await lstat(directory)).isSymbolicLink()) throw new Error('The mobile socket directory must not be a symlink');
    let existing;
    try { existing = await lstat(config.socket); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (existing) {
      if (!existing.isSocket() || (process.getuid && existing.uid !== process.getuid())) throw new Error('Refusing to replace a socket path not owned by this service');
      const stale = await new Promise(resolve => {
        const client = net.createConnection({ path: config.socket });
        client.setTimeout(1000, () => { client.destroy(); resolve(false); });
        client.once('connect', () => { client.destroy(); resolve(false); });
        client.once('error', error => { client.destroy(); resolve(error.code === 'ECONNREFUSED' || error.code === 'ENOENT'); });
      });
      if (!stale) throw new Error('The mobile socket already has a listening service');
      await unlink(config.socket).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.socket, resolve); });
    await chmod(config.socket, 0o660);
  } else {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(config.port, config.host, resolve); });
  }
}

export async function main() {
  const config = configuration();
  const pool = new DevicePool(config);
  await pool.initialize();
  const server = createServer(pool, config.token);
  let sweeping = false;
  const timer = setInterval(async () => {
    if (sweeping) return;
    sweeping = true;
    try { await pool.sweepIdle(); } catch { console.error(JSON.stringify({ event: 'idle_sweep_failed' })); }
    finally { sweeping = false; }
  }, 30_000);
  timer.unref();
  await listenServer(server, config);
  console.log(JSON.stringify({ event: 'mobile_broker_ready', slots: pool.devices.size, maxSlots: config.maxSlots, maxRunning: config.maxRunning }));
  const shutdown = () => { clearInterval(timer); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 10_000).unref(); };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
  return { pool, server };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => { console.error('Mobile broker startup failed. Verify its private configuration and Android runtime.'); process.exitCode = 1; });
