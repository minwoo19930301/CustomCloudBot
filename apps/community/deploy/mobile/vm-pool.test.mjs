import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp, readFile, writeFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {VMPool, vmConfiguration, guestToken, requestGuest} from './vm-pool.mjs';
import {BROKER_RUNTIME_REVISION, createServer} from './service.mjs';
import {MobileError} from './device-pool.mjs';

const A = '12345678-1234-4234-8234-123456789abc';
const B = '87654321-4321-4321-8321-cba987654321';
const C = 'abcdef01-2345-4234-8234-123456789abc';
const TOKEN = 'private-test-token-with-at-least-32-characters';
const PNG = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'ccb-vm-test-'));
  const config = {...vmConfiguration({MOBILE_BROKER_TOKEN:TOKEN, MOBILE_VM_DATA_DIR:directory}), ...options.config};
  let time = 1_000_000, highWater = 0;
  const running = new Set(), calls = [], requests = [];
  const runtime = Object.fromEntries(['provision','start','stop','isRunning'].map(name => [name, async (spec, context) => {
    calls.push({name, ...spec});
    assert.ok(context.signal instanceof AbortSignal);
    if (options.runtime?.[name]) return options.runtime[name](spec, context, running);
    if (name === 'start') {running.add(spec.roomId); highWater = Math.max(highWater, running.size);}
    if (name === 'stop') running.delete(spec.roomId);
    if (name === 'isRunning') return running.has(spec.roomId);
  }]));
  const request = async (spec, request) => {
    requests.push({...request, ...spec});
    assert.equal(spec.token, guestToken(TOKEN, spec.roomId));
    assert.ok(request.path === '/health' || request.path.startsWith(`/devices/${spec.roomId}`));
    if (options.request) {
      const result = await options.request(spec, request);
      if (result !== undefined) return result;
    }
    if (request.path === '/health') return {ok:true, runtimeRevision:BROKER_RUNTIME_REVISION};
    if (request.path.endsWith('/screenshot')) return PNG;
    if (request.path.endsWith('/observe')) return {width:720, height:1280, nodes:[]};
    return {device:{roomId:spec.roomId, state:'running'}};
  };
  const dependencies = {runtime, request, now:() => time, pause:async ms => {time += ms;}};
  const pool = new VMPool(config, dependencies);
  await pool.initialize();
  t.after(async () => {await Promise.all([...pool.starts.values()]); await rm(directory, {recursive:true, force:true});});
  return {pool, config, dependencies, running, calls, requests, directory, advance:ms => {time += ms;}, highWater:() => highWater};
}

async function ready(pool, id) {
  await pool.wake(id);
  await pool.starts.get(id);
  const result = await pool.status(id);
  assert.equal(result.device.state, 'running', JSON.stringify(result));
  return result;
}

test('configuration keeps ten saved VMs, one running VM and bounded cold boot by default', () => {
  const config = vmConfiguration({MOBILE_BROKER_TOKEN:TOKEN});
  assert.equal(config.maxSlots, 10); assert.equal(config.maxRunning, 1); assert.equal(config.wakeMs, 300000);
  assert.equal(config.dataDir, '/var/lib/customcloudbot-mobile-vm');
  assert.equal(vmConfiguration({MOBILE_BROKER_TOKEN:TOKEN, MOBILE_VM_REQUEST_SECONDS:'60'}).requestMs, 60_000);
  assert.equal(guestToken(TOKEN, A), guestToken(TOKEN, A.toUpperCase()));
  assert.notEqual(guestToken(TOKEN, A), guestToken(TOKEN, B));
  for (const env of [{MOBILE_MAX_SLOTS:'101'}, {MOBILE_MAX_RUNNING:'0'}, {MOBILE_VM_BASE_PORT:'65535'}, {MOBILE_VM_DATA_DIR:'../tmp'}, {MOBILE_VM_BOOT_SECONDS:'0'}, {MOBILE_VM_REQUEST_SECONDS:'61'}])
    assert.throws(() => vmConfiguration({MOBILE_BROKER_TOKEN:TOKEN, ...env}));
  assert.throws(() => guestToken(TOKEN, '../other'));
});

