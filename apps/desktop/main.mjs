import { app, BrowserWindow, WebContentsView, ipcMain, dialog, safeStorage, shell, Menu } from 'electron';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createExecutor } from './executor.mjs';
import { createSecureStore } from './secure-store.mjs';
import { initialDesktopSettings } from './release-config.mjs';
import { normalizeAppUrl, isTrustedSender, isSameOriginUrl, externalHttpsUrl, capabilityList, consentDetails, safeError, validJob, isStaleResultError } from './security.mjs';

app.setName('CustomCloudBot Desktop');

const here = path.dirname(fileURLToPath(import.meta.url));
const localPage = path.join(here, 'ui/index.html');
let window;
let cloud;
let settingsVisible = true;
let enabled = false;
let statusMessage = '로그인한 뒤 이 컴퓨터에 허용할 권한을 선택하세요.';
let pendingExternal = null;
let currentJob = null;
let currentJobPromise = null;
let pendingJobs = [];
let clearingConnection = false;
let closing = false;
let readyToClose = false;
let pollController = null;
let pollTimer = null;
let connecting = false;
let loadingState = true;
let storeQueue = Promise.resolve();
let config = { origin: '', name: os.hostname(), roots: [], capabilities: { files: false, terminal: false, browser: false } };
let credentials = { token: null, device: null, seenJobs: [], outbox: [], pairedCapabilities: [] };
let storageAvailable = false;
let diagnosticQueue = Promise.resolve();
const secureStore = createSecureStore({ safeStorage, onDiagnostic: diagnostic => {
  const directory = app.getPath('userData');
  diagnosticQueue = diagnosticQueue.catch(() => {}).then(() => fs.mkdir(directory, { recursive: true, mode: 0o700 })).then(() => fs.writeFile(path.join(directory, 'storage-diagnostic.json'), JSON.stringify(diagnostic), { mode: 0o600 })).catch(() => {});
} });
const policy = () => ({ enabled, roots: [...config.roots], capabilities: { ...config.capabilities } });
const executor = createExecutor({ getPolicy: policy, protectedPaths: [app.getPath('userData'), app.getAppPath(), ...(app.isPackaged ? [process.resourcesPath, path.resolve(process.resourcesPath, '../..')] : [])], openExternal: url => shell.openExternal(url), describeMachine: () => ({ name: config.name, platform: process.platform, arch: process.arch }) });

app.enableSandbox();
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) app.quit();
app.on('second-instance', () => { window?.show(); window?.focus(); });

function paths() {
  const directory = app.getPath('userData');
  return { directory, config: path.join(directory, 'desktop-settings.json'), credential: path.join(directory, 'desktop-connection.enc') };
}

async function encryptionAvailable() { return secureStore.available(); }

async function atomicWrite(file, data) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, data, { mode: 0o600 });
  await fs.rename(temporary, file);
}

function persist({ secret = true } = {}) {
  storeQueue = storeQueue.catch(() => {}).then(async () => {
    const files = paths();
    await fs.mkdir(files.directory, { recursive: true, mode: 0o700 });
    await atomicWrite(files.config, JSON.stringify(config));
    if (secret) {
      if (!await encryptionAvailable()) throw new Error('secure_storage_unavailable');
      await atomicWrite(files.credential, await secureStore.encrypt(JSON.stringify(credentials)));
    }
  });
  return storeQueue;
}

