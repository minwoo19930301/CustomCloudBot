import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { installationHelp } from '../public/pwa.js';

const source = readFileSync(new URL('../public/pwa.js', import.meta.url), 'utf8').replaceAll('export function ', 'function ');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function setup({ supported = false, api, requestPermission, url = 'https://bots.example.test/', standalone = false, native = false } = {}) {
  const nodes = new Map();
  for (const id of ['install-button', 'auth-install-button', 'push-button', 'test-push-button', 'push-status', 'pwa-dialog', 'pwa-dialog-title', 'pwa-dialog-message', 'app-install-dialog', 'install-pwa-button', 'install-pwa-status', 'install-desktop-link', 'install-desktop-status', 'install-desktop-note']) {
    const classes = new Set(['is-hidden']);
    nodes.set(id, { textContent: '', handlers: {}, attrs: {}, setAttribute(k,v) { this.attrs[k]=v; }, getAttribute(k) { return this.attrs[k] ?? null; }, removeAttribute(k) { delete this.attrs[k]; }, classList: { add(k) { classes.add(k); }, remove(k) { classes.delete(k); }, toggle(k, on) { on ? classes.add(k) : classes.delete(k); }, contains(k) { return classes.has(k); } }, addEventListener(k, fn) { this.handlers[k] = fn; }, removeEventListener(k) { delete this.handlers[k]; }, showModal() { this.open = true; }, close() { this.open = false; } });
  }
  let session = null;
  const calls = [];
  let subscribed = 0;
  const registration = { pushManager: { getSubscription: async () => null, subscribe: async () => { subscribed++; return { toJSON: () => ({}), unsubscribe: async () => {}, endpoint: 'https://push.example/sub' }; } } };
  const navigator = { userAgent: 'Chrome/140', platform: 'Linux', maxTouchPoints: 0 };
  const navigations = [], opened = [], location = new URL(url);
  location.assign = value => navigations.push(value);
  const window = { location, open(...args) { opened.push(args); return null; }, handlers: {}, isSecureContext: true, matchMedia: () => ({ matches: standalone }), addEventListener(k, fn) { this.handlers[k] = fn; }, removeEventListener(k) { delete this.handlers[k]; } };
  if (native) window.customCloudBotDesktop = { openSettings() {} };
  const Notification = { permission: 'default', requestPermission: requestPermission || (async () => { throw Error('unsolicited permission'); }) };
  if (supported) { navigator.serviceWorker = { register: async () => registration, ready: Promise.resolve(registration) }; window.PushManager = {}; window.Notification = Notification; }
  const context = { URL, navigator, window, Notification, document: { querySelector: (selector) => nodes.get(selector.slice(1)) }, Uint8Array, atob: (v) => Buffer.from(v, 'base64').toString('binary') };
  vm.runInNewContext(source + '\nthis.createPwaController = createPwaController;', context);
  const controller = context.createPwaController({ api: async (...args) => { calls.push(args); return api ? api(...args) : { configured: true, publicKey: 'AQID' }; }, getSession: () => session, toast() {} });
  return { nodes, window, calls, controller, navigations, opened, get subscribed() { return subscribed; }, setSession(id) { session = id ? { user: { id } } : null; controller.setSession(session); } };
}

test('install action opens the two choices, then PWA gives honest browser instructions', async () => {
  const app = setup();
  for (const id of ['install-button', 'auth-install-button']) assert.equal(app.nodes.get(id).classList.contains('is-hidden'), false);
  await app.nodes.get('install-button').handlers.click();
  assert.equal(app.nodes.get('app-install-dialog').open, true);
  assert.equal(app.nodes.get('pwa-dialog').open, undefined);
  await app.nodes.get('install-pwa-button').handlers.click();
  assert.equal(app.nodes.get('app-install-dialog').open, false);
  assert.equal(app.nodes.get('pwa-dialog').open, true);
  assert.match(app.nodes.get('pwa-dialog-message').textContent, /Chrome 메뉴/);
  assert.match(installationHelp({ userAgent: 'iPhone' }).message, /홈 화면/);
  assert.match(installationHelp({ userAgent: 'Safari', platform: 'MacIntel' }).message, /Sonoma 14/);
  assert.match(installationHelp({ userAgent: 'Firefox' }).message, /직접 열 수 없어요/);
  assert.deepEqual(app.calls.map(([path]) => path), ['/api/desktop/downloads']);
});

