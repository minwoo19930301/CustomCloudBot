import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';
import { configuration, DevicePool, parseUiTree, roomId, runCommand, operationDiagnostic } from './device-pool.mjs';
import { BROKER_RUNTIME_REVISION, createServer, listenServer, readReadyRevision } from './service.mjs';

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
  const run = async (file, args, options = {}) => {
    calls.push({ file, args: [...args], options });
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
        const network = args.includes('--network') ? args[args.indexOf('--network') + 1] : 'bridge';
        containers.set(name, { Config: { Labels: labels }, HostConfig: { NetworkMode: network, PortBindings: { '5555/tcp': [{ HostIp: hostIp, HostPort: hostPort }] } }, NetworkSettings: { Networks: { [network]: {} } }, State: { Running: false } });
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

test('software Android boot allowance accepts at most ten minutes', () => {
  const env = { MOBILE_ANDROID_IMAGE: 'image', MOBILE_BROKER_TOKEN: TOKEN };
  assert.equal(configuration(env).bootMs, 90_000);
  assert.equal(configuration({ ...env, MOBILE_BOOT_SECONDS: '600' }).bootMs, 600_000);
  for (const value of ['601', '9', 'Infinity', '600.1']) {
    assert.throws(() => configuration({ ...env, MOBILE_BOOT_SECONDS: value }), /MOBILE_BOOT_SECONDS/);
  }
});

test('optional Docker network accepts a dedicated name and rejects modes or unsafe syntax', () => {
  const env = { MOBILE_ANDROID_IMAGE: 'image', MOBILE_BROKER_TOKEN: TOKEN };
  assert.equal(configuration(env).network, '');
  assert.equal(configuration({ ...env, MOBILE_DOCKER_NETWORK: 'community-mobile_1' }).network, 'community-mobile_1');
  for (const network of ['bridge', 'host', 'none', 'default', 'container:other', '--privileged', 'mobile network', 'mobile\nnetwork', 'network,alias=other', 'a'.repeat(129)]) {
    assert.throws(() => configuration({ ...env, MOBILE_DOCKER_NETWORK: network }), /MOBILE_DOCKER_NETWORK/);
  }
});

test('status and leases never allocate a device for ordinary chats', async t => {
  const { pool, calls } = await fixture(t);
  assert.equal((await pool.status(A)).device.state, 'unallocated');
  assert.equal((await pool.lease(A, true)).device.state, 'unallocated');
  assert.equal(pool.devices.size, 0);
  assert.equal(calls.filter(item => item.file === 'docker').length, 0);
  await assert.rejects(pool.status('../anything'), { code: 'invalid_room' });
});

test('reserved personal room IDs support wake and sleep while path and control characters stay rejected', async t => {
  const personal='f6f6cd49-10f4-6102-2f64-da6554d8dba8';
  const {pool,calls}=await fixture(t);
  assert.equal(roomId(personal.toUpperCase()),personal);
  assert.equal(roomId('00000000-0000-0000-0000-000000000000'),'00000000-0000-0000-0000-000000000000');
  assert.equal((await pool.wake(personal)).device.state,'running');
  await pool.input(personal,{type:'key',key:'HOME'});
  assert.equal((await pool.sleep(personal)).device.state,'sleeping');
  const count=calls.length;
  for (const id of [personal+'\n',personal+'\r',personal+'/',personal+'%2f',personal.slice(1),personal.replace('-','/'),'../'+personal]) {
    assert.throws(()=>roomId(id),{code:'invalid_room'});
    await assert.rejects(pool.wake(id),{code:'invalid_room'});
  }
  assert.equal(calls.length,count);
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
  assert.equal(creates.some(item => item.args.includes('--network')), false);
  await pool.sleep(A);
  await pool.wake(A);
  assert.equal(calls.filter(item => item.args[0] === 'create').length, 2);
  assert.equal(calls.some(item => ['rm', 'volume'].includes(item.args[0])), false);
});

test('dedicated network is retained across sleep, wake and broker restart', async t => {
  const { pool, config, calls, containers } = await fixture(t, { network: 'community-mobile' });
  await pool.wake(A);
  const create = calls.find(item => item.args[0] === 'create');
  assert.equal(create.args[create.args.indexOf('--network') + 1], 'community-mobile');
  await pool.sleep(A);
  const restored = new DevicePool(config, { run: pool.run, now: pool.now, pause: pool.pause });
  await restored.initialize();
  await restored.wake(A);
  assert.equal(containers.get(pool.name(pool.devices.get(A))).State.Running, true);
  assert.equal(calls.filter(item => item.args[0] === 'create').length, 1);
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
  const { pool, containers, calls } = await fixture(t, { maxRunning: 1, network: 'community-mobile', externalContainers: ['legacy-redroid'] });
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

test('configuring a different network fails without migrating or deleting existing devices', async t => {
  const { pool, config, calls, containers } = await fixture(t);
  await pool.wake(A);
  const stored = await readFile(pool.stateFile, 'utf8');
  const previousCalls = calls.length;
  const changed = new DevicePool({ ...config, network: 'community-mobile' }, { run: pool.run, now: pool.now });
  await assert.rejects(changed.initialize(), { code: 'device_configuration_conflict' });
  assert.equal(await readFile(pool.stateFile, 'utf8'), stored);
  assert.equal(containers.get(pool.name(pool.devices.get(A))).State.Running, true);
  assert.ok(calls.slice(previousCalls).every(item => item.file === 'docker' && item.args[0] === 'inspect'));
});

test('additional or replaced network attachments block managed device operations', async t => {
  const { pool, containers, calls } = await fixture(t, { network: 'community-mobile' });
  await pool.wake(A);
  const info = containers.get(pool.name(pool.devices.get(A)));
  const previousCalls = calls.length;
  info.NetworkSettings.Networks.bridge = {};
  await assert.rejects(pool.input(A, { type: 'tap', x: 0, y: 0 }), { code: 'device_configuration_conflict' });
  info.NetworkSettings.Networks = { bridge: {} };
  await assert.rejects(pool.sleep(A), { code: 'device_configuration_conflict' });
  info.NetworkSettings.Networks = { 'community-mobile': {} };
  info.HostConfig.NetworkMode = 'bridge';
  await assert.rejects(pool.wake(A), { code: 'device_configuration_conflict' });
  assert.ok(calls.slice(previousCalls).every(item => item.file === 'docker' && item.args[0] === 'inspect'));
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

test('configured IME is enabled and selected before Android is reported ready', async t => {
  const inputIme = 'com.android.adbkeyboard/.AdbIME';
  const { pool, calls } = await fixture(t, { inputIme });
  assert.equal((await pool.wake(A)).device.state, 'running');
  const commands = calls.filter(item => item.file === 'adb' && item.args.includes('shell')).map(item => item.args.at(-1));
  assert.deepEqual(commands, ["'getprop' 'sys.boot_completed'", `'ime' 'enable' '${inputIme}'`, `'ime' 'set' '${inputIme}'`]);
  assert.deepEqual(calls.filter(item => item.args.at(-1).startsWith("'ime'")).map(item => item.options.timeout), [30_000, 30_000]);
});

test('slow software Android keyboard setup may take more than five seconds per command', async t => {
  const { pool, advance } = await fixture(t, { inputIme: 'com.android.adbkeyboard/.AdbIME', bootMs: 60_000 });
  const previous = pool.run, started = pool.now();
  pool.run = async (file, args, options) => {
    const duration = args.at(-1).startsWith("'ime' 'enable'") ? 7000 : args.at(-1).startsWith("'ime' 'set'") ? 9000 : 0;
    if (duration) {
      advance(Math.min(duration, options.timeout));
      if (duration > options.timeout) throw new Error('command timed out');
    }
    return previous(file, args, options);
  };
  assert.equal((await pool.wake(A)).device.state, 'running');
  assert.equal(pool.now() - started, 16_000);
});

test('transient IME selection timeout retries within the same boot deadline', async t => {
  const { pool, advance, calls } = await fixture(t, { inputIme: 'com.android.adbkeyboard/.AdbIME', bootMs: 60_000 });
  const previous = pool.run, started = pool.now();
  let selections = 0;
  pool.run = async (file, args, options) => {
    const output = await previous(file, args, options);
    if (args.at(-1).startsWith("'ime' 'set'")) {
      selections++;
      if (selections === 1) { advance(options.timeout); throw new Error('command timed out'); }
      advance(7000);
    }
    return output;
  };
  const status = await pool.wake(A);
  assert.equal(status.device.state, 'running');
  assert.equal(status.device.lastError, undefined);
  assert.equal(selections, 2);
  assert.equal(calls.filter(item => item.args.at(-1).startsWith("'ime' 'enable'")).length, 1);
  assert.deepEqual(calls.filter(item => item.args.at(-1).startsWith("'ime' 'set'")).map(item => item.options.timeout), [30_000, 29_000]);
  assert.equal(pool.now() - started, 38_000);
});

test('late Android readiness leaves only the remaining deadline for IME initialization', async t => {
  const { pool, advance, calls, containers } = await fixture(t, { inputIme: 'com.android.adbkeyboard/.AdbIME', bootMs: 10_000 });
  const previous = pool.run, started = pool.now();
  pool.run = async (file, args, options) => {
    const output = await previous(file, args, options);
    if (file !== 'adb') return output;
    assert.ok(options.timeout > 0 && options.timeout <= started + 10_000 - pool.now());
    if (args[0] === 'connect') advance(8000);
    if (args.at(-1).startsWith("'getprop'")) advance(1000);
    if (args.at(-1).startsWith("'ime' 'enable'")) { advance(options.timeout); throw new Error('command timed out'); }
    return output;
  };
  const status = await pool.wake(A);
  assert.equal(status.device.state, 'running');
  assert.equal(status.device.lastError, 'device_keyboard_timeout');
  assert.equal(pool.now() - started, 10_000);
  assert.equal(calls.find(item => item.args.at(-1).startsWith("'ime' 'enable'")).options.timeout, 1000);
  assert.equal(calls.some(item => item.args.at(-1).startsWith("'ime' 'set'")), false);
  assert.equal(containers.get(pool.name(pool.devices.get(A))).State.Running, true);
  assert.equal(calls.some(item => item.file === 'docker' && item.args[0] === 'stop'), false);
});

test('Android that never boots still times out, with ADB work capped to the remaining deadline', async t => {
  const { pool, advance, calls, containers } = await fixture(t, { inputIme: 'com.android.adbkeyboard/.AdbIME', bootMs: 10_000 });
  const previous = pool.run, started = pool.now();
  pool.run = async (file, args, options) => {
    const output = await previous(file, args, options);
    if (file !== 'adb') return output;
    assert.ok(options.timeout > 0 && options.timeout <= started + 10_000 - pool.now());
    if (args[0] === 'connect') advance(8000);
    if (args.at(-1).startsWith("'getprop'")) { advance(options.timeout); return ''; }
    return output;
  };
  await assert.rejects(pool.wake(A), { code: 'device_boot_timeout', status: 503 });
  assert.equal(pool.now() - started, 10_000);
  assert.equal(calls.find(item => item.args.at(-1).startsWith("'getprop'")).options.timeout, 2000);
  assert.equal(calls.some(item => item.args.at(-1).startsWith("'ime'")), false);
  assert.equal((await pool.status(A)).device.lastError, 'device_boot_timeout');
  assert.equal(pool.devices.get(A).state, 'error');
  assert.equal(containers.get(pool.name(pool.devices.get(A))).State.Running, false);
});

test('headless app launch resolves and starts only the requested package activity', async t => {
  const { pool, calls } = await fixture(t);
  await pool.wake(A);
  const previous = pool.run;
  let component;
  pool.run = async (file, args, options) => {
    const output = await previous(file, args, options);
    return file === 'adb' && args.at(-1).startsWith("'cmd' 'package' 'resolve-activity'") ? `priority=0 preferredOrder=0 match=0x108000 specificIndex=-1 isDefault=false\n${component}\n` : output;
  };
  for (component of ['com.android.settings/.Settings', 'com.android.settings/com.android.settings.Settings', 'com.android.settings/.Settings$MainActivity']) {
    assert.deepEqual(await pool.launch(A, 'com.android.settings'), { ok: true });
    assert.equal(calls.at(-2).args.at(-1), "'cmd' 'package' 'resolve-activity' '--brief' '--user' '0' '-a' 'android.intent.action.MAIN' '-c' 'android.intent.category.LAUNCHER' 'com.android.settings'");
    assert.equal(calls.at(-1).args.at(-1), `'am' 'start' '--user' '0' '-W' '-n' '${component}'`);
  }
  assert.equal(calls.some(item => item.args.at(-1).startsWith("'monkey'")), false);
});

test('missing, malformed or cross-package launcher results never start an activity', async t => {
  const { pool, calls } = await fixture(t);
  await pool.wake(A);
  const previous = pool.run;
  let resolved;
  pool.run = async (file, args, options) => {
    const output = await previous(file, args, options);
    return file === 'adb' && args.at(-1).startsWith("'cmd' 'package' 'resolve-activity'") ? resolved : output;
  };
  for (resolved of ['', 'No activity found\n', 'com.android.settings/', 'com.android.settings/.Settings/extra', 'com.android.settings/.Settings;reboot', 'com.android.settings/.Settings --user 10', 'com.other.app/.MainActivity', 'com.android.settings/.Settings\nError: invalid activity']) {
    await assert.rejects(pool.launch(A, 'com.android.settings'), { code: 'app_not_launchable', status: 404 });
  }
  assert.equal(calls.some(item => item.file === 'adb' && item.args.at(-1).startsWith("'am' 'start'")), false);
});

test('IME failure preserves a booted Android for screen and keys, then wake can repair text input', async t => {
  const { pool, calls } = await fixture(t, { inputIme: 'com.android.adbkeyboard/.AdbIME', bootMs: 1000 });
  const previous = pool.run;
  let fail = true;
  pool.run = async (file, args, options) => {
    if (fail && file === 'adb' && args.at(-1).startsWith("'ime' 'set'")) throw new Error('IME unavailable');
    return previous(file, args, options);
  };
  assert.equal((await pool.wake(A)).device.state, 'running');
  const status = await pool.status(A);
  assert.equal(status.device.state, 'running');
  assert.equal(status.device.lastError, 'device_keyboard_timeout');
  assert.equal(status.capacity.running, 1);
  const stored = JSON.parse(await readFile(pool.stateFile, 'utf8')).devices[0];
  assert.equal(stored.state, 'running');
  assert.equal(stored.lastError, 'device_keyboard_timeout');
  assert.equal(calls.some(item => item.file === 'docker' && item.args[0] === 'stop'), false);
  assert.deepEqual(await pool.screenshot(A), png);
  assert.deepEqual(await pool.input(A, { type: 'key', key: 'HOME' }), { ok: true });
  await assert.rejects(pool.input(A, { type: 'text', text: '한글' }), /IME unavailable/);
  assert.equal(calls.some(item => item.args.at(-1).includes('ADB_INPUT_B64')), false);
  fail = false;
  assert.equal((await pool.wake(A)).device.lastError, undefined);
  assert.deepEqual(await pool.input(A, { type: 'text', text: '한글' }), { ok: true });
  assert.equal(calls.filter(item => item.file === 'docker' && item.args[0] === 'create').length, 1);
});

test('Unicode is explicit and base64 input targets only the configured IME for user zero', async t => {
  const first = await fixture(t);
  await first.pool.wake(A);
  await assert.rejects(first.pool.input(A, { type: 'text', text: '안녕하세요' }), { code: 'text_not_supported' });
  await assert.rejects(first.pool.input(A, { type: 'text', text: 'line\nbreak' }), { code: 'invalid_text' });
  const second = await fixture(t, { inputIme: 'com.android.adbkeyboard/.AdbIME' });
  await second.pool.wake(A);
  await second.pool.input(A, { type: 'text', text: '안녕하세요' });
  assert.equal(second.calls.at(-1).args.at(-1), `'am' 'broadcast' '--user' '0' '-a' 'ADB_INPUT_B64' '-p' 'com.android.adbkeyboard' '--es' 'msg' '${Buffer.from('안녕하세요').toString('base64')}'`);
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

test('focused autocomplete inputs are editable while their SearchView container is not', () => {
  const parsed = parseUiTree('<node text="Search…" class="android.widget.AutoCompleteTextView" enabled="true" focused="true" bounds="[0,0][300,50]"/><node text="Recipients" class="android.widget.MultiAutoCompleteTextView" enabled="true" focused="true" bounds="[0,50][300,100]"/><node class="android.widget.SearchView" enabled="true" focused="true" bounds="[0,0][320,60]"/>', 720, 1280);
  assert.deepEqual(parsed.nodes.map(({ className, editable, enabled, focused }) => ({ className, editable, enabled, focused })), [
    { className: 'android.widget.AutoCompleteTextView', editable: true, enabled: true, focused: true },
    { className: 'android.widget.MultiAutoCompleteTextView', editable: true, enabled: true, focused: true },
    { className: 'android.widget.SearchView', editable: false, enabled: true, focused: true },
  ]);
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
  assert.equal((await (await fetch(`${base}/health`, { headers: auth })).json()).runtimeRevision, BROKER_RUNTIME_REVISION);
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

test('broker revision identifies loaded code and remains fixed when files are replaced before restart', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ccb-mobile-revision-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const file of ['device-pool.mjs', 'service.mjs']) {
    await writeFile(path.join(directory, file), await readFile(new URL(file, import.meta.url)));
  }
  const url = pathToFileURL(path.join(directory, 'service.mjs')).href;
  const loaded = await import(url);
  assert.match(loaded.BROKER_RUNTIME_REVISION, /^[a-f0-9]{12}$/);
  assert.equal(loaded.BROKER_RUNTIME_REVISION, BROKER_RUNTIME_REVISION);
  const updatedPool = await readFile(path.join(directory, 'device-pool.mjs'), 'utf8');
  await writeFile(path.join(directory, 'device-pool.mjs'), updatedPool + '\n// Newly installed broker, not loaded by the old process.\n');
  const server = loaded.createServer({ health: async () => ({ ok: true }) }, TOKEN);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/health`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  assert.equal((await response.json()).runtimeRevision, BROKER_RUNTIME_REVISION);
  const restarted = await import(url + '?restarted');
  assert.notEqual(restarted.BROKER_RUNTIME_REVISION, loaded.BROKER_RUNTIME_REVISION);
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

test('operator command scaling is bounded and leaves ordinary deployment defaults unchanged', () => {
  const env = { MOBILE_ANDROID_IMAGE: 'image', MOBILE_BROKER_TOKEN: TOKEN };
  assert.equal(configuration(env).commandTimeoutScale, 1);
  assert.equal(configuration(env).operationMs, 45_000);
  assert.equal(configuration({ ...env, MOBILE_COMMAND_TIMEOUT_SCALE: '3' }).commandTimeoutScale, 3);
  for (const value of ['0', '4', '1.5', 'NaN', 'Infinity']) assert.throws(() => configuration({ ...env, MOBILE_COMMAND_TIMEOUT_SCALE: value }), /MOBILE_COMMAND_TIMEOUT_SCALE/);
  for (const value of ['0', '46', '44.5', 'NaN', 'Infinity']) assert.throws(() => configuration({ ...env, MOBILE_OPERATION_SECONDS: value }), /MOBILE_OPERATION_SECONDS/);
});

function simulatedDelay(advance, options, duration) {
  advance(Math.min(options.timeout, duration));
  if (options.timeout < duration) throw Object.assign(new Error('private command contents must not reach diagnostics'), { killed: true, signal: 'SIGTERM' });
}

test('TCG scaling permits a slow screen, app launch and Unicode input without changing default caps', async t => {
  for (const scale of [1, 3]) {
    const { pool, advance, calls } = await fixture(t, { commandTimeoutScale: scale, inputIme: 'com.android.adbkeyboard/.AdbIME' });
    await pool.wake(A);
    const previous = pool.run;
    pool.run = async (file, args, options) => {
      const result = await previous(file, args, options);
      const command = args.at(-1);
      if (args.includes('screencap')) simulatedDelay(advance, options, 11_000);
      if (file === 'adb' && command.startsWith("'cmd' 'package' 'resolve-activity'")) {
        simulatedDelay(advance, options, 9_000); return 'com.android.settings/.Settings';
      }
      if (file === 'adb' && command.startsWith("'am' 'start'")) simulatedDelay(advance, options, 9_000);
      if (file === 'adb' && command.startsWith("'ime' 'set'")) simulatedDelay(advance, options, 6_000);
      if (file === 'adb' && command.startsWith("'am' 'broadcast'")) simulatedDelay(advance, options, 9_000);
      return result;
    };
    if (scale === 1) {
      for (const action of [() => pool.screenshot(A), () => pool.launch(A, 'com.android.settings'), () => pool.input(A, { type: 'text', text: '한글 검색' })]) {
        await assert.rejects(action(), error => operationDiagnostic(error).code === 'timeout');
      }
    } else {
      assert.deepEqual(await pool.screenshot(A), png);
      assert.deepEqual(await pool.launch(A, 'com.android.settings'), { ok: true });
      assert.deepEqual(await pool.input(A, { type: 'text', text: '한글 검색' }), { ok: true });
      assert.equal(calls.findLast(item => item.args.includes('screencap')).options.timeout, 30_000);
      assert.equal(calls.findLast(item => item.args.at(-1).startsWith("'am' 'broadcast'")).options.timeout, 24_000);
    }
    assert.equal(pool.devices.get(A).state, 'running');
  }
});

test('one operation shares its whole 45-second allowance across commands and does not continue after expiry', async t => {
  const { pool, advance, calls } = await fixture(t, { commandTimeoutScale: 3 });
  await pool.wake(A);
  const previous = pool.run;
  pool.run = async (file, args, options) => {
    const result = await previous(file, args, options);
    if (file === 'adb' && args[0] === 'connect') simulatedDelay(advance, options, 23_000);
    if (file === 'adb' && args.at(-1).startsWith("'cmd' 'package' 'resolve-activity'")) {
      assert.equal(options.timeout, 22_000);
      simulatedDelay(advance, options, 23_000); return 'com.android.settings/.Settings';
    }
    return result;
  };
  const started = pool.now();
  await assert.rejects(pool.launch(A, 'com.android.settings'), error => {
    assert.equal(error.code, 'device_operation_timeout');
    assert.deepEqual(operationDiagnostic(error), { action: 'launch', stage: 'resolve_activity', code: 'timeout', durationMs: 22_000, operationMs: 45_000 });
    return true;
  });
  assert.equal(pool.now() - started, 45_000);
  assert.equal(calls.some(item => item.args.at(-1).startsWith("'am' 'start'")), false);
  assert.equal(pool.devices.get(A).state, 'running');
});

test('expired queued operations return promptly and never run after the room is unlocked', async t => {
  const { pool, calls } = await fixture(t, { operationMs: 25 });
  await pool.wake(A);
  pool.now = Date.now;
  let release;
  const blocker = pool.lock(A, () => new Promise(resolve => { release = resolve; }));
  await Promise.resolve();
  const before = calls.length;
  await assert.rejects(pool.screenshot(A), error => error.code === 'device_operation_timeout' && operationDiagnostic(error).stage === 'queue');
  release(); await blocker;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.length, before);
  assert.equal(pool.depths.has(A), false);
});

test('client cancellation aborts running work and prevents any following input stage', async t => {
  const { pool } = await fixture(t);
  await pool.wake(A);
  const controller = new AbortController();
  const previous = pool.run;
  let connected, aborted, calls = 0;
  const began = new Promise(resolve => { connected = resolve; });
  pool.run = async (file, args, options) => {
    calls++;
    if (file === 'adb' && args[0] === 'connect') return new Promise((resolve, reject) => {
      aborted = options.signal;
      options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      connected();
    });
    return previous(file, args, options);
  };
  const pending = pool.input(A, { type: 'key', key: 'HOME' }, { signal: controller.signal });
  await began; controller.abort(new Error('private abort message'));
  await assert.rejects(pending, { code: 'device_operation_cancelled' });
  assert.equal(aborted.aborted, true);
  assert.equal(calls, 2); // inspect and connect; no key injection after disconnect.
  assert.equal(pool.devices.get(A).state, 'running');
});

test('execFile receives cancellation and stops a real child before its delayed write', async t => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ccb-mobile-abort-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const ready = path.join(directory, 'ready'), late = path.join(directory, 'late');
  const controller = new AbortController();
  const pending = runCommand(process.execPath, ['-e', "const fs=require('fs');fs.writeFileSync(process.argv[1],'ready');setTimeout(()=>fs.writeFileSync(process.argv[2],'unexpected'),300);", ready, late], { signal: controller.signal, timeout: 2000 });
  const rejected = assert.rejects(pending, { name: 'AbortError' });
  const deadline = Date.now() + 1500;
  while (true) {
    try { await readFile(ready); break; } catch (error) { if (error.code !== 'ENOENT' || Date.now() > deadline) throw error; }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  controller.abort(); await rejected;
  await new Promise(resolve => setTimeout(resolve, 350));
  await assert.rejects(readFile(late), { code: 'ENOENT' });
});

test('HTTP failures expose only fixed diagnostics, never command text, input, outputs or arbitrary codes', async t => {
  const { pool } = await fixture(t, { inputIme: 'com.android.adbkeyboard/.AdbIME' });
  await pool.wake(A);
  const secret = 'private-password-and-command-output';
  const previous = pool.run, logs = [];
  pool.run = async (file, args, options) => {
    if (file === 'adb' && args.at(-1).startsWith("'am' 'broadcast'")) throw Object.assign(new Error(secret), { code: secret, stdout: secret, stderr: secret, cmd: secret });
    return previous(file, args, options);
  };
  const server = createServer(pool, TOKEN, { logFailure: entry => logs.push(entry) });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/devices/${A}/input`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'text', text: secret }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'device_operation_failed', message: 'The mobile operation could not be completed.' });
  assert.equal(logs.length, 1);
  assert.deepEqual(Object.keys(logs[0]).sort(), ['action', 'code', 'durationMs', 'event', 'operationMs', 'requestMs', 'stage']);
  assert.equal(logs[0].action, 'input'); assert.equal(logs[0].stage, 'send_input'); assert.equal(logs[0].code, 'command_failed');
  assert.equal(JSON.stringify(logs).includes(secret), false);
  assert.equal(JSON.stringify(logs).includes(A), false);
});

test('closing the HTTP connection cancels the guest operation signal', async t => {
  let began, ended;
  const start = new Promise(resolve => { began = resolve; });
  const end = new Promise(resolve => { ended = resolve; });
  const pool = { screenshot: async (room, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => { ended(); reject(new Error('private disconnected request')); }, { once: true });
    began();
  }) };
  const server = createServer(pool, TOKEN, { logFailure: () => {} });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const request = http.get(`http://127.0.0.1:${server.address().port}/devices/${A}/screenshot`, { headers: { Authorization: `Bearer ${TOKEN}` } });
  request.on('error', () => {});
  await start; request.destroy();
  await Promise.race([end, new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('Disconnect did not cancel guest work')), 1000); timer.unref(); })]);
});