test('status and leases never allocate a VM; startup is asynchronous and deduplicated', async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, {request:async (spec, request) => {if (request.path.endsWith('/wake')) {entered.resolve(); await gate.promise;}}});
  t.after(() => gate.resolve());
  assert.equal((await f.pool.status(A)).device.state, 'unallocated');
  await f.pool.lease(A, false); await f.pool.health();
  assert.equal(f.calls.length, 0);
  assert.equal((await f.pool.wake(A)).device.state, 'starting');
  await entered.promise;
  assert.equal((await f.pool.wake(A)).device.state, 'starting');
  assert.equal((await f.pool.status(A)).device.state, 'starting');
  assert.equal(f.calls.filter(call => call.name === 'start').length, 1);
  const pending = f.pool.starts.get(A); gate.resolve(); await pending;
  assert.equal((await f.pool.status(A)).device.state, 'running');
  assert.equal(f.calls.filter(call => call.name === 'provision').length, 1);
  const publicText = JSON.stringify(await f.pool.status(A));
  const persisted = await readFile(path.join(f.directory, 'vm-pool.json'), 'utf8');
  for (const privateValue of [TOKEN, guestToken(TOKEN,A), f.directory, '18091', 'unitName']) {
    assert.ok(!publicText.includes(privateValue)); assert.ok(!persisted.includes(privateValue));
  }
  assert.equal((await stat(path.join(f.directory,'vm-pool.json'))).mode & 0o777, 0o600);
  assert.equal((await stat(f.directory)).mode & 0o777, 0o750);
});

test('each room has a distinct VM, token and retained slot while inactive VMs are replaced', async t => {
  const f = await fixture(t);
  await ready(f.pool,A); f.advance(1000); await ready(f.pool,B);
  assert.deepEqual([...f.running], [B]);
  assert.equal((await f.pool.status(A)).device.state, 'sleeping');
  await ready(f.pool,A);
  assert.deepEqual([...f.running], [A]);
  assert.equal(f.highWater(), 1);
  const provisions = f.calls.filter(call => call.name === 'provision');
  const a = provisions.filter(call => call.roomId === A), b = provisions.find(call => call.roomId === B);
  assert.equal(a.length,2); assert.equal(a[0].slot,a[1].slot); assert.equal(a[0].token,a[1].token);
  assert.equal(a[0].dataDir, path.join(f.directory,'rooms',A));
  assert.notEqual(a[0].token,b.token); assert.notEqual(a[0].port,b.port);
  assert.equal(b.unitName,`customcloudbot-mobile-vm@${B}.service`);
  await f.pool.screenshot(A); await f.pool.observe(A); await f.pool.input(A,{type:'tap',x:10,y:20}); await f.pool.launch(A,'com.android.settings');
  assert.ok(f.requests.filter(request => request.roomId === A).every(request => request.port === a[0].port));
  assert.equal((await f.pool.health()).slots,2);
});

test('personal room UUID-shaped hashes pass through host allocation, guest routes and restart unchanged', async t => {
  const f=await fixture(t),id='f6f6cd49-10f4-6102-2f64-da6554d8dba8';
  await ready(f.pool,id);
  await f.pool.observe(id);await f.pool.input(id,{type:'key',key:'HOME'});await f.pool.sleep(id);
  assert.ok(f.requests.every(request=>request.path==='/health'||request.path.startsWith(`/devices/${id}`)));
  assert.ok(f.calls.every(call=>call.unitName===`customcloudbot-mobile-vm@${id}.service`));
  const restored=new VMPool(f.config,f.dependencies);await restored.initialize();
  assert.equal((await restored.status(id)).device.state,'sleeping');
  assert.equal(guestToken(TOKEN,id),guestToken(TOKEN,id.toUpperCase()));
});

test('leases prevent eviction; expired leases allow replacement and do not erase saved data', async t => {
  const f = await fixture(t);
  await ready(f.pool,A); await f.pool.lease(A,true);
  await f.pool.wake(B); await f.pool.starts.get(B);
  assert.equal((await f.pool.status(B)).device.lastError,'device_capacity_busy');
  assert.equal(f.pool.devices.has(B),false);
  assert.deepEqual([...f.running],[A]);
  await assert.rejects(f.pool.sleep(A), error => error.code === 'device_in_use');
  f.advance(f.config.leaseMs + 1); await ready(f.pool,B);
  assert.deepEqual([...f.running],[B]);
  assert.equal(f.pool.devices.has(A),true);
  await f.pool.lease(A,false);
});

test('an in-flight screen operation cannot be evicted by another wake', async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t,{request:async (spec, request) => {if(request.path.endsWith('/observe')) {entered.resolve(); await gate.promise;}}});
  t.after(() => gate.resolve());
  await ready(f.pool,A);
  const observing = f.pool.observe(A); await entered.promise;
  await f.pool.wake(B); await f.pool.starts.get(B);
  assert.equal((await f.pool.status(B)).device.lastError,'device_capacity_busy');
  assert.equal(f.calls.filter(call => call.name === 'stop').length,0);
  gate.resolve(); await observing; await ready(f.pool,B);
});

