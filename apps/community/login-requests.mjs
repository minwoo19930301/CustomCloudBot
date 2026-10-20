import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, renameSync, lstatSync, chmodSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import net from 'node:net';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const MAX_FILE = 1024 * 1024;
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const notFound = () => fail(404, 'LOGIN_REQUEST_NOT_FOUND', '로그인 요청을 찾을 수 없습니다.');
const invalid = () => fail(400, 'LOGIN_INPUT_INVALID', '로그인 정보의 형식을 확인해주세요.');
const identifier = value => {
  if (typeof value !== 'string' || !UUID.test(value)) throw invalid();
  return value;
};
function text(value, max, { blank = false, trim = true } = {}) {
  if (typeof value !== 'string' || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw invalid();
  const result = trim ? value.trim() : value;
  if (!blank && !result) throw invalid();
  return result;
}

export function loginOrigin(value) {
  if (typeof value !== 'string' || value.length > 500) throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      url.pathname !== '/' || net.isIP(host.replace(/^\[|\]$/g, '')) || !host.includes('.') ||
      host.endsWith('.') || /(?:^|\.)(?:localhost|local|internal)$/.test(host)) throw invalid();
  return url.origin;
}

function maskedUsername(value) {
  const [name, ...domain] = value.split('@');
  const prefix = Array.from(name).slice(0, Math.min(2, Math.max(0, Array.from(name).length - 1))).join('');
  return prefix + '••••' + (domain.length === 1 ? '@' + domain[0] : '');
}

function accountStore(dataDir) {
  const path = join(dataDir, 'browser-login-vault.json'), keyPath = join(dataDir, 'browser-login-vault.key');
  let key, accounts = [];
  function readPrivate(file, max) {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error('Invalid private file');
    chmodSync(file, 0o600);
    return readFileSync(file);
  }
  try {
    if (existsSync(keyPath)) {
      key = readPrivate(keyPath, 32);
      if (key.length !== 32) throw new Error('Invalid key');
    }
    if (existsSync(path)) {
      if (!key) throw new Error('Missing key');
      const envelope = JSON.parse(readPrivate(path, MAX_FILE).toString('utf8'));
      if (envelope.version !== 1) throw new Error('Invalid envelope');
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
      const state = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]));
      if (state.version !== 1 || !Array.isArray(state.accounts) || state.accounts.length > 256) throw new Error('Invalid state');
      const ids = new Set();
      accounts = state.accounts.map(account => {
        identifier(account.id); identifier(account.userId);
        if (ids.has(account.id)) throw new Error('Duplicate account');
        ids.add(account.id);
        return { id: account.id, userId: account.userId, origin: loginOrigin(account.origin),
          label: text(account.label, 80), username: text(account.username, 320),
          password: text(account.password, 4096, { trim: false }) };
      });
    }
  } catch {
    throw fail(503, 'LOGIN_VAULT_UNAVAILABLE', '로그인 Vault를 읽지 못했습니다. 기존 파일을 보존했습니다.');
  }
  function persist(next) {
    if (!key) {
      const generated = randomBytes(32);
      try { writeFileSync(keyPath, generated, { mode: 0o600, flag: 'wx' }); }
      catch { generated.fill(0); throw fail(503, 'LOGIN_VAULT_UNAVAILABLE', '로그인 정보를 저장하지 못했습니다.'); }
      key = generated;
    }
    const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify({ version: 1, accounts: next })), cipher.final()]);
    const envelope = JSON.stringify({ version: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') });
    if (Buffer.byteLength(envelope) > MAX_FILE) throw fail(409, 'LOGIN_VAULT_FULL', '로그인 Vault 저장 한도를 초과했습니다.');
    const temporary = path + '.' + randomUUID() + '.tmp';
    try {
      writeFileSync(temporary, envelope, { mode: 0o600, flag: 'wx' });
      renameSync(temporary, path);
    } catch {
      try { unlinkSync(temporary); } catch {}
      throw fail(503, 'LOGIN_VAULT_UNAVAILABLE', '로그인 정보를 저장하지 못했습니다.');
    }
    accounts = next;
  }
  return {
    list(userId, origin) {
      return accounts.filter(account => account.userId === userId && account.origin === origin)
        .map(({ id, label, username }) => ({ id, label, maskedUsername: maskedUsername(username) }));
    },
    find(userId, origin, accountId) {
      const account = accounts.find(item => item.id === accountId && item.userId === userId && item.origin === origin);
      if (!account) throw fail(404, 'LOGIN_ACCOUNT_NOT_FOUND', '이 사이트에 사용할 본인 계정을 찾을 수 없습니다.');
      return account;
    },
    save(userId, origin, input) {
      const username = text(input.username, 320), password = text(input.password, 4096, { trim: false });
      const label = text(input.label || new URL(origin).hostname, 80);
      const previous = accounts.find(item => item.userId === userId && item.origin === origin && item.username === username);
      if (!previous && (accounts.length >= 256 || accounts.filter(item => item.userId === userId).length >= 32))
        throw fail(409, 'LOGIN_VAULT_FULL', '저장할 수 있는 로그인 계정 수를 초과했습니다.');
      const account = { id: previous?.id || randomUUID(), userId, origin, label, username, password };
      persist([...accounts.filter(item => item.id !== account.id), account]);
      return account;
    },
    close() { accounts = []; key?.fill(0); key = null; },
  };
}

