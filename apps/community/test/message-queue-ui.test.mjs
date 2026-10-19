import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';

const queueSource = readFileSync(new URL('../public/message-queue.js', import.meta.url), 'utf8').replace('export function', 'function');
const appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const deferred = () => {let resolve, reject; const promise = new Promise((yes, no) => {resolve=yes; reject=no;}); return {promise, resolve, reject};};
const tick = () => new Promise(resolve => setImmediate(resolve));
function setupQueue({response, refresh} = {}) {
  class Element {
    constructor(tag) {this.tagName=tag; this.children=[]; this.dataset={}; this.attributes={}; this.isConnected=true; this.textContent='';}
    append(...items) {for(const item of items) {item.parent=this; this.children.push(item);}}
    prepend(item) {item.parent=this; this.children.unshift(item);}
    setAttribute(key,value) {this.attributes[key]=value;}
    querySelectorAll(selector) {return this.children.flatMap(child=>[...((selector.startsWith('.')?child.className===selector.slice(1):child.tagName===selector)?[child]:[]),...child.querySelectorAll(selector)]);}
    querySelector(selector) {return this.querySelectorAll(selector)[0];}
    remove() {this.isConnected=false; if(this.parent)this.parent.children=this.parent.children.filter(item=>item!==this);}
  }
  const document={createElement:tag=>new Element(tag)}, context={document};
  vm.runInNewContext(queueSource+'\nthis.createMessageQueue=createMessageQueue;',context);
  let userId='owner';const calls=[],refreshes=[],toasts=[],form=new Element('form');
  const ui=context.createMessageQueue({getSession:()=>({user:{id:userId}}),api:async(path,options)=>{calls.push({path,options});return response?response():{};},onRefresh:async roomId=>{refreshes.push(roomId);await refresh?.();},toast:value=>toasts.push(value)});
  return {ui,form,calls,refreshes,toasts,setUser:id=>{userId=id;},render(items,roomId='room-1'){ui.render(form,roomId,items);},buttons(){return form.querySelectorAll('button');},text(){const walk=node=>[node.textContent,...node.children.flatMap(walk)];return walk(form).join(' ');}};
}
const item={id:'queue-1',roomId:'room-1',text:'이것도 확인해 줘',authorId:'owner',author:'나',createdAt:1,state:'queued',attachmentNames:['설계.pdf'],canSendNow:true,canCancel:true};

test('server queue renders in its own composer, exposes only permitted controls, and clears on room switch',()=>{
  const app=setupQueue();app.render([item,{...item,id:'foreign',roomId:'room-2'},{...item,id:'read-only',text:'다른 요청',canSendNow:false,canCancel:false}]);
  assert.match(app.text(),/대기 중 · 2/);assert.match(app.text(),/설계.pdf/);assert.equal(app.buttons().length,2);
  assert.equal(app.buttons()[0].textContent,'지금 보내기');assert.match(app.buttons()[0].title,/진행 중인 요청/);
  app.render([], 'room-2');assert.equal(app.form.querySelector('.message-queue'),undefined);
});

test('now and cancel bind the original room/item, avoid repeat clicks and preserve server ownership',async()=>{
  for(const action of ['now','cancel']) {
    const pending=deferred(),app=setupQueue({response:()=>pending.promise});app.render([item]);
    const button=app.buttons()[action==='now'?0:1],first=button.onclick();await button.onclick();
    assert.equal(app.calls.length,1);assert.equal(app.calls[0].path,`/api/rooms/room-1/queue/queue-1${action==='now'?'/send-now':''}`);
    assert.equal(app.calls[0].options.method,action==='now'?'POST':'DELETE');assert.equal(app.buttons().every(button=>button.disabled),true);
    pending.resolve({});await first;assert.deepEqual(app.refreshes,['room-1']);assert.equal(app.buttons().some(button=>button.disabled),false);
  }
});

test('pending actions cannot refresh or show errors after room switch, logout or same-account relogin',async()=>{
  for(const change of ['room','account','reset']) {
    const pending=deferred(),app=setupQueue({response:()=>pending.promise});app.render([item]);const request=app.buttons()[0].onclick();
    if(change==='room')app.render([{...item,roomId:'room-2'}],'room-2');
    if(change==='account')app.setUser('someone-else');
    if(change==='reset')app.ui.reset();
    pending.reject(new Error('late failure'));await request;
    assert.deepEqual(app.refreshes,[]);assert.deepEqual(app.toasts,[]);
  }
});

test('a poll rerender during a failed action unlocks the new row so it can be retried',async()=>{
  const pending=deferred(),app=setupQueue({response:()=>pending.promise});app.render([item]);const request=app.buttons()[0].onclick();
  app.render([item]);assert.equal(app.buttons()[0].disabled,true);pending.reject(new Error('잠시 후 다시 시도해 주세요'));await request;
  assert.equal(app.buttons()[0].disabled,false);assert.deepEqual(app.toasts,['잠시 후 다시 시도해 주세요']);
});

test('steering items show progress and refuse repeat now requests while preserving cancellation',async()=>{
  const app=setupQueue();app.render([{...item,steering:true}]);
  assert.match(app.text(),/진행 중인 요청에 반영 중/);assert.equal(app.buttons()[0].disabled,true);assert.equal(app.buttons()[1].disabled,false);
  await app.buttons()[0].onclick();assert.equal(app.calls.length,0);
  await app.buttons()[1].onclick();assert.equal(app.calls.length,1);assert.equal(app.calls[0].options.method,'DELETE');assert.equal(app.buttons()[0].disabled,true);
});

