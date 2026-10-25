import http from 'node:http';
import {createHmac, randomUUID} from 'node:crypto';
import {mkdir, readFile, writeFile, rename, lstat, chmod, unlink} from 'node:fs/promises';
import path from 'node:path';
import {MobileError, roomId} from './device-pool.mjs';
import {BROKER_RUNTIME_REVISION} from './service.mjs';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const integer = (value, min, max) => Number.isInteger(value) && value >= min && value <= max;
const fail = (code, message, status = 503) => new MobileError(code, message, status);
const KEYS = new Set(['BACK', 'HOME', 'APP_SWITCH', 'ENTER', 'DEL', 'TAB', 'ESCAPE', 'DPAD_UP', 'DPAD_DOWN', 'DPAD_LEFT', 'DPAD_RIGHT']);
// Guest responses may contain private command output. Preserve only recognized
// codes, with locally defined messages and statuses instead of guest text.
const GUEST_ERRORS = Object.freeze({
  device_boot_timeout:[503, 'Android did not finish starting.'],
  device_keyboard_timeout:[503, 'Android is running, but its input keyboard is not ready.'],
  device_runtime_unavailable:[503, 'The Android runtime could not be inspected.'],
  device_display_unavailable:[503, 'Android display dimensions are unavailable.'],
  device_screen_unavailable:[503, 'Android did not return a valid screenshot.'],
  device_operation_failed:[503, 'The Android operation could not be completed.'],
  device_operation_timeout:[504, 'The mobile operation took too long. Try again.'],
  device_operation_cancelled:[409, 'The mobile operation was cancelled.'],
  device_sleeping:[409, 'Open or wake this mobile device first.'],
  device_starting:[409, 'The Android device is still starting.'],
  device_in_use:[409, 'An AI task is using this Android device.'],
  device_busy:[429, 'Too many Android operations are waiting.'],
  device_capacity_busy:[409, 'All running Android slots are busy.'],
  device_slots_full:[409, 'All persistent Android slots are assigned.'],
  device_ownership_conflict:[409, 'The Android runtime ownership does not match this room.'],
  device_configuration_conflict:[409, 'The Android runtime configuration does not match this room.'],
  app_not_launchable:[404, 'The requested Android app has no launchable activity.'],
  text_not_supported:[422, 'This text requires the configured Android input keyboard.'],
  invalid_coordinates:[400, 'The input coordinates are outside the Android display.'],
  invalid_input:[400, 'The Android input is invalid.'],
  invalid_key:[400, 'The Android key is not supported.'],
  invalid_text:[400, 'The Android input text is invalid.'],
  invalid_package:[400, 'The Android package name is invalid.'],
  invalid_lease:[400, 'The Android lease is invalid.'],
  invalid_room:[400, 'The Android room is invalid.'],
});

function envInt(env, key, fallback, min, max) {
  const value = Number(env[key] || fallback);
  if (!integer(value, min, max)) throw new Error(`${key} is outside its allowed range`);
  return value;
}

export function vmConfiguration(env = process.env) {
  const token = env.MOBILE_BROKER_TOKEN || '';
  if (!/^[\x21-\x7e]{32,4096}$/.test(token)) throw new Error('MOBILE_BROKER_TOKEN must contain a private token of at least 32 characters');
  const dataDir = env.MOBILE_VM_DATA_DIR || '/var/lib/customcloudbot-mobile-vm';
  const socket = env.MOBILE_LISTEN_SOCKET || '/run/community-mobile/mobile.sock';
  if (!path.isAbsolute(dataDir) || /[\x00-\x1f]/.test(dataDir)) throw new Error('MOBILE_VM_DATA_DIR must be an absolute path');
  if (!path.isAbsolute(socket) || Buffer.byteLength(socket) > 100 || /[\x00-\x1f]/.test(socket)) throw new Error('MOBILE_LISTEN_SOCKET must be a short absolute path');
  const maxSlots = envInt(env, 'MOBILE_MAX_SLOTS', 10, 1, 100);
  const basePort = envInt(env, 'MOBILE_VM_BASE_PORT', 18091, 1024, 65435);
  return {
    token, dataDir, socket, basePort, maxSlots, expectedGuestRevision:BROKER_RUNTIME_REVISION,
    maxRunning:envInt(env, 'MOBILE_MAX_RUNNING', 1, 1, 10),
    idleMs:envInt(env, 'MOBILE_IDLE_SECONDS', 600, 60, 86400) * 1000,
    leaseMs:envInt(env, 'MOBILE_LEASE_SECONDS', 120, 30, 600) * 1000,
    bootMs:envInt(env, 'MOBILE_VM_BOOT_SECONDS', 180, 10, 900) * 1000,
    provisionMs:envInt(env, 'MOBILE_VM_PROVISION_SECONDS', 60, 5, 600) * 1000,
    stopMs:envInt(env, 'MOBILE_VM_STOP_SECONDS', 45, 5, 180) * 1000,
    requestMs:envInt(env, 'MOBILE_VM_REQUEST_SECONDS', 15, 1, 60) * 1000,
    wakeMs:envInt(env, 'MOBILE_VM_ANDROID_BOOT_SECONDS', 300, 10, 600) * 1000,
  };
}

