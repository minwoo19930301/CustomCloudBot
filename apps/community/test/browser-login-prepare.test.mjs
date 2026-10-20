import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {createBrowserLogin} from '../browser-login.mjs';

const NAVER = 'https://naver.com/';
const SIGN_IN = 'https://nid.naver.com/nidlogin.login?mode=form';
const OLD = 'https://accounts.example.com/login';
const anchor = (href = SIGN_IN, label = 'NAVER 로그인', extra = {}) => ({href, label, ...extra});
function fixture(t, {initial = OLD, pages = {}, deny = () => false, onCheck, afterGoto} = {}) {
  const states = new Map(), navigations = [], clicks = [], checks = [], enqueues = [], disposals = [];
  const definitions = {[OLD]:{form:true}, [NAVER]:{anchors:[anchor()]}, [SIGN_IN]:{form:true}, ...pages};
  let active, tail = Promise.resolve(), navigationWaiters = [];
  const setPage = href => {
    if (!states.has(href)) states.set(href, makePage(href, definitions[href] || {}));
    active = states.get(href);
    for (const waiter of navigationWaiters) if (waiter.predicate(new URL(href))) waiter.resolve();
    navigationWaiters = navigationWaiters.filter(waiter => !waiter.predicate(new URL(href)));
  };
  function makePage(href, definition) {
    const context = vm.createContext({URL, Date, move:target => setPage(target), recordClick:value => clicks.push({tag:value.tag, href:value.href})});
    vm.runInContext(`
      globalThis.location = ${JSON.stringify({href, origin:new URL(href).origin, pathname:new URL(href).pathname})};
      globalThis.getComputedStyle = node => ({display:node.hidden?'none':'block',visibility:'visible'});
      globalThis.form = {getAttribute:name=>name==='action'?'/login':null, querySelectorAll:()=>buttons};
      globalThis.buttons = [{type:'submit',innerText:'Log in',getAttribute:()=>null}];
      globalThis.inputs = ${definition.form ? `[
        {type:'email',name:'username',id:'username',autocomplete:'username'},
        {type:'password',name:'password',id:'password',autocomplete:'current-password'}
      ]` : '[]'};
      inputs.forEach(node=>{
        node.form=form; node.isConnected=true; node.getBoundingClientRect=()=>({width:200,height:40});
        node.getAttribute=name=>name==='autocomplete'?node.autocomplete:null;
        Object.defineProperty(node,'value',{get(){throw new Error('Credential values must never be read');}});
      });
      globalThis.anchors = ${JSON.stringify(definition.anchors || [])}.map(spec=>({
        ...spec,tagName:'A',innerText:spec.label,isConnected:true,
        get href(){return new URL(this.rawHref??spec.href,location.href).href;},
        getAttribute(name){return name==='href'?(this.rawHref??spec.href):name==='target'?(spec.target||''):null;},
        hasAttribute:name=>name==='download'&&Boolean(spec.download),
        getBoundingClientRect(){return {width:100,height:24};},
        click(){recordClick({tag:this.tagName,href:this.href});move(spec.redirect||this.href);}
      }));
      globalThis.document={querySelectorAll:selector=>selector==='input'?inputs:selector==='a[href]'?anchors:buttons};
    `, context);
    return context;
  }
  setPage(initial);
  const page = {
    url:() => active.location.href, isClosed:() => false,
    async goto(href) {navigations.push(href); setPage(definitions[href]?.redirect || href); afterGoto?.();},
    waitForURL(predicate) {
      return predicate(new URL(page.url())) ? Promise.resolve() : new Promise(resolve => navigationWaiters.push({predicate, resolve}));
    },
    async evaluateHandle(fn, argument) {
      const context = active;
      context.argument = argument;
      const value = vm.runInContext(`(${fn.toString()})(argument)`, context);
      return {
        async evaluate(callback, args) {
          context.target = value; context.args = args;
          return vm.runInContext(`(${callback.toString()})(target,args)`, context);
        },
        asElement:() => value.tagName ? {click:async () => value.click()} : null,
        async dispose() {disposals.push(value);},
      };
    },
  };
  const api = createBrowserLogin({
    enqueue:(room, work) => {
      enqueues.push(room);
      const next = tail.catch(() => {}).then(work); tail = next; return next;
    },
    pageFor:async () => ({page, session:{}}),
    assertSafeUrl:async value => {
      checks.push(value); onCheck?.(value, active);
      if (deny(value)) throw Object.assign(new Error('Blocked address'), {status:403});
      return value;
    },
    redact:() => assert.fail('prepare must not read credentials'),
    invalidate:async () => {},
  });
  t.after(() => api.close());
  return {api, page, navigations, clicks, checks, enqueues, disposals, get context() {return active;}};
}