async function loadState() {
  try {
    const saved = await initialDesktopSettings(paths().config, path.join(here, 'release.json'));
    if (saved) config = validateSettings(saved, saved.roots);
    if (config.origin) {
      settingsVisible = false;
      void ensureCloud().catch(() => { showSettings(true); setMessage('서비스를 열지 못했습니다. 연결 설정에서 주소를 확인해 주세요.'); });
    }
    notify();
  } catch {}
  storageAvailable = await secureStore.selfTest().catch(() => false);
  if (!storageAvailable) { statusMessage = secureStore.diagnostic().async === 'timeout' ? '암호 저장소 응답이 지연되고 있습니다. 연결 설정에서 다시 시도해 주세요.' : '운영체제 암호 저장소를 확인하지 못했습니다. 연결 설정에서 다시 시도해 주세요.'; return; }
  try {
    const decrypted = await secureStore.decrypt(await fs.readFile(paths().credential));
    if (!decrypted) throw new Error('secure_storage_unavailable');
    const saved = JSON.parse(decrypted.result);
    if (saved.pairedOrigin !== config.origin) throw new Error('stored_origin_mismatch');
    if (/^ccb_pc_[A-Za-z0-9_-]{43}$/.test(saved.token) && saved.device?.id && saved.device?.userId) {
      credentials = { token: saved.token, pairedOrigin: saved.pairedOrigin, device: saved.device, ownerLabel: String(saved.ownerLabel || '').slice(0, 80), seenJobs: Array.isArray(saved.seenJobs) ? saved.seenJobs.filter(id => typeof id === 'string').slice(-2048) : [], outbox: Array.isArray(saved.outbox) ? saved.outbox : [], pairedCapabilities: Array.isArray(saved.pairedCapabilities) ? saved.pairedCapabilities : [] };
      if (decrypted.shouldReEncrypt) await persist();
    }
  } catch (error) {
    if (error.code === 'SECURE_STORAGE_RECONNECT_REQUIRED') statusMessage = '이전 버전의 연결 저장 방식을 사용할 수 없습니다. 권한을 선택해 다시 연결해 주세요.';
    else if (error.code !== 'ENOENT') statusMessage = '저장한 연결을 읽지 못했습니다. 권한을 선택해 다시 연결해 주세요.';
  }
  // Every launch starts paused, including a previously authorized machine.
  if (credentials.token) statusMessage = '저장된 연결이 일시정지되어 있습니다. 연결 허용을 누르면 다시 시작합니다.';
  else if (statusMessage === '운영체제 암호 저장소를 확인하고 있습니다.') statusMessage = '로그인한 뒤 이 컴퓨터에 허용할 권한을 선택하세요.';
}

function validateSettings(value, roots = config.roots) {
  const origin = normalizeAppUrl(value?.origin);
  const name = String(value?.name || os.hostname()).trim().slice(0, 80);
  return { origin, name: name || '내 컴퓨터', roots: Array.isArray(roots) ? roots.filter(item => typeof item === 'string' && path.isAbsolute(item)).slice(0, 16) : [], capabilities: {
    files: value?.capabilities?.files === true, terminal: value?.capabilities?.terminal === true, browser: value?.capabilities?.browser === true
  } };
}

function permissionStatus() {
  if (process.platform !== 'darwin') return { platform: process.platform };
  return { platform: process.platform };
}

function state() {
  return { ...config, enabled, paired: Boolean(credentials.token), deviceName: credentials.device?.name || config.name,
    settingsVisible, ownerLabel: credentials.ownerLabel || '', message: statusMessage, busy: connecting || loadingState, job: currentJob ? { tool: currentJob.tool } : null,
    externalHost: pendingExternal ? new URL(pendingExternal).host : null,
    permissions: permissionStatus(), storageAvailable };
}

function notify() { if (window && !window.isDestroyed()) window.webContents.send('desktop:state', state()); }
function setMessage(message) { statusMessage = message; notify(); }
function layoutCloud() {
  if (!cloud || !window) return;
  const [width, height] = window.getContentSize();
  cloud.setBounds({ x: 0, y: 0, width, height: Math.max(0, height) });
  cloud.setVisible(!settingsVisible);
}
function showSettings(show) { settingsVisible = show; layoutCloud(); notify(); }

function pendingLink(value) {
  const url = externalHttpsUrl(value);
  if (url) { pendingExternal = url; setMessage('외부 링크를 열려면 상단의 링크 열기를 눌러 주세요.'); }
}