export function guestToken(master, rawRoomId) {
  return createHmac('sha256', master).update('customcloudbot-mobile-guest-v1\0' + roomId(rawRoomId)).digest('hex');
}

// This client accepts only a manager-created spec and fixed broker route. It does
// not follow redirects, accept user URLs, or expose guest credentials in errors.
export function requestGuest(spec, {method = 'GET', path:route, body, timeoutMs = 15000, binary = false, signal} = {}) {
  const base = `/devices/${roomId(spec.roomId)}`;
  const allowed = method === 'GET' ? ['/health', base, base + '/screenshot', base + '/observe'] : method === 'POST' ? ['wake', 'sleep', 'lease', 'input', 'launch'].map(action => base + '/' + action) : [];
  if (!integer(spec.port, 1024, 65535) || !allowed.includes(route))
    return Promise.reject(fail('guest_request_invalid', 'The mobile request is invalid.', 400));
  const payload = body === undefined ? undefined : JSON.stringify(body);
  if (payload !== undefined && Buffer.byteLength(payload) > 16384) return Promise.reject(fail('guest_request_invalid', 'The mobile request is too large.', 400));
  return new Promise((resolve, reject) => {
    let timer, settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(value);
    };
    const request = http.request({hostname:'127.0.0.1', port:spec.port, method, path:route, agent:false,
      headers:{authorization:`Bearer ${spec.token}`, connection:'close', ...(payload === undefined ? {} : {'content-type':'application/json', 'content-length':Buffer.byteLength(payload)})}}, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > (binary ? 5 * 1024 * 1024 : 256 * 1024)) {
          finish(fail('guest_response_too_large', 'The mobile response is too large.')); response.destroy(); request.destroy();
        } else chunks.push(chunk);
      });
      response.on('end', () => {
        const bytes = Buffer.concat(chunks);
        if (response.statusCode !== 200) {
          let code;
          try {code = JSON.parse(bytes.toString('utf8'))?.error;} catch { /* Unrecognized bodies remain private. */ }
          if (typeof code === 'string' && Object.hasOwn(GUEST_ERRORS, code)) {
            const [status, message] = GUEST_ERRORS[code];
            return finish(fail(code, message, status));
          }
          return finish(fail('guest_operation_failed', 'The private mobile operation could not be completed.', [400, 409, 422, 429].includes(response.statusCode) ? response.statusCode : 503));
        }
        if (binary) return finish(null, bytes);
        try {finish(null, JSON.parse(bytes.toString('utf8')));} catch {finish(fail('guest_response_invalid', 'The mobile response is invalid.'));}
      });
      response.on('error', () => finish(fail('guest_connection_failed', 'The private mobile connection was interrupted.')));
      response.on('aborted', () => finish(fail('guest_connection_failed', 'The private mobile connection was interrupted.')));
    });
    const abort = () => {finish(fail('guest_request_cancelled', 'The mobile request was cancelled.', 499)); request.destroy();};
    timer = setTimeout(() => {finish(fail('guest_request_timeout', 'The private mobile request timed out.')); request.destroy();}, timeoutMs);
    signal?.addEventListener('abort', abort, {once:true});
    request.on('error', () => finish(fail('guest_connection_failed', 'The private mobile service could not be reached.')));
    if (signal?.aborted) return abort();
    request.end(payload);
  });
}

