import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {mkdtemp, readFile, writeFile, rm, stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {VMPool, vmConfiguration, guestToken, requestGuest} from './vm-pool.mjs';
import {createServer} from './service.mjs';

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
    if (request.path === '/health') return {ok:true};
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
  assert.equal(guestToken(TOKEN, A), guestToken(TOKEN, A.toUpperCase()));
  assert.notEqual(guestToken(TOKEN, A), guestToken(TOKEN, B));
  for (const env of [{MOBILE_MAX_SLOTS:'101'}, {MOBILE_MAX_RUNNING:'0'}, {MOBILE_VM_BASE_PORT:'65535'}, {MOBILE_VM_DATA_DIR:'../tmp'}, {MOBILE_VM_BOOT_SECONDS:'0'}])
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