async function ensureCloud() {
  if (!cloud) {
    cloud = new WebContentsView({ webPreferences: {
      preload: path.join(here, 'cloud-preload.cjs'), partition: 'persist:customcloudbot-cloud', sandbox: true, contextIsolation: true,
      nodeIntegration: false, webSecurity: true, allowRunningInsecureContent: false,
      webviewTag: false, navigateOnDragDrop: false
    } });
    window.contentView.addChildView(cloud);
    cloud.webContents.setWindowOpenHandler(({ url }) => { pendingLink(url); return { action: 'deny' }; });
    const guard = (event, url) => { if (!isSameOriginUrl(url, config.origin)) { event.preventDefault(); pendingLink(url); } };
    cloud.webContents.on('will-navigate', guard);
    cloud.webContents.on('will-redirect', guard);
    cloud.webContents.on('will-attach-webview', event => event.preventDefault());
    cloud.webContents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
    cloud.webContents.session.setPermissionCheckHandler(() => false);
    cloud.webContents.session.on('will-download', async (event, item, contents) => {
      // A browser download never chooses a local path without a native save dialog.
      if (contents !== cloud?.webContents || !externalHttpsUrl(item.getURL())) { event.preventDefault(); return; }
      item.pause();
      const result = await dialog.showSaveDialog(window, { title: '파일 저장', defaultPath: path.basename(item.getFilename()) }).catch(() => ({ canceled: true }));
      if (result.canceled || !result.filePath) item.cancel();
      else { item.setSavePath(result.filePath); item.resume(); }
    });
    cloud.webContents.on('did-fail-load', (_event, code, _description, _url, mainFrame) => {
      if (mainFrame && code !== -3) setMessage('서비스를 열지 못했습니다. 주소와 인터넷 연결을 확인해 주세요.');
    });
  }
  if (!isSameOriginUrl(cloud.webContents.getURL(), config.origin)) await cloud.webContents.loadURL(config.origin);
  layoutCloud();
}

async function request(route, { method = 'GET', body, cookie = false, csrf, signal, timeout = 35_000 } = {}) {
  const headers = { Accept: 'application/json', Origin: config.origin };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (csrf) headers['x-csrf-token'] = csrf;
  if (!cookie) {
    if (!credentials.token || credentials.pairedOrigin !== config.origin) { const error = new Error('stored_origin_mismatch'); error.code = 'UNAUTHORIZED'; throw error; }
    headers.Authorization = `Bearer ${credentials.token}`;
  }
  const response = await cloud.webContents.session.fetch(`${config.origin}${route}`, {
    method, headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: cookie ? 'include' : 'omit',
    redirect: 'error', signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout)
  });
  if (!response.ok) { const error = new Error('request_failed'); error.status = response.status; error.code = [401, 403].includes(response.status) ? 'UNAUTHORIZED' : `HTTP_${response.status}`; throw error; }
  if (response.status === 204) return {};
  const text = await response.text();
  if (text.length > 2_000_000) throw new Error('response_too_large');
  return JSON.parse(text);
}

async function flushResults() {
  for (const item of [...credentials.outbox]) {
    try {
      await request(`/api/local-computers/jobs/${encodeURIComponent(item.id)}/result`, { method: 'POST', body: item.body, timeout: 15_000 });
    } catch (error) {
      // An expired or canceled server job is terminal; never replay its local side effect.
      if (!isStaleResultError(error)) throw error;
    }
    credentials.outbox = credentials.outbox.filter(entry => entry.id !== item.id);
    await persist();
  }
}

async function finishJob(job, body, token) {
  if (!token || credentials.token !== token) return;
  credentials.outbox = [...credentials.outbox.filter(entry => entry.id !== job.id), { id: job.id, body }];
  // Persist results before transmission. Retrying a result cannot repeat a command.
  await persist();
  await flushResults();
}

function startNextJob() {
  if (!enabled || currentJob || !pendingJobs.length) return;
  const job = pendingJobs.shift();
  const controller = new AbortController();
  const token = credentials.token;
  currentJob = { id: job.id, tool: job.tool, controller };
  currentJobPromise = runJob(job, controller, token).catch(() => {
    pause('보안 저장소 오류로 연결을 일시정지했습니다.');
    void notifyPause();
  }).finally(() => {
    currentJob = null;
    currentJobPromise = null;
    if (enabled) setMessage('연결됨 · 이 컴퓨터에서 요청을 기다리고 있습니다.'); else notify();
    startNextJob();
  });
}

