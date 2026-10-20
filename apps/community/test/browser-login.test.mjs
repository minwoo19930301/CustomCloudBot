import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { createBrowserLogin } from '../browser-login.mjs';

const USERNAME = 'private-user@example.com', PASSWORD = 'private-password-fixture';
function pageFixture({ password = true, username = true, href = 'https://accounts.example.com/login', button = 'Log in' } = {}) {
  const context = vm.createContext({ URL, Date });
  vm.runInContext(`
    globalThis.location = ${JSON.stringify({ href, origin: new URL(href).origin, pathname: new URL(href).pathname })};
    globalThis.events = [];
    globalThis.Event = class { constructor(type) { this.type=type; } };
    globalThis.HTMLInputElement = class {
      constructor(type,name,autocomplete) { this.type=type;this.name=name;this.id=name;this.autocomplete=autocomplete;this.isConnected=true;this.disabled=false;this.readOnly=false;this.hidden=false;this._value=''; }
      get value() { return this._value; }
      set value(value) { this._value=value; }
      getAttribute(name) { return name==='autocomplete'?this.autocomplete:null; }
      getBoundingClientRect() { return {width:100,height:30}; }
      dispatchEvent(event) { events.push({name:this.name,type:event.type});globalThis.eventHook?.(this,event); }
    };
    globalThis.getComputedStyle = element => ({display:element.hidden?'none':'block',visibility:'visible'});
    globalThis.form = {action:'/login',getAttribute(name){return name==='action'?this.action:null;},querySelectorAll(){return buttons;}};
    globalThis.buttons = [{type:'submit',innerText:${JSON.stringify(button)},getAttribute(){return null;}}];
    globalThis.inputs = [];
    globalThis.document = {querySelectorAll(selector){return selector==='input'?inputs:buttons;}};
    ${username ? "globalThis.username = new HTMLInputElement('email','email','username');username.form=form;inputs.push(username);" : ''}
    ${password ? "globalThis.password = new HTMLInputElement('password','password','current-password');password.form=form;inputs.push(password);" : ''}
  `, context);
  const handles = [];
  const invoke = (fn, target, args) => {
    context.targetArgument = target; context.extraArgument = args;
    return vm.runInContext(`(${fn.toString()})(targetArgument,extraArgument)`, context);
  };
  const page = {
    url: () => context.location.href, isClosed: () => false,
    async evaluateHandle(fn) {
      const target = vm.runInContext(`(${fn.toString()})()`, context);
      const handle = { disposed: false, async evaluate(callback, args) { return invoke(callback, target, args); }, async dispose() { this.disposed = true; } };
      handles.push(handle); return handle;
    },
  };
  return { page, context, handles, change: source => vm.runInContext(source, context) };
}

function fixture(t, options = {}) {
  const page = pageFixture(options), redactions = [], invalidated = [];
  let current = page.page, time = Date.now(), tail = Promise.resolve();
  const session = {};
  const api = createBrowserLogin({
    enqueue: (_room, work) => { const next = tail.catch(() => {}).then(work); tail = next; return next; },
    pageFor: async () => ({ page: current, session }),
    assertSafeUrl: async value => value,
    redact: (_session, values) => redactions.push(values),
    invalidate: async value => invalidated.push(value),
    now: () => time,
  });
  t.after(() => api.close());
  const fill = target => api.fillLogin({ roomId: 'room', ...target, username: USERNAME, password: PASSWORD, authorize: async () => {} });
  return { api, ...page, fill, redactions, invalidated, setPage: value => { current = value; }, advance: ms => { time += ms; } };
}

test('private capture binds exact login nodes; filling never clicks, submits or returns secrets', async t => {
  const f = fixture(t), target = await f.api.captureLoginTarget('room');
  assert.equal(target.origin, 'https://accounts.example.com');
  assert.equal(target.siteLabel, 'accounts.example.com');
  const result = await f.fill(target);
  assert.deepEqual(result, { status: 'filled', nextStep: 'submit' });
  assert.equal(f.context.username.value, USERNAME);
  assert.equal(f.context.password.value, PASSWORD);
  assert.ok(f.context.events.every(event => ['input', 'change'].includes(event.type)));
  assert.deepEqual(f.redactions, [[USERNAME, PASSWORD]]);
  assert.equal(f.invalidated.length, 1);
  assert.equal(f.handles[0].disposed, true);
  assert.ok(!JSON.stringify({ target, result }).includes(PASSWORD));
  await assert.rejects(f.fill(target), { code: 'LOGIN_TARGET_CHANGED' });
});

test('username-only sign-in is supported and explicitly needs another step', async t => {
  const f = fixture(t, { password: false, button: 'Continue' }), target = await f.api.captureLoginTarget('room');
  assert.deepEqual(await f.fill(target), { status: 'filled', nextStep: 'continue' });
  assert.equal(f.context.username.value, USERNAME);
});