test('an expired queued input returns promptly and never runs when the previous operation releases', async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, {config:{requestMs:20}, request:async (spec, request) => {
    if (request.path.endsWith('/observe')) {entered.resolve(); await gate.promise;}
  }});
  t.after(() => gate.resolve());
  await ready(f.pool, A);
  const first = f.pool.operation(A, 'observe', {timeoutMs:1000});
  await entered.promise;
  await assert.rejects(f.pool.input(A, {type:'key', key:'HOME'}), {code:'device_queue_timeout'});
  assert.equal(f.requests.some(request => request.path.endsWith('/input')), false);
  gate.resolve(); await first;
  await f.pool.locks.get(A)?.catch(() => {});
  assert.equal(f.requests.some(request => request.path.endsWith('/input')), false);
  assert.equal(f.pool.depths.has(A), false);
});

test('guest operation receives only the configured budget left after queue wait', async t => {
  const gate = deferred(), entered = deferred();
  const f = await fixture(t, {config:{requestMs:60_000}, request:async (spec, request) => {
    if (request.path.endsWith('/observe')) {entered.resolve(); await gate.promise;}
  }});
  t.after(() => gate.resolve());
  await ready(f.pool, A);
  const first = f.pool.operation(A, 'observe', {timeoutMs:60_000});
  await entered.promise;
  const second = f.pool.input(A, {type:'key', key:'HOME'});
  f.advance(9000); gate.resolve();
  await Promise.all([first, second]);
  assert.equal(f.requests.find(request => request.path.endsWith('/input')).timeoutMs, 51_000);
});

test('an in-flight operation aborts its guest transport when the shared budget expires', async t => {
  let signal;
  const f = await fixture(t, {config:{requestMs:20}, request:async (spec, request) => {
    if (request.path.endsWith('/input')) {
      signal = request.signal;
      return new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(new MobileError('guest_request_cancelled', 'Cancelled', 499)), {once:true});
      });
    }
  }});
  await ready(f.pool, A);
  await assert.rejects(f.pool.input(A, {type:'key', key:'HOME'}), {code:'guest_request_timeout'});
  assert.equal(signal.aborted, true);
  await f.pool.locks.get(A)?.catch(() => {});
  assert.equal(f.pool.depths.has(A), false);
  assert.equal(f.calls.some(call => call.name === 'stop'), false);
});

test('all four VM operation methods reject already-cancelled callers without sending work', async t => {
  const f = await fixture(t);
  await ready(f.pool, A);
  const count = f.requests.length, controller = new AbortController(); controller.abort();
  const options = {signal:controller.signal};
  for (const action of [() => f.pool.screenshot(A, options), () => f.pool.observe(A, options),
    () => f.pool.input(A, {type:'key', key:'HOME'}, options), () => f.pool.launch(A, 'com.android.settings', options)]) {
    await assert.rejects(action(), {code:'device_operation_cancelled', status:409});
  }
  assert.equal(f.requests.length, count);
  assert.equal(f.pool.depths.has(A), false);
});

test('caller cancellation removes a queued input from execution without cancelling an unrelated active operation', async t => {
  const gate = deferred(), entered = deferred();
  let activeSignal;
  const f = await fixture(t, {request:async (spec, request) => {
    if (request.path.endsWith('/observe')) {activeSignal = request.signal; entered.resolve(); await gate.promise;}
  }});
  t.after(() => gate.resolve());
  await ready(f.pool, A);
  const first = f.pool.observe(A); await entered.promise;
  const controller = new AbortController();
  const second = assert.rejects(f.pool.input(A, {type:'key', key:'HOME'}, {signal:controller.signal}), {code:'device_operation_cancelled'});
  controller.abort(); await second;
  assert.equal(activeSignal.aborted, false);
  gate.resolve(); await first;
  await f.pool.locks.get(A)?.catch(() => {});
  assert.equal(f.requests.some(request => request.path.endsWith('/input')), false);
});

test('all four VM operation methods forward caller cancellation to the active guest request', async t => {
  const f = await fixture(t);
  await ready(f.pool, A);
  const original = f.pool.request;
  for (const action of ['screenshot', 'observe', 'input', 'launch']) {
    const entered = deferred(); let guestSignal;
    f.pool.request = (spec, request) => {
      if (!request.path.endsWith('/' + action)) return original(spec, request);
      guestSignal = request.signal; entered.resolve();
      return new Promise((resolve, reject) => guestSignal.addEventListener('abort', () => reject(new MobileError('guest_request_cancelled', 'Cancelled', 499)), {once:true}));
    };
    const controller = new AbortController(), options = {signal:controller.signal};
    const pending = action === 'input' ? f.pool.input(A, {type:'key', key:'HOME'}, options)
      : action === 'launch' ? f.pool.launch(A, 'com.android.settings', options) : f.pool[action](A, options);
    const rejected = assert.rejects(pending, {code:'device_operation_cancelled', status:409});
    await entered.promise; controller.abort(); await rejected;
    assert.equal(guestSignal.aborted, true);
    await f.pool.locks.get(A)?.catch(() => {});
    assert.equal(f.pool.depths.has(A), false);
  }
});

