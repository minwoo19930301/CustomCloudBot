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

function forbidAsync(storage) {
  for (const name of ['isAsyncEncryptionAvailable', 'encryptStringAsync', 'decryptStringAsync']) {
    Object.defineProperty(storage, name, { get() { forbiddenCalls.push(name); assert.fail(`Mac must not initialize or inspect ${name}`); } });
  }
  return storage;
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

test('Mac uses only Keychain legacy before and after restart and never initializes async storage', async () => {
  const store = createSecureStore({ safeStorage: forbidAsync(api()), platform: 'darwin' });
  assert.equal(await store.selfTest(), true);
  assert.equal(store.diagnostic().async, 'disabled-on-macos');
  const encrypted = await store.encrypt('private-token');
  assert.equal(encrypted.includes(Buffer.from('private-token')), false);
  assert.match(encrypted.toString(), /electron-macos-keychain-legacy/);
  const restart = createSecureStore({ safeStorage: forbidAsync(api()), platform: 'darwin' });
  await restart.available();
  const decrypted = await restart.decrypt(encrypted);
  assert.equal(decrypted.result, 'private-token');
  assert.equal(decrypted.shouldReEncrypt, false);
});

test('Mac never starts a stalled async initialization before using Keychain', async () => {
  let asyncCalls = 0;
  const storage = api();
  storage.isAsyncEncryptionAvailable = () => { asyncCalls += 1; return new Promise(() => {}); };
  const store = createSecureStore({ safeStorage: storage, platform: 'darwin', timeoutMs: 10 });
  assert.equal(await store.selfTest(), true);
  assert.equal(asyncCalls, 0);
  assert.equal(store.diagnostic().async, 'disabled-on-macos');
});

test('Mac rejects old async envelopes and pre-envelope records without initializing their backend', async () => {
  for (const initializeFirst of [false, true]) {
    const store = createSecureStore({ safeStorage: forbidAsync(api()), platform: 'darwin' });
    if (initializeFirst) assert.equal(await store.selfTest(), true);
    for (const record of [envelope('electron-async'), Buffer.from('async-cipher:old-record')]) {
      await assert.rejects(store.decrypt(record), { code: 'SECURE_STORAGE_RECONNECT_REQUIRED' });
    }
    assert.equal((await store.decrypt(envelope('electron-macos-keychain-legacy'))).result, 'old-record');
    assert.equal(await store.selfTest(), true);
  }
});

test('Mac fails closed without available Keychain instead of trying async storage', async () => {
  const store = createSecureStore({ safeStorage: forbidAsync(api({ legacyAvailable: false })), platform: 'darwin' });
  assert.equal(await store.selfTest(), false);
  await assert.rejects(store.encrypt('private-token'), /secure_storage_unavailable/);
  await assert.rejects(store.decrypt(envelope('electron-macos-keychain-legacy')), /secure_storage_unavailable/);
  assert.equal(store.diagnostic().legacy, 'unavailable');
  const incomplete = forbidAsync(api()); delete incomplete.decryptString;
  const missing = createSecureStore({ safeStorage: incomplete, platform: 'darwin' });
  assert.equal(await missing.available(), false);
  assert.equal(missing.diagnostic().legacy, 'missing-api');
});

test('Mac Keychain errors never switch backends and retries remain legacy only', async () => {
  for (const method of ['isEncryptionAvailable', 'encryptString', 'decryptString']) {
    const storage = forbidAsync(api());
    const original = storage[method];
    storage[method] = () => { throw new Error('keychain-error'); };
    const store = createSecureStore({ safeStorage: storage, platform: 'darwin' });
    assert.equal(await store.selfTest(), false);
    assert.equal(store.diagnostic().provider, null);
    storage[method] = original;
    assert.equal(await store.selfTest(), true);
    assert.equal(store.diagnostic().provider, 'electron-macos-keychain-legacy');
  }
});

test('async initialization timeout is diagnosed and never falls back to legacy', async () => {
  const storage = forbidLegacy(api()); storage.isAsyncEncryptionAvailable = () => new Promise(() => {});
  const store = createSecureStore({ safeStorage: storage, platform: 'win32', timeoutMs: 10 });
  assert.equal(await store.selfTest(), false);
  assert.equal(store.diagnostic().async, 'timeout');
  assert.equal(store.diagnostic().provider, null);
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