export class VMPool {
  constructor(config, {runtime, request = requestGuest, now = Date.now, pause = sleep} = {}) {
    if (!runtime || ['provision', 'start', 'stop', 'isRunning'].some(name => typeof runtime[name] !== 'function')) throw new Error('A bounded private VM runtime adapter is required');
    this.config = config; this.runtime = runtime; this.request = request; this.now = now; this.pause = pause;
    this.devices = new Map(); this.starts = new Map(); this.startingLeases = new Map(); this.failures = new Map(); this.depths = new Map(); this.locks = new Map(); this.globalLock = Promise.resolve(); this.diskLock = Promise.resolve();
    this.stateFile = path.join(config.dataDir, 'vm-pool.json');
  }

  spec(device) {
    return {roomId:device.roomId, slot:device.slot, unitName:`customcloudbot-mobile-vm@${device.roomId}.service`,
      port:this.config.basePort + device.slot, dataDir:path.join(this.config.dataDir, 'rooms', device.roomId), token:guestToken(this.config.token, device.roomId)};
  }

  async bounded(operation, timeoutMs, code, {signal:callerSignal} = {}) {
    const cancelled = () => fail('device_operation_cancelled', 'The mobile operation was cancelled.', 409);
    if (callerSignal?.aborted) throw cancelled();
    const controller = new AbortController(); let timer, cancel;
    try {
      return await Promise.race([
        Promise.resolve().then(() => operation(controller.signal)),
        new Promise((_, reject) => {
          cancel = () => {controller.abort(); reject(cancelled());};
          callerSignal?.addEventListener('abort', cancel, {once:true});
          timer = setTimeout(() => {controller.abort(); reject(fail(typeof code === 'function' ? code() : code, 'The private mobile runtime operation timed out.'));}, timeoutMs);
          if (callerSignal?.aborted) cancel();
        }),
      ]);
    } finally {clearTimeout(timer); callerSignal?.removeEventListener('abort', cancel);}
  }

  runtimeCall(name, device, timeoutMs = this.config.requestMs) {
    return this.bounded(signal => this.runtime[name](this.spec(device), {signal}), timeoutMs, 'vm_runtime_timeout');
  }

  delegate(device, action = '', {method = 'GET', body, timeoutMs = this.config.requestMs, binary = false, signal:callerSignal} = {}) {
    const route = action === 'health' ? '/health' : `/devices/${device.roomId}${action ? '/' + action : ''}`;
    return this.bounded(signal => this.request(this.spec(device), {method, path:route, body, timeoutMs, binary, signal}), timeoutMs, 'guest_request_timeout', {signal:callerSignal});
  }

  async wakeGuest(device) {
    // A cloud-init broker restart can sever the first request after health
    // succeeds. One recovery shares the original deadline; it cannot grant
    // Android another full boot window or retry an actual boot failure.
    const end = this.now() + this.config.wakeMs + 30_000;
    const send = () => {
      const remaining = end - this.now();
      if (remaining <= 0) throw fail('guest_request_timeout', 'The private mobile request timed out.');
      return this.delegate(device, 'wake', {method:'POST', body:{}, timeoutMs:remaining});
    };
    try {return await send();}
    catch (error) {
      if (!(error instanceof MobileError) || !['guest_connection_failed', 'guest_request_cancelled'].includes(error.code)) throw error;
      const recoveryEnd = Math.min(end, this.now() + 30_000);
      let ready = false;
      for (let attempts = 0; attempts < 30 && this.now() < recoveryEnd; attempts++) {
        if (!await this.runtimeCall('isRunning', device, Math.min(this.config.requestMs, recoveryEnd - this.now()))) {
          device.vmRunning = false;
          throw fail('vm_start_failed', 'The mobile VM stopped before Android could start.');
        }
        const remaining = recoveryEnd - this.now();
        if (remaining <= 0) break;
        try {
          const health = await this.delegate(device, 'health', {timeoutMs:Math.min(3000, remaining)});
          ready = health?.ok === true && health.runtimeRevision === this.config.expectedGuestRevision;
        } catch { /* The approved guest broker may still be restarting. */ }
        if (ready) break;
        if (this.now() < recoveryEnd) await this.pause(Math.min(1000, recoveryEnd - this.now()));
      }
      if (!ready) throw error;
      return send();
    }
  }