async function runJob(job, controller, token) {
  if (credentials.seenJobs.includes(job.id)) {
    await finishJob(job, { ok: false, error: '중복 작업은 다시 실행하지 않습니다.' }, token);
    return;
  }
  credentials.seenJobs = [...credentials.seenJobs, job.id].slice(-2048);
  await persist();
  let body;
  if (!enabled || controller.signal.aborted || job.expiresAt <= Date.now()) {
    body = { ok: false, error: '실행 전에 취소되거나 만료된 작업입니다.' };
  } else {
    setMessage(`컴퓨터에서 작업 중 · ${job.tool}`);
    const deadline = setTimeout(() => controller.abort(), Math.max(1, job.expiresAt - Date.now()));
    try {
      const result = await executor.execute(job.tool, job.args || {}, { signal: controller.signal });
      body = controller.signal.aborted
        ? { ok: false, error: '작업이 중단되었습니다.' }
        : { ok: true, result };
    } catch (error) {
      body = { ok: false, error: controller.signal.aborted ? '작업이 중단되었습니다.' : `컴퓨터에서 작업을 완료하지 못했습니다. (${String(error?.code || 'EXECUTION_FAILED').slice(0, 80)})` };
    } finally { clearTimeout(deadline); }
  }
  try { await finishJob(job, body, token); }
  catch (error) {
    if (error.code === 'UNAUTHORIZED') await forgetConnection();
    else setMessage('작업 결과 전송을 기다리고 있습니다. 같은 명령을 다시 실행하지 않습니다.');
  }
}

async function acknowledgeCancellation(id) {
  try {
    await request(`/api/local-computers/jobs/${encodeURIComponent(id)}/result`, {
      method: 'POST', body: { ok: false, error: '실행 전에 취소되었습니다.' }, timeout: 15_000
    });
  } catch (error) { if (!isStaleResultError(error)) throw error; }
}

async function poll() {
  if (!enabled) return;
  const controller = new AbortController();
  pollController = controller;
  try {
    const login = await request('/api/session', { cookie: true, signal: controller.signal });
    if (login.user?.id !== credentials.device?.userId) {
      await pauseConnection();
      setMessage('로그인 계정이 바뀌어 컴퓨터 연결을 일시정지했습니다. 계정을 확인하고 다시 연결해 주세요.');
      return;
    }
    if (!currentJob) await flushResults();
    const data = await request('/api/local-computers/poll', { signal: controller.signal });
    if (!enabled) return;
    if (data.device?.revokedAt || data.device?.status === 'revoked') { await forgetConnection(); return; }
    for (const id of Array.isArray(data.cancellations) ? data.cancellations : []) {
      if (typeof id !== 'string' || !/^[a-f0-9-]{36}$/.test(id)) continue;
      pendingJobs = pendingJobs.filter(job => job.id !== id);
      if (currentJob?.id === id) currentJob.controller.abort();
      else await acknowledgeCancellation(id);
    }
    if (data.job && validJob(data.job) && data.job.id !== currentJob?.id && !pendingJobs.some(job => job.id === data.job.id)) {
      pendingJobs.push(data.job);
      startNextJob();
    }
  } catch (error) {
    if (enabled) {
      if (error.code === 'UNAUTHORIZED') await forgetConnection();
      else setMessage('서비스에 다시 연결하는 중입니다.');
    }
  } finally {
    if (pollController === controller) pollController = null;
    if (enabled) pollTimer = setTimeout(() => void poll(), 1500);
  }
}

function pause(message = '일시정지 · 컴퓨터에서 새 작업을 실행하지 않습니다.') {
  enabled = false;
  pendingJobs = [];
  clearTimeout(pollTimer);
  pollController?.abort();
  currentJob?.controller.abort();
  setMessage(message);
}

async function notifyPause() {
  if (!credentials.token || !cloud) return;
  try { await request('/api/local-computers/pause', { method: 'POST', body: {}, timeout: 2000 }); }
  catch (error) {
    if (error.code === 'UNAUTHORIZED') await forgetConnection();
    else setMessage('컴퓨터 실행은 일시정지됐습니다. 서버에 정지 상태를 전달하지 못했습니다.');
  }
}

async function pauseConnection() {
  pause();
  await notifyPause();
  return state();
}

async function forgetConnection() {
  if (clearingConnection) return;
  clearingConnection = true;
  try {
    pause('컴퓨터 연결이 만료되었거나 해제되었습니다. 다시 연결해 주세요.');
    credentials = { token: null, device: null, seenJobs: [], outbox: [], pairedCapabilities: [] };
    await storeQueue.catch(() => {});
    await fs.rm(paths().credential, { force: true });
  } finally { clearingConnection = false; notify(); }
}

