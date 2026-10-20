import test from 'node:test';
import assert from 'node:assert/strict';
import {createLoginRequestUI} from '../public/browser-logins.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const timestamp = 1792454400000;
const pending = {id:'request-1', roomId:'room-1', origin:'https://accounts.example.com', siteLabel:'Example', status:'pending', expiresAt:timestamp + 600_000};
const account = {id:'account-1', label:'Work', maskedUsername:'m***@example.com'};

class Element extends EventTarget {
  constructor(tag) {
    super(); this.tagName = tag; this.children = []; this.attributes = {}; this.value = ''; this.checked = false; this.disabled = false; this.hidden = false; this.open = false; this._text = '';
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  append(...children) { children.forEach(child => {child.parent = this; this.children.push(child);}); }
  replaceChildren(...children) { this._text = ''; this.children = []; this.append(...children); }
  setAttribute(name, value) { this.attributes[name] = value; }
  querySelectorAll(tag) { return this.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...child.querySelectorAll(tag)]); }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event('close')); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(child => child !== this); }
}
function fixture(t, {api, current = {userId:'owner-1', roomId:'room-1', isOwner:true}, detail = {...pending, accounts:[account]}} = {}) {
  const document = {body:new Element('body'), createElement:tag => new Element(tag)};
  const calls = [], notifications = [], resolved = [], toasts = [];
  const f = {document, current, calls, notifications, resolved, toasts};
  const ui = createLoginRequestUI({
    document, now:() => timestamp, getContext:() => f.current,
    api:async (path, options = {}) => {
      calls.push({path, options});
      return api ? api(path, options) : options.method === 'POST' ? {status:'filled'} : detail;
    },
    onPendingChange:value => notifications.push(value), onResolved:value => resolved.push(value), toast:value => toasts.push(value),
  });
  f.ui = ui;
  f.find = (tag, predicate = () => true) => document.body.querySelectorAll(tag).find(predicate);
  f.input = name => f.find('input', input => input.name === name);
  f.choice = value => f.find('input', input => input.type === 'radio' && input.value === value);
  f.change = (input, checked = true) => { input.checked = checked; input.dispatchEvent(new Event('change')); };
  f.submit = async () => { f.find('form').dispatchEvent(new Event('submit', {cancelable:true})); await flush(); };
  f.show = async (requests = [pending]) => {ui.sync(requests); await flush();};
  t.after(() => ui.destroy());
  return f;
}

test('only current owner and room can display server pending requests', async t => {
  const f = fixture(t, {current:{userId:'member-1', roomId:'room-1', isOwner:false}});
  await f.show();
  assert.equal(f.calls.length, 0);
  assert.equal(f.find('dialog'), undefined);
  f.current = {userId:'owner-1', roomId:'other-room', isOwner:true};
  await f.show();
  assert.equal(f.calls.length, 0);
  assert.equal(f.notifications.at(-1).count, 0);
});

test('one automatic prompt per request, with manual reopening after dismissal', async t => {
  const f = fixture(t);
  await f.show();
  assert.equal(f.find('dialog').open, true);
  assert.match(f.document.body.textContent, /https:\/\/accounts.example.com/);
  assert.match(f.document.body.textContent, /m\*\*\*@example.com/);
  f.find('dialog').dispatchEvent(new Event('cancel', {cancelable:true}));
  await f.show();
  assert.equal(f.calls.length, 1);
  assert.equal(f.find('dialog').open, false);
  await f.ui.open();
  assert.equal(f.calls.length, 2);
  assert.equal(f.find('dialog').open, true);
});

test('credentials cannot be sent without both an explicit account selection and shared-PC confirmation', async t => {
  const f = fixture(t);
  await f.show(); await f.submit();
  f.change(f.choice(`saved:${account.id}`)); await f.submit();
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 0);
  f.change(f.input('sharedDeviceConfirmed')); await f.submit();
  const post = f.calls.find(call => call.options.method === 'POST');
  assert.equal(post.path, '/api/browser-logins/request-1/resolve');
  assert.deepEqual(JSON.parse(post.options.body), {accountId:account.id, sharedDeviceConfirmed:true});
  assert.deepEqual(f.resolved, [{requestId:pending.id, roomId:pending.roomId, status:'filled'}]);
  assert.match(f.toasts[0], /브라우저에서 로그인·추가 인증/);
});

test('new credentials are cleared before the POST and never copied into notifications or success UI', async t => {
  let f, release;
  f = fixture(t, {api:async (path, options) => {
    if (options.method !== 'POST') return {...pending, accounts:[]};
    assert.equal(f.input('password').value, '');
    assert.equal(f.input('username').value, '');
    return new Promise(resolve => { release = resolve; });
  }});
  await f.show();
  f.input('label').value = 'Personal';
  f.input('username').value = ' me@example.com ';
  f.input('password').value = ' secret with spaces ';
  f.change(f.input('sharedDeviceConfirmed')); await f.submit();
  const post = f.calls.find(call => call.options.method === 'POST');
  assert.deepEqual(JSON.parse(post.options.body), {action:'save', username:'me@example.com', password:' secret with spaces ', label:'Personal', sharedDeviceConfirmed:true});
  assert.equal(f.find('fieldset').disabled, true);
  assert.equal(f.input('password').value, '');
  release({status:'filled', password:'this should never be rendered'}); await flush();
  assert.equal(f.find('dialog').open, false);
  assert.equal(JSON.stringify([...f.notifications, ...f.resolved, ...f.toasts]).includes('secret'), false);
  assert.equal(f.document.body.textContent.includes('this should never be rendered'), false);
});

