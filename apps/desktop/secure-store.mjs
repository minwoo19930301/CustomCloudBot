const HEADER = 'CCB-SECURE-STORE-1\n';

export function createSecureStore({ safeStorage, platform = process.platform, timeoutMs = 5000, onDiagnostic = () => {} }) {
  let provider = null;
  let diagnostic = { async: 'unchecked', legacy: 'not-attempted', provider: null, selfTest: 'unchecked' };
  const report = patch => { diagnostic = { ...diagnostic, ...patch }; onDiagnostic({ ...diagnostic }); };
  const unavailable = () => Object.assign(new Error('secure_storage_unavailable'), { code: 'SECURE_STORAGE_UNAVAILABLE' });
  async function bounded(promise) {
    let timer;
    try {
      return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('secure_storage_timeout'), { code: 'SECURE_STORAGE_TIMEOUT' })), timeoutMs); })]);
    } finally { clearTimeout(timer); }
  }
  async function available() {
    if (provider) return true;
    if (platform === 'linux' && ['basic_text', 'unknown'].includes(safeStorage.getSelectedStorageBackend?.())) {
      report({ async: 'insecure-backend', provider: null }); return false;
    }
    if (typeof safeStorage.isAsyncEncryptionAvailable !== 'function') report({ async: 'missing-api' });
    else {
      try {
        if (await bounded(safeStorage.isAsyncEncryptionAvailable())) {
          provider = 'electron-async'; report({ async: 'ready', provider }); return true;
        }
        report({ async: 'unavailable' });
      } catch (error) { report({ async: error?.code === 'SECURE_STORAGE_TIMEOUT' ? 'timeout' : 'error' }); }
    }
    // Electron 45 retains the macOS Keychain-backed synchronous API. This is
    // never a plaintext or Linux basic_text fallback. Remove when upgrading46.
    if (platform === 'darwin' && typeof safeStorage.isEncryptionAvailable === 'function') {
      try {
        if (safeStorage.isEncryptionAvailable()) {
          provider = 'electron-macos-keychain-legacy'; report({ legacy: 'ready', provider }); return true;
        }
        report({ legacy: 'unavailable' });
      } catch { report({ legacy: 'error' }); }
    }
    return false;
  }
  async function encrypt(text) {
    if (!await available()) throw unavailable();
    const selected = provider;
    try {
      const ciphertext = selected === 'electron-async'
        ? await bounded(safeStorage.encryptStringAsync(text)) : safeStorage.encryptString(text);
      if (!Buffer.isBuffer(ciphertext) || !ciphertext.length) throw unavailable();
      return Buffer.from(HEADER + JSON.stringify({ version: 1, provider: selected, ciphertext: ciphertext.toString('base64') }));
    } catch (error) { provider = null; report({ provider: null }); throw error; }
  }
  async function decrypt(record) {
    let selected = 'electron-async';
    let ciphertext = record;
    if (record.subarray(0, HEADER.length).toString() === HEADER) {
      const envelope = JSON.parse(record.subarray(HEADER.length).toString('utf8'));
      if (envelope.version !== 1 || !['electron-async', 'electron-macos-keychain-legacy'].includes(envelope.provider)
          || typeof envelope.ciphertext !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(envelope.ciphertext)) throw unavailable();
      selected = envelope.provider;
      ciphertext = Buffer.from(envelope.ciphertext, 'base64');
    }
    if (selected === 'electron-macos-keychain-legacy') {
      if (platform !== 'darwin' || typeof safeStorage.decryptString !== 'function' || !safeStorage.isEncryptionAvailable()) throw unavailable();
      return { result: safeStorage.decryptString(ciphertext), shouldReEncrypt: provider === 'electron-async' };
    }
    if (typeof safeStorage.decryptStringAsync !== 'function') throw unavailable();
    return bounded(safeStorage.decryptStringAsync(ciphertext));
  }
  async function selfTest() {
    if (!await available()) return false;
    try {
      const probe = 'CustomCloudBot secure storage self-test';
      const encrypted = await encrypt(probe);
      const decoded = await decrypt(encrypted);
      if (decoded.result !== probe) throw unavailable();
      report({ selfTest: 'passed' }); return true;
    } catch { provider = null; report({ provider: null, selfTest: 'failed' }); return false; }
  }
  return { available, encrypt, decrypt, selfTest, diagnostic: () => ({ ...diagnostic }) };
}
