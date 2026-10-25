import test from 'node:test';
import assert from 'node:assert/strict';
import {mobileFramePoint,mobileGesture,mobileWheel,mobileEditableAt,mobileEditableRegions,mobileTextEdit,createMobileKeyboard,createMobileWorkspace} from '../public/mobile-workspace.js';

class Element {
  constructor(document,tag='div'){this.ownerDocument=document;this.tagName=tag.toUpperCase();this.handlers=new Map();this.attributes={};this.children=[];this.value='';this.dataset={};this.hidden=false;this.scrollHeight=500;this.clientHeight=300;this.scrollTop=200;this.classList={toggle:()=>{}};}
  setAttribute(key,value){this.attributes[key]=value;}
  removeAttribute(key){delete this.attributes[key];}
  append(...nodes){for(const node of nodes){node.parent=this;this.children.push(node);}}
  replaceChildren(...nodes){for(const node of this.children)node.parent=null;this.children=[];this.append(...nodes);}
  addEventListener(type,handler){if(!this.handlers.has(type))this.handlers.set(type,new Set());this.handlers.get(type).add(handler);}
  removeEventListener(type,handler){this.handlers.get(type)?.delete(handler);}
  focus(){this.ownerDocument.activeElement=this;}
  blur(){if(this.ownerDocument.activeElement===this){this.ownerDocument.activeElement=null;this.fire('blur');}}
  setSelectionRange(start,end){this.selectionStart=start;this.selectionEnd=end;}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter(child=>child!==this);}
  getBoundingClientRect(){return {left:0,top:0,width:360,height:780};}
  setPointerCapture(){}releasePointerCapture(){}
  fire(type,details={}){const event={target:this,button:0,pointerId:1,preventDefault(){this.prevented=true;},stopPropagation(){},...details};for(const handler of this.handlers.get(type)||[])handler(event);return event;}
}
function dom(){const document={hidden:false,activeElement:null,createElement(tag){return new Element(this,tag);}};return {document,mount:new Element(document)};}
const find=(root,className)=>root.className?.split(' ').includes(className)?root:root.children.flatMap(child=>{const found=find(child,className);return found?[found]:[];})[0];
const buttonBy=(root,label)=>root.attributes?.['aria-label']===label?root:root.children.flatMap(child=>{const found=buttonBy(child,label);return found?[found]:[];})[0];
const flush=()=>new Promise(resolve=>setImmediate(resolve));

test('screen coordinates preserve contain aspect ratio and ignore black letterboxing',()=>{
  const rect={left:10,top:20,width:800,height:600};
  assert.deepEqual(mobileFramePoint(rect,720,1560,410,320),{x:360,y:780});
  assert.equal(mobileFramePoint(rect,720,1560,20,320),null);
  assert.equal(mobileFramePoint(rect,720,1560,410,620),null);
  assert.equal(mobileFramePoint(rect,0,1560,410,320),null);
  assert.equal(mobileFramePoint(rect,720,1560,NaN,320),null);
  assert.deepEqual(mobileFramePoint({left:0,top:0,width:360,height:780},720,1560,12,20),{x:24,y:40});
});

test('taps, swipes, long presses and cancelled touches remain distinct',()=>{
  const start={x:100,y:200};
  assert.deepEqual(mobileGesture(start,{x:104,y:205},{elapsed:100}),{type:'tap',x:100,y:200});
  assert.deepEqual(mobileGesture(start,start,{elapsed:700}),{type:'swipe',x1:100,y1:200,x2:100,y2:200,duration:700});
  assert.equal(mobileGesture(start,{x:100,y:50},{cancelled:true}),null);
  assert.equal(mobileGesture(null,start),null);
  assert.equal(mobileGesture(start,{x:100,y:50},{elapsed:9000,moved:true}).duration,2000);
  assert.equal(mobileGesture(start,start,{moved:true}).type,'swipe');
});

test('wheel translates to opposite finger motion without sending coordinates outside the device',()=>{
  const down=mobileWheel({x:200,y:500},150,720,1560),up=mobileWheel({x:0,y:5},-150,720,1560);
  assert.ok(down.y1>down.y2);assert.ok(up.y1<up.y2);assert.equal(up.y1,0);
  assert.equal(mobileWheel({x:2,y:2},0,720,1560),null);
  assert.equal(mobileWheel(null,10,720,1560),null);
});