test('install prompt only runs on click once and dismissal keeps the help button', async () => {
  const app = setup();
  let prompts = 0;
  app.window.handlers.beforeinstallprompt({ preventDefault() {}, prompt: async () => { prompts++; }, userChoice: Promise.resolve({ outcome: 'dismissed' }) });
  assert.equal(prompts, 0);
  await app.nodes.get('install-button').handlers.click();
  assert.equal(prompts, 0, 'opening choices must not trigger an OS prompt');
  await app.nodes.get('install-pwa-button').handlers.click();
  assert.equal(prompts, 1);
  assert.equal(app.nodes.get('install-button').textContent, '앱 받기');
  await app.nodes.get('install-button').handlers.click();
  await app.nodes.get('install-pwa-button').handlers.click();
  assert.equal(prompts, 1);
  app.window.handlers.appinstalled();
  assert.equal(app.nodes.get('install-button').disabled, false);
  assert.equal(app.nodes.get('install-pwa-status').textContent, 'PWA 설치됨');
  assert.equal(app.nodes.get('install-pwa-button').disabled, true);
});

test('stale config and permission responses cannot subscribe after account change', async () => {
  const first = deferred();
  let configs = 0;
  const app = setup({ supported: true, api: async () => ++configs === 1 ? first.promise : { configured: false } });
  app.setSession('one');
  app.setSession('two');
  await tick();
  first.resolve({ configured: true, publicKey: 'AQID' });
  await tick();
  await app.nodes.get('push-button').handlers.click();
  assert.equal(app.subscribed, 0);
  assert.equal(app.calls.some(([path]) => path === '/api/push/subscriptions'), false);
  const permission = deferred();
  const pending = setup({ supported: true, requestPermission: () => permission.promise });
  pending.setSession('one');
  await tick();
  const enable = pending.nodes.get('push-button').handlers.click();
  pending.setSession(null);
  permission.resolve('granted');
  await enable;
  assert.equal(pending.subscribed, 0);
  assert.equal(pending.calls.some(([path]) => path === '/api/push/subscriptions'), false);
});

test('unsupported browser retains notification guidance without sending a test push', async () => {
  const app = setup();
  app.setSession('one');
  assert.equal(app.nodes.get('push-button').classList.contains('is-hidden'), false);
  assert.equal(app.nodes.get('test-push-button').classList.contains('is-hidden'), true);
  await app.nodes.get('push-button').handlers.click();
  assert.match(app.nodes.get('pwa-dialog-message').textContent, /앱 안의 알림함/);
  assert.equal(app.calls.length, 0);
});


test('legacy app origin never redirects current-domain installation or discards its prompt', async () => {
  const app = setup({ url: 'https://bots.example.test/?room=private-room#invite=private-token' });
  let prompts = 0;
  app.window.handlers.beforeinstallprompt({ preventDefault() {}, prompt: async () => { prompts++; }, userChoice: Promise.resolve({ outcome: 'accepted' }) });
  assert.equal(app.controller.setAppOrigin('https://192.0.2.10'), false);
  assert.deepEqual(app.navigations, []);
  assert.equal(prompts, 0);
  assert.equal(app.nodes.get('pwa-dialog').open, undefined);
  for (const id of ['install-button', 'auth-install-button']) {
    assert.equal(app.nodes.get(id).disabled, false);
    await app.nodes.get(id).handlers.click();
    await app.nodes.get('install-pwa-button').handlers.click();
  }
  assert.deepEqual(app.navigations, []);
  assert.deepEqual(app.opened, []);
  assert.equal(prompts, 1, 'the current domain install prompt is preserved');
  assert.equal(app.window.location.href, 'https://bots.example.test/?room=private-room#invite=private-token');
  assert.match(app.nodes.get('pwa-dialog-message').textContent, /현재 열어 둔 주소\(https:\/\/bots\.example\.test\)/);
  assert.doesNotMatch(app.nodes.get('pwa-dialog-message').textContent, /192\.0\.2\.10|private-room|private-token/);
  assert.deepEqual(app.calls.map(([path]) => path), ['/api/desktop/downloads', '/api/desktop/downloads']);
});