test('closing the app HTTP request cancels the guest request through the shared broker service', async t => {
  const entered = deferred(), aborted = deferred();
  const f = await fixture(t, {request:async (spec, request) => {
    if (request.path.endsWith('/screenshot')) {
      entered.resolve();
      return new Promise((resolve, reject) => request.signal.addEventListener('abort', () => {
        aborted.resolve(); reject(new MobileError('guest_request_cancelled', 'Cancelled', 499));
      }, {once:true}));
    }
  }});
  await ready(f.pool, A);
  const server = createServer(f.pool, TOKEN);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => {server.closeAllConnections(); await new Promise(resolve => server.close(resolve));});
  const controller = new AbortController();
  const pending = fetch(`http://127.0.0.1:${server.address().port}/devices/${A}/screenshot`, {headers:{authorization:`Bearer ${TOKEN}`}, signal:controller.signal});
  const rejected = assert.rejects(pending, {name:'AbortError'});
  await entered.promise; controller.abort(); await rejected;
  await Promise.race([aborted.promise, new Promise((resolve, reject) => {const timer = setTimeout(() => reject(new Error('Guest cancellation was not forwarded')), 500); aborted.promise.finally(() => clearTimeout(timer));})]);
  await f.pool.locks.get(A)?.catch(() => {});
  assert.equal(f.pool.depths.has(A), false);
  assert.equal(f.calls.some(call => call.name === 'stop'), false);
});

test('concurrent wakes and stored-slot exhaustion cannot exceed capacity or stop an unrelated VM', async t => {
  const f = await fixture(t,{config:{maxSlots:2}});
  await Promise.all([f.pool.wake(A),f.pool.wake(B)]);
  await Promise.all([...f.pool.starts.values()]);
  assert.ok(f.highWater() <= 1);
  // The second room retries after the first boot (a boot is itself protected).
  await ready(f.pool,B);
  const stops = f.calls.filter(call => call.name === 'stop').length;
  await f.pool.wake(C); await f.pool.starts.get(C);
  assert.equal((await f.pool.status(C)).device.lastError,'device_slots_full');
  assert.equal(f.calls.filter(call => call.name === 'stop').length,stops);
  assert.deepEqual([...f.running],[B]);
});

test('idle sweep ignores status polling, respects leases, and stops only after input becomes idle', async t => {
  const f = await fixture(t);
  await ready(f.pool,A); f.advance(f.config.idleMs-1);
  await f.pool.input(A,{type:'key',key:'HOME'}); f.advance(f.config.idleMs-1);
  await f.pool.status(A); await f.pool.sweepIdle(); assert.ok(f.running.has(A));
  f.advance(2); await f.pool.sweepIdle(); assert.equal(f.running.size,0);
  const count = f.calls.length; await f.pool.sleep(B); assert.equal(f.calls.length,count);
  await ready(f.pool,A); await f.pool.lease(A,true); f.advance(f.config.leaseMs-1);
  await f.pool.sweepIdle(); assert.ok(f.running.has(A));
});

test('guest readiness failure stops its VM and exposes a retryable state without private errors', async t => {
  const f = await fixture(t,{config:{bootMs:2000},request:async (spec, request) => {if(request.path==='/health') throw new Error(spec.token);}});
  await f.pool.wake(A); await f.pool.starts.get(A);
  const status = await f.pool.status(A);
  assert.equal(status.device.state,'error'); assert.equal(status.device.lastError,'vm_boot_timeout');
  assert.equal(f.running.size,0); assert.equal(status.capacity.running,0);
  assert.ok(!JSON.stringify(status).includes(guestToken(TOKEN,A)));
});

test('a booted guest keyboard warning keeps the VM usable and an explicit wake retries initialization', async t => {
  let warning = true;
  const f = await fixture(t, {request:async (spec, request) => {
    if (request.path.endsWith('/wake')) return {device:{roomId:spec.roomId, state:'running', ...(warning ? {lastError:'device_keyboard_timeout'} : {})}};
  }});
  const first = await ready(f.pool, A);
  assert.equal(first.device.lastError, 'device_keyboard_timeout');
  assert.equal(first.capacity.running, 1);
  assert.ok(f.running.has(A));
  assert.equal(f.calls.some(call => call.name === 'stop'), false);
  assert.equal(JSON.parse(await readFile(path.join(f.directory, 'vm-pool.json'), 'utf8')).devices[0].lastError, 'device_keyboard_timeout');
  assert.deepEqual(await f.pool.screenshot(A), PNG);
  await f.pool.input(A, {type:'key', key:'HOME'});
  assert.equal((await ready(f.pool, A)).device.lastError, 'device_keyboard_timeout');
  assert.equal(f.requests.filter(request => request.path.endsWith('/wake')).length, 2);
  warning = false;
  assert.equal((await ready(f.pool, A)).device.lastError, undefined);
  assert.equal(f.requests.filter(request => request.path.endsWith('/wake')).length, 3);
  await f.pool.wake(A);
  assert.equal(f.requests.filter(request => request.path.endsWith('/wake')).length, 3);
  assert.equal(f.calls.filter(call => call.name === 'start').length, 1);
  assert.equal(f.calls.some(call => call.name === 'stop'), false);
});

