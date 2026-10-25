import {spawn} from 'node:child_process';
import {lstat, mkdir, chmod, chown, readFile, writeFile, rename, rm, statfs} from 'node:fs/promises';
import path from 'node:path';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const UNIT = id => `customcloudbot-mobile-vm@${id}.service`;
const fail = () => new Error('The private mobile VM runtime could not complete this operation.');
const abort = signal => {if (signal?.aborted) throw fail();};
const safePath = value => typeof value === 'string' && /^\/[A-Za-z0-9_./-]+$/.test(value) && path.normalize(value) === value && value !== '/';
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;

// Never return child output in an error: seed input contains a private credential.
export function runVMCommand(command, args, {input, signal, timeoutMs = 30000} = {}) {
  return new Promise((resolve, reject) => {
    abort(signal);
    let done = false, timer, stdout = '', size = 0;
    const child = spawn(command, args, {stdio:['pipe', 'pipe', 'pipe'], shell:false,
      env:{PATH:'/usr/sbin:/usr/bin:/sbin:/bin', LANG:'C', LC_ALL:'C'}});
    const finish = (error, value) => {
      if (done) return;
      done = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel);
      error ? reject(fail()) : resolve(value);
    };
    const cancel = () => {child.kill('SIGKILL'); finish(true);};
    signal?.addEventListener('abort', cancel, {once:true});
    timer = setTimeout(cancel, timeoutMs);
    child.stdout.on('data', chunk => {size += chunk.length; if (size > 65536) cancel(); else stdout += chunk.toString('utf8');});
    child.stderr.on('data', chunk => {size += chunk.length; if (size > 65536) cancel();});
    child.on('error', () => finish(true));
    child.stdin.on('error', () => {});
    child.on('close', code => finish(code !== 0, {stdout}));
    if (signal?.aborted) cancel();
    child.stdin.end(input);
  });
}

export function vmRuntimeConfiguration(env = process.env) {
  const dataDir = env.MOBILE_VM_DATA_DIR || '/var/lib/customcloudbot-mobile-vm';
  const baseDir = path.join(dataDir, 'base');
  const config = {
    dataDir, baseDir, goldenImage:path.join(baseDir, 'golden.qcow2'), kernel:path.join(baseDir, 'Image'), initrd:path.join(baseDir, 'initrd'),
    python:env.MOBILE_VM_SEED_PYTHON || '/opt/customcloudbot-mobile/seed-venv/bin/python',
    seedScript:env.MOBILE_VM_SEED_SCRIPT || '/opt/customcloudbot-mobile/vm-seed.py',
    systemctl:'/usr/bin/systemctl', qemuImg:'/usr/bin/qemu-img', id:'/usr/bin/id', user:'ccb-mobile-vm',
    maxSlots:Number(env.MOBILE_MAX_SLOTS || 10), basePort:Number(env.MOBILE_VM_BASE_PORT || 18091),
  };
  if (![dataDir, config.python, config.seedScript].every(safePath) || !integer(config.maxSlots, 1, 100) || config.basePort !== 18091)
    throw new Error('Invalid private mobile VM runtime configuration');
  return config;
}

export function validateVMSpec(spec, config) {
  if (!spec || typeof spec.roomId !== 'string' || spec.roomId.length !== 36 || !UUID.test(spec.roomId) || !integer(spec.slot, 0, config.maxSlots - 1) ||
      spec.unitName !== UNIT(spec.roomId) || spec.port !== 18091 + spec.slot ||
      spec.dataDir !== path.join(config.dataDir, 'rooms', spec.roomId) || !/^[0-9a-f]{64}$/.test(spec.token || ''))
    throw new Error('Invalid private mobile VM specification');
  return spec;
}