/**
 * Private HTTP/UI handoff only. The caller captures origin/tabRef from the real
 * browser; neither may come from model-provided or HTTP client target values.
 * fill must verify both again inside its browser operation queue, immediately
 * before typing. Credentials and fill results must never enter model context.
 */
export function createLoginRequests({ dataDir, authorize, fill, now = Date.now, ttlMs = 10 * 60_000 } = {}) {
  if (typeof dataDir !== 'string' || typeof authorize !== 'function' || typeof fill !== 'function')
    throw new TypeError('Private login store, authorization and browser fill are required');
  if (!Number.isInteger(ttlMs) || ttlMs < 1000 || ttlMs > 10 * 60_000) throw new TypeError('Invalid login expiry');
  const vault = accountStore(dataDir), requests = new Map();
  let closed = false;
  const publicView = request => ({ id: request.id, roomId: request.roomId, origin: request.origin,
    siteLabel: request.siteLabel, expiresAt: request.expiresAt, status: request.status });
  const binding = request => ({ userId: request.userId, roomId: request.roomId });
  function checkOpen() {
    if (closed) throw fail(503, 'LOGIN_UNAVAILABLE', '로그인 연결이 종료되었습니다.');
  }
  async function permitted(request) {
    checkOpen();
    await authorize(binding(request));
    checkOpen();
  }
  function sweep() {
    for (const [id, request] of requests) {
      if (request.expiresAt <= now()) {
        request.controller?.abort();
        requests.delete(id);
      }
    }
  }
  async function owned(userId, id) {
    checkOpen(); identifier(userId); identifier(id); sweep();
    const request = requests.get(id);
    if (!request || request.userId !== userId) throw notFound();
    await permitted(request);
    if (request.expiresAt <= now() || requests.get(id) !== request) throw notFound();
    return request;
  }
  return {
    async request({ userId, roomId, origin, tabRef, siteLabel }) {
      checkOpen(); identifier(userId); identifier(roomId);
      const target = { userId, roomId, origin: loginOrigin(origin), tabRef: text(tabRef, 256),
        siteLabel: text(siteLabel || new URL(origin).hostname, 80) };
      await permitted(target); sweep();
      const current = [...requests.values()].filter(item => item.userId === userId && item.roomId === roomId && ['pending', 'filling'].includes(item.status));
      if (current.some(item => item.status === 'filling'))
        throw fail(409, 'LOGIN_REQUEST_BUSY', '이 대화의 로그인 정보를 입력하는 중입니다.');
      const duplicate = current.find(item => item.origin === target.origin && item.tabRef === target.tabRef);
      if (duplicate) return publicView(duplicate);
      for (const previous of current) requests.delete(previous.id);
      if (requests.size >= 256 || [...requests.values()].filter(item => item.userId === userId && ['pending', 'filling'].includes(item.status)).length >= 8)
        throw fail(429, 'LOGIN_REQUEST_LIMIT', '열려 있는 로그인 요청을 먼저 완료해주세요.');
      const request = { ...target, id: randomUUID(), expiresAt: now() + ttlMs, status: 'pending' };
      requests.set(request.id, request);
      return publicView(request);
    },
    async list(userId) {
      checkOpen(); identifier(userId); sweep();
      const result = [];
      for (const request of requests.values()) {
        if (request.userId !== userId || !['pending', 'filling'].includes(request.status)) continue;
        try { await permitted(request); } catch { request.controller?.abort(); requests.delete(request.id); continue; }
        if (request.expiresAt > now() && requests.get(request.id) === request) result.push(publicView(request));
      }
      return result;
    },
    async get(userId, id) {
      const request = await owned(userId, id);
      return { ...publicView(request), accounts: vault.list(userId, request.origin) };
    },
    async resolve(userId, id, input, { assertAuthorized, signal } = {}) {
      const request = await owned(userId, id);
      if (request.status !== 'pending') throw fail(409, 'LOGIN_REQUEST_USED', '이미 처리한 로그인 요청입니다.');
      if (!input || typeof input !== 'object' || Array.isArray(input) || input.sharedDeviceConfirmed !== true)
        throw fail(400, 'LOGIN_SHARED_DEVICE_CONFIRMATION', '공유 PC에 로그인하는 것을 확인해주세요.');
      const save = input.action === 'save';
      const allowed = save ? ['action', 'label', 'username', 'password', 'sharedDeviceConfirmed'] : ['accountId', 'sharedDeviceConfirmed'];
      if (Object.keys(input).some(key => !allowed.includes(key))) throw invalid();
      // Reserve before any asynchronous operation; concurrent POSTs cannot replay.
      request.status = 'filling';
      const controller = new AbortController(); request.controller = controller;
      const abort = () => controller.abort();
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
      const timeout = setTimeout(() => controller.abort(), Math.max(1, request.expiresAt - now()));
      timeout.unref?.();
      let account;
      const authorizeOperation = async () => {
        await permitted(request);
        await assertAuthorized?.();
        if (controller.signal.aborted || request.expiresAt <= now() || requests.get(id) !== request) throw notFound();
      };
      try {
        await authorizeOperation();
        account = save ? vault.save(userId, request.origin, input) : vault.find(userId, request.origin, identifier(input.accountId));
        const result = await fill({ ...binding(request), origin: request.origin, tabRef: request.tabRef,
          username: account.username, password: account.password, signal: controller.signal,
          assertAuthorized: authorizeOperation });
        await authorizeOperation();
        request.status = 'filled';
        return { ...publicView(request), ...(['continue', 'submit'].includes(result?.nextStep) ? { nextStep: result.nextStep } : {}) };
      } catch (error) {
        if (request.status === 'filling') request.status = 'failed';
        // Browser/provider error messages may include submitted field values.
        if (['LOGIN_INPUT_INVALID', 'LOGIN_ACCOUNT_NOT_FOUND', 'LOGIN_VAULT_FULL', 'LOGIN_VAULT_UNAVAILABLE'].includes(error?.code)) throw error;
        throw fail([401, 403].includes(error?.status) ? error.status : 409, 'LOGIN_FILL_FAILED', '로그인 정보를 입력하지 못했습니다. 페이지를 확인하고 다시 요청해주세요.');
      } finally {
        clearTimeout(timeout); signal?.removeEventListener('abort', abort); delete request.controller; account = null;
      }
    },
    async cancel(userId, id) {
      const request = await owned(userId, id);
      request.controller?.abort(); request.status = 'cancelled';
      return publicView(request);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const request of requests.values()) request.controller?.abort();
      requests.clear(); vault.close();
    },
  };
}
