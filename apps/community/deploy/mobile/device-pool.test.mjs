import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { configuration, DevicePool, parseUiTree } from './device-pool.mjs';
import { createServer, listenServer } from './service.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const TOKEN = 'this-test-token-has-more-than-thirty-two-characters';
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

async function fixture(t, overrides = {}) {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'ccb-mobile-test-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const config = { ...configuration({ MOBILE_BROKER_TOKEN: TOKEN, MOBILE_ANDROID_IMAGE: 'operator/android:test', MOBILE_DATA_DIR: dataDir }), ...overrides };
  const containers = new Map(), calls = [];
  let time = 1_000_000;
  const run = async (file, args) => {
    calls.push({ file, args: [...args] });
    if (file === 'docker') {
      const operation = args[0];
      if (operation === 'inspect') {
        const item = containers.get(args[1]);
        if (!item) throw Object.assign(new Error('No such container'), { stderr: 'No such object' });
        return JSON.stringify([item]);
      }
      if (operation === 'create') {
        const name = args[args.indexOf('--name') + 1];
        const labels = Object.fromEntries(args.flatMap((value, index) => value === '--label' ? [args[index + 1].split('=')] : []));
        assert.equal(containers.has(name), false);
        const [hostIp, hostPort] = args[args.indexOf('--publish') + 1].split(':');
        containers.set(name, { Config: { Labels: labels }, HostConfig: { PortBindings: { '5555/tcp': [{ HostIp: hostIp, HostPort: hostPort }] } }, State: { Running: false } });
        return name;
      }
      if (operation === 'start') { containers.get(args[1]).State.Running = true; return args[1]; }
      if (operation === 'stop') { containers.get(args.at(-1)).State.Running = false; return args.at(-1); }
      throw new Error(`Unexpected Docker operation ${operation}`);
    }
    assert.equal(file, 'adb');
    if (args[0] === 'connect' || args[0] === 'disconnect') return '';
    if (args.includes('screencap')) return png;
    if (args.includes('exec-out')) return '<hierarchy><node text="Hello" class="android.widget.EditText" enabled="true" focused="true" bounds="[0,0][100,40]" /></hierarchy>';
    const command = args.at(-1);
    if (command.startsWith("'getprop'")) return '1\n';
    if (command.startsWith("'wm'")) return 'Physical size: 720x1280\n';
    return '';
  };
  const pool = new DevicePool(config, { run, now: () => time, pause: async ms => { time += ms; } });
  await pool.initialize();
  return { pool, config, calls, containers, advance: ms => { time += ms; } };
}

test('configuration requires explicit private authentication and operator image', () => {
  assert.throws(() => configuration({}), /MOBILE_ANDROID_IMAGE/);
  assert.throws(() => configuration({ MOBILE_ANDROID_IMAGE: 'image' }), /MOBILE_BROKER_TOKEN/);
  assert.throws(() => configuration({ MOBILE_ANDROID_IMAGE: 'image', MOBILE_BROKER_TOKEN: TOKEN, MOBILE_DOCKER_DEVICES_JSON: '["/etc/passwd"]' }), /device mapping/);
});

test('status and leases never allocate a device for ordinary chats', async t => {
  const { pool, calls } = await fixture(t);
  assert.equal((await pool.status(A)).device.state, 'unallocated');
  assert.equal((await pool.lease(A, true)).device.state, 'unallocated');
  assert.equal(pool.devices.size, 0);
  assert.equal(calls.filter(item => item.file === 'docker').length, 0);
  await assert.rejects(pool.status('../anything'), { code: 'invalid_room' });
});

test('each room receives persistent isolated data and only loopback ADB', async t => {
  const { pool, calls, config } = await fixture(t);
  const first = await pool.wake(A), second = await pool.wake(B);
  assert.equal(first.device.state, 'running');
  assert.equal(second.capacity.running, 2);
  const creates = calls.filter(item => item.args[0] === 'create');
  assert.equal(creates.length, 2);
  assert.ok(creates[0].args.includes(`type=bind,src=${config.dataDir}/rooms/${A},dst=/data`));
  assert.ok(creates[1].args.includes(`type=bind,src=${config.dataDir}/rooms/${B},dst=/data`));
  assert.ok(creates[0].args.includes('127.0.0.1:16555:5555'));
  assert.ok(creates[1].args.includes('127.0.0.1:16556:5555'));
  assert.equal(creates.some(item => item.args.includes('--privileged')), false);
  await pool.sleep(A);
  await pool.wake(A);
  assert.equal(calls.filter(item => item.args[0] === 'create').length, 2);
  assert.equal(calls.some(item => ['rm', 'volume'].includes(item.args[0])), false);
});

