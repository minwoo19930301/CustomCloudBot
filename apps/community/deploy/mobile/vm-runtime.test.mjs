import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat, readdir, realpath} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {createVMRuntime, vmRuntimeConfiguration, validateVMSpec, runVMCommand} from './vm-runtime.mjs';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const TOKEN = 'a'.repeat(64);

async function fixture(t) {
  const dataDir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'ccb-vm-runtime-')));
  t.after(() => rm(dataDir, {recursive:true, force:true}));
  await mkdir(path.join(dataDir, 'base'), {mode:0o750});
  for (const name of ['golden.qcow2', 'Image', 'initrd']) await writeFile(path.join(dataDir, 'base', name), 'fixture', {mode:0o640});
  const env = {MOBILE_VM_DATA_DIR:dataDir};
  const calls = [], states = new Map();
  let seedFails = false, imageInfo = {format:'qcow2', 'virtual-size':12 * 1024 ** 3}, freeGiB = 30;
  const run = async (command, args, options = {}) => {
    calls.push({command, args, options});
    if (command === '/usr/bin/id') return {stdout:String(args[0] === '-u' ? process.getuid() : process.getgid())};
    if (command === '/usr/bin/systemctl') {
      const unit = args.at(-1);
      if (args[0] === 'show') return {stdout:states.get(unit) || 'inactive'};
      if (args[1] === 'start') states.set(unit, 'active');
      else if (args[1] === 'stop') states.set(unit, 'inactive');
      else throw Error('Unexpected systemctl command');
      return {stdout:''};
    }
    if (command === '/usr/bin/qemu-img') {
      if (args[0] === 'info') return {stdout:JSON.stringify(imageInfo)};
      assert.deepEqual(args.slice(0, 7), ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', path.join(dataDir, 'base/golden.qcow2')]);
      assert.equal(args.at(-1), '12G');
      await writeFile(args.at(-2), 'overlay', {mode:0o640});
      return {stdout:''};
    }
    assert.equal(command, '/opt/customcloudbot-mobile/seed-venv/bin/python');
    assert.deepEqual(args, ['/opt/customcloudbot-mobile/vm-seed.py']);
    if (seedFails) throw Error('failure that accidentally includes ' + TOKEN);
    const request = JSON.parse(options.input);
    assert.equal(request.token, TOKEN);
    await writeFile(request.output, 'private fake ISO', {mode:0o600});
    return {stdout:''};
  };
  const runtime = createVMRuntime(env, {run, controllerUid:process.getuid(), diskSpace:async () => ({bavail:BigInt(freeGiB) * 1024n ** 3n, bsize:1n})});
  const spec = {roomId:A, slot:0, unitName:`customcloudbot-mobile-vm@${A}.service`, port:18091,
    dataDir:path.join(dataDir, 'rooms', A), token:TOKEN};
  return {runtime, spec, env, dataDir, calls, states, failSeed:() => {seedFails = true;}, imageInfo:info => {imageInfo = info;}, freeSpace:gib => {freeGiB = gib;}};
}

test('untrusted paths, units, slots, ports and tokens never reach a root command', async t => {
  const {runtime, spec, calls} = await fixture(t);
  for (const change of [{roomId:'../etc'}, {roomId:A + ';reboot'}, {slot:-1}, {slot:10}, {port:8091},
    {unitName:'ssh.service'}, {dataDir:'/etc'}, {token:'token\nMOBILE_DOCKER_PRIVILEGED=true'}]) {
    for (const operation of ['provision', 'start', 'stop', 'isRunning']) await assert.rejects(runtime[operation]({...spec, ...change}), /specification/);
  }
  assert.equal(calls.length, 0);
  assert.throws(() => vmRuntimeConfiguration({MOBILE_VM_BASE_PORT:'22'}));
  assert.throws(() => vmRuntimeConfiguration({MOBILE_VM_DATA_DIR:'/var/lib/x,format=raw'}));
  assert.throws(() => vmRuntimeConfiguration({MOBILE_VM_DATA_DIR:'/var/lib/../etc'}));
  const c = vmRuntimeConfiguration({});
  assert.equal(validateVMSpec({...spec, dataDir:path.join(c.dataDir, 'rooms', A)}, c).roomId, A);
});

test('provision creates one persistent private overlay and keeps credentials out of argv and metadata', async t => {
  const {runtime, spec, calls} = await fixture(t);
  await runtime.provision(spec);
  assert.deepEqual((await readdir(spec.dataDir)).sort(), ['disk.qcow2', 'runtime.json', 'seed.iso']);
  assert.equal((await stat(path.join(spec.dataDir, 'disk.qcow2'))).mode & 0o777, 0o600);
  assert.equal((await stat(path.join(spec.dataDir, 'seed.iso'))).mode & 0o777, 0o640);
  const metadata = await readFile(path.join(spec.dataDir, 'runtime.json'), 'utf8');
  assert.equal(metadata.includes(TOKEN), false);
  assert.deepEqual(JSON.parse(metadata), {version:1, roomId:A, slot:0, port:18091});
  assert.equal(calls.some(call => JSON.stringify(call.args).includes(TOKEN)), false);
  await runtime.provision(spec);
  assert.equal(calls.filter(call => call.command === '/usr/bin/qemu-img' && call.args[0] === 'create').length, 1);
  await runtime.start(spec);
  assert.equal(await runtime.isRunning(spec), true);
  await runtime.stop(spec);
  assert.equal(await runtime.isRunning(spec), false);
});