test('editable map uses real enabled Android bounds and excludes invalid or disabled nodes',()=>{
  const data={nodes:[{editable:true,enabled:true,bounds:{left:20,top:30,right:120,bottom:80},text:'private password'},
    {editable:true,enabled:false,bounds:{left:20,top:30,right:120,bottom:80}},
    {editable:false,enabled:true,bounds:{left:20,top:30,right:120,bottom:80}},
    {editable:true,bounds:{left:0,top:0,right:Infinity,bottom:80}}]};
  const regions=mobileEditableRegions(data);assert.equal(regions.length,1);assert.equal('text' in regions[0],false);
  assert.equal(mobileEditableAt({x:22,y:31},regions),regions[0]);assert.equal(mobileEditableAt({x:120,y:31},regions),null);
});

test('typing handles Unicode edits and bounded text while mapping control characters to Android keys',()=>{
  assert.deepEqual(mobileTextEdit('\u200bcat','\u200bcar'),[{type:'key',key:'DEL'},{type:'text',text:'r'}]);
  assert.deepEqual(mobileTextEdit('\u200b',''),[{type:'key',key:'DEL'}]);
  assert.deepEqual(mobileTextEdit('\u200b','\u200b한🙂\n\tA\u0000'),[{type:'text',text:'한🙂'},{type:'key',key:'ENTER'},{type:'key',key:'TAB'},{type:'text',text:'A'}]);
  const long=mobileTextEdit('\u200b','🙂'.repeat(3000));assert.ok(long.every(action=>action.text.length<=2000));assert.equal(long.map(action=>action.text).join(''),'🙂'.repeat(3000));
});

test('native keyboard focuses during a known editable tap and Korean composition sends once',()=>{
  const {document,mount}=dom(),actions=[];let active=true;const changes=[];
  const keyboard=createMobileKeyboard({viewport:mount,send:action=>actions.push(action),canInput:()=>active,onChange:value=>changes.push(value)}),input=mount.children[0];
  assert.equal(keyboard.focus({inputMode:'email'}),true);assert.equal(document.activeElement,input);assert.equal(input.attributes.inputmode,'email');
  input.fire('compositionstart');input.value='\u200bㅎ';input.fire('input',{isComposing:true});assert.deepEqual(actions,[]);
  input.value='\u200b한';input.fire('compositionend');input.fire('input');assert.deepEqual(actions,[{type:'text',text:'한'}]);
  input.value='\u200b한🙂';input.fire('input');assert.equal(actions.at(-1).text,'🙂');
  active=false;input.value='secret';input.fire('input');assert.equal(actions.length,2);assert.equal(keyboard.focus(),false);
  keyboard.destroy();assert.equal(input.value,'');assert.equal(mount.children.length,0);for(const handlers of input.handlers.values())assert.equal(handlers.size,0);
});

test('remote keyboard arrows and enter are sent once, and deactivation clears private input',()=>{
  const {mount}=dom(),actions=[];const keyboard=createMobileKeyboard({viewport:mount,send:action=>actions.push(action)}),input=mount.children[0];keyboard.focus();
  assert.equal(input.fire('keydown',{key:'Enter'}).prevented,true);
  assert.equal(input.fire('beforeinput',{inputType:'insertParagraph'}).prevented,true);
  input.fire('keydown',{key:'ArrowLeft'});assert.deepEqual(actions,[{type:'key',key:'ENTER'},{type:'key',key:'ENTER'},{type:'key',key:'DPAD_LEFT'}]);
  input.value='\u200bprivate';input.fire('input');keyboard.deactivate();assert.equal(mount.ownerDocument.activeElement,null);
  assert.equal(input.value,'\u200b');assert.equal(input.disabled,true);keyboard.destroy();
});