test('concurrent wake requests respect global running and persistent slot caps', async t => {
  const { pool, calls } = await fixture(t, { maxSlots: 2, maxRunning: 1 });
  const results = await Promise.allSettled([pool.wake(A), pool.wake(B)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'device_capacity_busy');
  assert.equal(pool.devices.size, 1);
  await pool.sleep(A);
  await pool.wake(B);
  await pool.sleep(B);
  await assert.rejects(pool.wake(C), { code: 'device_slots_full' });
  assert.equal(calls.filter(item => item.args[0] === 'create').length, 2);
});

test('unmanaged legacy container counts toward running capacity but is never adopted', async t => {
  const { pool, containers, calls } = await fixture(t, { maxRunning: 1, externalContainers: ['legacy-redroid'] });
  containers.set('legacy-redroid', { Config: { Labels: {} }, State: { Running: true } });
  await assert.rejects(pool.wake(A), { code: 'device_capacity_busy' });
  assert.equal(pool.devices.size, 0);
  assert.equal(calls.some(item => ['stop', 'rm', 'start'].includes(item.args[0])), false);
});

test('lease refresh prevents idle stop; released expired devices sleep without deleting data', async t => {
  const { pool, advance, calls } = await fixture(t, { idleMs: 60_000, leaseMs: 120_000 });
  await pool.wake(A);
  await pool.lease(A, true);
  advance(70_000);
  await pool.sweepIdle();
  assert.equal((await pool.status(A)).device.state, 'running');
  await assert.rejects(pool.sleep(A), { code: 'device_in_use' });
  await pool.lease(A, false);
  await pool.sweepIdle();
  assert.equal((await pool.status(A)).device.state, 'sleeping');
  assert.equal(pool.devices.size, 1);
  assert.equal(calls.some(item => item.args[0] === 'rm'), false);
});

test('expired crash leases do not keep devices alive indefinitely and mapping survives restart', async t => {
  const { pool, config, advance } = await fixture(t, { idleMs: 60_000, leaseMs: 30_000 });
  await pool.wake(A);
  await pool.lease(A, true);
  advance(70_000);
  const restored = new DevicePool(config, { run: pool.run, now: pool.now, pause: pool.pause });
  await restored.initialize();
  assert.equal(restored.devices.get(A).slot, 0);
  await restored.sweepIdle();
  assert.equal((await restored.status(A)).device.state, 'sleeping');
  const stored = JSON.parse(await readFile(restored.stateFile, 'utf8'));
  assert.equal(stored.devices[0].roomId, A);
});

test('broker never operates an existing container with mismatched ownership labels', async t => {
  const { pool, containers, calls } = await fixture(t);
  await pool.wake(A);
  const name = pool.name(pool.devices.get(A));
  containers.get(name).Config.Labels['org.customcloudbot.room'] = B;
  await assert.rejects(pool.sleep(A), { code: 'device_ownership_conflict' });
  assert.equal(calls.some(item => item.args[0] === 'stop'), false);
});

test('changing the configured ADB port cannot silently operate another room device', async t => {
  const { pool, config } = await fixture(t);
  await pool.wake(A);
  const changed = new DevicePool({ ...config, adbBasePort: config.adbBasePort + 1 }, { run: pool.run, now: pool.now });
  await assert.rejects(changed.initialize(), { code: 'device_configuration_conflict' });
});

test('Android rotation changes the coordinate bounds used by touch and observations', async t => {
  const { pool } = await fixture(t);
  await pool.wake(A);
  const previous = pool.run;
  pool.run = (file, args, options) => args.at(-1) === "'dumpsys' 'input'" ? Promise.resolve('SurfaceOrientation: 1') : previous(file, args, options);
  assert.deepEqual(await pool.dimensions(pool.devices.get(A)), { width: 1280, height: 720 });
  await pool.input(A, { type: 'tap', x: 1000, y: 600 });
  await assert.rejects(pool.input(A, { type: 'tap', x: 600, y: 1000 }), { code: 'invalid_coordinates' });
});

test('inputs validate real dimensions and never allow host shell or arbitrary Android keys', async t => {
  const { pool, calls } = await fixture(t);
  await pool.wake(A);
  await assert.rejects(pool.input(A, { type: 'tap', x: 720, y: 0 }), { code: 'invalid_coordinates' });
  await assert.rejects(pool.input(A, { type: 'swipe', x1: 0, y1: 0, x2: 2, y2: 2, duration: 9000 }), { code: 'invalid_coordinates' });
  await assert.rejects(pool.input(A, { type: 'key', key: 'HOME;reboot' }), { code: 'invalid_key' });
  await assert.rejects(pool.launch(A, 'com.app;reboot'), { code: 'invalid_package' });
  await pool.input(A, { type: 'tap', x: 0, y: 0 });
  await pool.input(A, { type: 'text', text: "hi'; $(touch /host-marker)" });
  const command = calls.at(-1);
  assert.equal(command.file, 'adb');
  assert.equal(command.args.length, 4);
  assert.match(command.args.at(-1), /^'input' 'text' 'hi'\\'';/);
  assert.equal(calls.some(item => ['sh', 'bash'].includes(item.file)), false);
});

test('Unicode is explicit: no silent corruption and configured IME uses base64', async t => {
  const first = await fixture(t);
  await first.pool.wake(A);
  await assert.rejects(first.pool.input(A, { type: 'text', text: '안녕하세요' }), { code: 'text_not_supported' });
  await assert.rejects(first.pool.input(A, { type: 'text', text: 'line\nbreak' }), { code: 'invalid_text' });
  const second = await fixture(t, { inputIme: 'com.android.adbkeyboard/.AdbIME' });
  await second.pool.wake(A);
  await second.pool.input(A, { type: 'text', text: '안녕하세요' });
  assert.match(second.calls.at(-1).args.at(-1), /'ADB_INPUT_B64'/);
  assert.ok(second.calls.at(-1).args.at(-1).includes(Buffer.from('안녕하세요').toString('base64')));
});

test('screenshots are PNG and UI observes editable bounds with password redaction', async t => {
  const { pool } = await fixture(t);
  await pool.wake(A);
  assert.deepEqual(await pool.screenshot(A), png);
  const observation = await pool.observe(A);
  assert.equal(observation.width, 720);
  assert.equal(observation.nodes[0].editable, true);
  assert.deepEqual(observation.nodes[0].bounds, { left: 0, top: 0, right: 100, bottom: 40 });
  const parsed = parseUiTree('<node text="secret" content-desc="secret description" password="true" class="android.widget.EditText" bounds="[-1,-1][100,40]"/><node text="A &amp; B &#x1F600;" bounds="[0,0][10,10]"/>', 50, 60);
  assert.equal(parsed.nodes[0].text, '');
  assert.equal(parsed.nodes[0].description, '');
  assert.equal(parsed.nodes[0].bounds.right, 50);
  assert.equal(parsed.nodes[1].text, 'A & B 😀');
  await pool.sleep(A);
  await assert.rejects(pool.screenshot(A), { code: 'device_sleeping' });
});

test('large Unicode UI trees remain bounded for the app gateway', () => {
  const node = `<node text="${'문'.repeat(512)}" content-desc="${'문'.repeat(512)}" resource-id="${'문'.repeat(256)}" class="${'문'.repeat(128)}" bounds="[0,0][10,10]"/>`;
  const tree = parseUiTree(node.repeat(500), 720, 1280);
  assert.ok(tree.nodes.length > 0);
  assert.ok(Buffer.byteLength(JSON.stringify(tree)) < 240 * 1024);
});

test('HTTP requires bearer on every route, rejects unsafe bodies, and returns typed errors', async t => {
  const { pool } = await fixture(t);
  const server = createServer(pool, TOKEN);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const auth = { Authorization: `Bearer ${TOKEN}` };
  assert.equal((await fetch(`${base}/health`)).status, 401);
  assert.equal((await fetch(`${base}/devices/${A}/wake`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/health`, { headers: auth })).status, 200);
  assert.equal((await fetch(`${base}/devices/${A}/wake`, { method: 'POST', headers: auth, body: '{}' })).status, 415);
  const headers = { ...auth, 'Content-Type': 'application/json' };
  assert.equal((await fetch(`${base}/devices/${A}/wake`, { method: 'POST', headers, body: '{' })).status, 400);
  assert.equal((await fetch(`${base}/devices/${A}/wake`, { method: 'POST', headers, body: JSON.stringify({ extra: 'a'.repeat(18000) }) })).status, 413);
  const asleep = await fetch(`${base}/devices/${A}/screenshot`, { headers: auth });
  assert.equal(asleep.status, 409);
  assert.equal((await asleep.json()).error, 'device_sleeping');
  assert.equal((await fetch(`${base}/devices/${A}/wake`, { method: 'POST', headers, body: '{}' })).status, 200);
  const screenshot = await fetch(`${base}/devices/${A}/screenshot`, { headers: auth });
  assert.equal(screenshot.headers.get('content-type'), 'image/png');
  assert.deepEqual(Buffer.from(await screenshot.arrayBuffer()), png);
  assert.equal((await fetch(`${base}/health?token=bad`, { headers: auth })).status, 400);
});

test('Unix socket listener opens no TCP port and retains bearer authentication', async t => {
  const { pool, config } = await fixture(t);
  const socket = path.join(config.dataDir, 'runtime', 'mobile.sock');
  const server = createServer(pool, TOKEN);
  await listenServer(server, { ...config, socket });
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  assert.equal(server.address(), socket);
  const { lstat } = await import('node:fs/promises');
  assert.equal((await lstat(socket)).mode & 0o777, 0o660);
  const request = token => new Promise((resolve, reject) => {
    const call = http.request({ socketPath: socket, path: '/health', headers: token ? { Authorization: `Bearer ${token}` } : {} }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    call.on('error', reject); call.end();
  });
  assert.equal((await request()).status, 401);
  assert.equal((await request(TOKEN)).body.ok, true);
  const duplicate = createServer(pool, TOKEN);
  await assert.rejects(listenServer(duplicate, { ...config, socket }), /already has a listening service/);
  assert.equal((await request(TOKEN)).status, 200);
});