test('an explicit bare domain follows the unique actual Naver login anchor in one shared queue operation', {timeout:1500}, async t => {
  const f = fixture(t);
  const target = await f.api.prepareLoginTarget('room', {url:'naver.com'});
  assert.deepEqual(f.navigations, [NAVER]);
  assert.deepEqual(f.clicks, [{tag:'A', href:SIGN_IN}]);
  assert.deepEqual(f.enqueues, ['room'], 'capture must not enqueue recursively');
  assert.equal(target.origin, 'https://nid.naver.com');
  assert.equal(target.siteLabel, 'nid.naver.com');
  assert.match(target.tabRef, /^[a-f0-9-]{36}$/);
  assert.ok(f.checks.includes(NAVER) && f.checks.includes(SIGN_IN));
  assert.deepEqual(Object.keys(target).sort(), ['expiresAt', 'origin', 'siteLabel', 'tabRef']);
});

test('an existing login form on the requested site family is reused without navigation', async t => {
  const f = fixture(t, {initial:SIGN_IN});
  const target = await f.api.prepareLoginTarget('room', {url:'https://www.naver.com'});
  assert.equal(target.origin, 'https://nid.naver.com');
  assert.deepEqual(f.navigations, []);
  assert.deepEqual(f.clicks, []);
});

test('an explicit login-page URL is navigated directly without guessing or clicking a submit', async t => {
  const f = fixture(t);
  const target = await f.api.prepareLoginTarget('room', {url:SIGN_IN});
  assert.equal(target.origin, 'https://nid.naver.com');
  assert.deepEqual(f.navigations, [SIGN_IN]);
  assert.deepEqual(f.clicks, []);
});

test('a URL-free continuation requires the exact expected origin and never navigates', async t => {
  const f = fixture(t);
  await assert.rejects(f.api.prepareLoginTarget('room', {expectedOrigin:'https://example.com'}), {code:'LOGIN_TARGET_MISMATCH'});
  const target = await f.api.prepareLoginTarget('room', {expectedOrigin:'https://accounts.example.com'});
  assert.equal(target.origin, 'https://accounts.example.com');
  assert.deepEqual(f.navigations, []);
  assert.deepEqual(f.clicks, []);
  assert.equal((await f.api.captureLoginTarget('room')).origin, target.origin, 'existing capture contract is preserved');
});

test('ambiguous login anchors are not clicked', async t => {
  const f = fixture(t, {pages:{[NAVER]:{anchors:[anchor(), anchor('/login', '로그인')]}}});
  await assert.rejects(f.api.prepareLoginTarget('room', {url:NAVER}), {code:'LOGIN_LINK_UNSUPPORTED'});
  assert.deepEqual(f.clicks, []);
});

