import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { installationHelp } from '../public/pwa.js';

const source = readFileSync(new URL('../public/pwa.js', import.meta.url), 'utf8').replaceAll('export function ', 'function ');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
function setup({ supported = false, api, requestPermission, url = 'https://bots.example.test/', standalone = false } = {}) {
  const nodes = new Map();
  for (const id of ['install-button', 'auth-install-button', 'push-button', 'test-push-button', 'push-status', 'pwa-dialog', 'pwa-dialog-title', 'pwa-dialog-message']) {
    const classes = new Set(['is-hidden']);
    nodes.set(id, { textContent: '', handlers: {}, attrs: {}, setAttribute(k,v) { this.attrs[k]=v; }, classList: { remove(k) { classes.delete(k); }, toggle(k, on) { on ? classes.add(k) : classes.delete(k); }, contains(k) { return classes.has(k); } }, addEventListener(k, fn) { this.handlers[k] = fn; }, removeEventListener(k) { delete this.handlers[k]; }, showModal() { this.open = true; }, close() { this.open = false; } });
  }
  let session = null;
  const calls = [];
  let subscribed = 0;
  const registration = { pushManager: { getSubscription: async () => null, subscribe: async () => { subscribed++; return { toJSON: () => ({}), unsubscribe: async () => {}, endpoint: 'https://push.example/sub' }; } } };
  const navigator = { userAgent: 'Chrome/140', platform: 'Linux', maxTouchPoints: 0 };
  const navigations = [], opened = [], location = new URL(url);
  location.assign = value => navigations.push(value);
  const window = { location, open(...args) { opened.push(args); return null; }, handlers: {}, isSecureContext: true, matchMedia: () => ({ matches: standalone }), addEventListener(k, fn) { this.handlers[k] = fn; }, removeEventListener(k) { delete this.handlers[k]; } };
  const Notification = { permission: 'default', requestPermission: requestPermission || (async () => { throw Error('unsolicited permission'); }) };
  if (supported) { navigator.serviceWorker = { register: async () => registration, ready: Promise.resolve(registration) }; window.PushManager = {}; window.Notification = Notification; }
  const context = { URL, navigator, window, Notification, document: { querySelector: (selector) => nodes.get(selector.slice(1)) }, Uint8Array, atob: (v) => Buffer.from(v, 'base64').toString('binary') };
  vm.runInNewContext(source + '\nthis.createPwaController = createPwaController;', context);
  const controller = context.createPwaController({ api: async (...args) => { calls.push(args); return api ? api(...args) : { configured: true, publicKey: 'AQID' }; }, getSession: () => session, toast() {} });
  return { nodes, window, calls, controller, navigations, opened, get subscribed() { return subscribed; }, setSession(id) { session = id ? { user: { id } } : null; controller.setSession(session); } };
}

test('install action stays visible without beforeinstallprompt and gives honest browser instructions', async () => {
  const app = setup();
  for (const id of ['install-button', 'auth-install-button']) assert.equal(app.nodes.get(id).classList.contains('is-hidden'), false);
  await app.nodes.get('install-button').handlers.click();
  assert.equal(app.nodes.get('pwa-dialog').open, true);
  assert.match(app.nodes.get('pwa-dialog-message').textContent, /Chrome 메뉴/);
  assert.match(installationHelp({ userAgent: 'iPhone' }).message, /홈 화면/);
  assert.match(installationHelp({ userAgent: 'Safari', platform: 'MacIntel' }).message, /Sonoma 14/);
  assert.match(installationHelp({ userAgent: 'Firefox' }).message, /직접 열 수 없어요/);
  assert.equal(app.calls.length, 0);
});