test('a steering status received during send-now keeps the rerendered now button disabled',async()=>{
  let app;
  app=setupQueue({refresh:()=>app.render([{...item,steering:true}])});app.render([item]);
  await app.buttons()[0].onclick();assert.equal(app.calls.length,1);assert.equal(app.buttons()[0].disabled,true);assert.equal(app.buttons()[1].disabled,false);
});

function functionSource(start,end) {return appSource.slice(appSource.indexOf(start),appSource.indexOf(end,appSource.indexOf(start)));}
function setupSubmit({paneMode=false,busy=true,response}={}) {
  const input={value:'다음 요청',disabled:false,style:{},focus(){}},form={};
  const pane={roomId:'room-1',data:{room:{id:'room-1'},busy},model:'selected-model',effort:'high',draft:input.value};
  const state={session:{user:{id:'owner'}},selectedRoom:'room-1',roomData:pane.data,pendingAttachments:[],selectedBots:['assistant'],extra:[pane],sending:false};
  const pendingMessages=new Map(),calls=[],optimistic=[],paints=[],toasts=[];let nonce=0;
  const elements={'#message-input':input,'#model-select':{value:'selected-model'},'#effort-select':{value:'high'},'#send-button':{disabled:false}};
  const context={agentPresence:{react(){}},state,composerRecorder:{status:"idle",context:null},MONITOR_ROOM:'monitor',Map,Set,JSON,crypto:{randomUUID:()=>`nonce-${++nonce}`},modelChanges:new Map(),branchOperations:new Set(),topicPrompts:new Set(),presenceErrors:new Set(),pendingMessages,
    $:selector=>selector==='textarea'?input:selector==='.model-select'?elements['#model-select']:selector==='.effort-select'?elements['#effort-select']:elements[selector],
    roomContextOwner:current=>({roomId:current?current.roomId:state.selectedRoom,data:current?current.data:state.roomData,busy:current?current.data.busy:state.roomData.busy}),
    contextOwnerCurrent:(roomId,userId,current)=>state.session?.user?.id===userId&&(current?current.roomId===roomId:state.selectedRoom===roomId),
    offerTopicChoice:async()=>false,updateModelAvailability(){},optimisticMessage:async(roomId,text,nonce,attachments)=>{const message={id:`pending:${nonce}`,text,attachments};optimistic.push(message);pendingMessages.set(roomId,message);return message;},
    api:async(path,options)=>{calls.push({path,options});return response?response():{accepted:true,queued:true,queueId:'queue-1'};},
    applyModels(){},clearPendingAttachments(){state.pendingAttachments=[];},refreshRoom:async()=>{},refreshExtra:async()=>{},loadRooms:async()=>{},paintPending:roomId=>paints.push(roomId),toast:text=>toasts.push(text),clearThinking(){},els:{sendingStatus:{}},
  };
  vm.runInNewContext(functionSource('function roomReadOnly(', 'function clearPendingAttachments(')+functionSource('function recordingBlocksSend(', 'function syncRecordingButtons(')+functionSource('async function submitMessage(', 'async function authSubmit(')+functionSource('function composerBlocked(', 'function updateModelAvailability(')+functionSource('async function submitPane(', 'async function refreshExtra(')+'\nthis.submit=()=>'+(paneMode?'submitPane({preventDefault(){},currentTarget:{}},0,true)':'submitMessage({preventDefault(){}},true)')+';',context);
  return {state,pane,input,calls,optimistic,paints,toasts,pendingMessages,submit:context.submit};
}

test('busy main and split composers accept Enter into server queue without a history bubble',async()=>{
  for(const paneMode of [false,true]) {
    const app=setupSubmit({paneMode});await app.submit();
    assert.equal(app.calls.length,1);const payload=JSON.parse(app.calls[0].options.body);
    assert.equal(payload.queueIfBusy,true);assert.equal(payload.model,'selected-model');assert.equal(payload.effort,'high');assert.deepEqual(payload.botIds,['assistant']);
    assert.equal(app.optimistic.length,0);assert.equal(app.pendingMessages.size,0);assert.equal(app.input.value,'');assert.equal(app.input.disabled,false);
  }
});

test('a server-busy race removes the exact optimistic bubble when the request was queued',async()=>{
  for(const paneMode of [false,true]) {
    const app=setupSubmit({paneMode,busy:false});await app.submit();assert.equal(app.optimistic.length,1);assert.equal(app.pendingMessages.size,0);assert.deepEqual(app.paints,['room-1']);
  }
});

test('repeated submit while accepting a queue entry sends once, and main attachments/model remain captured',async()=>{
  const pending=deferred(),app=setupSubmit({response:()=>pending.promise});app.state.pendingAttachments=[{attachment:{id:'file-1',name:'파일'}}];
  const first=app.submit();await tick();await app.submit();assert.equal(app.calls.length,1);
  const payload=JSON.parse(app.calls[0].options.body);assert.deepEqual(payload.attachmentIds,['file-1']);assert.equal(payload.text,'다음 요청');
  pending.resolve({accepted:true,queued:true,queueId:'queue-1'});await first;assert.deepEqual(app.state.pendingAttachments,[]);assert.equal(app.input.disabled,false);
});

test('failed enqueue restores draft without creating a failed chat message',async()=>{
  for(const paneMode of [false,true]) {
    const app=setupSubmit({paneMode,response:()=>Promise.reject(new Error('대기열이 가득 찼습니다'))});await app.submit();
    assert.equal(app.input.value,'다음 요청');assert.equal(app.pendingMessages.size,0);assert.match(app.toasts[0],/가득/);
  }
});