  view(device) {
    return {roomId:device.roomId, state:device.state, lastActiveAt:device.lastActiveAt, leaseExpiresAt:device.leaseExpiresAt,
      ...(device.lastError ? {lastError:device.lastError} : {})};
  }

  capacity() {
    return {slots:this.devices.size, maxSlots:this.config.maxSlots, running:[...this.devices.values()].filter(device => device.vmRunning).length, maxRunning:this.config.maxRunning};
  }

  async persist() {
    const payload = JSON.stringify({version:1, devices:[...this.devices.values()].map(({roomId, slot, createdAt, lastActiveAt, leaseExpiresAt, state, lastError}) =>
      ({roomId, slot, createdAt, lastActiveAt, leaseExpiresAt, state, ...(lastError ? {lastError} : {})}))});
    const writing = this.diskLock.catch(() => {}).then(async () => {
      const temporary = this.stateFile + '.' + randomUUID() + '.tmp';
      try {await writeFile(temporary, payload, {mode:0o600, flag:'wx'}); await rename(temporary, this.stateFile);}
      finally {await unlink(temporary).catch(() => {});}
    });
    this.diskLock = writing; return writing;
  }

  async initialize() {
    await mkdir(this.config.dataDir, {recursive:true, mode:0o750});
    if ((await lstat(this.config.dataDir)).isSymbolicLink()) throw new Error('VM data directory cannot be a symlink');
    // The installer supplies the private VM group; QEMU needs to traverse this
    // parent to its own VM-owned directory. State and credentials stay 0600.
    await chmod(this.config.dataDir, 0o750);
    let data;
    try {
      if ((await lstat(this.stateFile)).isSymbolicLink()) throw new Error('VM state cannot be a symlink');
      data = JSON.parse(await readFile(this.stateFile, 'utf8'));
    } catch (error) {if (error.code !== 'ENOENT') throw error;}
    if (data) {
      if (data.version !== 1 || !Array.isArray(data.devices) || data.devices.length > this.config.maxSlots) throw new Error('Invalid VM pool state');
      const slots = new Set();
      for (const item of data.devices) {
        const id = roomId(item.roomId);
        if (!integer(item.slot, 0, this.config.maxSlots - 1) || slots.has(item.slot) || this.devices.has(id)) throw new Error('Invalid VM slot assignment');
        slots.add(item.slot);
        this.devices.set(id, {roomId:id, slot:item.slot, createdAt:Number(item.createdAt) || this.now(), lastActiveAt:Number(item.lastActiveAt) || this.now(),
          leaseExpiresAt:Math.min(Number(item.leaseExpiresAt) || 0, this.now() + this.config.leaseMs), state:'sleeping', vmRunning:false});
      }
    }
    await this.reconcile();
    for (const device of this.devices.values()) {
      if (!device.vmRunning) continue;
      // After a controller restart neither systemd active nor the guest's
      // cached container state proves Android framework readiness. Re-run the
      // guest's boot-property check asynchronously, without starting another VM.
      await this.wake(device.roomId);
    }
  }

  async reconcile() {
    for (const device of this.devices.values()) {
      device.vmRunning = Boolean(await this.runtimeCall('isRunning', device));
      if (!device.vmRunning) {device.state = 'sleeping'; device.leaseExpiresAt = 0;}
    }
    await this.persist();
  }

  lock(id, operation) {
    const depth = this.depths.get(id) || 0;
    if (depth >= 8) return Promise.reject(fail('device_busy', 'Too many mobile requests are queued.', 429));
    this.depths.set(id, depth + 1);
    const pending = (this.locks.get(id) || Promise.resolve()).catch(() => {}).then(operation);
    this.locks.set(id, pending);
    pending.finally(() => {
      const remaining = this.depths.get(id) - 1;
      remaining ? this.depths.set(id, remaining) : this.depths.delete(id);
      if (this.locks.get(id) === pending) this.locks.delete(id);
    }).catch(() => {});
    return pending;
  }

  exclusive(operation) {
    const pending = this.globalLock.catch(() => {}).then(operation);
    this.globalLock = pending; return pending;
  }