test('email settings and unknown forms do not count as login requests', async t => {
  const f = fixture(t, { password: false, href: 'https://accounts.example.com/settings', button: 'Save' });
  f.change("username.autocomplete='email';form.action='/settings';");
  await assert.rejects(f.api.captureLoginTarget('room'), { code: 'LOGIN_FORM_UNSUPPORTED' });
});

test('registration, new passwords, multiple passwords and cross-origin form destinations are rejected', async t => {
  for (const change of [
    "password.autocomplete='new-password';",
    "password.name='confirmPassword';",
    "const extra=new HTMLInputElement('password','repeat','');extra.form=form;inputs.push(extra);",
    "buttons[0].innerText='Create account';",
    "form.action='/signup';",
    "form.action='https://other.example.com/login';",
    "buttons[0].getAttribute=name=>name==='formaction'?'https://other.example.com/login':null;",
    "const unknown=new HTMLInputElement('text','verification_code','');unknown.form=form;inputs.push(unknown);",
  ]) {
    const f = fixture(t); f.change(change);
    await assert.rejects(f.api.captureLoginTarget('room'), { code: 'LOGIN_FORM_UNSUPPORTED' }, change);
    assert.equal(f.context.password.value, '');
  }
});

test('changing tab, exact URL, form destination or DOM fields after capture prevents password entry', async t => {
  for (const mutation of ['tab', 'url', 'form', 'node', 'type', 'extra']) {
    const f = fixture(t), target = await f.api.captureLoginTarget('room');
    if (mutation === 'tab') f.setPage(pageFixture().page);
    if (mutation === 'url') f.change("location.href='https://accounts.example.com/other';location.pathname='/other';");
    if (mutation === 'form') f.change("form.action='https://evil.example.com/login';");
    if (mutation === 'node') f.change("password.isConnected=false;inputs=inputs.filter(input=>input!==password);const replacement=new HTMLInputElement('password','password','current-password');replacement.form=form;inputs.push(replacement);");
    if (mutation === 'type') f.change("password.type='text';");
    if (mutation === 'extra') f.change("const extra=new HTMLInputElement('password','other','');extra.form=form;inputs.push(extra);");
    await assert.rejects(f.fill(target), { code: 'LOGIN_TARGET_CHANGED' }, mutation);
    assert.equal(f.context.password.value, '', mutation);
    assert.equal(f.context.username.value, '', mutation);
  }
});

test('username input events that change the page or password controls cannot receive the password', async t => {
  for (const effect of [
    "form.action='https://evil.example.com/login';",
    "password.type='text';",
    "location.href='https://evil.example.com/login';location.origin='https://evil.example.com';",
    "password.isConnected=false;inputs=inputs.filter(input=>input!==password);",
  ]) {
    const f = fixture(t), target = await f.api.captureLoginTarget('room');
    f.change(`eventHook=(element,event)=>{if(element===username&&event.type==='input'){${effect}}};`);
    await assert.rejects(f.fill(target), { code: 'LOGIN_TARGET_CHANGED' });
    assert.equal(f.context.username.value, USERNAME);
    assert.equal(f.context.password.value, '');
  }
});

test('another room or origin cannot reuse a captured tab', async t => {
  const f = fixture(t), target = await f.api.captureLoginTarget('room');
  await assert.rejects(f.api.fillLogin({ roomId: 'other', ...target, username: USERNAME, password: PASSWORD, authorize: async () => {} }), { code: 'LOGIN_TARGET_CHANGED' });
  await assert.rejects(f.fill({ ...target, origin: 'https://evil.example.com' }), { code: 'LOGIN_TARGET_CHANGED' });
  assert.equal(f.context.password.value, '');
});

test('authorization and cancellation are checked inside the shared operation queue', async t => {
  const f = fixture(t), target = await f.api.captureLoginTarget('room');
  let checks = 0;
  await assert.rejects(f.api.fillLogin({ roomId: 'room', ...target, username: USERNAME, password: PASSWORD, authorize: async () => {
    if (++checks === 2) throw new Error('Logged out');
  } }), { code: 'LOGIN_TARGET_CHANGED' });
  assert.equal(checks, 2); assert.equal(f.context.password.value, '');
  const next = await f.api.captureLoginTarget('room'), controller = new AbortController(); controller.abort();
  await assert.rejects(f.api.fillLogin({ roomId: 'room', ...next, username: USERNAME, password: PASSWORD, signal: controller.signal, authorize: async () => {} }), { name: 'AbortError' });
  assert.equal(f.context.password.value, '');
});

test('expired captures are disposed and cannot fill a password', async t => {
  const f = fixture(t), target = await f.api.captureLoginTarget('room'); f.advance(600001);
  await assert.rejects(f.fill(target), { code: 'LOGIN_TARGET_CHANGED' });
  assert.equal(f.handles[0].disposed, true); assert.equal(f.context.password.value, '');
});