test('install prompt only runs on click once and dismissal keeps the help button', async () => {
  const app = setup();
  let prompts = 0;
  app.window.handlers.beforeinstallprompt({ preventDefault() {}, prompt: async () => { prompts++; }, userChoice: Promise.resolve({ outcome: 'dismissed' }) });
  assert.equal(prompts, 0);
  await app.nodes.get('install-button').handlers.click();
  assert.equal(prompts, 1);
  assert.equal(app.nodes.get('install-button').textContent, '앱으로 만들기');
  await app.nodes.get('install-button').handlers.click();
  assert.equal(prompts, 1);
  app.window.handlers.appinstalled();
  assert.equal(app.nodes.get('install-button').textContent, '앱 설치됨');
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


test('configured app origin changes only the install destination until explicitly clicked', async () => {
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
  }
  assert.deepEqual(app.navigations, ['https://192.0.2.10/?install=1', 'https://192.0.2.10/?install=1']);
  assert.deepEqual(app.opened, [], 'regular browser installation keeps same-window navigation');
  assert.equal(prompts, 0, 'a deferred domain install prompt must not be used for the IP app');
  assert.equal(app.calls.length, 0);
});

test('alternate-origin installation preserves standalone scope but navigates a regular browser after appinstalled', async () => {
  for (const standalone of [false, true]) {
    const url = 'https://bots.example.test/?room=private-room#invite=private-token';
    const app = setup({ standalone, url });
    if (!standalone) app.window.handlers.appinstalled();
    assert.equal(app.nodes.get('install-button').disabled, true);
    app.controller.setAppOrigin('https://192.0.2.10');
    assert.deepEqual(app.navigations, [], 'setting configuration must never redirect an installed app');
    assert.deepEqual(app.opened, [], 'setting configuration must not open another window');
    assert.equal(app.nodes.get('install-button').disabled, false);
    assert.equal(app.nodes.get('install-button').textContent, '앱으로 만들기');
    for (const id of ['install-button', 'auth-install-button']) await app.nodes.get(id).handlers.click();
    if (standalone) {
      assert.deepEqual(app.navigations, [], 'a null window.open result must never fall back to leaving app scope');
      assert.equal(app.window.location.href, url);
      assert.deepEqual(app.opened, Array.from({length: 2}, () => ['https://192.0.2.10/?install=1', '_blank', 'noopener,noreferrer']));
    } else {
      assert.deepEqual(app.navigations, ['https://192.0.2.10/?install=1', 'https://192.0.2.10/?install=1']);
      assert.deepEqual(app.opened, []);
    }
    assert.equal(app.calls.length, 0);
  }
});

test('same-origin installed apps keep install disabled without navigation or OS prompts', async () => {
  for (const standalone of [false, true]) {
    const app = setup({ url: 'https://192.0.2.10/?room=example', standalone });
    if (!standalone) app.window.handlers.appinstalled();
    app.controller.setAppOrigin('https://192.0.2.10');
    for (const id of ['install-button', 'auth-install-button']) {
      assert.equal(app.nodes.get(id).disabled, true);
      await app.nodes.get(id).handlers.click();
    }
    assert.deepEqual(app.navigations, []);
    assert.deepEqual(app.opened, []);
    assert.equal(app.nodes.get('pwa-dialog').open, undefined);
    assert.equal(app.calls.length, 0);
  }
});

test('malformed or non-HTTPS app origins are cleared and cannot become navigation destinations', async () => {
  for (const value of [undefined, null, '', 'not a URL', '/relative', '//192.0.2.10', 'http://192.0.2.10', 'javascript:alert(1)', 'https://name:password@192.0.2.10', 'https://192.0.2.10/', 'https://192.0.2.10/path', 'https://192.0.2.10?redirect=https://other.example', 'https://192.0.2.10#fragment', ' https://192.0.2.10']) {
    const app = setup();
    app.controller.setAppOrigin('https://192.0.2.10');
    app.controller.setAppOrigin(value);
    await app.nodes.get('install-button').handlers.click();
    assert.deepEqual(app.navigations, [], String(value));
    assert.equal(app.nodes.get('pwa-dialog').open, true, String(value));
  }
});

test('the explicit IP installation page shows browser help once without triggering installation', () => {
  const app = setup({ url: 'https://192.0.2.10/?install=1' });
  app.controller.setAppOrigin('https://192.0.2.10');
  assert.equal(app.nodes.get('pwa-dialog').open, true);
  assert.match(app.nodes.get('pwa-dialog-message').textContent, /Chrome 메뉴/);
  app.nodes.get('pwa-dialog').close();
  app.controller.setAppOrigin('https://192.0.2.10');
  assert.equal(app.nodes.get('pwa-dialog').open, false);
  assert.deepEqual(app.navigations, []);
  assert.equal(app.calls.length, 0);
});

test('an installed app reopened at its install URL does not offer reinstallation', async () => {
  const app = setup({ url: 'https://192.0.2.10/?install=1', standalone: true });
  let prompts = 0;
  app.window.handlers.beforeinstallprompt({ preventDefault() {}, prompt: async () => { prompts++; }, userChoice: Promise.resolve({ outcome: 'accepted' }) });
  for (let i = 0; i < 2; i++) app.controller.setAppOrigin('https://192.0.2.10');
  for (const id of ['install-button', 'auth-install-button']) {
    assert.equal(app.nodes.get(id).disabled, true);
    await app.nodes.get(id).handlers.click();
  }
  assert.equal(app.nodes.get('pwa-dialog').open, undefined);
  assert.equal(prompts, 0);
  assert.deepEqual(app.navigations, []);
  assert.deepEqual(app.opened, []);
  assert.equal(app.calls.length, 0);
});
