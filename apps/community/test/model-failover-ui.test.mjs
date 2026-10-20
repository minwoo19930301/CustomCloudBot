import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const source = readFileSync(new URL('../public/model-failover.mjs', import.meta.url), 'utf8').replace('export function', 'function');
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve = yes; reject = no;}); return {promise, resolve, reject};};
const status = {runId:'run-1', userId:'owner', phase:'trying', model:'다음 모델', reason:'response', automatic:true, canControl:true, visible:true, attempt:2};

function setup({response, refresh, selectModel} = {}) {
  class Element {
    constructor(tag) {this.tagName=tag; this.children=[]; this.dataset={}; this.attributes={}; this._text=''; this.writes=0; this.rootConnected=false;}
    get isConnected() {return this.rootConnected || Boolean(this.parentNode?.isConnected);}
    get textContent() {return this._text;}
    set textContent(value) {this._text=String(value); this.writes++;}
    append(...items) {for (const item of items) {item.remove(); item.parentNode=this; this.children.push(item);}}
    prepend(item) {item.remove(); item.parentNode=this; this.children.unshift(item);}
    remove() {if(this.parentNode)this.parentNode.children=this.parentNode.children.filter(item=>item!==this); this.parentNode=null;}
    setAttribute(key,value) {this.attributes[key]=String(value);}
    getAttribute(key) {return this.attributes[key];}
    querySelectorAll(selector) {return this.children.flatMap(child=>[
      ...((selector.startsWith('.') ? child.className?.split(' ').includes(selector.slice(1)) : child.tagName===selector) ? [child] : []),
      ...child.querySelectorAll(selector),
    ]);}
    querySelector(selector) {return this.querySelectorAll(selector)[0];}
  }
  const context={document:{createElement:tag=>new Element(tag)}};
  vm.runInNewContext(source+'\nthis.createModelFailoverUI=createModelFailoverUI;',context);
  let session={user:{id:'owner'},csrfToken:'login-1'};
  const calls=[],refreshes=[],toasts=[],selections=[],form=new Element('form');form.rootConnected=true;
  const ui=context.createModelFailoverUI({
    getSession:()=>session,
    api:async(path,options)=>{calls.push({path,options});return response?response(path,options):{};},
    onRefresh:async roomId=>{refreshes.push(roomId);await refresh?.(roomId);},
    onSelectModel:selectModel===false?undefined:async options=>{selections.push(options);return selectModel?.(options);},
    toast:value=>toasts.push(value),
  });
  const app={ui,form,calls,refreshes,toasts,selections,
    render(value=status,roomId='room-1',host=form){return ui.render(host,roomId,value);},
    panel(){return form.querySelector('.model-failover');},
    message(){return form.querySelector('.model-failover-message');},
    actions(){return form.querySelector('.model-failover-actions');},
    button(action){return form.querySelector('.model-failover-'+action);},
    setSession(value){session=value;},
    newHost(){const host=new Element('form');host.rootConnected=true;return host;},
  };
  return app;
}

test('only observed failovers or failure states appear; normal tool attempts never open the panel',()=>{
  const app=setup();
  app.render({...status,visible:false,attempt:99});assert.equal(app.panel(),undefined);
  app.render({...status,visible:true,attempt:1});assert.ok(app.panel());
  app.render(null);assert.equal(app.panel(),undefined);
  for(const phase of ['waiting','exhausted','stopped']) {
    app.render({...status,visible:false,phase});assert.ok(app.panel(),phase);
  }
  for(const value of [{...status,runId:''},{...status,phase:'success'},undefined,null]) {
    app.ui.render(app.form,'room-1',value);assert.equal(app.panel(),undefined);
  }
});

test('same run keeps its DOM and focus targets through polling without repeating live announcements',()=>{
  const app=setup();const panel=app.render(),message=app.message(),select=app.button('select'),writes=message.writes;
  app.render({...status});
  assert.equal(app.panel(),panel);assert.equal(app.message(),message);assert.equal(app.button('select'),select);assert.equal(message.writes,writes);
  app.render({...status,model:'새 모델'});
  assert.equal(app.panel(),panel);assert.equal(message.writes,writes+1);assert.match(message.textContent,/새 모델로 이어서/);
  assert.equal(message.getAttribute('role'),'status');assert.equal(message.getAttribute('aria-live'),'polite');
  assert.equal(panel.tagName,'section');assert.equal(panel.getAttribute('aria-modal'),undefined);
});