test('invalid screen data and child output limits have distinct safe diagnostic stages', async t => {
  const { pool } = await fixture(t);
  await pool.wake(A);
  const previous = pool.run;
  let outputLimit = false;
  pool.run = async (file, args, options) => {
    if (args.includes('screencap')) {
      if (outputLimit) throw Object.assign(new Error('private output sample'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER', killed: true, stdout: 'private output sample' });
      return Buffer.from('private invalid screen contents');
    }
    return previous(file, args, options);
  };
  await assert.rejects(pool.screenshot(A), error => error.code === 'device_screen_unavailable' && operationDiagnostic(error).stage === 'validate_screen');
  outputLimit = true;
  await assert.rejects(pool.screenshot(A), error => operationDiagnostic(error).stage === 'screencap' && operationDiagnostic(error).code === 'output_limit');
});

test('guest readiness opt-in is explicit and cannot silently accept a misspelled value', () => {
  const env = { MOBILE_ANDROID_IMAGE: 'image', MOBILE_BROKER_TOKEN: TOKEN };
  assert.equal(configuration(env).requireReadyRevision, false);
  assert.equal(configuration({ ...env, MOBILE_REQUIRE_READY_REVISION: 'true' }).requireReadyRevision, true);
  assert.equal(configuration({ ...env, MOBILE_REQUIRE_READY_REVISION: 'false' }).requireReadyRevision, false);
  assert.throws(() => configuration({ ...env, MOBILE_REQUIRE_READY_REVISION: 'yes' }), /MOBILE_REQUIRE_READY_REVISION/);
});

test('guest health waits for its post-restart revision but normal restart reuses the persistent proof', async t => {
  let marker;
  const readyRevision = async () => {
    if (marker instanceof Error) throw marker;
    return marker;
  };
  const health = async () => ({ ok: true, slots: 1, maxSlots: 1 });
  const makeServer = async options => {
    const server = createServer({ health }, TOKEN, options);
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
    return async (authenticated = true) => fetch(`http://127.0.0.1:${server.address().port}/health`, { headers: authenticated ? { Authorization: `Bearer ${TOKEN}` } : {} });
  };
  const request = await makeServer({ requireReadyRevision: true, readyRevision });
  assert.equal((await request(false)).status, 401);
  for (marker of [undefined, '000000000000', 'untrusted malformed revision', Object.assign(new Error('private marker error'), { code: 'ENOENT' }), new Error('unreadable marker')]) {
    const response = await request();
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: false, slots: 1, maxSlots: 1, runtimeRevision: BROKER_RUNTIME_REVISION });
  }
  marker = BROKER_RUNTIME_REVISION;
  assert.equal((await (await request()).json()).ok, true);
  const restarted = await makeServer({ requireReadyRevision: true, readyRevision });
  assert.equal((await (await restarted()).json()).ok, true);
  const host = await makeServer({ readyRevision: async () => { throw new Error('The host must never inspect a guest marker'); } });
  assert.equal((await (await host()).json()).ok, true);
});