  async allocate(id) {
    if (this.devices.has(id)) return this.devices.get(id);
    if (this.devices.size >= this.config.maxSlots) throw fail('device_slots_full', 'All persistent mobile slots are assigned.', 409);
    const slots = new Set([...this.devices.values()].map(device => device.slot));
    let slot = 0; while (slots.has(slot)) slot++;
    const device = {roomId:id, slot, createdAt:this.now(), lastActiveAt:this.now(), leaseExpiresAt:this.startingLeases.get(id) || 0, state:'sleeping', vmRunning:false};
    this.devices.set(id, device);
    try {await this.persist();} catch (error) {this.devices.delete(id); throw error;}
    return device;
  }

  async status(rawId) {
    const id = roomId(rawId), device = this.devices.get(id);
    if (device && !this.depths.has(id)) {
      device.vmRunning = Boolean(await this.runtimeCall('isRunning', device));
      if (!device.vmRunning) {if (device.state !== 'error') device.state = 'sleeping'; device.leaseExpiresAt = 0;}
    }
    const value = device ? this.view(device) : {roomId:id, state:'unallocated', lastActiveAt:null, leaseExpiresAt:0};
    if (this.starts.has(id)) {value.state = 'starting'; delete value.lastError;}
    else if (this.failures.has(id)) {value.state = 'error'; value.lastError = this.failures.get(id);}
    return {device:value, capacity:this.capacity()};
  }

  async health() {return {ok:true, ...this.capacity()};}

  async stopDevice(device) {
    if (device.vmRunning) {
      // The host lease is authoritative. Guest sleep is best effort when the
      // guest is unresponsive; the adapter must stop QEMU gracefully and verify.
      await this.delegate(device, 'sleep', {method:'POST', body:{}}).catch(() => {});
      try {await this.runtimeCall('stop', device, this.config.stopMs);}
      catch (error) {device.vmRunning = Boolean(await this.runtimeCall('isRunning', device)); throw error;}
      device.vmRunning = Boolean(await this.runtimeCall('isRunning', device));
      if (device.vmRunning) throw fail('vm_stop_failed', 'The mobile VM has not stopped yet.');
    }
    device.state = 'sleeping'; device.leaseExpiresAt = 0; delete device.lastError;
    await this.persist();
  }

  async wake(rawId) {
    const id = roomId(rawId);
    if (!this.starts.has(id) && this.devices.get(id)?.state === 'running') {
      const current = await this.status(id);
      if (current.device.state === 'running' && current.device.lastError !== 'device_keyboard_timeout') return current;
    }
    if (!this.starts.has(id)) {
      if (this.starts.size >= this.config.maxSlots) throw fail('device_busy', 'Too many mobile devices are being prepared.', 429);
      this.failures.delete(id);
      const pending = this.startDevice(id).catch(error => {
        // Requests return immediately; bounded startup failures are retrieved by
        // status polling. Never retain guest bodies, paths or tokens in status.
        if (this.failures.size >= 100) this.failures.delete(this.failures.keys().next().value);
        this.failures.set(id, error instanceof MobileError ? error.code : 'vm_start_failed');
      }).finally(() => {if (this.starts.get(id) === pending) {this.starts.delete(id); this.startingLeases.delete(id);}});
      this.starts.set(id, pending);
    }
    return this.status(id);
  }

