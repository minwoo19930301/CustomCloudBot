import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecureStore } from '../secure-store.mjs';

const forbiddenCalls = [];
test.afterEach(() => {
  const calls = forbiddenCalls.splice(0);
  assert.deepEqual(calls, [], 'the other storage backend must never be inspected, even when errors are caught');
});

function api({ asyncAvailable = true, legacyAvailable = true } = {}) {
  return {
    isAsyncEncryptionAvailable: async () => asyncAvailable,
    isEncryptionAvailable: () => legacyAvailable,
    encryptStringAsync: async value => Buffer.from(`async-cipher:${value}`),
    decryptStringAsync: async value => ({ result: value.toString().replace(/^async-cipher:/, ''), shouldReEncrypt: false }),
    encryptString: value => Buffer.from(`legacy-cipher:${value}`),
    decryptString: value => value.toString().replace(/^legacy-cipher:/, '')
  };
}

function forbidLegacy(storage) {
  for (const name of ['isEncryptionAvailable', 'encryptString', 'decryptString']) {
    Object.defineProperty(storage, name, { get() { forbiddenCalls.push(name); assert.fail(`Async platform must not inspect ${name}`); } });
  }
  return storage;
}

function envelope(provider, plaintext = 'old-record') {
  const ciphertext = Buffer.from(`${provider === 'electron-async' ? 'async' : 'legacy'}-cipher:${plaintext}`).toString('base64');
  return Buffer.from('CCB-SECURE-STORE-1\n' + JSON.stringify({ version: 1, provider, ciphertext }));
}

test('non-Mac uses async storage with an explicit versioned encrypted provider envelope', async () => {
  const store = createSecureStore({ safeStorage: forbidLegacy(api()), platform: 'win32' });
  assert.equal(await store.selfTest(), true);
  const encrypted = await store.encrypt('private-token');
  assert.equal(encrypted.includes(Buffer.from('private-token')), false);
  assert.match(encrypted.toString(), /"version":1,"provider":"electron-async"/);
  assert.equal((await store.decrypt(encrypted)).result, 'private-token');
  assert.equal(store.diagnostic().selfTest, 'passed');
});

test('Mac uses async storage before and after restart without inspecting synchronous Keychain APIs', async () => {
  const store = createSecureStore({ safeStorage: forbidLegacy(api()), platform: 'darwin' });
  assert.equal(await store.selfTest(), true);
  assert.equal(store.diagnostic().async, 'ready');
  const encrypted = await store.encrypt('private-token');
  assert.equal(encrypted.includes(Buffer.from('private-token')), false);
  assert.match(encrypted.toString(), /electron-async/);
  const restart = createSecureStore({ safeStorage: forbidLegacy(api()), platform: 'darwin' });
  await restart.available();
  const decrypted = await restart.decrypt(encrypted);
  assert.equal(decrypted.result, 'private-token');
  assert.equal(decrypted.shouldReEncrypt, false);
});

test('Mac async initialization timeout returns without accessing synchronous Keychain', async () => {
  let asyncCalls = 0;
  const storage = forbidLegacy(api());
  storage.isAsyncEncryptionAvailable = () => { asyncCalls += 1; return new Promise(() => {}); };
  const store = createSecureStore({ safeStorage: storage, platform: 'darwin', timeoutMs: 10 });
  assert.equal(await store.selfTest(), false);
  assert.equal(asyncCalls, 1);
  assert.equal(store.diagnostic().async, 'timeout');
  assert.equal(store.diagnostic().provider, null);
  storage.isAsyncEncryptionAvailable = async () => true;
  assert.equal(await store.selfTest(), true);
});

test('Mac rejects legacy envelopes without initializing their backend and accepts async records', async () => {
  for (const initializeFirst of [false, true]) {
    const store = createSecureStore({ safeStorage: forbidLegacy(api()), platform: 'darwin' });
    if (initializeFirst) assert.equal(await store.selfTest(), true);
    await assert.rejects(store.decrypt(envelope('electron-macos-keychain-legacy')), { code: 'SECURE_STORAGE_RECONNECT_REQUIRED' });
    for (const record of [envelope('electron-async'), Buffer.from('async-cipher:old-record')]) assert.equal((await store.decrypt(record)).result, 'old-record');
    assert.equal(await store.selfTest(), true);
  }
});