test('a booted guest display warning stays running and explicit wake retries until the display is ready', async t => {
  let warning = true;
  const f = await fixture(t, {request:async (spec, request) => {
    if (request.path.endsWith('/wake')) return {device:{roomId:spec.roomId, state:'running', ...(warning ? {lastError:'device_display_timeout'} : {})}};
  }});
  const first = await ready(f.pool, A);
  assert.equal(first.device.lastError, 'device_display_timeout');
  assert.equal(first.capacity.running, 1);
  assert.equal(JSON.parse(await readFile(path.join(f.directory, 'vm-pool.json'), 'utf8')).devices[0].lastError, 'device_display_timeout');
  assert.deepEqual(await f.pool.screenshot(A), PNG);
  await f.pool.input(A, {type:'key', key:'HOME'});
  assert.equal((await ready(f.pool, A)).device.lastError, 'device_display_timeout');
  assert.equal(f.requests.filter(request => request.path.endsWith('/wake')).length, 2);
  warning = false;
  assert.equal((await ready(f.pool, A)).device.lastError, undefined);
  assert.equal(f.requests.filter(request => request.path.endsWith('/wake')).length, 3);
  await f.pool.wake(A);
  assert.equal(f.requests.filter(request => request.path.endsWith('/wake')).length, 3);
  assert.equal(f.calls.filter(call => call.name === 'start').length, 1);
  assert.equal(f.calls.some(call => call.name === 'stop'), false);
});

test('guest wake transport allows Docker and response overhead beyond the unchanged boot limit', async t => {
  const f = await fixture(t, {config:{wakeMs:600_000}, request:async (spec, request) => {
    if (request.path.endsWith('/wake')) {
      assert.equal(request.timeoutMs, 630_000);
      return {device:{roomId:spec.roomId, state:'running', lastError:'device_keyboard_timeout'}};
    }
  }});
  const status = await ready(f.pool, A);
  assert.equal(f.config.wakeMs, 600_000);
  assert.equal(status.device.lastError, 'device_keyboard_timeout');
  assert.equal(f.calls.some(call => call.name === 'stop'), false);
  await f.pool.input(A, {type:'key', key:'HOME'});
  assert.equal(f.requests.find(request => request.path.endsWith('/input')).timeoutMs, f.config.requestMs);
});

test('one interrupted guest wake survives broker restart and waits for matching health without restarting the VM', async t => {
  for (const code of ['guest_connection_failed', 'guest_request_cancelled']) await t.test(code, async t => {
    let wakes = 0, recoveryHealth = 0;
    const f = await fixture(t, {config:{wakeMs:600_000}, request:async (spec, request) => {
      if (request.path.endsWith('/wake')) {
        wakes++;
        if (wakes === 1) {f.advance(100_000); throw new MobileError(code, 'Disconnected', 503);}
        assert.equal(recoveryHealth, 3);
        assert.equal(request.timeoutMs, 528_000);
      }
      if (request.path === '/health' && wakes) {
        recoveryHealth++;
        if (recoveryHealth === 1) throw new MobileError('guest_connection_failed', 'Restarting', 503);
        if (recoveryHealth === 2) return {ok:true, runtimeRevision:'000000000000'};
      }
    }});
    await ready(f.pool, A);
    assert.equal(wakes, 2);
    assert.equal(f.calls.filter(call => call.name === 'start').length, 1);
    assert.equal(f.calls.some(call => call.name === 'stop'), false);
    assert.ok(f.running.has(A));
  });
});

test('guest wake connection recovery is attempted only once', async t => {
  let wakes = 0;
  const f = await fixture(t, {request:async (spec, request) => {
    if (request.path.endsWith('/wake')) {wakes++; throw new MobileError('guest_connection_failed', 'Disconnected', 503);}
  }});
  await f.pool.wake(A); await f.pool.starts.get(A);
  assert.equal(wakes, 2);
  assert.equal((await f.pool.status(A)).device.lastError, 'guest_connection_failed');
  assert.equal(f.running.size, 0);
});