  async startDevice(rawId) {
    const id = roomId(rawId);
    return this.lock(id, async () => {
      let device;
      await this.exclusive(async () => {
        device = this.devices.get(id);
        // Do not power down an existing device when all stored slots are used.
        if (!device && this.devices.size >= this.config.maxSlots) throw fail('device_slots_full', 'All persistent mobile slots are assigned.', 409);
        await this.reconcile();
        while (!device?.vmRunning && this.capacity().running >= this.config.maxRunning) {
          const candidates = [...this.devices.values()].filter(item => item.roomId !== id && item.vmRunning && item.state !== 'starting' && item.leaseExpiresAt <= this.now() && !this.depths.has(item.roomId))
            .sort((a, b) => Number(this.now() - b.lastActiveAt >= this.config.idleMs) - Number(this.now() - a.lastActiveAt >= this.config.idleMs) || a.lastActiveAt - b.lastActiveAt);
          if (!candidates.length) throw fail('device_capacity_busy', 'Every running mobile VM is in use.', 409);
          // Reserve the candidate's lock synchronously after checking depth=0.
          // A new input/lease cannot slip in while its VM is being stopped.
          await this.lock(candidates[0].roomId, () => this.stopDevice(candidates[0]));
        }
        device ??= await this.allocate(id);
        if (!device.vmRunning) {
          await this.runtimeCall('provision', device, this.config.provisionMs);
          device.state = 'starting'; device.vmRunning = true; device.lastActiveAt = this.now();
          await this.persist();
          try {await this.runtimeCall('start', device, this.config.requestMs);}
          catch (error) {device.vmRunning = Boolean(await this.runtimeCall('isRunning', device)); device.state = 'error'; device.lastError = 'vm_start_failed'; await this.persist(); throw error;}
        }
      });
      try {
        if (!await this.runtimeCall('isRunning', device)) {
          device.vmRunning = false;
          throw fail('vm_start_failed', 'The mobile VM stopped before Android could start.');
        }
        const end = this.now() + this.config.bootMs;
        let ready = false;
        for (let attempts = 0; attempts < Math.ceil(this.config.bootMs / 1000) && this.now() < end; attempts++) {
          try {
            const health = await this.delegate(device, 'health', {timeoutMs:Math.min(3000, Math.max(1, end - this.now()))});
            ready = health?.ok === true && health.runtimeRevision === this.config.expectedGuestRevision;
          } catch { /* Guest networking and the approved broker revision are still starting. */ }
          if (ready) break;
          if (!await this.runtimeCall('isRunning', device)) {
            device.vmRunning = false;
            throw fail('vm_start_failed', 'The mobile VM stopped before Android could start.');
          }
          await this.pause(1000);
        }
        if (!ready) throw fail('vm_boot_timeout', 'The private mobile VM did not finish starting.');
        // Guest readiness owns its boot limit; transport also needs time for
        // Docker startup and the final running/keyboard-warning response.
        const result = await this.wakeGuest(device);
        if (result?.device?.roomId !== id || result.device.state !== 'running') throw fail('device_boot_timeout', 'Android did not finish starting.');
        if (this.startingLeases.has(id)) device.leaseExpiresAt = this.startingLeases.get(id);
        device.state = 'running'; device.lastActiveAt = this.now();
        if (result.device.lastError === 'device_keyboard_timeout') device.lastError = 'device_keyboard_timeout';
        else delete device.lastError;
        await this.persist();
      } catch (error) {
        await this.exclusive(() => this.stopDevice(device)).catch(() => {});
        device.state = 'error'; device.lastError = error instanceof MobileError ? error.code : 'device_boot_timeout'; device.leaseExpiresAt = 0;
        await this.persist();
        throw error instanceof MobileError ? error : fail('device_boot_timeout', 'The mobile device could not finish starting.');
      }
      return this.status(id);
    });
  }

  async sleep(rawId, {idle = false} = {}) {
    const id = roomId(rawId);
    return this.lock(id, () => this.exclusive(async () => {
      const device = this.devices.get(id);
      if (!device) return this.status(id);
      if (device.leaseExpiresAt > this.now()) {if (idle) return null; throw fail('device_in_use', 'An AI task is using this mobile VM.', 409);}
      if (idle && this.now() - device.lastActiveAt < this.config.idleMs) return null;
      device.vmRunning = Boolean(await this.runtimeCall('isRunning', device));
      await this.stopDevice(device);
      this.failures.delete(id);
      return this.status(id);
    }));
  }

  async lease(rawId, active) {
    const id = roomId(rawId);
    if (typeof active !== 'boolean') throw fail('invalid_lease', 'Lease state must be a boolean.', 400);
    // A task may arrive while the UI has already started a several-minute boot.
    // Reserving/releasing its host lease must not wait behind that boot's lock
    // or the app's ordinary 15-second lease request would time out. No guest
    // input is permitted yet; the app renews the guest lease after readiness.
    if (this.starts.has(id)) {
      const expires = active ? this.now() + this.config.leaseMs : 0;
      this.startingLeases.set(id, expires);
      const device = this.devices.get(id);
      if (device) {device.leaseExpiresAt = expires; if (active) device.lastActiveAt = this.now(); await this.persist();}
      return this.status(id);
    }
    return this.lock(id, async () => {
      const device = this.devices.get(id);
      if (!device) return this.status(id);
      if (active && (!device.vmRunning || device.state !== 'running')) throw fail('device_sleeping', 'Wake this mobile device first.', 409);
      if (device.vmRunning) await this.delegate(device, 'lease', {method:'POST', body:{active}});
      device.leaseExpiresAt = active ? this.now() + this.config.leaseMs : 0;
      if (active) device.lastActiveAt = this.now();
      await this.persist(); return this.status(id);
    });
  }