test('legacy personal room shape provisions its exact private unit without weakening path validation', async t => {
  const {runtime,spec,dataDir,calls}=await fixture(t);
  const id='f6f6cd49-10f4-6102-2f64-da6554d8dba8';
  const personal={...spec,roomId:id,unitName:`customcloudbot-mobile-vm@${id}.service`,dataDir:path.join(dataDir,'rooms',id)};
  await runtime.provision(personal);await runtime.start(personal);
  assert.equal(await runtime.isRunning(personal),true);
  await runtime.stop(personal);assert.equal(await runtime.isRunning(personal),false);
  const count=calls.length;
  for (const room of [id+'\n',id+'\r',id+'/',id+'%2f',id.slice(1),id.replace('-','/'),'../'+id]) {
    const invalid={...personal,roomId:room,unitName:`customcloudbot-mobile-vm@${room}.service`,dataDir:path.join(dataDir,'rooms',room)};
    for (const operation of ['provision','start','stop','isRunning'])await assert.rejects(runtime[operation](invalid),/specification/);
  }
  assert.equal(calls.length,count);
});

test('broker umask 0077 preserves VM group access to immutable runtime metadata', async t => {
  const {runtime, spec} = await fixture(t);
  const previousMask = process.umask(0o077);
  try {
    await runtime.provision(spec);
  } finally {
    process.umask(previousMask);
  }
  const metadata = await stat(path.join(spec.dataDir, 'runtime.json'));
  assert.equal(metadata.mode & 0o777, 0o640, 'the unprivileged VM group must be able to read runtime.json');
  assert.equal(metadata.uid, process.getuid());
  assert.equal(metadata.gid, process.getgid());
  assert.equal((await stat(spec.dataDir)).mode & 0o777, 0o750);
  assert.equal((await stat(path.join(spec.dataDir, 'seed.iso'))).mode & 0o777, 0o640);
  assert.equal((await stat(path.join(spec.dataDir, 'disk.qcow2'))).mode & 0o777, 0o600);
});

test('partial seed failure cannot publish a bootable disk and does not disclose the credential', async t => {
  const {runtime, spec, failSeed} = await fixture(t);
  failSeed();
  await assert.rejects(runtime.provision(spec), error => !error.message.includes(TOKEN));
  assert.deepEqual(await readdir(spec.dataDir), []);
  await assert.rejects(runtime.start(spec));
});

test('symlinked rooms cannot redirect privileged image or seed writes', async t => {
  const {runtime, spec, dataDir, calls} = await fixture(t);
  const elsewhere = path.join(dataDir, 'elsewhere');
  await mkdir(elsewhere);
  await symlink(elsewhere, path.join(dataDir, 'rooms'));
  await assert.rejects(runtime.provision(spec));
  assert.deepEqual(await readdir(elsewhere), []);
  assert.equal(calls.some(call => call.args[0] === 'create'), false);
});

test('an existing room cannot be silently reassigned to another port or use a symlinked disk', async t => {
  const {runtime, spec} = await fixture(t);
  await runtime.provision(spec);
  await assert.rejects(runtime.provision({...spec, slot:1, port:18092}));
  const disk = path.join(spec.dataDir, 'disk.qcow2');
  await rm(disk);
  await symlink('/etc/passwd', disk);
  await assert.rejects(runtime.provision(spec));
});

test('golden image must be a standalone sealed 12GiB qcow2', async t => {
  const {runtime, spec, imageInfo, calls} = await fixture(t);
  for (const info of [{format:'raw', 'virtual-size':12 * 1024 ** 3}, {format:'qcow2', 'virtual-size':40 * 1024 ** 3},
    {format:'qcow2', 'virtual-size':12 * 1024 ** 3, 'backing-filename':'/private/build.qcow2'}]) {
    imageInfo(info);
    await assert.rejects(runtime.provision(spec));
  }
  assert.equal(calls.some(call => call.args[0] === 'create'), false);
});

test('abort before provision never executes a host command and no unit outside the UUID template is accepted', async t => {
  const {runtime, spec, calls} = await fixture(t);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runtime.provision(spec, {signal:controller.signal}));
  assert.equal(calls.length, 0);
  await assert.rejects(runtime.start({...spec, unitName:`customcloudbot-mobile-vm@${B}.service`}));
});

test('low host disk space cannot allocate a new Android disk', async t => {
  const {runtime, spec, calls, freeSpace} = await fixture(t);
  freeSpace(19);
  await assert.rejects(runtime.provision(spec), /20 GiB/);
  assert.equal(calls.some(call => call.args[0] === 'create'), false);
});

test('command failures and timeouts discard potentially sensitive child output', async () => {
  await assert.rejects(runVMCommand(process.execPath, ['-e', 'process.stdin.on("data", d => {console.error(d.toString());process.exit(1)})'], {input:TOKEN}), error => !error.message.includes(TOKEN));
  await assert.rejects(runVMCommand(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {timeoutMs:30}));
});