test('Android failures, HTTP operation failures and expired requests are never retried as restarts', async t => {
  for (const code of ['device_boot_timeout', 'guest_operation_failed', 'guest_request_timeout']) await t.test(code, async t => {
    let wakes = 0;
    const f = await fixture(t, {request:async (spec, request) => {
      if (request.path.endsWith('/wake')) {wakes++; throw new MobileError(code, 'Failed', 503);}
    }});
    await f.pool.wake(A); await f.pool.starts.get(A);
    assert.equal(wakes, 1);
    assert.equal((await f.pool.status(A)).device.lastError, code);
  });
});

test('guest wake recovery never retries a VM that has exited', async t => {
  let wakes = 0;
  const f = await fixture(t, {request:async (spec, request) => {
    if (request.path.endsWith('/wake')) {
      wakes++; f.running.delete(A);
      throw new MobileError('guest_connection_failed', 'Disconnected', 503);
    }
  }});
  await f.pool.wake(A); await f.pool.starts.get(A);
  assert.equal(wakes, 1);
  assert.equal((await f.pool.status(A)).device.lastError, 'vm_start_failed');
  assert.equal(f.requests.filter(request => request.path === '/health').length, 1);
});

test('restart recovery health wait is at most thirty seconds and never extends the original wake deadline', async t => {
  for (const firstElapsed of [100_000, 629_000]) await t.test(String(firstElapsed), async t => {
    let wakes = 0;
    const f = await fixture(t, {config:{wakeMs:600_000}, request:async (spec, request) => {
      if (request.path.endsWith('/wake')) {
        wakes++; f.advance(firstElapsed);
        throw new MobileError('guest_connection_failed', 'Disconnected', 503);
      }
      if (request.path === '/health' && wakes) return {ok:true, runtimeRevision:'000000000000'};
    }});
    const started = f.pool.now();
    await f.pool.wake(A); await f.pool.starts.get(A);
    assert.equal(wakes, 1);
    assert.equal(f.pool.now() - started, Math.min(firstElapsed + 30_000, 630_000));
    assert.equal((await f.pool.status(A)).device.lastError, 'guest_connection_failed');
  });
});

test('guest wake only copies recognized readiness warnings into public and persisted status', async t => {
  const f = await fixture(t, {request:async (spec, request) => {
    if (request.path.endsWith('/wake')) return {device:{roomId:spec.roomId, state:'running', lastError:spec.token}};
  }});
  const status = await ready(f.pool, A);
  assert.equal(status.device.lastError, undefined);
  assert.ok(!JSON.stringify(status).includes(guestToken(TOKEN, A)));
  assert.ok(!(await readFile(path.join(f.directory, 'vm-pool.json'), 'utf8')).includes(guestToken(TOKEN, A)));
});

test('host waits for the approved running broker revision before asking Android to wake', async t => {
  let healthCalls = 0;
  const f = await fixture(t, {config:{bootMs:5000}, request:async (spec, request) => {
    if (request.path === '/health') {
      healthCalls++;
      return {ok:true, ...(healthCalls === 1 ? {} : {runtimeRevision:healthCalls === 2 ? '000000000000' : BROKER_RUNTIME_REVISION})};
    }
    if (request.path.endsWith('/wake')) assert.equal(healthCalls, 3);
  }});
  assert.equal(f.config.expectedGuestRevision, BROKER_RUNTIME_REVISION);
  await ready(f.pool, A);
  assert.equal(healthCalls, 3);
  assert.equal(f.requests.filter(request => request.path.endsWith('/wake')).length, 1);
});

test('a stale broker that never restarts cannot receive the wake request', async t => {
  const f = await fixture(t, {config:{bootMs:2000}, request:async (spec, request) => {
    if (request.path === '/health') return {ok:true, runtimeRevision:'000000000000'};
  }});
  await f.pool.wake(A);
  await f.pool.starts.get(A);
  assert.equal((await f.pool.status(A)).device.lastError, 'vm_boot_timeout');
  assert.equal(f.requests.some(request => request.path.endsWith('/wake')), false);
  assert.equal(f.running.size, 0);
});

test('wrong-room guest response cannot mark Android ready and unsuccessful stop still occupies capacity', async t => {
  const f = await fixture(t,{request:async (spec, request) => {if(request.path.endsWith('/wake'))return {device:{roomId:B,state:'running'}};},runtime:{stop:async()=>{}}});
  await f.pool.wake(A); await f.pool.starts.get(A);
  const status = await f.pool.status(A);
  assert.equal(status.device.state,'error'); assert.equal(status.capacity.running,1);
  await f.pool.wake(B); await f.pool.starts.get(B);
  assert.equal((await f.pool.status(B)).device.lastError,'vm_stop_failed');
  assert.equal(f.calls.filter(call => call.name === 'start').length,1);
});

