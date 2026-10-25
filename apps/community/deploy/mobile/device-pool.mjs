import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, rename, writeFile, lstat } from 'node:fs/promises';
import path from 'node:path';

const execFileAsync = promisify(execFile);
// Personal room IDs preserve this shape but may not have RFC UUID variant bits.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_CODES = Object.freeze({ BACK: 4, HOME: 3, APP_SWITCH: 187, ENTER: 66, DEL: 67, TAB: 61, ESCAPE: 111, DPAD_UP: 19, DPAD_DOWN: 20, DPAD_LEFT: 21, DPAD_RIGHT: 22 });
const OWNER_LABEL = 'org.customcloudbot.mobile';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const integer = (value, low, high) => Number.isInteger(value) && value >= low && value <= high;
const diagnostics = new WeakMap();
export const operationDiagnostic = error => diagnostics.get(error);
const failureKind = error => {
  if (error?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') return 'output_limit';
  if (error?.code === 'device_operation_cancelled' || error?.name === 'AbortError') return 'cancelled';
  if (error?.code === 'device_operation_timeout' || error?.killed || error?.code === 'ETIMEDOUT') return 'timeout';
  if (['ENOENT', 'EACCES', 'EPERM'].includes(error?.code)) return 'spawn_failed';
  if (Number.isInteger(error?.code) && error.code >= 0 && error.code <= 255) return `exit_${error.code}`;
  return error instanceof MobileError ? 'device_error' : 'command_failed';
};
const shellQuote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";

export class MobileError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}

export function roomId(value) {
  if (typeof value !== 'string' || value.length !== 36 || !UUID.test(value)) throw new MobileError('invalid_room', 'A valid room UUID is required.');
  return value.toLowerCase();
}

function envInt(env, key, fallback, min, max) {
  const value = Number(env[key] || fallback);
  if (!integer(value, min, max)) throw new Error(`${key} must be an integer between ${min} and ${max}`);
  return value;
}

function jsonList(env, key) {
  const value = JSON.parse(env[key] || '[]');
  if (!Array.isArray(value) || value.length > 40 || value.some(item => typeof item !== 'string' || item.length > 512 || /[\x00-\x1f]/.test(item))) throw new Error(`${key} must be a short array of strings`);
  return value;
}

export function configuration(env = process.env) {
  const image = env.MOBILE_ANDROID_IMAGE || '';
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/@-]{0,255}$/.test(image)) throw new Error('MOBILE_ANDROID_IMAGE must name the operator-approved Android image');
  const readyRevisionFlag = env.MOBILE_REQUIRE_READY_REVISION || 'false';
  if (!['true', 'false'].includes(readyRevisionFlag)) throw new Error('MOBILE_REQUIRE_READY_REVISION must be true or false');
  const token = env.MOBILE_BROKER_TOKEN || '';
  if (token.length < 32) throw new Error('MOBILE_BROKER_TOKEN must contain at least 32 characters');
  const dataDir = env.MOBILE_DATA_DIR || '/var/lib/customcloudbot-mobile';
  if (!path.isAbsolute(dataDir)) throw new Error('MOBILE_DATA_DIR must be absolute');
  const devices = jsonList(env, 'MOBILE_DOCKER_DEVICES_JSON');
  if (devices.some(value => !/^\/dev\/[a-zA-Z0-9_./-]+(?::\/dev\/[a-zA-Z0-9_./-]+)?(?::[rwm]{1,3})?$/.test(value))) throw new Error('Invalid Docker device mapping');
  const network = env.MOBILE_DOCKER_NETWORK || '';
  if (network && (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(network) || ['bridge', 'host', 'none', 'default'].includes(network))) throw new Error('MOBILE_DOCKER_NETWORK must name a dedicated Docker network');
  const externalContainers = (env.MOBILE_EXTERNAL_CONTAINERS || '').split(',').map(value => value.trim()).filter(Boolean);
  if (externalContainers.some(value => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(value))) throw new Error('Invalid external container name');
  const inputIme = env.MOBILE_INPUT_IME || '';
  if (inputIme && !/^[a-zA-Z0-9_.]+\/[a-zA-Z0-9_.$]+$/.test(inputIme)) throw new Error('Invalid input IME component');
  const socket = env.MOBILE_LISTEN_SOCKET || '';
  if (socket && (!path.isAbsolute(socket) || Buffer.byteLength(socket) > 100 || /[\x00-\x1f]/.test(socket))) throw new Error('MOBILE_LISTEN_SOCKET must be a short absolute Unix socket path');
  return {
    token, image, dataDir, devices, network, externalContainers, inputIme, socket,
    requireReadyRevision: readyRevisionFlag === 'true',
    host: env.MOBILE_LISTEN_HOST || '127.0.0.1',
    port: envInt(env, 'MOBILE_LISTEN_PORT', 8091, 1024, 65535),
    maxSlots: envInt(env, 'MOBILE_MAX_SLOTS', 10, 1, 100),
    maxRunning: envInt(env, 'MOBILE_MAX_RUNNING', 2, 1, 32),
    adbBasePort: envInt(env, 'MOBILE_ADB_BASE_PORT', 16555, 1024, 65000),
    idleMs: envInt(env, 'MOBILE_IDLE_SECONDS', 600, 60, 86400) * 1000,
    leaseMs: envInt(env, 'MOBILE_LEASE_SECONDS', 120, 30, 600) * 1000,
    bootMs: envInt(env, 'MOBILE_BOOT_SECONDS', 90, 10, 600) * 1000,
    commandTimeoutScale: envInt(env, 'MOBILE_COMMAND_TIMEOUT_SCALE', 1, 1, 3),
    operationMs: envInt(env, 'MOBILE_OPERATION_SECONDS', 45, 5, 45) * 1000,
    memoryMb: envInt(env, 'MOBILE_MEMORY_MB', 3072, 512, 32768),
    cpus: envInt(env, 'MOBILE_CPUS', 2, 1, 16),
    privileged: env.MOBILE_DOCKER_PRIVILEGED === 'true',
    androidArgs: jsonList(env, 'MOBILE_ANDROID_ARGS_JSON'),
  };
}