test('brief status copy distinguishes real retries, switching, waiting and stopped attempts without raw errors',()=>{
  const app=setup();
  app.render({...status,phase:'switching'});assert.match(app.message().textContent,/바꾸고/);assert.doesNotMatch(app.message().textContent,/시도하고|다음 모델/);
  app.render({...status,reason:'limit'});assert.match(app.message().textContent,/사용 한도/);
  app.render({...status,reason:'connection'});assert.match(app.message().textContent,/연결이 원활하지/);
  app.render({...status,reason:'switch'});assert.equal(app.message().textContent,'다음 모델로 이어서 시도하고 있어요.');
  app.render({...status,reason:'private stack and token',model:'<img src=x onerror=alert(1)>',error:'secret'});
  assert.match(app.message().textContent,/<img/);assert.doesNotMatch(app.message().textContent,/private stack|secret/);assert.equal(app.message().children.length,0);
  app.render({...status,phase:'waiting'});assert.match(app.message().textContent,/모델을 선택하거나 자동으로 다시 시도/);
  app.render({...status,phase:'stopped',canControl:false});assert.equal(app.message().textContent,'모델 응답을 중지했어요.');
  app.render({...status,phase:'exhausted',canControl:false});assert.equal(app.message().textContent,'연결된 모델에서 답변을 받지 못했어요.');
});

test('other users read status but only the requesting user with server permission sees enabled controls',async()=>{
  for(const change of ['reader','no-permission','no-requester','logged-out']) {
    const app=setup();let value={...status};
    if(change==='reader')app.setSession({user:{id:'other'},csrfToken:'login-1'});
    if(change==='no-permission')value.canControl=false;
    if(change==='no-requester')delete value.userId;
    if(change==='logged-out')app.setSession(null);
    app.render(value);assert.equal(app.actions().hidden,true,change);
    for(const action of ['select','stop','auto']) {assert.equal(app.button(action).disabled,true);await app.button(action).onclick();}
    assert.deepEqual(app.calls,[]);assert.deepEqual(app.selections,[]);
  }
  const app=setup();app.render();assert.equal(app.actions().hidden,false);
  assert.equal(app.button('select').disabled,false);assert.equal(app.button('stop').disabled,false);assert.equal(app.button('auto').disabled,true);
  assert.equal(app.button('auto').getAttribute('aria-pressed'),'true');
});

test('temporary, account and request notices never claim that the model is unsupported',()=>{
  const app=setup();
  for(const [reason,phrase] of [
    ['authentication','계정 인증'],['billing','사용 예산'],['endpoint','연결 주소'],
    ['provider','일시적인 오류'],['timeout','응답 시간이 초과'],['size','처리 크기 한도'],
    ['request','요청 형식'],
  ]) {
    app.render({...status,reason});
    assert.match(app.message().textContent,new RegExp(phrase),reason);
    assert.match(app.message().textContent,/다음 모델로 이어서 시도/);
    assert.doesNotMatch(app.message().textContent,/이 모델을 사용할 수 없어/);
  }
  app.render({...status,reason:'unavailable'});
  assert.match(app.message().textContent,/이 모델을 사용할 수 없어/);
  assert.deepEqual(app.calls,[],'status text alone must not start an extra request');
});

test('an unanswered notice never pauses or creates a retry; waiting permits an explicit automatic retry',async()=>{
  const app=setup();app.render();await Promise.resolve();app.render();
  assert.deepEqual(app.calls,[]);await app.button('auto').onclick();assert.deepEqual(app.calls,[]);
  app.render({...status,phase:'waiting'});assert.equal(app.button('auto').disabled,false);
  await app.button('auto').onclick();
  assert.equal(app.calls.length,1);assert.deepEqual(JSON.parse(app.calls[0].options.body),{runId:'run-1',action:'auto'});
  assert.deepEqual(app.refreshes,['room-1']);
});

test('stop binds the original room and run, encodes the URL and rejects double clicks even after a poll',async()=>{
  const pending=deferred(),app=setup({response:()=>pending.promise});app.render(status,'room/a');
  const button=app.button('stop'),request=button.onclick();
  await button.onclick();app.render({...status},'room/a');await app.button('select').onclick();
  assert.equal(app.calls.length,1);assert.equal(app.calls[0].path,'/api/rooms/room%2Fa/model-control');
  assert.equal(app.calls[0].options.method,'POST');assert.deepEqual(JSON.parse(app.calls[0].options.body),{runId:'run-1',action:'stop'});
  assert.equal(app.actions().getAttribute('aria-busy'),'true');assert.equal(app.form.querySelectorAll('button').every(item=>item.disabled),true);
  pending.resolve({});await request;
  assert.deepEqual(app.refreshes,['room/a']);assert.equal(app.button('stop').disabled,false);assert.equal(app.actions().getAttribute('aria-busy'),'false');
});

test('two views of one run share the in-flight action lock',async()=>{
  const pending=deferred(),app=setup({response:()=>pending.promise}),second=app.newHost();
  app.render();app.render(status,'room-1',second);
  const request=app.button('stop').onclick();
  assert.equal(second.querySelector('.model-failover-stop').disabled,true);
  await second.querySelector('.model-failover-stop').onclick();assert.equal(app.calls.length,1);
  pending.resolve({});await request;assert.equal(second.querySelector('.model-failover-stop').disabled,false);
});