test('restart reconciles actual VMs, never wakes saved devices, and rejects duplicate persisted slots', async t => {
  const f = await fixture(t); await ready(f.pool,A); await ready(f.pool,B); await f.pool.sleep(B);
  const starts = f.calls.filter(call => call.name === 'start').length;
  const restored = new VMPool(f.config,f.dependencies); await restored.initialize();
  assert.equal((await restored.status(A)).device.state,'sleeping'); assert.equal((await restored.health()).slots,2);
  assert.equal(f.calls.filter(call => call.name === 'start').length,starts);
  const stateFile = path.join(f.directory,'vm-pool.json');
  const state = JSON.parse(await readFile(stateFile,'utf8')); state.devices[1].slot=state.devices[0].slot;
  await writeFile(stateFile,JSON.stringify(state));
  await assert.rejects(new VMPool(f.config,f.dependencies).initialize(), /Invalid VM slot/);
});

test('controller restart rechecks Android boot instead of treating active QEMU or cached guest status as ready', async t => {
  const f = await fixture(t); await ready(f.pool,A);
  const gate=deferred(),entered=deferred();
  const restored=new VMPool(f.config,{...f.dependencies,request:async(spec,request)=>{
    if(request.path.endsWith('/wake')){entered.resolve();await gate.promise;}
    return f.dependencies.request(spec,request);
  }});
  t.after(async()=>{gate.resolve();await Promise.all([...restored.starts.values()]);});
  const starts=f.calls.filter(call=>call.name==='start').length;
  await restored.initialize(); await entered.promise;
  assert.equal((await restored.status(A)).device.state,'starting');
  assert.equal(f.calls.filter(call=>call.name==='start').length,starts);
  const pending=restored.starts.get(A);gate.resolve();await pending;
  assert.equal((await restored.status(A)).device.state,'running');
});

test('eviction reserves the old room while a late lease is queued', async t => {
  const gate=deferred(),entered=deferred();
  const f=await fixture(t,{runtime:{stop:async(spec,context,running)=>{entered.resolve();await gate.promise;running.delete(spec.roomId);}}});
  t.after(()=>gate.resolve());
  await ready(f.pool,A);
  await f.pool.wake(B);await entered.promise;
  const leasing=assert.rejects(f.pool.lease(A,true),error=>error.code==='device_sleeping');
  gate.resolve();await leasing;await f.pool.starts.get(B);
  assert.equal((await f.pool.status(A)).device.leaseExpiresAt,0);
  assert.equal((await f.pool.status(B)).device.state,'running');
  assert.equal(f.highWater(),1);
});

test('runtime deadlines abort a hung provision and publish a safe retryable failure', async t => {
  let aborted=false;
  const f=await fixture(t,{config:{provisionMs:10},runtime:{provision:async(spec,{signal})=>new Promise(resolve=>{
    signal.addEventListener('abort',()=>{aborted=true;resolve();},{once:true});
  })}});
  await f.pool.wake(A);await f.pool.starts.get(A);
  assert.equal(aborted,true);
  const status=await f.pool.status(A);
  assert.equal(status.device.state,'error');assert.equal(status.device.lastError,'vm_runtime_timeout');
  assert.equal(f.calls.filter(call=>call.name==='start').length,0);
});

test('a VM that exits immediately after start fails without waiting for the guest health deadline', async t => {
  const f=await fixture(t,{runtime:{start:async()=>{}}});
  await f.pool.wake(A);await f.pool.starts.get(A);
  const status=await f.pool.status(A);
  assert.equal(status.device.state,'error');assert.equal(status.device.lastError,'vm_start_failed');
  assert.equal(status.capacity.running,0);
  assert.equal(f.requests.length,0,'a unit that has already stopped is not polled for three minutes');
});

test('a VM exiting while guest networking is pending fails before another health retry', async t => {
  let stopVM;
  const f=await fixture(t,{request:async(spec,request)=>{if(request.path==='/health'){stopVM();return {ok:false};}}});
  stopVM=()=>f.running.delete(A);
  await f.pool.wake(A);await f.pool.starts.get(A);
  assert.equal((await f.pool.status(A)).device.lastError,'vm_start_failed');
  assert.equal(f.requests.filter(request=>request.path==='/health').length,1);
});