async function fixture(t,{readOnly=false,running=true,send=async()=>{},fetchFrame=null,draft,initialMessages}={}){
  const {document,mount}=dom(),requests=[],messages=initialMessages||[{id:'m1',role:'user',content:'이 모바일의 설정을 열어줘.'}];
  const originalFetch=globalThis.fetch;globalThis.fetch=fetchFrame||(async()=>new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/png'}}));
  t.after(()=>{globalThis.fetch=originalFetch;view.destroy();});
  const api=async(path,options={})=>{requests.push({path,options});if(path.endsWith('/observe'))return {width:720,height:1560,nodes:[{editable:true,enabled:true,bounds:{left:0,top:0,right:200,bottom:200}}]};if(path.endsWith('/input'))return {ok:true};return {device:{state:running?'running':'sleeping'},capacity:{running:running?1:0,maxRunning:2},readOnly};};
  const loads=[],sends=[];
  const view=createMobileWorkspace({mount,api,roomId:'room-A',draft,mobileChat:{load:async(roomId)=>{loads.push(roomId);return {messages,readOnly};},send:async(roomId,text)=>{sends.push({roomId,text});await send();messages.push({id:'m2',role:'user',content:text});}}});
  await flush();await flush();
  return {view,document,mount,requests,loads,sends,input:find(mount,'mobile-chat-input'),form:find(mount,'mobile-chat-form'),image:find(mount,'mobile-screen-image')};
}

test('mobile chat sends through the existing room callback and updates the same room transcript',async t=>{
  const f=await fixture(t);assert.deepEqual(f.loads,['room-A']);assert.equal(f.input.disabled,false);assert.equal(find(f.mount,'mobile-workspace-scroll').scrollTop,200);
  f.input.value='설정을 열어줘.';await f.form.onsubmit({preventDefault(){}});
  assert.deepEqual(f.sends,[{roomId:'room-A',text:'설정을 열어줘.'}]);assert.equal(f.input.value,'');
  assert.equal(find(f.mount,'mobile-chat-history').children.length,2);
  assert.ok(f.requests.every(request=>request.path.startsWith('/api/rooms/room-A/mobile')));
});

test('readonly sources block chat, keyboard and all device mutations while preserving readable history',async t=>{
  const f=await fixture(t,{readOnly:true});assert.equal(f.input.readOnly,true);assert.equal(buttonBy(f.mount,'모바일 깨우기').disabled,true);assert.equal(buttonBy(f.mount,'모바일 휴면').disabled,true);
  f.input.value='do not send';await f.form.onsubmit({preventDefault(){}});assert.deepEqual(f.sends,[]);
  f.image.fire('pointerdown',{clientX:10,clientY:10});f.image.fire('pointerup',{clientX:10,clientY:10});buttonBy(f.mount,'Android 홈').onclick();await flush();
  assert.ok(f.requests.every(request=>!request.path.endsWith('/input')));assert.equal(find(f.mount,'mobile-chat-history').children.length,1);
});

test('touch sends a tap before synchronously opening the iPhone keyboard; cancellation never taps',async t=>{
  const f=await fixture(t);f.image.fire('pointerdown',{clientX:10,clientY:10});f.image.fire('pointerup',{clientX:10,clientY:10});
  assert.equal(f.document.activeElement,find(f.mount,'mobile-native-keyboard'));await flush();
  assert.deepEqual(JSON.parse(f.requests.find(request=>request.path.endsWith('/input')).options.body),{type:'tap',x:20,y:20});
  f.image.fire('pointerdown',{clientX:30,clientY:30});f.image.fire('pointercancel',{clientX:30,clientY:30});await flush();
  assert.equal(f.requests.filter(request=>request.path.endsWith('/input')).length,1);
});

test('failed AI sending preserves the user draft',async t=>{
  const f=await fixture(t,{send:async()=>{throw new Error('연결 실패');}});f.input.value='중요한 초안';await f.form.onsubmit({preventDefault(){}});
  assert.equal(f.input.value,'중요한 초안');assert.equal(find(f.mount,'mobile-chat-state').textContent,'연결 실패');
});

test('destroy aborts screenshot polling and ignores late frames without making object URLs',async t=>{
  let complete;const pending=new Promise(resolve=>{complete=resolve;});const f=await fixture(t,{fetchFrame:()=>pending});
  f.view.destroy();complete(new Response(new Uint8Array([1]),{headers:{'content-type':'image/png'}}));await flush();
  assert.equal(f.mount.children.length,0);assert.equal(f.image.src,undefined);const count=f.requests.length;
  f.image.fire('pointerdown',{clientX:10,clientY:10});f.image.fire('pointerup',{clientX:10,clientY:10});await flush();assert.equal(f.requests.length,count);
});

test('explicit Mobile view wakes an allocated sleeping device once after room permissions load',async t=>{
  const f=await fixture(t,{running:false});await flush();
  assert.equal(f.requests.filter(request=>request.path.endsWith('/wake')).length,1);
  assert.equal(f.requests.find(request=>request.path.endsWith('/wake')).options.method,'POST');
  assert.equal(f.requests.find(request=>request.path.endsWith('/wake')).options.body,'{}');
});

test('readonly mobile views never auto-wake or allocate a device',async t=>{
  const f=await fixture(t,{running:false,readOnly:true});await flush();assert.ok(f.requests.every(request=>!request.path.endsWith('/wake')));
});

test('hidden views ignore late permission/status replies instead of waking in the background',async()=>{
  const {document,mount}=dom(),requests=[];let complete;const pending=new Promise(resolve=>{complete=resolve;});
  const view=createMobileWorkspace({mount,roomId:'hidden-room',api:async path=>{requests.push(path);return pending;},mobileChat:{load:async()=>({messages:[],readOnly:false}),send:async()=>{}}});
  document.hidden=true;complete({device:{state:'sleeping'},capacity:{running:0,maxRunning:2}});await flush();
  assert.deepEqual(requests,['/api/rooms/hidden-room/mobile']);assert.equal(find(mount,'mobile-screen-image').src,undefined);view.destroy();
});

test('real room message kinds render the human author and assistant separately',async t=>{
  const f=await fixture(t,{initialMessages:[{id:'h',kind:'human',author:'민우',text:'설정을 열어줘.'},{id:'b',kind:'bot',author:'CustomCloudBot',text:'설정을 열었습니다.'}]});
  const rows=find(f.mount,'mobile-chat-history').children;assert.equal(rows[0].dataset.role,'user');assert.equal(rows[0].children[0].textContent,'민우');assert.equal(rows[1].dataset.role,'assistant');assert.equal(rows[1].children[0].textContent,'CustomCloudBot');
});

test('closing the workspace retains the draft only in its room window memory',async t=>{
  const draft={value:'이전 초안',pending:false,revision:1},f=await fixture(t,{draft});assert.equal(f.input.value,'이전 초안');
  f.input.value='이어서 작성한 초안';f.input.fire('input');f.view.destroy();assert.equal(draft.value,'이어서 작성한 초안');assert.equal(draft.pending,false);
});

test('a successful send finishing after the popup closes clears its retained draft',async t=>{
  let finish;const pending=new Promise(resolve=>{finish=resolve;}),draft={value:'',pending:false,revision:0},f=await fixture(t,{draft,send:()=>pending});
  f.input.value='모바일 설정 열기';const sending=f.form.onsubmit({preventDefault(){}});assert.equal(draft.pending,true);f.view.destroy();finish();await sending;
  assert.equal(draft.value,'');assert.equal(draft.pending,false);
});

test('unconfigured mobile explains server setup without claiming retry will fix it or hiding the room chat',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {mount}=dom(),requests=[],statuses=[];const view=createMobileWorkspace({mount,roomId:'room-A',api:async path=>{requests.push(path);throw Object.assign(new Error('Mobile devices are not connected'),{code:'MOBILE_NOT_CONFIGURED',status:503});},onStatus:(message,kind)=>statuses.push({message,kind}),mobileChat:{load:async()=>({messages:[],readOnly:false}),send:async()=>{}}});
  t.after(()=>view.destroy());
  await flush();
  const message=find(mount,'mobile-screen-message').textContent;
  assert.equal(message,'모바일 기기가 아직 연결되지 않았습니다. 서버의 Android 설정이 필요합니다.');
  assert.deepEqual(statuses,[{message,kind:''}]);
  assert.equal(find(mount,'mobile-workspace').dataset.state,'unavailable');
  assert.equal(buttonBy(mount,'모바일 깨우기').disabled,true);
  assert.equal(find(mount,'mobile-chat-input').disabled,false);
  t.mock.timers.tick(5000);await flush();
  assert.deepEqual(requests,['/api/rooms/room-A/mobile']);
});