test('Mac fails closed without async storage instead of trying synchronous Keychain', async () => {
  const store = createSecureStore({ safeStorage: forbidLegacy(api({ asyncAvailable: false })), platform: 'darwin' });
  assert.equal(await store.selfTest(), false);
  await assert.rejects(store.encrypt('private-token'), /secure_storage_unavailable/);
  await assert.rejects(store.decrypt(envelope('electron-async')), /secure_storage_unavailable/);
  assert.equal(store.diagnostic().async, 'unavailable');
  const incomplete = forbidLegacy(api()); delete incomplete.decryptStringAsync;
  const missing = createSecureStore({ safeStorage: incomplete, platform: 'darwin' });
  assert.equal(await missing.available(), false);
  assert.equal(missing.diagnostic().async, 'missing-api');
});

test('Mac async storage errors never access legacy storage and can retry asynchronously', async () => {
  for (const method of ['isAsyncEncryptionAvailable', 'encryptStringAsync', 'decryptStringAsync']) {
    const storage = forbidLegacy(api());
    const original = storage[method];
    storage[method] = async () => { throw new Error('keychain-error'); };
    const store = createSecureStore({ safeStorage: storage, platform: 'darwin' });
    assert.equal(await store.selfTest(), false);
    assert.equal(store.diagnostic().provider, null);
    storage[method] = original;
    assert.equal(await store.selfTest(), true);
    assert.equal(store.diagnostic().provider, 'electron-async');
  }
});

test('async initialization timeout is diagnosed and never falls back to legacy', async () => {
  const storage = forbidLegacy(api()); storage.isAsyncEncryptionAvailable = () => new Promise(() => {});
  const store = createSecureStore({ safeStorage: storage, platform: 'win32', timeoutMs: 10 });
  assert.equal(await store.selfTest(), false);
  assert.equal(store.diagnostic().async, 'timeout');
  assert.equal(store.diagnostic().provider, null);
});

test('Mac encryption and decryption waits are bounded without synchronous fallback', async () => {
  for (const method of ['encryptStringAsync', 'decryptStringAsync']) {
    const storage = forbidLegacy(api());
    storage[method] = () => new Promise(() => {});
    const store = createSecureStore({ safeStorage: storage, platform: 'darwin', timeoutMs: 10 });
    const operation = method === 'encryptStringAsync' ? store.encrypt('private-token') : store.decrypt(envelope('electron-async'));
    await assert.rejects(operation, { code: 'SECURE_STORAGE_TIMEOUT' });
  }
});

test('Linux basic_text is refused for both new encryption and existing decryption', async () => {
  const insecure = forbidLegacy(api()); insecure.getSelectedStorageBackend = () => 'basic_text';
  const linux = createSecureStore({ safeStorage: insecure, platform: 'linux' });
  assert.equal(await linux.available(), false);
  await assert.rejects(linux.encrypt('private-token'), /secure_storage_unavailable/);
  await assert.rejects(linux.decrypt(envelope('electron-async')), /secure_storage_unavailable/);
});

test('async platforms support pre-envelope records and refuse foreign provider labels without mixing', async () => {
  const store = createSecureStore({ safeStorage: forbidLegacy(api()), platform: 'win32' });
  assert.equal((await store.decrypt(Buffer.from('async-cipher:old-record'))).result, 'old-record');
  await assert.rejects(store.decrypt(envelope('electron-macos-keychain-legacy')), { code: 'SECURE_STORAGE_RECONNECT_REQUIRED' });
  await assert.rejects(store.decrypt(Buffer.from('CCB-SECURE-STORE-1\n{"version":1,"provider":"plaintext","ciphertext":"YWJj"}')), /secure_storage_unavailable/);
});