export async function runCommand(file, args, options = {}) {
  const result = await execFileAsync(file, args, { timeout: options.timeout || 15_000, maxBuffer: options.maxBuffer || 5 * 1024 * 1024, encoding: options.binary ? 'buffer' : 'utf8', windowsHide: true, signal: options.signal });
  return result.stdout;
}

function decodeXml(value) {
  return String(value).replace(/&(?:#(x[\da-f]+|\d+)|amp|quot|apos|lt|gt);/gi, (entity, number) => {
    if (number) { const cp = number[0].toLowerCase() === 'x' ? parseInt(number.slice(1), 16) : Number(number); return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : ''; }
    return ({ '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' })[entity] || entity;
  });
}

export function parseUiTree(xml, width, height) {
  const nodes = [];
  let encodedBytes = 128;
  for (const match of String(xml).matchAll(/<node\s+([^>]*?)\/?\s*>/g)) {
    if (nodes.length >= 400) break;
    const fields = Object.fromEntries([...match[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(value => [value[1], decodeXml(value[2])]));
    const bounds = /^\[(-?\d+),(-?\d+)\]\[(-?\d+),(-?\d+)\]$/.exec(fields.bounds || '');
    if (!bounds) continue;
    const [left, top, right, bottom] = bounds.slice(1).map(Number);
    if (right <= 0 || bottom <= 0 || left >= width || top >= height) continue;
    const node = {
      text: fields.password === 'true' ? '' : (fields.text || '').slice(0, 512), description: fields.password === 'true' ? '' : (fields['content-desc'] || '').slice(0, 512),
      resourceId: (fields['resource-id'] || '').slice(0, 256), className: (fields.class || '').slice(0, 128),
      bounds: { left: Math.max(0, left), top: Math.max(0, top), right: Math.min(width, right), bottom: Math.min(height, bottom) },
      clickable: fields.clickable === 'true', editable: /(?:EditText|(?:Multi)?AutoCompleteTextView)$/.test(fields.class || '') || fields.editable === 'true',
      enabled: fields.enabled !== 'false', focused: fields.focused === 'true',
    };
    encodedBytes += Buffer.byteLength(JSON.stringify(node)) + 1;
    if (encodedBytes > 240 * 1024) break;
    nodes.push(node);
  }
  return { width, height, nodes };
}

export class DevicePool {
  constructor(config, { run = runCommand, now = Date.now, pause = delay } = {}) {
    this.config = config; this.run = run; this.now = now; this.pause = pause;
    this.devices = new Map(); this.locks = new Map(); this.depths = new Map(); this.globalLock = Promise.resolve(); this.diskLock = Promise.resolve();
    this.stateFile = path.join(config.dataDir, 'devices.json');
  }

  async initialize() {
    await mkdir(this.config.dataDir, { recursive: true, mode: 0o700 });
    if ((await lstat(this.config.dataDir)).isSymbolicLink()) throw new Error('Mobile data directory must not be a symlink');
    let stored;
    try { stored = JSON.parse(await readFile(this.stateFile, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (stored) {
      if (stored.version !== 1 || !Array.isArray(stored.devices)) throw new Error('Unsupported mobile state file');
      const slots = new Set();
      for (const item of stored.devices) {
        const id = roomId(item.roomId);
        if (!integer(item.slot, 0, 99) || slots.has(item.slot) || this.devices.has(id)) throw new Error('Invalid or duplicate mobile slot');
        slots.add(item.slot);
        this.devices.set(id, { roomId: id, slot: item.slot, createdAt: Number(item.createdAt) || this.now(), lastActiveAt: Number(item.lastActiveAt) || this.now(), leaseExpiresAt: Math.min(Number(item.leaseExpiresAt) || 0, this.now() + this.config.leaseMs), state: 'sleeping' });
      }
    }
    await this.reconcile();
  }

  name(device) { return `ccb-mobile-${device.roomId.replaceAll('-', '')}`; }
  serial(device) { return `127.0.0.1:${this.config.adbBasePort + device.slot}`; }
  view(device) { return device ? { roomId: device.roomId, state: device.state, lastActiveAt: device.lastActiveAt, leaseExpiresAt: device.leaseExpiresAt, ...(device.lastError ? { lastError: device.lastError } : {}) } : null; }

  lock(id, operation) {
    const depth = this.depths.get(id) || 0;
    if (depth >= 8) return Promise.reject(new MobileError('device_busy', 'Too many pending requests for this mobile device.', 429));
    this.depths.set(id, depth + 1);
    const previous = this.locks.get(id) || Promise.resolve();
    const pending = previous.catch(() => {}).then(operation);
    this.locks.set(id, pending);
    pending.finally(() => { const remaining = (this.depths.get(id) || 1) - 1; if (remaining) this.depths.set(id, remaining); else this.depths.delete(id); if (this.locks.get(id) === pending) this.locks.delete(id); }).catch(() => {});
    return pending;
  }

  operation(id, action, execute, { signal } = {}) {
    const started = this.now(), controller = new AbortController();
    const budget = this.config.operationMs ?? 45_000;
    const deadline = started + budget;
    let stage = 'queue', stageStarted = started, rejectAborted;
    const annotate = error => {
      if (error && typeof error === 'object' && !diagnostics.has(error)) diagnostics.set(error, {
        action, stage, code: failureKind(error), durationMs: Math.max(0, this.now() - stageStarted),
        operationMs: Math.max(0, this.now() - started),
      });
      return error;
    };
    const aborted = new Promise((resolve, reject) => { rejectAborted = reject; });
    const stop = timeout => {
      if (controller.signal.aborted) return;
      const error = annotate(timeout
        ? new MobileError('device_operation_timeout', 'The mobile operation took too long. Try again.', 504)
        : new MobileError('device_operation_cancelled', 'The mobile operation was cancelled.', 409));
      controller.abort(error); rejectAborted(error);
    };
    const check = () => {
      if (!controller.signal.aborted && this.now() >= deadline) stop(true);
      if (controller.signal.aborted) throw controller.signal.reason;
    };
    const context = {
      step: async (name, callback, maximum = 15_000) => {
        check(); stage = name; stageStarted = this.now();
        try {
          const result = await callback({ signal: controller.signal, timeout: Math.max(1, Math.min(maximum * (this.config.commandTimeoutScale ?? 1), deadline - this.now())) });
          check(); return result;
        } catch (error) {
          if (!controller.signal.aborted && this.now() >= deadline) stop(true);
          throw annotate(controller.signal.aborted ? controller.signal.reason : error);
        }
      },
    };
    const onAbort = () => stop(false);
    const timer = setTimeout(() => stop(true), budget);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) stop(false);
    const pending = this.lock(id, async () => { check(); return execute(context); });
    // Keep the room lock until an aborted child has exited; a queued operation
    // that expired must not run later when an earlier request finally settles.
    return Promise.race([pending, aborted]).catch(error => { throw annotate(error); }).finally(() => {
      clearTimeout(timer); signal?.removeEventListener('abort', onAbort);
    });
  }

  exclusive(operation) {
    const pending = this.globalLock.catch(() => {}).then(operation);
    this.globalLock = pending;
    return pending;
  }

  persist() {
    const snapshot = JSON.stringify({ version: 1, devices: [...this.devices.values()] });
    const pending = this.diskLock.catch(() => {}).then(async () => {
      const temp = `${this.stateFile}.tmp`;
      await writeFile(temp, snapshot, { mode: 0o600 });
      await rename(temp, this.stateFile);
    });
    this.diskLock = pending;
    return pending;
  }

  async inspect(name, expectedRoom, options = {}) {
    let data;
    try { data = JSON.parse(await this.run('docker', ['inspect', name], { ...options, maxBuffer: 256 * 1024 }))[0]; }
    catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (/No such (?:object|container)/i.test(String(error.stderr || error.message))) return null;
      throw new MobileError('device_runtime_unavailable', 'The Android runtime could not be inspected.', 503);
    }
    if (expectedRoom && (data.Config?.Labels?.[OWNER_LABEL] !== '1' || data.Config?.Labels?.['org.customcloudbot.room'] !== expectedRoom)) throw new MobileError('device_ownership_conflict', 'A container with this name is not owned by the mobile pool.', 409);
    if (expectedRoom && this.devices.has(expectedRoom)) {
      const expectedPort = String(this.config.adbBasePort + this.devices.get(expectedRoom).slot);
      const bindings = data.HostConfig?.PortBindings?.['5555/tcp'] || [];
      if (bindings.length !== 1 || bindings[0].HostIp !== '127.0.0.1' || bindings[0].HostPort !== expectedPort) throw new MobileError('device_configuration_conflict', 'The existing Android transport does not match its private device slot.', 409);
      if (this.config.network) {
        const networks = Object.keys(data.NetworkSettings?.Networks || {});
        if (data.HostConfig?.NetworkMode !== this.config.network || networks.length !== 1 || networks[0] !== this.config.network) throw new MobileError('device_configuration_conflict', 'The existing Android network does not match the configured private network.', 409);
      }
    }
    return data;
  }

  async capacity() {
    const external = await Promise.all(this.config.externalContainers.map(name => this.inspect(name)));
    return { slots: this.devices.size, maxSlots: this.config.maxSlots, running: [...this.devices.values()].filter(device => ['running', 'starting'].includes(device.state)).length + external.filter(item => item?.State?.Running).length, maxRunning: this.config.maxRunning };
  }

  async reconcile() {
    for (const device of this.devices.values()) {
      const info = await this.inspect(this.name(device), device.roomId);
      device.state = info?.State?.Running ? (device.state === 'starting' ? 'starting' : 'running') : 'sleeping';
      if (!info?.State?.Running) device.leaseExpiresAt = 0;
    }
    await this.persist();
  }

  async status(rawId) {
    const id = roomId(rawId), device = this.devices.get(id);
    return { device: this.view(device) || { roomId: id, state: 'unallocated', lastActiveAt: null, leaseExpiresAt: 0 }, capacity: await this.capacity() };
  }

  async health() { return { ok: true, ...await this.capacity() }; }

  async allocate(id) {
    if (this.devices.has(id)) return this.devices.get(id);
    if (this.devices.size >= this.config.maxSlots) throw new MobileError('device_slots_full', 'All persistent mobile slots are assigned.', 409);
    const used = new Set([...this.devices.values()].map(device => device.slot));
    let slot = 0; while (used.has(slot)) slot++;
    const device = { roomId: id, slot, createdAt: this.now(), lastActiveAt: this.now(), leaseExpiresAt: 0, state: 'sleeping' };
    this.devices.set(id, device);
    await this.persist();
    return device;
  }

  async adb(device, args, options) {
    return this.run('adb', ['-s', this.serial(device), ...args], options);
  }

  async shell(device, args, options) {
    // adb shell invokes a remote shell even though the host process uses execFile.
    return this.adb(device, ['shell', args.map(shellQuote).join(' ')], options);
  }

  async connect(device, { timeout = 8000, signal } = {}) {
    await this.run('adb', ['connect', this.serial(device)], { timeout, signal });
  }

  async ready(device) {
    const end = this.now() + this.config.bootMs;
    let attempts = 0, androidReady = false, imeEnabled = false;
    const failure = () => androidReady
      ? new MobileError('device_keyboard_timeout', 'Android is running, but its input keyboard is not ready. Try waking the device again to retry keyboard setup.', 503)
      : new MobileError('device_boot_timeout', 'Android did not finish starting. Try waking the device again.', 503);
    const timeout = maximum => {
      const remaining = end - this.now();
      if (remaining <= 0) throw failure();
      return Math.min(maximum, remaining);
    };
    while (this.now() < end && attempts++ < Math.ceil(this.config.bootMs / 1000)) {
      try {
        await this.connect(device, { timeout: timeout(8000) });
        const boot = await this.shell(device, ['getprop', 'sys.boot_completed'], { timeout: timeout(5000) });
        if (String(boot).trim() === '1') {
          androidReady = true;
          if (this.config.inputIme) {
            if (!imeEnabled) {
              await this.shell(device, ['ime', 'enable', this.config.inputIme], { timeout: timeout(30_000) });
              imeEnabled = true;
            }
            await this.shell(device, ['ime', 'set', this.config.inputIme], { timeout: timeout(30_000) });
          }
          return;
        }
      } catch { /* Android's ADB transport appears before its framework and keyboard are ready. */ }
      const remaining = end - this.now();
      if (remaining > 0) await this.pause(Math.min(1000, remaining));
    }
    throw failure();
  }

  async wake(rawId) {
    const id = roomId(rawId);
    return this.lock(id, async () => {
      let device;
      await this.exclusive(async () => {
        device = this.devices.get(id);
        const info = device ? await this.inspect(this.name(device), id) : null;
        if (info?.State?.Running) { device.state = 'starting'; return; }
        await this.reconcile();
        if ((await this.capacity()).running >= this.config.maxRunning) throw new MobileError('device_capacity_busy', 'All running mobile slots are busy. Let another device sleep first.', 409);
        device = await this.allocate(id);
        const dataPath = path.join(this.config.dataDir, 'rooms', id);
        await mkdir(dataPath, { recursive: true, mode: 0o700 });
        if ((await lstat(dataPath)).isSymbolicLink()) throw new Error('Mobile room directory must not be a symlink');
        if (!info) {
          const args = ['create', '--name', this.name(device), '--label', `${OWNER_LABEL}=1`, '--label', `org.customcloudbot.room=${id}`, '--restart', 'no', '--memory', `${this.config.memoryMb}m`, '--cpus', String(this.config.cpus), '--shm-size', '256m', '--publish', `${this.serial(device)}:5555`, '--mount', `type=bind,src=${dataPath},dst=/data`];
          if (this.config.network) args.push('--network', this.config.network);
          if (this.config.privileged) args.push('--privileged');
          for (const mapping of this.config.devices) args.push('--device', mapping);
          args.push(this.config.image, ...this.config.androidArgs);
          await this.run('docker', args, { timeout: 30_000 });
        }
        await this.run('docker', ['start', this.name(device)], { timeout: 30_000 });
        device.state = 'starting'; device.lastActiveAt = this.now(); device.lastError = undefined;
        await this.persist();
      });
      try {
        await this.ready(device);
        device.state = 'running'; device.lastActiveAt = this.now(); device.lastError = undefined;
        await this.persist();
      } catch (error) {
        if (error.code === 'device_keyboard_timeout') {
          // A slow IME must not shut down an Android device that can already display and accept touch.
          device.state = 'running'; device.lastActiveAt = this.now(); device.lastError = error.code;
        } else {
          try { await this.run('docker', ['stop', '--time', '10', this.name(device)], { timeout: 20_000 }); } catch { /* Keep an error state and retry reconciliation on the next request. */ }
          device.state = 'error'; device.lastError = 'device_boot_timeout'; device.leaseExpiresAt = 0;
        }
        await this.persist();
        if (error.code !== 'device_keyboard_timeout') throw error;
      }
      return this.status(id);
    });
  }

  async sleep(rawId, { idle = false } = {}) {
    const id = roomId(rawId);
    return this.lock(id, () => this.exclusive(async () => {
      const device = this.devices.get(id);
      if (!device) return this.status(id);
      if (device.leaseExpiresAt > this.now()) {
        if (idle) return null;
        throw new MobileError('device_in_use', 'An AI task is using this device.', 409);
      }
      if (idle && this.now() - device.lastActiveAt < this.config.idleMs) return null;
      const info = await this.inspect(this.name(device), id);
      if (info?.State?.Running) await this.run('docker', ['stop', '--time', '10', this.name(device)], { timeout: 20_000 });
      try { await this.run('adb', ['disconnect', this.serial(device)], { timeout: 5000 }); } catch { /* The transport may already have gone away. */ }
      device.state = 'sleeping'; device.leaseExpiresAt = 0; device.lastError = undefined;
      await this.persist();
      return this.status(id);
    }));
  }

  async sweepIdle() {
    for (const device of this.devices.values()) {
      if (['running', 'error'].includes(device.state) && device.leaseExpiresAt <= this.now() && this.now() - device.lastActiveAt >= this.config.idleMs) await this.sleep(device.roomId, { idle: true });
    }
  }

  async activeDevice(id, options) {
    const device = this.devices.get(id);
    if (!device) throw new MobileError('device_sleeping', 'Open or wake this mobile device first.', 409);
    const info = await this.inspect(this.name(device), id, options);
    if (!info?.State?.Running) { device.state = 'sleeping'; device.leaseExpiresAt = 0; await this.persist(); throw new MobileError('device_sleeping', 'Open or wake this mobile device first.', 409); }
    if (device.state !== 'running') throw new MobileError('device_starting', 'The mobile device is still starting.', 409);
    device.lastActiveAt = this.now();
    return device;
  }

  async lease(rawId, active) {
    const id = roomId(rawId);
    if (typeof active !== 'boolean') throw new MobileError('invalid_lease', 'active must be a boolean.');
    return this.lock(id, async () => {
      const device = this.devices.get(id);
      if (device) { device.leaseExpiresAt = active ? this.now() + this.config.leaseMs : 0; if (active) device.lastActiveAt = this.now(); await this.persist(); }
      return this.status(id);
    });
  }

  async dimensions(device, context) {
    const step = context?.step || ((name, callback, timeout) => callback({ timeout }));
    const output = String(await step('display_size', options => this.shell(device, ['wm', 'size'], options), 5000));
    const matches = [...output.matchAll(/(?:Physical|Override) size:\s*(\d+)x(\d+)/g)];
    const match = matches.at(-1);
    if (!match || !integer(Number(match[1]), 1, 8192) || !integer(Number(match[2]), 1, 8192)) throw new MobileError('device_display_unavailable', 'Android display dimensions are unavailable.', 503);
    const width = Number(match[1]), height = Number(match[2]);
    // wm reports the panel's natural orientation; touch coordinates follow rotation.
    const inputState = String(await step('display_rotation', options => this.shell(device, ['dumpsys', 'input'], { ...options, maxBuffer: 1024 * 1024 }), 5000));
    const orientation = /SurfaceOrientation:\s*([0-3])/.exec(inputState) || /displayId=0[^\n]*orientation=([0-3])/.exec(inputState);
    return orientation && Number(orientation[1]) % 2 ? { width: height, height: width } : { width, height };
  }

  async screenshot(rawId, options) {
    const id = roomId(rawId);
    return this.operation(id, 'screenshot', async context => {
      const device = await context.step('inspect', options => this.activeDevice(id, options));
      await context.step('connect', options => this.connect(device, options), 8000);
      const bytes = Buffer.from(await context.step('screencap', options => this.adb(device, ['exec-out', 'screencap', '-p'], { ...options, binary: true, maxBuffer: 16 * 1024 * 1024 }), 10_000));
      await context.step('validate_screen', () => {
        if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) throw new MobileError('device_screen_unavailable', 'Android did not return a valid screenshot.', 503);
      });
      return bytes;
    }, options);
  }

  async observe(rawId, options) {
    const id = roomId(rawId);
    return this.operation(id, 'observe', async context => {
      const device = await context.step('inspect', options => this.activeDevice(id, options));
      await context.step('connect', options => this.connect(device, options), 8000);
      const { width, height } = await this.dimensions(device, context);
      await context.step('dump_ui', options => this.shell(device, ['uiautomator', 'dump', '--compressed', '/data/local/tmp/ccb-window.xml'], options), 12_000);
      const xml = await context.step('read_ui', options => this.adb(device, ['exec-out', 'cat', '/data/local/tmp/ccb-window.xml'], { ...options, maxBuffer: 2 * 1024 * 1024 }), 5000);
      return parseUiTree(xml, width, height);
    }, options);
  }

  async input(rawId, input, options) {
    const id = roomId(rawId);
    if (!input || typeof input !== 'object') throw new MobileError('invalid_input', 'Input details are required.');
    return this.operation(id, 'input', async context => {
      const device = await context.step('inspect', options => this.activeDevice(id, options));
      await context.step('connect', options => this.connect(device, options), 8000);
      let args;
      if (input.type === 'tap' || input.type === 'swipe') {
        const { width, height } = await this.dimensions(device, context);
        const point = (x, y) => integer(x, 0, width - 1) && integer(y, 0, height - 1);
        if (input.type === 'tap') {
          if (!point(input.x, input.y)) throw new MobileError('invalid_coordinates', 'Tap is outside the Android screen.');
          args = ['input', 'tap', input.x, input.y];
        } else {
          const duration = input.duration ?? 350;
          if (!point(input.x1, input.y1) || !point(input.x2, input.y2) || !integer(duration, 100, 3000)) throw new MobileError('invalid_coordinates', 'Swipe coordinates or duration are invalid.');
          args = ['input', 'swipe', input.x1, input.y1, input.x2, input.y2, duration];
        }
      } else if (input.type === 'key') {
        if (!Object.hasOwn(KEY_CODES, input.key)) throw new MobileError('invalid_key', 'This Android key is not supported.');
        args = ['input', 'keyevent', KEY_CODES[input.key]];
      } else if (input.type === 'text') {
        if (typeof input.text !== 'string' || input.text.length < 1 || input.text.length > 2000 || /[\x00-\x1f\x7f-\x9f]/.test(input.text)) throw new MobileError('invalid_text', 'Text must contain 1–2000 characters without control characters.');
        if (this.config.inputIme) {
          await context.step('select_keyboard', options => this.shell(device, ['ime', 'set', this.config.inputIme], options), 5000);
          args = ['am', 'broadcast', '--user', '0', '-a', 'ADB_INPUT_B64', '-p', this.config.inputIme.split('/')[0], '--es', 'msg', Buffer.from(input.text, 'utf8').toString('base64')];
        } else {
          if (/[^\x20-\x7e]/.test(input.text) || input.text.includes('%s')) throw new MobileError('text_not_supported', 'Unicode input requires the configured Android input keyboard.', 422);
          args = ['input', 'text', input.text.replaceAll(' ', '%s')];
        }
      } else throw new MobileError('invalid_input', 'Input type is not supported.');
      await context.step('send_input', options => this.shell(device, args, options), 8000);
      return { ok: true };
    }, options);
  }

  async launch(rawId, packageName, options) {
    const id = roomId(rawId);
    if (typeof packageName !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z0-9_]+)+$/.test(packageName) || packageName.length > 200) throw new MobileError('invalid_package', 'A valid Android package name is required.');
    return this.operation(id, 'launch', async context => {
      const device = await context.step('inspect', options => this.activeDevice(id, options));
      await context.step('connect', options => this.connect(device, options), 8000);
      const resolved = await context.step('resolve_activity', options => this.shell(device, ['cmd', 'package', 'resolve-activity', '--brief', '--user', '0', '-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', packageName], { ...options, maxBuffer: 64 * 1024 }), 8000);
      const component = String(resolved).trim().split(/\r?\n/).at(-1) || '';
      const [resolvedPackage, activity, ...extra] = component.split('/');
      if (component.length > 512 || resolvedPackage !== packageName || extra.length || !/^\.?[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/.test(activity || '')) throw new MobileError('app_not_launchable', 'This Android app has no valid launcher activity.', 404);
      await context.step('start_activity', options => this.shell(device, ['am', 'start', '--user', '0', '-W', '-n', component], options), 8000);
      return { ok: true };
    }, options);
  }
}