test('temporary mobile connection errors retain retry guidance and recover on the next status check',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {mount}=dom(),requests=[],statuses=[];
  const view=createMobileWorkspace({mount,roomId:'room-A',api:async path=>{
    requests.push(path);
    if(requests.length===1)throw Object.assign(new Error('Temporary connection failure'),{code:'MOBILE_UNAVAILABLE',status:503});
    return {device:{state:'sleeping'},readOnly:true};
  },onStatus:(message,kind)=>statuses.push({message,kind})});
  t.after(()=>view.destroy());
  await flush();
  assert.match(find(mount,'mobile-screen-message').textContent,/잠시 후 다시 연결/);
  assert.equal(statuses.at(-1).kind,'error');
  t.mock.timers.tick(5000);await flush();
  assert.equal(requests.length,2);
  assert.equal(find(mount,'mobile-workspace').dataset.state,'sleeping');
  assert.match(find(mount,'mobile-screen-message').textContent,/휴면 중/);
  assert.equal(statuses.at(-1).kind,'');
});

test('preparing VM remains visible and duplicate wake is disabled until a real Android frame loads',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const {mount}=dom(),requests=[],statuses=[];let state='starting',finishFrame,frameRequests=0;
  const originalFetch=globalThis.fetch;
  globalThis.fetch=()=>{frameRequests++;return new Promise(resolve=>{finishFrame=resolve;});};
  const view=createMobileWorkspace({mount,roomId:'room-A',api:async path=>{
    requests.push(path);
    if(path.endsWith('/observe'))return {width:720,height:1560,nodes:[]};
    return {device:{state},capacity:{running:1,maxRunning:1}};
  },onStatus:(message,kind)=>statuses.push({message,kind}),mobileChat:{load:async()=>({messages:[],readOnly:false}),send:async()=>{}}});
  t.after(()=>{view.destroy();globalThis.fetch=originalFetch;});
  await flush();
  assert.match(find(mount,'mobile-screen-message').textContent,/준비하는 중.*몇 분/);
  assert.equal(buttonBy(mount,'모바일 깨우기').disabled,true);
  buttonBy(mount,'모바일 깨우기').onclick();await flush();
  assert.ok(requests.every(path=>!path.endsWith('/wake')));
  assert.equal(frameRequests,0);
  assert.equal(find(mount,'mobile-chat-input').disabled,false,'room chat stays usable during cold boot');
  state='running';t.mock.timers.tick(5000);await flush();
  assert.equal(frameRequests,1);
  assert.match(find(mount,'mobile-screen-message').textContent,/화면을 불러오는 중/);
  assert.ok(statuses.every(status=>status.kind!=='ready'));
  finishFrame(new Response(new Uint8Array([1,2,3]),{headers:{'content-type':'image/png'}}));await flush();
  assert.ok(statuses.every(status=>status.kind!=='ready'),'response bytes alone do not prove the image decoded');
  const image=find(mount,'mobile-screen-image');image.naturalWidth=720;image.naturalHeight=1560;image.fire('load');
  assert.deepEqual(statuses.at(-1),{message:'Android 연결됨',kind:'ready'});
  assert.equal(image.hidden,false);
  assert.equal(buttonBy(mount,'모바일 화면 확대').disabled,false);
});

test('asynchronous capacity failures show their actual cause and allow an explicit retry',async t=>{
  const {mount}=dom(),requests=[],statuses=[];
  const view=createMobileWorkspace({mount,roomId:'room-A',api:async path=>{
    requests.push(path);return {device:{state:'error',lastError:'device_capacity_busy'}};
  },onStatus:(message,kind)=>statuses.push({message,kind}),mobileChat:{load:async()=>({messages:[],readOnly:false}),send:async()=>{}}});
  t.after(()=>view.destroy());await flush();
  assert.match(find(mount,'mobile-screen-message').textContent,/다른 모바일이 실행 중/);
  assert.equal(statuses.at(-1).kind,'error');
  assert.equal(buttonBy(mount,'모바일 깨우기').disabled,false);
  assert.ok(requests.every(path=>!path.endsWith('/wake')),'failed boots are not retried indefinitely');
  buttonBy(mount,'모바일 깨우기').onclick();await flush();
  assert.equal(requests.filter(path=>path.endsWith('/wake')).length,1);
});