  async operation(rawId, action, options = {}) {
    const id = roomId(rawId);
    const budget = options.timeoutMs ?? this.config.requestMs, end = this.now() + budget;
    let queued = true;
    return this.bounded(signal => this.lock(id, async () => {
      if (signal.aborted || this.now() >= end) throw fail('device_queue_timeout', 'The mobile request expired while waiting for another operation.');
      queued = false;
      const device = this.devices.get(id);
      if (!device?.vmRunning || device.state !== 'running') throw fail('device_sleeping', 'Wake this mobile device first.', 409);
      const result = await this.delegate(device, action, {...options, timeoutMs:end - this.now(), signal});
      if (signal.aborted || this.now() >= end) throw fail('guest_request_timeout', 'The private mobile request timed out.');
      device.lastActiveAt = this.now(); await this.persist();
      return result;
    }), budget, () => queued ? 'device_queue_timeout' : 'guest_request_timeout', {signal:options.signal});
  }

  async screenshot(rawId, {signal} = {}) {
    const bytes = await this.operation(rawId, 'screenshot', {binary:true, signal});
    if (!Buffer.isBuffer(bytes) || bytes.length > 5 * 1024 * 1024 || !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])))
      throw fail('guest_image_invalid', 'The mobile screenshot is invalid.');
    return bytes;
  }

  async observe(rawId, {signal} = {}) {
    const result = await this.operation(rawId, 'observe', {signal});
    if (!result || !integer(result.width, 1, 8192) || !integer(result.height, 1, 8192) || !Array.isArray(result.nodes) || result.nodes.length > 400 || Buffer.byteLength(JSON.stringify(result)) > 240 * 1024)
      throw fail('guest_observation_invalid', 'The mobile screen observation is invalid.');
    return {width:result.width, height:result.height, nodes:result.nodes};
  }

  async input(rawId, body, {signal} = {}) {
    const fields = {tap:['type', 'x', 'y'], swipe:['type', 'x1', 'y1', 'x2', 'y2', 'duration'], key:['type', 'key'], text:['type', 'text']}[body?.type];
    if (!fields || Object.keys(body).some(key => !fields.includes(key))) throw fail('invalid_input', 'The mobile input is invalid.', 400);
    if (body.type === 'tap' && ![body.x, body.y].every(value => integer(value, 0, 8191)) ||
        body.type === 'swipe' && (![body.x1, body.y1, body.x2, body.y2].every(value => integer(value, 0, 8191)) || body.duration !== undefined && !integer(body.duration, 100, 3000)) ||
        body.type === 'key' && !KEYS.has(body.key) ||
        body.type === 'text' && (typeof body.text !== 'string' || body.text.length < 1 || body.text.length > 2000 || /[\x00-\x1f\x7f-\x9f]/.test(body.text)))
      throw fail('invalid_input', 'The mobile input is invalid.', 400);
    await this.operation(rawId, 'input', {method:'POST', body, signal});
    return this.status(rawId);
  }

  async launch(rawId, packageName, {signal} = {}) {
    if (typeof packageName !== 'string' || packageName.length > 200 || !/^[a-zA-Z][a-zA-Z0-9_]*(?:\.[a-zA-Z][a-zA-Z0-9_]*)+$/.test(packageName)) throw fail('invalid_package', 'An installed Android package name is required.', 400);
    await this.operation(rawId, 'launch', {method:'POST', body:{package:packageName}, signal});
    return this.status(rawId);
  }

  async sweepIdle() {
    for (const device of this.devices.values()) {
      if (device.vmRunning && device.leaseExpiresAt <= this.now() && this.now() - device.lastActiveAt >= this.config.idleMs && !this.depths.has(device.roomId))
        await this.sleep(device.roomId, {idle:true});
    }
  }
}