test('manual selection reuses the current prompt run and sends only the chosen model',async()=>{
  const app=setup();app.render();await app.button('select').onclick();
  assert.equal(app.selections.length,1);assert.deepEqual(app.calls,[]);
  const choice=app.selections[0];assert.equal(choice.roomId,'room-1');assert.equal(choice.runId,'run-1');assert.equal(choice.model,'다음 모델');
  assert.equal(await choice.select(''),false);assert.equal(await choice.select(null),false);
  await choice.select(' vendor/model-id ');
  assert.deepEqual(JSON.parse(app.calls[0].options.body),{runId:'run-1',action:'select',model:'vendor/model-id'});
  assert.deepEqual(app.refreshes,['room-1']);
});

test('cancelling a model picker leaves automatic retry alone and the chooser can reopen',async()=>{
  const app=setup();app.render();await app.button('select').onclick();await app.button('select').onclick();
  assert.equal(app.selections.length,2);assert.equal(app.button('select').disabled,false);assert.deepEqual(app.calls,[]);
  const unavailable=setup({selectModel:false});unavailable.render();assert.equal(unavailable.button('select').disabled,true);
});

test('picker callbacks become inert after room/run changes, success, reset, logout or same-account relogin',async()=>{
  for(const change of ['room','run','success','reset','account','relogin','destroy','permission','removed-host']) {
    const app=setup();app.render();await app.button('select').onclick();const choice=app.selections[0];
    if(change==='room')app.render(status,'room-2');
    if(change==='run')app.render({...status,runId:'run-2'});
    if(change==='success')app.render(null);
    if(change==='reset')app.ui.reset();
    if(change==='account')app.setSession({user:{id:'other'},csrfToken:'login-1'});
    if(change==='relogin')app.setSession({user:{id:'owner'},csrfToken:'login-2'});
    if(change==='destroy')app.ui.destroy();
    if(change==='permission')app.render({...status,canControl:false});
    if(change==='removed-host')app.form.rootConnected=false;
    assert.equal(await choice.select('late/model'),false,change);assert.deepEqual(app.calls,[],change);
  }
});

test('late API results never refresh a new room, run or login and never leak raw errors',async()=>{
  for(const change of ['room','run','reset','relogin','destroy']) for(const outcome of ['success','failure']) {
    const pending=deferred(),app=setup({response:()=>pending.promise});app.render();const request=app.button('stop').onclick();
    if(change==='room')app.render(status,'room-2');
    if(change==='run')app.render({...status,runId:'run-2'});
    if(change==='reset')app.ui.reset();
    if(change==='relogin')app.setSession({user:{id:'owner'},csrfToken:'login-2'});
    if(change==='destroy')app.ui.destroy();
    if(outcome==='success')pending.resolve({});else pending.reject(new Error('secret provider token'));
    await request;assert.deepEqual(app.refreshes,[],change);assert.deepEqual(app.toasts,[],change);
  }
});

test('ordinary session-object refresh retains pending controls and permission updates remain authoritative',async()=>{
  let app;const pending=deferred();
  app=setup({response:()=>pending.promise,refresh:()=>app.render({...status,phase:'stopped',canControl:false})});app.render();
  const request=app.button('stop').onclick();app.setSession({user:{id:'owner',displayName:'new name'},csrfToken:'login-1'});app.render();
  assert.equal(app.button('stop').disabled,true);pending.resolve({});await request;
  assert.deepEqual(app.refreshes,['room-1']);assert.equal(app.actions().hidden,true);assert.equal(app.button('stop').disabled,true);
});

test('a failed action unlocks controls with a generic safe message; stale-run failures request fresh state',async()=>{
  for(const code of [500,409,404]) {
    const error=Object.assign(new Error('private stack, token=secret'),{status:code});
    const app=setup({response:()=>Promise.reject(error)});app.render();await app.button('stop').onclick();
    assert.equal(app.button('stop').disabled,false);assert.equal(app.toasts.length,1);assert.doesNotMatch(app.toasts[0],/private|token|secret/);
    assert.equal(app.refreshes.length,code===500?0:1);
  }
});

test('reset removes all panels, destroy prevents new panels, and a new run clears obsolete buttons',()=>{
  const app=setup(),second=app.newHost();const old=app.render();app.render(status,'room-2',second);
  app.render({...status,runId:'new-run'});assert.notEqual(app.panel(),old);assert.equal(old.isConnected,false);
  app.ui.reset();assert.equal(app.panel(),undefined);assert.equal(second.querySelector('.model-failover'),undefined);
  app.render();assert.ok(app.panel());app.ui.destroy();app.render();assert.equal(app.panel(),undefined);
});