export function createVMRuntime(env = process.env, {run = runVMCommand, controllerUid = 0, diskSpace = statfs} = {}) {
  const config = vmRuntimeConfiguration(env);
  let identity;
  const command = async (file, args, options) => {try {return await run(file, args, options);} catch {throw fail();}};
  const vmIdentity = async signal => {
    if (!identity) {
      const uid = Number((await command(config.id, ['-u', config.user], {signal})).stdout.trim());
      const gid = Number((await command(config.id, ['-g', config.user], {signal})).stdout.trim());
      if (!integer(uid, 1, 2147483647) || !integer(gid, 1, 2147483647)) throw fail();
      identity = {uid, gid};
    }
    return identity;
  };
  const check = async (file, {directory = false, writable = false, uid = controllerUid} = {}) => {
    const stat = await lstat(file);
    if (stat.isSymbolicLink() || !(directory ? stat.isDirectory() : stat.isFile()) || stat.uid !== uid ||
        (!writable && (stat.mode & 0o022)) || (!directory && stat.nlink !== 1)) throw fail();
    return stat;
  };
  const directory = async (file, gid) => {
    try {await mkdir(file, {mode:0o750});} catch (error) {if (error.code !== 'EEXIST') throw error;}
    await check(file, {directory:true});
    await chown(file, controllerUid, gid); await chmod(file, 0o750);
  };
  const files = spec => ({disk:path.join(spec.dataDir, 'disk.qcow2'), seed:path.join(spec.dataDir, 'seed.iso'), metadata:path.join(spec.dataDir, 'runtime.json')});
  const metadata = spec => ({version:1, roomId:spec.roomId, slot:spec.slot, port:spec.port});
  const sameMetadata = async spec => {
    const target = files(spec).metadata;
    await check(target);
    const stat = await lstat(target);
    if (stat.size > 1024) throw fail();
    const stored = JSON.parse(await readFile(target, 'utf8'));
    if (JSON.stringify(stored) !== JSON.stringify(metadata(spec))) throw fail();
  };
  const isRunning = async (spec, {signal} = {}) => {
    validateVMSpec(spec, config); abort(signal);
    const result = await command(config.systemctl, ['show', '--property=ActiveState', '--value', spec.unitName], {signal, timeoutMs:10000});
    const state = result.stdout.trim();
    if (['active', 'activating', 'deactivating', 'reloading'].includes(state)) return true;
    if (['inactive', 'failed'].includes(state)) return false;
    throw fail();
  };
  return {
    async provision(spec, {signal} = {}) {
      validateVMSpec(spec, config); abort(signal);
      const {uid, gid} = await vmIdentity(signal);
      await check(config.dataDir, {directory:true});
      await check(config.baseDir, {directory:true});
      for (const file of [config.goldenImage, config.kernel, config.initrd]) await check(file);
      // The base must be flattened/sealed: a hidden backing path could expose a
      // writable build image or make boot depend on files outside the base bind.
      const info = JSON.parse((await command(config.qemuImg, ['info', '--output=json', config.goldenImage], {signal})).stdout);
      if (info.format !== 'qcow2' || info['backing-filename'] || info['virtual-size'] !== 12 * 1024 ** 3) throw fail();
      await directory(path.join(config.dataDir, 'rooms'), gid);
      await directory(spec.dataDir, gid);
      const target = files(spec);
      let exists = false;
      try {await lstat(target.disk); exists = true;} catch (error) {if (error.code !== 'ENOENT') throw error;}
      if (exists) {
        await sameMetadata(spec);
        await check(target.disk, {writable:true, uid});
        await check(target.seed);
        return;
      }
      if (await isRunning(spec, {signal})) throw fail();
      const space = await diskSpace(config.dataDir, {bigint:true});
      if (BigInt(space.bavail) * BigInt(space.bsize) < 20n * 1024n ** 3n) throw new Error('The mobile VM storage needs at least 20 GiB free before creating another device.');
      // No VM is running and room directories are root-owned/non-writable by
      // QEMU. A failed attempt can safely replace only these fixed temp files.
      const temporaryDisk = target.disk + '.tmp', temporarySeed = target.seed + '.tmp', temporaryMetadata = target.metadata + '.tmp';
      try {
        for (const file of [temporaryDisk, temporarySeed, temporaryMetadata]) await rm(file, {force:true});
        abort(signal);
        await command(config.qemuImg, ['create', '-f', 'qcow2', '-F', 'qcow2', '-b', config.goldenImage, temporaryDisk, '12G'], {signal, timeoutMs:30000});
        await check(temporaryDisk);
        await chown(temporaryDisk, uid, gid); await chmod(temporaryDisk, 0o600);
        await command(config.python, [config.seedScript], {signal, timeoutMs:30000,
          input:JSON.stringify({roomId:spec.roomId, token:spec.token, output:temporarySeed})});
        await check(temporarySeed);
        await chown(temporarySeed, controllerUid, gid); await chmod(temporarySeed, 0o640);
        await writeFile(temporaryMetadata, JSON.stringify(metadata(spec)), {mode:0o640, flag:'wx'});
        await chown(temporaryMetadata, controllerUid, gid);
        // The broker uses UMask=0077. Creation's mode is masked, so grant the
        // VM group read access explicitly before publishing this root-owned file.
        await chmod(temporaryMetadata, 0o640);
        abort(signal);
        await rename(temporarySeed, target.seed);
        await rename(temporaryMetadata, target.metadata);
        // Disk is the completion marker. It is published last, only after the
        // token seed and immutable slot assignment are both complete.
        await rename(temporaryDisk, target.disk);
      } catch {throw fail();}
      finally {for (const file of [temporaryDisk, temporarySeed, temporaryMetadata]) await rm(file, {force:true}).catch(() => {});}
    },
    async start(spec, {signal} = {}) {
      validateVMSpec(spec, config); abort(signal);
      await sameMetadata(spec);
      await command(config.systemctl, ['--no-ask-password', 'start', spec.unitName], {signal, timeoutMs:15000});
      if (!await isRunning(spec, {signal})) throw fail();
    },
    async stop(spec, {signal} = {}) {
      validateVMSpec(spec, config); abort(signal);
      await command(config.systemctl, ['--no-ask-password', 'stop', spec.unitName], {signal, timeoutMs:44000});
      if (await isRunning(spec, {signal})) throw fail();
    },
    isRunning,
  };
}