test('tasks can reserve and release a lease during long boot without waiting behind it', async t => {
  const gate=deferred(),entered=deferred();
  const f=await fixture(t,{request:async(spec,request)=>{if(request.path.endsWith('/wake')){entered.resolve();await gate.promise;}}});
  t.after(()=>gate.resolve());
  await f.pool.wake(A);await entered.promise;
  const reserved=await f.pool.lease(A,true);
  assert.equal(reserved.device.state,'starting');assert.ok(reserved.device.leaseExpiresAt>0);
  assert.ok(f.requests.every(request=>!request.path.endsWith('/lease')),'starting leases are host-only until Android is ready');
  const released=await f.pool.lease(A,false);assert.equal(released.device.leaseExpiresAt,0);
  await f.pool.lease(A,true);
  const pending=f.pool.starts.get(A);gate.resolve();await pending;
  assert.ok((await f.pool.status(A)).device.leaseExpiresAt>0,'the host lease protects the transition to running');
  await f.pool.wake(B);await f.pool.starts.get(B);
  assert.equal((await f.pool.status(B)).device.lastError,'device_capacity_busy');
});

test('input and launch validation cannot become arbitrary commands or select another room', async t => {
  const f = await fixture(t); await ready(f.pool,A);
  const count=f.requests.length;
  for (const body of [{type:'shell',command:'id'},{type:'tap',x:1,y:1,roomId:B},{type:'text',text:'\nreboot'},{type:'key',key:'POWER'},{type:'swipe',x1:0,y1:0,x2:1,y2:1,duration:9999}])
    await assert.rejects(f.pool.input(A,body), error => error.code==='invalid_input');
  await assert.rejects(f.pool.launch(A,'com.example;id'), error=>error.code==='invalid_package');
  await assert.rejects(f.pool.wake('../outside'));
  assert.equal(f.requests.length,count);
});

test('private guest transport fixes host, authorization and room routes, and bounds bodies and waits', async t => {
  const seen=[];
  let handler=(request,response)=>{response.end('{"ok":true}');};
  const server=http.createServer((request,response)=>{seen.push({path:request.url,authorization:request.headers.authorization});handler(request,response);});
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const spec={roomId:A,port:server.address().port,token:guestToken(TOKEN,A)};
  assert.deepEqual(await requestGuest(spec,{path:'/health'}),{ok:true});
  assert.deepEqual(seen,[{path:'/health',authorization:`Bearer ${spec.token}`}]);
  await assert.rejects(requestGuest(spec,{path:`/devices/${B}/observe`}),error=>error.code==='guest_request_invalid');
  await assert.rejects(requestGuest(spec,{path:`/devices/${A}/input`,method:'POST',body:{text:'x'.repeat(17000)}}),error=>error.code==='guest_request_invalid');
  assert.equal(seen.length,1);
  handler=(request,response)=>{response.writeHead(302,{location:'http://example.com/secret'});response.end(spec.token);};
  await assert.rejects(requestGuest(spec,{path:'/health'}),error=>error.code==='guest_operation_failed'&&!error.message.includes(spec.token));
  for (const [code, status] of [['device_starting',409], ['device_screen_unavailable',503], ['device_display_timeout',503], ['device_operation_failed',503], ['device_operation_timeout',504], ['device_operation_cancelled',409], ['invalid_coordinates',400]]) {
    handler=(request,response)=>{response.writeHead(503,{'content-type':'application/json'});response.end(JSON.stringify({error:code,message:spec.token,stderr:spec.token}));};
    await assert.rejects(requestGuest(spec,{path:`/devices/${A}/screenshot`,binary:true}), error => error.code === code && error.status === status && !error.message.includes(spec.token));
  }
  for (const code of [spec.token, '__proto__', 'constructor', {private:spec.token}]) {
    handler=(request,response)=>{response.writeHead(503);response.end(JSON.stringify({error:code,message:spec.token}));};
    await assert.rejects(requestGuest(spec,{path:'/health'}), error => error.code === 'guest_operation_failed' && !error.message.includes(spec.token));
  }
  handler=()=>{};
  await assert.rejects(requestGuest(spec,{path:'/health',timeoutMs:10}),error=>error.code==='guest_request_timeout');
  handler=(request,response)=>response.end('x'.repeat(256*1024+1));
  await assert.rejects(requestGuest(spec,{path:'/health'}),error=>error.code==='guest_response_too_large');
});

test('existing authenticated broker HTTP contract serves VM startup and status without private runtime fields', async t => {
  const f=await fixture(t); const server=createServer(f.pool,TOKEN);
  server.listen(0,'127.0.0.1'); await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const base=`http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base+'/health')).status,401);
  const response=await fetch(`${base}/devices/${A}/wake`,{method:'POST',headers:{authorization:`Bearer ${TOKEN}`,'content-type':'application/json'},body:'{}'});
  assert.equal(response.status,200); assert.equal((await response.json()).device.state,'starting');
  await f.pool.starts.get(A);
  const status=await (await fetch(`${base}/devices/${A}`,{headers:{authorization:`Bearer ${TOKEN}`}})).json();
  assert.equal(status.device.state,'running');
  for (const name of ['token','slot','port','unitName','dataDir'])assert.equal(Object.hasOwn(status.device,name),false);
});