async function revoke() {
  pause();
  await currentJobPromise;
  if (credentials.token) {
    try { await request('/api/local-computers/disconnect', { method: 'POST', body: {} }); }
    catch (error) { if (error.code !== 'UNAUTHORIZED') throw error; }
  }
  await forgetConnection();
  setMessage('연결 해제됨 · 이 컴퓨터의 실행 권한을 제거했습니다.');
}

async function connect(settings) {
  if (connecting || currentJob) return state();
  connecting = true; notify();
  try {
    const next = validateSettings(settings);
    if (credentials.token && next.origin !== config.origin) throw new Error('disconnect_before_changing_service');
    const capabilities = capabilityList(next.capabilities);
    if (!capabilities.length) { setMessage('허용할 권한을 하나 이상 선택해 주세요.'); return state(); }
    if (next.capabilities.files && !next.roots.length) { setMessage('파일 접근을 허용할 폴더를 먼저 선택해 주세요.'); return state(); }
    if (!await encryptionAvailable()) { storageAvailable = false; setMessage('운영체제 암호 저장소를 사용할 수 없어 연결할 수 없습니다.'); return state(); }
    config = next;
    await ensureCloud();
    const session = await request('/api/session', { cookie: true });
    if (!session.user || !session.csrfToken) { showSettings(false); setMessage('먼저 서비스에 로그인한 뒤 상단 연결 설정에서 연결을 허용해 주세요.'); return state(); }
    const ownerLabel = String(session.user.displayName || session.user.display_name || session.user.username || session.user.id).slice(0, 80);
    const consent = await dialog.showMessageBox(window, { type: 'question', title: '이 컴퓨터 연결 허용', message: `${ownerLabel} 계정에 ${next.name}의 실행 권한을 허용할까요?`, detail: consentDetails(next), buttons: ['취소', '선택한 권한으로 연결'], defaultId: 0, cancelId: 0, noLink: true });
    if (consent.response !== 1) return state();
    pause();
    const changed = JSON.stringify(capabilities) !== JSON.stringify(credentials.pairedCapabilities)
      || credentials.device?.userId !== session.user.id;
    if (credentials.token && changed) await revoke();
    // Verify the login again after the native consent dialog before issuing a grant.
    const confirmed = await request('/api/session', { cookie: true });
    if (confirmed.user?.id !== session.user.id || !confirmed.csrfToken) throw new Error('account_changed');
    if (!credentials.token) {
      const registered = await request('/api/local-computers', { method: 'POST', cookie: true, csrf: confirmed.csrfToken, body: { name: config.name, platform: process.platform, capabilities } });
      if (!registered.device?.id || registered.device.userId !== session.user.id || typeof registered.token !== 'string') throw new Error('invalid_registration');
      credentials = { token: registered.token, pairedOrigin: config.origin, device: registered.device, ownerLabel, seenJobs: [], outbox: [], pairedCapabilities: capabilities };
    } else credentials.ownerLabel = ownerLabel;
    await persist();
    storageAvailable = true;
    enabled = true;
    setMessage('연결됨 · 이 컴퓨터에서 요청을 기다리고 있습니다.');
    showSettings(false);
    void poll();
    return state();
  } finally { connecting = false; notify(); }
}

function handle(channel, callback) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event, window.webContents, localPage)) throw new Error('untrusted_sender');
    try { return { ok: true, state: await callback(...args) || state() }; }
    catch (error) { setMessage(safeError(error)); return { ok: false, state: state(), error: statusMessage }; }
  });
}