test('already installed PWA keeps desktop download available without reinstalling or navigating', async () => {
  for (const standalone of [false, true]) {
    const url = 'https://bots.example.test/?room=private-room#invite=private-token';
    const app = setup({ standalone, url });
    if (!standalone) app.window.handlers.appinstalled();
    assert.equal(app.nodes.get('install-button').disabled, false);
    app.controller.setAppOrigin('https://192.0.2.10');
    assert.deepEqual(app.navigations, [], 'setting configuration must never redirect an installed app');
    assert.deepEqual(app.opened, [], 'setting configuration must not open another window');
    assert.equal(app.nodes.get('install-pwa-button').disabled, true);
    assert.equal(app.nodes.get('install-pwa-status').textContent, standalone ? 'PWA로 사용 중' : 'PWA 설치됨');
    for (const id of ['install-button', 'auth-install-button']) {
      await app.nodes.get(id).handlers.click();
      await app.nodes.get('install-pwa-button').handlers.click();
    }
    assert.equal(app.nodes.get('app-install-dialog').open, true);
    assert.deepEqual(app.navigations, []);
    assert.equal(app.window.location.href, url);
    assert.deepEqual(app.opened, []);
    assert.deepEqual(app.calls.map(([path]) => path), ['/api/desktop/downloads', '/api/desktop/downloads']);
  }
});

test('same-origin installed apps only disable PWA without navigation or OS prompts', async () => {
  for (const standalone of [false, true]) {
    const app = setup({ url: 'https://192.0.2.10/?room=example', standalone });
    if (!standalone) app.window.handlers.appinstalled();
    app.controller.setAppOrigin('https://192.0.2.10');
    for (const id of ['install-button', 'auth-install-button']) {
      assert.equal(app.nodes.get(id).disabled, false);
      await app.nodes.get(id).handlers.click();
      assert.equal(app.nodes.get('install-pwa-button').disabled, true);
      await app.nodes.get('install-pwa-button').handlers.click();
    }
    assert.deepEqual(app.navigations, []);
    assert.deepEqual(app.opened, []);
    assert.equal(app.nodes.get('pwa-dialog').open, undefined);
    assert.equal(app.nodes.get('app-install-dialog').open, true);
  }
});

test('legacy app origin values cannot become installation navigation destinations', async () => {
  for (const value of [undefined, null, '', 'not a URL', '/relative', '//192.0.2.10', 'http://192.0.2.10', 'javascript:alert(1)', 'https://name:password@192.0.2.10', 'https://192.0.2.10/', 'https://192.0.2.10/path', 'https://192.0.2.10?redirect=https://other.example', 'https://192.0.2.10#fragment', ' https://192.0.2.10']) {
    const app = setup();
    app.controller.setAppOrigin('https://192.0.2.10');
    app.controller.setAppOrigin(value);
    await app.nodes.get('install-button').handlers.click();
    assert.deepEqual(app.navigations, [], String(value));
    assert.equal(app.nodes.get('app-install-dialog').open, true, String(value));
  }
});

test('the current-domain installation page shows choices once even with a legacy IP origin', async () => {
  const app = setup({ url: 'https://bots.example.test/?install=1' });
  app.controller.setAppOrigin('https://192.0.2.10');
  assert.equal(app.nodes.get('app-install-dialog').open, true);
  await app.nodes.get('install-pwa-button').handlers.click();
  assert.match(app.nodes.get('pwa-dialog-message').textContent, /Chrome 메뉴/);
  assert.match(app.nodes.get('pwa-dialog-message').textContent, /https:\/\/bots\.example\.test/);
  assert.doesNotMatch(app.nodes.get('pwa-dialog-message').textContent, /192\.0\.2\.10/);
  app.nodes.get('pwa-dialog').close();
  app.controller.setAppOrigin('https://192.0.2.10');
  assert.equal(app.nodes.get('pwa-dialog').open, false);
  assert.deepEqual(app.navigations, []);
  assert.deepEqual(app.calls.map(([path]) => path), ['/api/desktop/downloads']);
});

test('an installed app reopened at its install URL does not offer reinstallation', async () => {
  const app = setup({ url: 'https://192.0.2.10/?install=1', standalone: true });
  let prompts = 0;
  app.window.handlers.beforeinstallprompt({ preventDefault() {}, prompt: async () => { prompts++; }, userChoice: Promise.resolve({ outcome: 'accepted' }) });
  for (let i = 0; i < 2; i++) app.controller.setAppOrigin('https://192.0.2.10');
  for (const id of ['install-button', 'auth-install-button']) {
    assert.equal(app.nodes.get(id).disabled, false);
    await app.nodes.get(id).handlers.click();
    await app.nodes.get('install-pwa-button').handlers.click();
  }
  assert.equal(app.nodes.get('pwa-dialog').open, undefined);
  assert.equal(prompts, 0);
  assert.deepEqual(app.navigations, []);
  assert.deepEqual(app.opened, []);
  assert.deepEqual(app.calls.map(([path]) => path), ['/api/desktop/downloads', '/api/desktop/downloads']);
});