test('ready marker reader uses only the fixed bounded non-symlink root-owned file', async () => {
  const { constants } = await import('node:fs');
  let closed = 0, reads = 0;
  let properties = { uid: 0, mode: 0o100644, size: 13, isFile: () => true };
  let contents = BROKER_RUNTIME_REVISION + '\n';
  const openFile = async (file, flags) => {
    assert.equal(file, '/etc/customcloudbot-mobile.ready-revision');
    assert.equal(flags & constants.O_NOFOLLOW, constants.O_NOFOLLOW);
    assert.equal(flags & constants.O_NONBLOCK, constants.O_NONBLOCK);
    return {
      stat: async () => properties,
      read: async buffer => { reads++; assert.equal(buffer.length, 14); return { bytesRead: buffer.write(contents) }; },
      close: async () => { closed++; },
    };
  };
  assert.equal(await readReadyRevision({ openFile }), BROKER_RUNTIME_REVISION);
  const safe = { ...properties };
  for (const changed of [{ uid: 1000 }, { mode: 0o100666 }, { size: 10000 }, { size: 0 }, { isFile: () => false }]) {
    properties = { ...safe, ...changed };
    assert.equal(await readReadyRevision({ openFile }), '');
  }
  assert.equal(reads, 1);
  properties = safe; contents = BROKER_RUNTIME_REVISION + 'xx';
  assert.equal(await readReadyRevision({ openFile }), '');
  assert.equal(closed, 7);
  await assert.rejects(readReadyRevision({ openFile: async () => { throw Object.assign(new Error('symlink refused'), { code: 'ELOOP' }); } }), { code: 'ELOOP' });
});
