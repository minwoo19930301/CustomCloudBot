import test from 'node:test';
import assert from 'node:assert/strict';
import {createComposerSuggestions} from '../public/composer-suggestions.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => Promise.withResolvers();
class Input {
  value = ''; placeholder = ''; disabled = false; isConnected = true; dataset = {}; listeners = new Map(); attributes = {};
  addEventListener(type, fn) { this.listeners.set(type, fn); }
  removeEventListener(type) { this.listeners.delete(type); }
  setAttribute(key, value) { this.attributes[key] = value; }
  removeAttribute(key) { delete this.attributes[key]; }
  dispatchEvent(event) { this.listeners.get(event.type)?.(event); }
  setSelectionRange(start, end) { this.selection = [start, end]; }
  type(value) { this.value = value; this.dispatchEvent(new Event('input')); }
  key(key, extra = {}) { const event={key,prevented:false,preventDefault(){this.prevented=true;},...extra}; this.listeners.get('keydown')?.(event); return event; }
}
function fixture(response = async () => ({suggestion:'이 계획을 실행 순서로 정리해 줘.', revision:'reply-1'})) {
  let session={user:{id:'owner'},csrfToken:'first-login'}, visible=true;
  const calls=[], input=new Input();
  const ui=createComposerSuggestions({getSession:()=>session,isVisible:()=>visible,api:async(path,options)=>{calls.push({path,options});return response(path,options);}});
  const data={room:{id:'room-1'},messages:[{id:'human-1',kind:'human'},{id:'reply-1',kind:'bot'}],busy:false};
  const sync=(extra={})=>ui.sync({input,roomId:'room-1',data,...extra});
  return {ui,input,data,calls,sync,setSession:value=>{session=value;},setVisible:value=>{visible=value;}};
}

test('a completed reply produces a placeholder once, never an actual draft or send',async()=>{
  const app=fixture();app.sync();app.sync();await tick();
  assert.equal(app.calls.length,1);assert.equal(app.calls[0].path,'/api/rooms/room-1/suggestion');
  assert.deepEqual(JSON.parse(app.calls[0].options.body),{afterMessageId:'reply-1',model:'',effort:''});
  assert.equal(app.input.placeholder,'제안: 이 계획을 실행 순서로 정리해 줘.');assert.equal(app.input.value,'');
  app.sync();await tick();assert.equal(app.calls.length,1);
  assert.equal(app.input.key('Enter').prevented,false,'Enter never submits the placeholder itself');
  const event=app.input.key('Tab');assert.equal(event.prevented,true);
  assert.equal(app.input.value,'이 계획을 실행 순서로 정리해 줘.');assert.equal(app.calls.length,1);
  assert.equal(app.input.key('Tab').prevented,false,'normal keyboard navigation resumes after acceptance');
});

test('busy, queued, empty, pending attachments, and non-bot latest messages do not infer',async()=>{
  for(const extra of [{queued:true},{blocked:true},{hasAttachments:true},{data:null},{data:{room:{id:'room-1'},messages:[]}},{data:{room:{id:'room-1'},messages:[{id:'x',kind:'human'}]}},{data:{room:{id:'room-1'},messages:[{id:'x',kind:'bot'}],busy:true}},{data:{room:{id:'room-1'},messages:[{id:'x',kind:'bot'}],queue:[{}]}}]) {
    const app=fixture();app.sync(extra);await tick();assert.equal(app.calls.length,0);
    assert.equal(app.input.value,'');assert.equal(app.input.dataset.suggestion,undefined);
  }
  const app=fixture();app.setVisible(false);app.sync();await tick();assert.equal(app.calls.length,0);
  app.setVisible(true);app.sync();await tick();assert.equal(app.calls.length,1);
});

test('typing before or during inference is preserved and clearing the draft can reveal the cached suggestion',async()=>{
  const pending=deferred(), app=fixture(()=>pending.promise);app.input.value='직접 쓰는 요청';app.sync();await tick();
  assert.equal(app.calls.length,0);app.input.type('');await tick();assert.equal(app.calls.length,1);
  app.input.type('내가 정한 요청');pending.resolve({suggestion:'다음으로 할 일을 정리해 줘.',revision:'reply-1'});await tick();
  assert.equal(app.input.value,'내가 정한 요청');assert.equal(app.input.placeholder,'무엇을 함께 해볼까요?');
  assert.equal(app.input.key('Tab').prevented,false);
  app.input.type('');assert.equal(app.input.placeholder,'제안: 다음으로 할 일을 정리해 줘.');assert.equal(app.calls.length,1);
});