const desktopRelease = { platform: 'macos', arch: 'arm64', label: 'Mac · Apple Silicon', version: '0.1.0', url: 'https://downloads.example.test/desktop-mac-arm64.zip', notarized: false };

test('desktop choice exposes the real HTTPS download and its Mac signing status', async () => {
  const app = setup({ api: async () => ({ downloads: [desktopRelease] }) });
  await app.nodes.get('auth-install-button').handlers.click();
  const link = app.nodes.get('install-desktop-link');
  assert.equal(link.getAttribute('href'), desktopRelease.url);
  assert.equal(link.getAttribute('aria-disabled'), 'false');
  assert.equal(link.tabIndex, 0);
  assert.match(app.nodes.get('install-desktop-status').textContent, /Mac · Apple Silicon · v0\.1\.0/);
  assert.equal(app.nodes.get('install-desktop-note').hidden, false);
  assert.match(app.nodes.get('install-desktop-note').textContent, /Apple 공증 전/);
  let prevented = false;
  link.handlers.click({ preventDefault() { prevented = true; } });
  assert.equal(prevented, false, 'an available release follows a normal user-activated link');
  assert.deepEqual(app.navigations, [], 'opening the chooser must not download or navigate');
});

test('a notarized release does not show the initial-version warning', async () => {
  const app = setup({ api: async () => ({ downloads: [{ ...desktopRelease, notarized: true }] }) });
  await app.nodes.get('install-button').handlers.click();
  assert.equal(app.nodes.get('install-desktop-note').hidden, true);
});

test('unavailable or unsafe desktop URLs never become actionable links', async () => {
  for (const url of ['', 'javascript:alert(1)', 'http://downloads.example.test/app.zip', '/app.zip', 'https://user:secret@downloads.example.test/app.zip']) {
    const app = setup({ api: async () => ({ downloads: [{ ...desktopRelease, url }] }) });
    await app.nodes.get('install-button').handlers.click();
    const link = app.nodes.get('install-desktop-link');
    assert.equal(link.getAttribute('href'), null, url);
    assert.equal(link.getAttribute('aria-disabled'), 'true');
    let prevented = false;
    link.handlers.click({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
    assert.match(app.nodes.get('install-desktop-status').textContent, /아직 준비 중/);
  }
});

test('metadata failure clears a previous release and leaves PWA installation usable', async () => {
  let calls = 0;
  const app = setup({ api: async () => { if (++calls === 1) return { downloads: [desktopRelease] }; throw Error('offline'); } });
  await app.nodes.get('install-button').handlers.click();
  assert.equal(app.nodes.get('install-desktop-link').getAttribute('href'), desktopRelease.url);
  await app.nodes.get('install-button').handlers.click();
  assert.equal(app.nodes.get('install-desktop-link').getAttribute('href'), null);
  assert.match(app.nodes.get('install-desktop-status').textContent, /불러오지 못했습니다/);
  assert.equal(app.nodes.get('install-pwa-button').disabled, false);
  await app.nodes.get('install-pwa-button').handlers.click();
  assert.equal(app.nodes.get('pwa-dialog').open, true);
});

test('stale download metadata cannot replace a newer selection or survive controller destruction', async () => {
  const first = deferred();
  let calls = 0;
  const app = setup({ api: async () => ++calls === 1 ? first.promise : { downloads: [] } });
  const pending = app.nodes.get('install-button').handlers.click();
  await app.nodes.get('auth-install-button').handlers.click();
  first.resolve({ downloads: [desktopRelease] });
  await pending;
  assert.equal(app.nodes.get('install-desktop-link').getAttribute('href'), null);
  const late = deferred();
  const destroyed = setup({ api: () => late.promise });
  const loading = destroyed.nodes.get('install-button').handlers.click();
  destroyed.controller.destroy();
  late.resolve({ downloads: [desktopRelease] });
  await loading;
  assert.equal(destroyed.nodes.get('install-desktop-link').getAttribute('href'), null);
  assert.equal(destroyed.nodes.get('install-pwa-button').handlers.click, undefined);
});

test('native desktop shell does not offer installation again', () => {
  const app = setup({ native: true });
  for (const id of ['install-button', 'auth-install-button']) {
    assert.equal(app.nodes.get(id).hidden, true);
    assert.equal(app.nodes.get(id).classList.contains('is-hidden'), true);
  }
  assert.equal(app.calls.length, 0);
});