test('foreign, lookalike, javascript, invisible, download and new-window anchors are not eligible', async t => {
  for (const item of [
    anchor('https://outside.example/login'),
    anchor('https://naver.com.evil.example/login'),
    anchor('javascript:submitLogin()'),
    anchor(SIGN_IN, '회원 가입'),
    anchor('https://nid.naver.com/logout', '로그인'),
    anchor(SIGN_IN, '로그인', {hidden:true}),
    anchor(SIGN_IN, '로그인', {download:true}),
    anchor(SIGN_IN, '로그인', {target:'_blank'}),
  ]) {
    const f = fixture(t, {pages:{[NAVER]:{anchors:[item]}}});
    await assert.rejects(f.api.prepareLoginTarget('room', {url:NAVER}), {code:'LOGIN_LINK_UNSUPPORTED'});
    assert.deepEqual(f.clicks, []);
  }
});

test('a landing page with only a login submit button is never submitted', async t => {
  const f = fixture(t, {pages:{[NAVER]:{anchors:[]}}});
  await assert.rejects(f.api.prepareLoginTarget('room', {url:NAVER}), {code:'LOGIN_LINK_UNSUPPORTED'});
  assert.deepEqual(f.clicks, []);
});

test('redirects out of the requested site family stop before capturing any login form', async t => {
  for (const pages of [
    {[NAVER]:{redirect:OLD}},
    {[NAVER]:{anchors:[anchor(SIGN_IN, '로그인', {redirect:OLD})]}},
  ]) {
    const f = fixture(t, {pages});
    await assert.rejects(f.api.prepareLoginTarget('room', {url:NAVER}), {code:'LOGIN_TARGET_MISMATCH'});
    assert.equal(f.page.url(), OLD);
  }
});

test('destination and selected-link DNS/host checks run before navigation or clicking', async t => {
  const blockedDestination = fixture(t, {deny:value => value === NAVER});
  await assert.rejects(blockedDestination.api.prepareLoginTarget('room', {url:NAVER}), {status:403});
  assert.deepEqual(blockedDestination.navigations, []);
  const blockedLink = fixture(t, {deny:value => value === SIGN_IN});
  await assert.rejects(blockedLink.api.prepareLoginTarget('room', {url:NAVER}), {code:'LOGIN_LINK_UNSUPPORTED'});
  assert.deepEqual(blockedLink.clicks, []);
});

test('a login anchor replaced while its URL is checked is not clicked', async t => {
  const f = fixture(t, {onCheck:(value, context) => {
    if (value === SIGN_IN) context.anchors[0].rawHref = 'https://outside.example/login';
  }});
  await assert.rejects(f.api.prepareLoginTarget('room', {url:NAVER}), {code:'LOGIN_LINK_UNSUPPORTED'});
  assert.deepEqual(f.clicks, []);
});

test('invalid URLs and unexpected credential arguments are rejected before browser access', async t => {
  for (const options of [
    {url:'http://naver.com'}, {url:'https://name:secret@naver.com/login'}, {url:'https://127.0.0.1/login'},
    {url:'https://localhost/login'}, {url:'naver.com login please'}, {url:'javascript:alert(1)'},
    {url:NAVER, password:'must-not-be-accepted'}, {expectedOrigin:'https://naver.com/login'},
  ]) {
    const f = fixture(t);
    await assert.rejects(f.api.prepareLoginTarget('room', options), {code:'LOGIN_URL_INVALID'});
    assert.deepEqual(f.navigations, []);
    assert.deepEqual(f.clicks, []);
  }
});

test('cancellation before queued work or after navigation prevents capture and clicks', async t => {
  const before = new AbortController(); before.abort();
  const first = fixture(t);
  await assert.rejects(first.api.prepareLoginTarget('room', {url:NAVER, signal:before.signal}), {name:'AbortError'});
  assert.deepEqual(first.navigations, []);
  const during = new AbortController();
  const second = fixture(t, {afterGoto:() => during.abort()});
  await assert.rejects(second.api.prepareLoginTarget('room', {url:NAVER, signal:during.signal}), {name:'AbortError'});
  assert.deepEqual(second.clicks, []);
});