function installIPC() {
  ipcMain.handle('desktop:open-settings', event => {
    if (!cloud || event.sender !== cloud.webContents || event.senderFrame !== cloud.webContents.mainFrame
        || !isSameOriginUrl(event.senderFrame?.url, config.origin)) throw new Error('untrusted_sender');
    showSettings(true);
  });
  handle('desktop:status', () => state());
  handle('desktop:configure', async value => {
    if (enabled || currentJob) throw new Error('pause_before_configuring');
    const next = validateSettings(value);
    if (credentials.token && next.origin !== config.origin) { setMessage('다른 서비스로 바꾸려면 먼저 연결을 해제해 주세요.'); return state(); }
    config = next;
    await persist({ secret: false });
    await ensureCloud();
    showSettings(false);
    return state();
  });
  handle('desktop:folders', async () => {
    if (enabled || currentJob) { setMessage('폴더를 바꾸려면 먼저 연결을 일시정지해 주세요.'); return state(); }
    const selection = await dialog.showOpenDialog(window, { title: '봇이 접근할 폴더 선택', properties: ['openDirectory', 'multiSelections', 'createDirectory'] });
    if (!selection.canceled) { config.roots = await Promise.all(selection.filePaths.map(folder => fs.realpath(folder))); await persist({ secret: false }); }
    return state();
  });
  handle('desktop:connect', connect);
  handle('desktop:pause', pauseConnection);
  handle('desktop:revoke', async () => {
    const result = await dialog.showMessageBox(window, { type: 'question', message: '이 컴퓨터의 연결을 해제할까요?', detail: '서비스에 등록된 실행 권한과 저장된 연결 키를 제거합니다.', buttons: ['취소', '연결 해제'], defaultId: 0, cancelId: 0 });
    if (result.response === 1) await revoke();
    return state();
  });
  handle('desktop:show-app', async () => { if (config.origin) { await ensureCloud(); showSettings(false); } return state(); });
  handle('desktop:show-settings', () => { showSettings(true); return state(); });
  handle('desktop:external', async () => {
    const url = pendingExternal;
    if (!url) return state();
    const answer = await dialog.showMessageBox(window, { type: 'question', message: '기본 브라우저에서 링크를 열까요?', detail: url, buttons: ['취소', '브라우저에서 열기'], defaultId: 0, cancelId: 0 });
    if (answer.response === 1) await shell.openExternal(url);
    pendingExternal = null; return state();
  });
  handle('desktop:permission-settings', async kind => {
    const pages = { files: 'Privacy_AllFiles' };
    if (process.platform === 'darwin' && Object.hasOwn(pages, kind)) await shell.openExternal(`x-apple.systempreferences:com.apple.preference.security?${pages[kind]}`);
    return state();
  });
}

// Do not await app.whenReady() at ESM top level: Electron must finish loading the
// entry module before emitting ready. Show the UI before asking the OS key store.
if (primaryInstance) void app.whenReady().then(async () => {
window = new BrowserWindow({ width: 1240, height: 860, minWidth: 760, minHeight: 620, title: 'CustomCloudBot Desktop', backgroundColor: '#f4f3fa',
  titleBarStyle: 'default',
  webPreferences: { preload: path.join(here, 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, webviewTag: false, navigateOnDragDrop: false }
});
Menu.setApplicationMenu(Menu.buildFromTemplate([{ label: 'CustomCloudBot Desktop', submenu: [{ role: 'about' }, { label: '컴퓨터 연결 설정…', accelerator: 'CmdOrCtrl+,', click: () => showSettings(true) }, { type: 'separator' }, { label: '연결 일시정지', click: () => { void pauseConnection(); } }, { role: 'quit' }] }, { role: 'editMenu' }, { role: 'windowMenu' }]));
window.webContents.on('will-navigate', event => event.preventDefault());
window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
window.webContents.on('will-attach-webview', event => event.preventDefault());
window.on('resize', layoutCloud);
window.on('close', event => {
  if (readyToClose) return;
  event.preventDefault();
  if (closing) return;
  closing = true;
  // Keep the main process alive until the executor has killed its process group.
  const work = currentJobPromise;
  void pauseConnection().then(() => work).catch(() => {}).finally(() => { readyToClose = true; window?.close(); });
});
window.on('closed', () => { cloud?.webContents.close(); cloud = null; window = null; app.quit(); });
app.on('before-quit', () => pause());
installIPC();
await window.loadFile(localPage);
setMessage('운영체제 암호 저장소를 확인하고 있습니다.');
try { await loadState(); }
catch { setMessage('저장한 연결을 확인하지 못했습니다. 연결 설정에서 다시 시도해 주세요.'); }
finally { loadingState = false; notify(); }
}).catch(error => { console.error('Desktop startup failed:', error?.code || error?.name || 'unknown'); app.quit(); });