test('raw server errors cannot echo a password and failed saves require a new selection and confirmation', async t => {
  const f = fixture(t, {api:async (path, options) => {
    if (options.method !== 'POST') return {...pending, accounts:[]};
    throw new Error('password secret-123 has failed');
  }});
  await f.show();
  f.input('username').value = 'name'; f.input('password').value = 'secret-123';
  f.change(f.input('sharedDeviceConfirmed')); await f.submit();
  assert.equal(f.document.body.textContent.includes('secret-123'), false);
  assert.equal(f.input('password').value, '');
  assert.equal(f.input('sharedDeviceConfirmed').checked, false);
  await f.submit();
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 1);
});

test('logout closes and clears the form, aborts its request and suppresses late callbacks', async t => {
  let release;
  const f = fixture(t, {api:async (path, options) => options.method !== 'POST' ? {...pending, accounts:[]} : new Promise(resolve => {release = resolve;})});
  await f.show();
  const password = f.input('password');
  f.input('username').value = 'name'; password.value = 'private';
  f.change(f.input('sharedDeviceConfirmed')); await f.submit();
  const post = f.calls.find(call => call.options.method === 'POST');
  f.current = null; f.ui.reset();
  assert.equal(password.value, '');
  assert.equal(f.find('dialog').open, false);
  assert.equal(post.options.signal.aborted, true);
  release({status:'filled'}); await flush();
  assert.deepEqual(f.resolved, []);
  assert.deepEqual(f.toasts, []);
});

test('room or actor changes invalidate delayed account lists', async t => {
  let release;
  const f = fixture(t, {api:async () => new Promise(resolve => {release = resolve;})});
  await f.show();
  f.current = {...f.current, roomId:'room-2'};
  f.ui.sync([pending]); release({...pending, accounts:[account]}); await flush();
  assert.equal(f.find('dialog').open, false);
  assert.equal(f.find('form'), undefined);
  assert.equal(f.calls[0].options.signal.aborted, true);
});

test('untrusted or changed origin is never accepted for a saved account', async t => {
  const f = fixture(t, {detail:{...pending, origin:'https://other.example', accounts:[account]}});
  await f.show();
  assert.equal(f.find('form'), undefined);
  assert.equal(f.find('input'), undefined);
  const invalid = fixture(t);
  await invalid.show([{...pending, origin:'http://example.com'}, {...pending, origin:'https://example.com@evil.example'}, {...pending, expiresAt:timestamp - 1}]);
  assert.equal(invalid.calls.length, 0);
});

test('request metadata and account labels are rendered as text only', async t => {
  const attack = '<img src=x onerror=alert(1)>';
  const request = {...pending, siteLabel:attack};
  const f = fixture(t, {detail:{...request, accounts:[{...account, label:attack, password:'unexpected response secret'}]}});
  await f.show([request]);
  assert.equal(f.document.body.textContent.includes(attack), true);
  assert.equal(f.find('img'), undefined);
  assert.equal(f.document.body.textContent.includes('unexpected response secret'), false);
});

test('cancellation clears entered credentials and sends only a DELETE', async t => {
  const f = fixture(t, {detail:{...pending, accounts:[]}});
  await f.show();
  const password = f.input('password'); password.value = 'private';
  f.find('button', button => button.textContent === '요청 취소').dispatchEvent(new Event('click'));
  await flush();
  const mutation = f.calls.find(call => call.options.method);
  assert.equal(mutation.options.method, 'DELETE');
  assert.equal(mutation.options.body, undefined);
  assert.equal(password.value, '');
  assert.equal(f.find('dialog').open, false);
});

test('a consumed request is cleared on sync and cannot silently reopen', async t => {
  const f = fixture(t);
  await f.show();
  f.ui.sync([]);
  assert.equal(f.find('dialog').open, false);
  assert.equal(f.find('input'), undefined);
  await f.show();
  assert.equal(f.calls.length, 1);
});

test('an owner change without a fresh sync cannot submit another owner’s visible request', async t => {
  const f = fixture(t);
  await f.show();
  f.change(f.choice(`saved:${account.id}`)); f.change(f.input('sharedDeviceConfirmed'));
  f.current = {...f.current, userId:'owner-2'};
  await f.submit();
  assert.equal(f.calls.filter(call => call.options.method === 'POST').length, 0);
});

test('polling filling or consumed state preserves an active submit until its response arrives', async t => {
  let release;
  const f = fixture(t, {api:async (path, options) => options.method !== 'POST' ? {...pending, accounts:[account]} : new Promise(resolve => {release = resolve;})});
  await f.show();
  f.change(f.choice(`saved:${account.id}`)); f.change(f.input('sharedDeviceConfirmed'));
  await f.submit();
  const post = f.calls.find(call => call.options.method === 'POST');
  for (const list of [[{...pending, status:'filling'}], []]) {
    f.ui.sync(list);
    assert.equal(f.find('dialog').open, true);
    assert.equal(post.options.signal.aborted, false);
  }
  release({status:'filled', nextStep:'continue'}); await flush();
  assert.equal(f.find('dialog').open, false);
  assert.match(f.toasts[0], /아이디를 입력했습니다.*다음 단계.*Vault/);
  assert.equal(f.resolved[0].nextStep, 'continue');
});