test('late results cannot leak into another room, another account, or a remounted input',async()=>{
  for(const mode of ['room','session','reset','detached']) {
    const pending=deferred(), app=fixture(()=>pending.promise);app.sync();await tick();
    if(mode==='room')app.sync({roomId:'room-2',data:null});
    if(mode==='session'){app.setSession({user:{id:'other'}});app.sync({data:null});}
    if(mode==='reset')app.ui.reset();
    if(mode==='detached')app.input.isConnected=false;
    pending.resolve({suggestion:'이전 대화의 제안',revision:'reply-1'});await tick();
    assert.equal(app.input.dataset.suggestion,undefined,mode);assert.equal(app.input.value,'');
  }
});

test('stale revisions, malformed output, and provider errors silently retain the normal placeholder',async()=>{
  for(const result of [{suggestion:'old',revision:'old-reply'},{suggestion:'line\nbreak',revision:'reply-1'},{suggestion:'x'.repeat(101),revision:'reply-1'},{suggestion:{text:'bad'},revision:'reply-1'},null]) {
    const app=fixture(async()=>result);app.sync();await tick();assert.equal(app.input.placeholder,'무엇을 함께 해볼까요?');
    app.sync();await tick();assert.equal(app.calls.length,1,'polls do not repeatedly retry invalid suggestions');
  }
  const app=fixture(async()=>{throw Error('provider unavailable');});app.sync();await tick();app.sync();await tick();
  assert.equal(app.calls.length,1);assert.equal(app.input.dataset.suggestion,undefined);
});

test('main and split inputs share one request per revision; new replies replace the previous suggestion',async()=>{
  const app=fixture(), other=new Input();app.sync();app.sync({input:other});await tick();assert.equal(app.calls.length,1);
  assert.equal(app.input.placeholder,other.placeholder);
  app.sync({data:{...app.data,messages:[{id:'human-2',kind:'human'}]}});assert.equal(app.input.dataset.suggestion,undefined);
  app.sync({data:{...app.data,messages:[{id:'reply-2',kind:'bot'}]},model:'chosen',effort:'high'});await tick();
  assert.equal(app.calls.length,2);assert.equal(JSON.parse(app.calls[1].options.body).afterMessageId,'reply-2');
});

test('keyboard shortcuts and IME composition never accept a suggestion accidentally',async()=>{
  const app=fixture();app.sync();await tick();
  for(const extra of [{shiftKey:true},{ctrlKey:true},{metaKey:true},{altKey:true},{isComposing:true},{defaultPrevented:true}])assert.equal(app.input.key('Tab',extra).prevented,false);
  app.input.disabled=true;assert.equal(app.input.key('Tab').prevented,false);assert.equal(app.input.value,'');
  app.ui.reset();assert.equal(app.input.listeners.size,0);assert.equal(app.input.dataset.suggestion,undefined);
});

test('context reset invalidates cached or pending suggestions without changing the last message ID',async()=>{
  for(const pendingResult of [false,true]) {
    const pending=deferred(), app=fixture(()=>pendingResult?pending.promise:Promise.resolve({suggestion:'이전 대화를 이어줘.',revision:'reply-1'}));
    const before={...app.data,context:{usedChars:1200,messageTokens:600,summaryTokens:0,compacted:false,merged:false}};
    app.sync({data:before});await tick();assert.equal(app.calls.length,1);
    if(!pendingResult)assert.equal(app.input.dataset.suggestion,'이전 대화를 이어줘.');
    app.sync({data:{...before,context:{...before.context,usedChars:0,messageTokens:0}}});
    pending.resolve({suggestion:'이전 대화를 이어줘.',revision:'reply-1'});await tick();
    assert.equal(app.input.dataset.suggestion,undefined);assert.equal(app.input.placeholder,'무엇을 함께 해볼까요?');
    assert.equal(app.input.key('Tab').prevented,false);assert.equal(app.input.value,'');
    assert.equal(app.calls.length,1,'empty reset context does not request another prediction');
  }
});

test('compacting context replaces a cached suggestion even while the last message ID is unchanged',async()=>{
  let count=0;
  const app=fixture(async()=>({suggestion:++count===1?'기존 요청을 이어줘.':'요약한 계획을 실행해줘.',revision:'reply-1'}));
  app.sync({data:{...app.data,context:{usedChars:1200,messageTokens:600,summaryTokens:0,compacted:false,merged:false}}});
  await tick();assert.equal(app.input.dataset.suggestion,'기존 요청을 이어줘.');
  app.sync({data:{...app.data,context:{usedChars:200,messageTokens:0,summaryTokens:100,compacted:true,merged:false}}});
  assert.equal(app.input.dataset.suggestion,undefined);await tick();
  assert.equal(app.calls.length,2);assert.equal(app.input.dataset.suggestion,'요약한 계획을 실행해줘.');
});
