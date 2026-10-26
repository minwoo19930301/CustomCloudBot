import test from 'node:test';
import assert from 'node:assert/strict';
import { createSecureStore } from '../secure-store.mjs';

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

test('uses async storage with an explicit versioned encrypted provider envelope', async () => {
  const store = createSecureStore({ safeStorage: api(), platform: 'darwin' });
  assert.equal(await store.selfTest(), true);
  const encrypted = await store.encrypt('private-token');
  assert.equal(encrypted.includes(Buffer.from('private-token')), false);
  assert.match(encrypted.toString(), /"version":1,"provider":"electron-async"/);
  assert.equal((await store.decrypt(encrypted)).result, 'private-token');
  assert.equal(store.diagnostic().selfTest, 'passed');
});

test('Mac async unavailable uses Keychain legacy and retains its provider across restarts', async () => {
  const storage = api({ asyncAvailable: false });
  const store = createSecureStore({ safeStorage: storage, platform: 'darwin' });
  assert.equal(await store.selfTest(), true);
  assert.equal(store.diagnostic().async, 'unavailable');
  const encrypted = await store.encrypt('private-token');
  assert.match(encrypted.toString(), /electron-macos-keychain-legacy/);
  const restart = createSecureStore({ safeStorage: api(), platform: 'darwin' });
  await restart.available();
  const decrypted = await restart.decrypt(encrypted);
  assert.equal(decrypted.result, 'private-token');
  assert.equal(decrypted.shouldReEncrypt, true);
});

test('async initialization timeout is diagnosed separately and Mac can still use Keychain', async () => {
  const storage = api(); storage.isAsyncEncryptionAvailable = () => new Promise(() => {});
  const store = createSecureStore({ safeStorage: storage, platform: 'darwin', timeoutMs: 10 });
  assert.equal(await store.selfTest(), true);
  assert.equal(store.diagnostic().async, 'timeout');
  assert.equal(store.diagnostic().provider, 'electron-macos-keychain-legacy');
});

test('fails closed with no Mac Keychain and never uses Linux basic_text', async () => {
  const store = createSecureStore({ safeStorage: api({ asyncAvailable: false, legacyAvailable: false }), platform: 'darwin' });
  assert.equal(await store.selfTest(), false);
  await assert.rejects(store.encrypt('private-token'), /secure_storage_unavailable/);
  const insecure = api(); insecure.getSelectedStorageBackend = () => 'basic_text';
  insecure.encryptString = () => assert.fail('must not use basic_text');
  const linux = createSecureStore({ safeStorage: insecure, platform: 'linux' });
  assert.equal(await linux.available(), false);
});

test('supports pre-envelope async records and rejects foreign provider labels', async () => {
  const store = createSecureStore({ safeStorage: api(), platform: 'darwin' });
  assert.equal((await store.decrypt(Buffer.from('async-cipher:old-record'))).result, 'old-record');
  await assert.rejects(store.decrypt(Buffer.from('CCB-SECURE-STORE-1\n{"version":1,"provider":"plaintext","ciphertext":"YWJj"}')), /secure_storage_unavailable/);
});
