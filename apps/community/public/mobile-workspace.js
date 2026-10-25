const node=(document,tag,text,className)=>{const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(className)element.className=className;return element;};
const button=(document,label,text=label)=>{const element=node(document,'button',text,'workspace-button');element.type='button';element.setAttribute('aria-label',label);element.title=label;return element;};
const clamp=(value,min,max)=>Math.max(min,Math.min(max,value));

/** object-fit:contain leaves letterboxing; only actual device pixels are interactive. */
export function mobileFramePoint(rect,width,height,clientX,clientY) {
  if(![rect?.left,rect?.top,rect?.width,rect?.height,width,height,clientX,clientY].every(Number.isFinite)||width<=0||height<=0||rect.width<=0||rect.height<=0)return null;
  const scale=Math.min(rect.width/width,rect.height/height),left=rect.left+(rect.width-width*scale)/2,top=rect.top+(rect.height-height*scale)/2;
  const x=(clientX-left)/scale,y=(clientY-top)/scale;
  return x>=0&&y>=0&&x<width&&y<height?{x:Math.min(width-1,Math.floor(x+1e-7)),y:Math.min(height-1,Math.floor(y+1e-7))}:null;
}
export function mobileGesture(start,end,{elapsed=0,moved=false,cancelled=false}={}) {
  if(cancelled||!start||!end)return null;
  if(!moved&&Math.hypot(end.x-start.x,end.y-start.y)<12&&elapsed<500)return {type:'tap',x:start.x,y:start.y};
  return {type:'swipe',x1:start.x,y1:start.y,x2:end.x,y2:end.y,duration:clamp(Math.round(elapsed)||300,100,2000)};
}
export function mobileWheel(point,delta,width,height) {
  if(!point||![width,height,delta].every(Number.isFinite)||width<1||height<1||!delta)return null;
  const travel=Math.min(height*.42,Math.max(80,Math.abs(delta))),sign=Math.sign(delta),half=travel/2;
  return {type:'swipe',x1:clamp(point.x,0,width-1),y1:clamp(point.y+sign*half,0,height-1),x2:clamp(point.x,0,width-1),y2:clamp(point.y-sign*half,0,height-1),duration:300};
}
export function mobileEditableAt(point,regions) {
  if(!point||!Array.isArray(regions))return null;
  return regions.find(region=>region&&[region.x,region.y,region.width,region.height].every(Number.isFinite)&&region.width>0&&region.height>0&&point.x>=region.x&&point.x<region.x+region.width&&point.y>=region.y&&point.y<region.y+region.height)||null;
}
export function mobileEditableRegions(data) {
  if(!Array.isArray(data?.nodes))return [];
  return data.nodes.filter(item=>item?.editable&&item.enabled!==false).map(item=>({x:item.bounds?.left,y:item.bounds?.top,width:item.bounds?.right-item.bounds?.left,height:item.bounds?.bottom-item.bounds?.top,inputMode:item.inputMode})).filter(region=>[region.x,region.y,region.width,region.height].every(Number.isFinite)&&region.x>=0&&region.y>=0&&region.width>0&&region.height>0);
}
const SEED='\u200b';
const chars=value=>Array.from(value.replaceAll(SEED,''));
export function mobileTextEdit(previous,next) {
  const before=chars(previous),after=chars(next);let common=0;
  while(common<before.length&&common<after.length&&before[common]===after[common])common++;
  const operations=[];
  const deletes=previous===SEED&&next===''?1:before.length-common;
  for(let i=0;i<deletes;i++)operations.push({type:'key',key:'DEL'});
  if(after.length>common){
    const parts=after.slice(common).join('').split(/(\r\n|\r|\n|\t)/);
    for(const part of parts){if(!part)continue;if(/^[\r\n]+$/.test(part))operations.push({type:'key',key:'ENTER'});else if(part==='\t')operations.push({type:'key',key:'TAB'});else {const clean=Array.from(part.replace(/[\x00-\x1f\x7f-\x9f]/g,''));for(let offset=0;offset<clean.length;offset+=1000)operations.push({type:'text',text:clean.slice(offset,offset+1000).join('')});}}
  }
  return operations;
}

/** Real native input focused synchronously from a known Android editable tap. */
export function createMobileKeyboard({viewport,send,canInput=()=>true,onChange=()=>{}}) {
  const document=viewport.ownerDocument,input=node(document,'textarea',undefined,'mobile-native-keyboard');
  input.rows=1;input.maxLength=4096;input.tabIndex=-1;input.disabled=true;
  for(const [key,value]of Object.entries({'aria-label':'모바일 기기에 입력',autocapitalize:'off',autocorrect:'off',autocomplete:'off',spellcheck:'false','data-lpignore':'true',inputmode:'text'}))input.setAttribute(key,value);
  viewport.append(input);let enabled=false,disposed=false,composing=false,previous=SEED;
  const listeners=[];const listen=(type,handler)=>{input.addEventListener(type,handler);listeners.push(()=>input.removeEventListener(type,handler));};
  const reset=()=>{previous=SEED;input.value=SEED;input.setSelectionRange?.(1,1);};
  const flush=()=>{if(!enabled||disposed||!canInput()||composing)return;const next=input.value;if(next===previous)return;for(const action of mobileTextEdit(previous,next))send(action);previous=next;if(!next||chars(next).length>256)reset();};
  const deactivate=()=>{if(enabled)flush();enabled=false;composing=false;reset();input.disabled=true;input.blur();onChange(false);};
  listen('compositionstart',()=>{composing=true;});listen('compositionend',()=>{composing=false;flush();});listen('input',event=>{if(!event.isComposing)flush();});
  listen('beforeinput',event=>{if(!enabled||!canInput()||composing||event.isComposing)return;if(['insertLineBreak','insertParagraph'].includes(event.inputType)){event.preventDefault();flush();send({type:'key',key:'ENTER'});reset();}});
  listen('keydown',event=>{event.stopPropagation();if(!enabled||!canInput()||composing||event.isComposing||event.keyCode===229)return;const keys={Enter:'ENTER',Backspace:'DEL',ArrowLeft:'DPAD_LEFT',ArrowRight:'DPAD_RIGHT',ArrowUp:'DPAD_UP',ArrowDown:'DPAD_DOWN',Tab:'TAB',Escape:'BACK'};if(keys[event.key]){event.preventDefault();flush();send({type:'key',key:keys[event.key]});reset();}});
  listen('keyup',event=>event.stopPropagation());listen('blur',()=>{composing=false;flush();reset();enabled=false;input.disabled=true;onChange(false);});reset();
  return {
    focus(region={}){if(disposed||!canInput())return false;if(!enabled)reset();enabled=true;input.disabled=false;input.setAttribute('inputmode',['text','email','url','tel','numeric','decimal','search'].includes(region.inputMode)?region.inputMode:'text');input.focus({preventScroll:true});onChange(true);return true;},
    flush,deactivate,
    destroy(){if(disposed)return;deactivate();disposed=true;for(const remove of listeners)remove();input.value='';input.remove();},
  };
}

async function screenshotBlob(url,signal) {
  const response=await fetch(url,{credentials:'same-origin',cache:'no-store',redirect:'error',signal});
  if(!response.ok)throw new Error(response.status===409?'모바일 기기를 깨운 뒤 다시 연결해주세요.':'모바일 화면을 불러오지 못했습니다.');
  if(!/^image\/(?:png|jpeg|webp)(?:;|$)/i.test(response.headers.get('content-type')||'')){await response.body?.cancel();throw new Error('모바일 화면 응답을 확인할 수 없습니다.');}
  if(Number(response.headers.get('content-length'))>8*1024*1024){await response.body?.cancel();throw new Error('모바일 화면 크기가 너무 큽니다.');}
  const reader=response.body?.getReader();if(!reader)throw new Error('모바일 화면 응답이 없습니다.');const parts=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>8*1024*1024)throw new Error('모바일 화면 크기가 너무 큽니다.');parts.push(value);}}finally{await reader.cancel().catch(()=>{});}
  return new Blob(parts,{type:response.headers.get('content-type')});
}

/** Each instance captures one immutable room id; it never retargets another phone. */
export function createMobileWorkspace({mount,api,roomId,signal,mobileChat,draft={value:'',pending:false,revision:0},onStatus=()=>{},onExpand=()=>{},onKeyboard=()=>{}}) {
  const document=mount.ownerDocument,base=`/api/rooms/${encodeURIComponent(roomId)}/mobile`,abort=new AbortController();
  const root=node(document,'section',undefined,'mobile-workspace');root.setAttribute('aria-label','이 대화의 모바일');
  const toolbar=node(document,'div',undefined,'mobile-toolbar'),deviceLabel=node(document,'strong','Android'),capacity=node(document,'span','','mobile-capacity'),wake=button(document,'모바일 깨우기','깨우기'),sleep=button(document,'모바일 휴면','휴면'),expand=button(document,'모바일 화면 확대','확대');
  toolbar.append(deviceLabel,capacity,wake,sleep,expand);
  const scroller=node(document,'div',undefined,'mobile-workspace-scroll'),screen=node(document,'div',undefined,'mobile-screen'),image=node(document,'img',undefined,'mobile-screen-image'),screenMessage=node(document,'p','모바일 상태를 확인하는 중…','mobile-screen-message');
  image.alt='이 대화의 Android 화면';image.draggable=false;image.hidden=true;image.tabIndex=0;image.setAttribute('aria-label','Android 화면 · 터치 또는 스와이프로 조작');screen.append(image,screenMessage);
  const navigation=node(document,'div',undefined,'mobile-navigation'),back=button(document,'Android 뒤로','뒤로'),home=button(document,'Android 홈','홈'),recent=button(document,'Android 최근 앱','최근 앱');navigation.append(back,home,recent);
  const transcript=node(document,'div',undefined,'mobile-chat-history');transcript.setAttribute('role','log');transcript.setAttribute('aria-label','이 대화의 메시지');
  const chatState=node(document,'div','','mobile-chat-state');chatState.setAttribute('role','status');
  const form=node(document,'form',undefined,'mobile-chat-form'),input=node(document,'textarea',undefined,'mobile-chat-input'),submit=button(document,'이 대화의 AI에게 보내기','↑');submit.type='submit';input.rows=2;input.maxLength=12000;input.value=draft.value||'';input.placeholder='이 모바일에서 무엇을 할까요?';input.setAttribute('aria-label','이 대화의 AI에게 요청');form.append(input,submit);
  scroller.append(screen,navigation,transcript);root.append(toolbar,scroller,chatState,form);mount.replaceChildren(root);
  let disposed=false,running=false,deviceWarning='',frameReady=false,readOnly=false,sending=false,operating=false,chatReady=false,width=720,height=1560,frameUrl=null,regions=[],regionsObservedAt=null,aiBusy=false,screenBusy=false,screenAbort=null,statusBusy=false,chatBusy=false,screenEpoch=0,regionRevision=0,statusReady=false,connectionUnavailable=false,deviceState='unallocated',initialWakeAttempted=false,pointer=null,wheelAt=0,expanded=false,pendingInputs=0,inputQueue=Promise.resolve(),chatVersion='',draftRevision=draft.revision||0;
  const timers=new Map(),listeners=[];
  const active=()=>!disposed&&!abort.signal.aborted&&!document.hidden;
  const schedule=(fn,delay)=>{if(!active())return;clearTimeout(timers.get(fn));const timer=setTimeout(()=>{timers.delete(fn);if(active())void fn();},delay);timers.set(fn,timer);};
  const clearTimers=()=>{for(const timer of timers.values())clearTimeout(timer);timers.clear();};
  const listen=(target,type,handler,options)=>{target.addEventListener(type,handler,options);listeners.push(()=>target.removeEventListener(type,handler,options));};
  const errorMessage=error=>({MOBILE_NOT_CONFIGURED:'모바일 기기가 아직 연결되지 않았습니다. 서버의 Android 설정이 필요합니다.',MOBILE_CONFIG_INVALID:'모바일 서버 연결 설정을 확인해주세요.',MOBILE_AUTH_FAILED:'모바일 서버 연결 인증을 확인해주세요.',MOBILE_UNAVAILABLE:'모바일 서버에 연결할 수 없습니다. 잠시 후 다시 연결해주세요.',MOBILE_TIMEOUT:'기기를 준비하는 데 시간이 걸리고 있습니다. 잠시 후 다시 연결해주세요.',MOBILE_PREPARING:'Android를 준비하고 있습니다. 준비가 끝나면 이 화면에서 이어집니다.',device_capacity_busy:'다른 모바일이 실행 중입니다. 한 대를 휴면하거나 작업이 끝난 뒤 깨워주세요.',device_slots_full:'저장할 수 있는 모바일 수를 채웠습니다.',device_queue_timeout:'다른 모바일 작업이 진행 중입니다. 잠시 후 다시 시도해 주세요.',device_operation_timeout:'Android 작업이 지연되고 있습니다. 화면을 확인한 뒤 다시 시도해 주세요.',device_operation_cancelled:'Android 작업이 취소되었습니다. 화면을 확인한 뒤 다시 시도해 주세요.',guest_request_timeout:'Android 응답이 지연되고 있습니다. 잠시 후 다시 시도해 주세요.',guest_connection_failed:'Android 연결이 끊겼습니다. 상태를 확인한 뒤 다시 연결해 주세요.',guest_operation_failed:'Android 작업을 완료하지 못했습니다. 화면을 확인한 뒤 다시 시도해 주세요.',device_operation_failed:'Android 작업을 완료하지 못했습니다. 화면을 확인한 뒤 다시 시도해 주세요.',device_busy:'AI가 이 모바일에서 작업 중입니다. 작업이 끝나면 휴면할 수 있습니다.',device_sleeping:'모바일이 휴면 중입니다. 깨우기를 눌러주세요.',vm_boot_timeout:'모바일 가상 컴퓨터를 시작하지 못했습니다. 다시 깨워주세요.',device_boot_timeout:'Android 준비가 완료되지 않았습니다. 다시 깨워주세요.',device_keyboard_timeout:'키보드 연결이 지연되고 있습니다. 다시 연결해 주세요.',device_display_timeout:'Android는 실행 중이지만 화면이 아직 켜지지 않았습니다. 화면 다시 켜기를 눌러 주세요.',vm_start_failed:'모바일을 시작하지 못했습니다. 서버 실행 환경을 확인해주세요.',vm_stop_failed:'이전 모바일이 종료되는 중입니다. 잠시 후 다시 깨워주세요.',vm_recovery_required:'모바일 서버가 다시 시작되었습니다. 깨우기를 눌러 이어주세요.',text_unicode_unsupported:'이 모바일의 키보드가 해당 문자를 아직 지원하지 않습니다.'}[error?.code]||error?.message||'연결하지 못했습니다. 다시 시도해주세요.');
  const error=error=>{if(active()&&error?.name!=='AbortError')onStatus(errorMessage(error),error?.code==='MOBILE_NOT_CONFIGURED'?'':'error');};
  const preparing=()=>['starting','booting'].includes(deviceState);
  const recoveryLabel=()=>({device_display_timeout:'화면 다시 켜기',device_keyboard_timeout:'키보드 다시 연결'}[deviceWarning]||'');
  const refreshControls=()=>{expand.disabled=!running||!frameReady;wake.textContent=recoveryLabel()||'깨우기';wake.setAttribute('aria-label',recoveryLabel()||'모바일 깨우기');wake.disabled=!active()||connectionUnavailable||operating||preparing()||(running&&!deviceWarning)||readOnly;sleep.disabled=!active()||connectionUnavailable||operating||!running||readOnly;for(const control of [back,home,recent])control.disabled=!active()||!running||operating||readOnly;input.readOnly=readOnly;input.disabled=!mobileChat?.send||!chatReady;submit.disabled=!mobileChat?.send||!chatReady||readOnly||sending||draft.pending||!input.value.trim();image.setAttribute('aria-disabled',String(!running||readOnly));};
  const invalidateRegions=()=>{regions=[];regionsObservedAt=null;regionRevision++;};
  const updateDimensions=(nextWidth,nextHeight)=>{const w=Number.isFinite(nextWidth)&&nextWidth>0?nextWidth:width,h=Number.isFinite(nextHeight)&&nextHeight>0?nextHeight:height;if(w!==width||h!==height)invalidateRegions();width=w;height=h;};
  const tryAutoWake=()=>{if(!active()||!statusReady||!chatReady||readOnly||initialWakeAttempted)return;initialWakeAttempted=true;if(['sleeping','stopped','unallocated','unassigned'].includes(deviceState))void power('wake');};
  const sendAction=action=>{
    if(!action||!active()||!running||readOnly||operating)return Promise.resolve();
    const epoch=screenEpoch;invalidateRegions();pendingInputs++;screenAbort?.abort();clearTimeout(timers.get(pollScreen));timers.delete(pollScreen);
    inputQueue=inputQueue.then(async()=>{if(!active()||!running||readOnly||epoch!==screenEpoch)return;await api(base+'/input',{method:'POST',body:JSON.stringify(action),signal:abort.signal});}).catch(error).finally(()=>{pendingInputs--;if(!pendingInputs&&active()&&running&&!operating)requestScreen();});
    return inputQueue;
  };
  const keyboard=createMobileKeyboard({viewport:screen,send:sendAction,canInput:()=>active()&&running&&!readOnly&&!operating,onChange:onKeyboard});
  const revokeFrame=()=>{if(frameUrl)URL.revokeObjectURL(frameUrl);frameUrl=null;frameReady=false;image.removeAttribute('src');image.hidden=true;};
  async function frame(readSignal,epoch) {
    try{const blob=await screenshotBlob(base+'/screenshot',readSignal);if(readSignal.aborted||!active()||!running||epoch!==screenEpoch)return false;
      // Clock/cursor animations do not invalidate semantic input bounds. Known
      // mutations, geometry changes and a short observation lifetime do instead.
      const next=URL.createObjectURL(blob),previous=frameUrl;frameUrl=next;image.src=next;if(previous)URL.revokeObjectURL(previous);return true;}
    catch(cause){if(!readSignal.aborted&&active()&&epoch===screenEpoch){if(!frameReady){screenMessage.hidden=false;screenMessage.textContent=errorMessage(cause);}error(cause);}return false;}
  }
  async function observe(readSignal,epoch) {
    const revision=regionRevision;
    try{const data=await api(base+'/observe',{signal:readSignal});if(readSignal.aborted||!active()||!running||epoch!==screenEpoch||revision!==regionRevision)return;updateDimensions(data.width,data.height);regions=mobileEditableRegions(data);regionsObservedAt=Date.now();}
    catch{if(!readSignal.aborted&&epoch===screenEpoch&&revision===regionRevision)invalidateRegions();}
  }
  // The Android broker serializes device operations. One completion-driven loop
  // avoids queuing a second expensive screen read while the first is still busy.
  async function pollScreen() {
    if(screenBusy||pendingInputs||!active()||!running||operating)return;
    clearTimeout(timers.get(pollScreen));timers.delete(pollScreen);
    screenBusy=true;const controller=new AbortController(),epoch=screenEpoch;screenAbort=controller;
    const cancel=()=>controller.abort();abort.signal.addEventListener('abort',cancel,{once:true});
    try{if(await frame(controller.signal,epoch)&&!controller.signal.aborted&&active()&&running&&!operating&&!aiBusy&&epoch===screenEpoch)await observe(controller.signal,epoch);}
    finally{abort.signal.removeEventListener('abort',cancel);screenBusy=false;if(screenAbort===controller)screenAbort=null;if(active()&&running&&!operating&&!pendingInputs)schedule(pollScreen,aiBusy?3000:1000);}
  }
  const requestScreen=()=>{if(!screenBusy&&!timers.has(pollScreen))void pollScreen();};
  function applyStatus(data) {
    const device=data.device||data,state=device.state||device.status||'unassigned';running=state==='running';deviceWarning=running&&['device_keyboard_timeout','device_display_timeout'].includes(device.lastError)?device.lastError:'';deviceState=state;statusReady=true;
    if(Boolean(data.readOnly??readOnly)!==readOnly)invalidateRegions();readOnly=Boolean(data.readOnly??readOnly);updateDimensions(device.width,device.height);
    const counts=data.capacity||data;capacity.textContent=Number.isFinite(counts.running)?`${counts.running} / ${counts.maxRunning||2} 실행 중`:'';
    deviceLabel.textContent=device.name||'Android';root.dataset.state=state;
    const startingMessage='이 대화의 Android를 준비하는 중… 처음에는 몇 분 걸릴 수 있습니다.';
    const messages={unallocated:'이 대화에 사용할 모바일을 깨워주세요.',error:'모바일 기기를 시작하지 못했습니다. 다시 깨워주세요.',running:frameReady?'Android 연결됨':'Android 화면을 불러오는 중…',starting:startingMessage,booting:startingMessage,sleeping:'기기가 휴면 중입니다. 깨우면 앱과 파일이 그대로 이어집니다.',stopped:'기기가 휴면 중입니다. 깨우면 앱과 파일이 그대로 이어집니다.',unassigned:'이 대화에 사용할 모바일을 깨워주세요.',unavailable:'모바일 서버가 아직 연결되지 않았습니다.'};
    const message=deviceWarning||state==='error'&&device.lastError?errorMessage({code:device.lastError}):messages[state]||'모바일 상태를 확인해주세요.';screenMessage.textContent=message;screenMessage.hidden=running&&frameReady;
    if(!running){screenEpoch++;screenAbort?.abort();keyboard.deactivate();invalidateRegions();revokeFrame();}else requestScreen();
    onStatus(message,deviceWarning?'warning':running&&frameReady?'ready':state==='error'?'error':'');refreshControls();tryAutoWake();
  }
  async function status() {
    if(statusBusy||!active())return;statusBusy=true;
    try{const data=await api(base,{signal:abort.signal});if(active())applyStatus(data);}
    catch(cause){if(active()){if(['MOBILE_NOT_CONFIGURED','MOBILE_CONFIG_INVALID','MOBILE_AUTH_FAILED'].includes(cause?.code)){connectionUnavailable=true;root.dataset.state='unavailable';running=false;screenEpoch++;keyboard.deactivate();invalidateRegions();revokeFrame();refreshControls();}if([401,403,404].includes(cause?.status)){running=false;readOnly=true;screenEpoch++;keyboard.deactivate();invalidateRegions();revokeFrame();refreshControls();}screenMessage.textContent=errorMessage(cause);error(cause);}}
    finally{statusBusy=false;if(active()&&!connectionUnavailable)schedule(status,5000);}
  }
  async function power(operation) {
    if(operating||!active()||readOnly||operation==='wake'&&preparing())return;operating=true;screenEpoch++;screenAbort?.abort();pointer=null;keyboard.deactivate();invalidateRegions();refreshControls();
    try{await inputQueue;if(!active())return;const data=await api(base+'/'+operation,{method:'POST',body:'{}',signal:abort.signal});if(active())applyStatus(data);}
    catch(cause){error(cause);}finally{operating=false;refreshControls();if(active())void status();}
  }
  const point=event=>mobileFramePoint(image.getBoundingClientRect(),width,height,event.clientX,event.clientY);
  listen(image,'pointerdown',event=>{if(event.button!==0||!running||readOnly||operating||!active()||pointer)return;const start=point(event);if(!start)return;event.preventDefault();keyboard.flush();pointer={id:event.pointerId,start,last:start,time:Date.now(),clientX:event.clientX,clientY:event.clientY,moved:false};image.setPointerCapture?.(event.pointerId);});
  listen(image,'pointermove',event=>{if(!pointer||pointer.id!==event.pointerId)return;pointer.moved||=Math.hypot(event.clientX-pointer.clientX,event.clientY-pointer.clientY)>8;pointer.last=point(event)||pointer.last;if(pointer.moved)invalidateRegions();});
  const endPointer=(event,cancelled=false)=>{if(!pointer||pointer.id!==event.pointerId)return;const gesture=pointer;pointer=null;try{image.releasePointerCapture?.(event.pointerId);}catch{}const action=mobileGesture(gesture.start,point(event)||gesture.last,{elapsed:Date.now()-gesture.time,moved:gesture.moved,cancelled});const editable=action?.type==='tap'&&regionsObservedAt!==null&&Date.now()-regionsObservedAt<30000?mobileEditableAt(gesture.start,regions):null;if(action)void sendAction(action);if(editable)keyboard.focus(editable);else keyboard.deactivate();};
  listen(image,'pointerup',event=>endPointer(event));listen(image,'pointercancel',event=>endPointer(event,true));listen(image,'lostpointercapture',()=>{pointer=null;});
  listen(image,'wheel',event=>{const target=point(event);if(!target||!running||readOnly||!active())return;event.preventDefault();keyboard.deactivate();if(Date.now()-wheelAt<250)return;wheelAt=Date.now();void sendAction(mobileWheel(target,event.deltaY*(event.deltaMode===1?16:event.deltaMode===2?height:1),width,height));},{passive:false});
  listen(image,'contextmenu',event=>event.preventDefault());listen(image,'load',()=>{if(active()&&running&&frameUrl&&image.naturalWidth>0&&image.naturalHeight>0){updateDimensions(image.naturalWidth,image.naturalHeight);frameReady=true;image.hidden=false;screenMessage.hidden=true;onStatus(deviceWarning?errorMessage({code:deviceWarning}):'Android 연결됨',deviceWarning?'warning':'ready');refreshControls();}});
  listen(image,'error',()=>{if(!active()||!running)return;frameReady=false;image.hidden=true;screenMessage.hidden=false;screenMessage.textContent='모바일 화면을 불러오지 못했습니다. 다시 연결하고 있습니다.';onStatus(screenMessage.textContent,'error');refreshControls();});
  back.onclick=()=>void sendAction({type:'key',key:'BACK'});home.onclick=()=>void sendAction({type:'key',key:'HOME'});recent.onclick=()=>void sendAction({type:'key',key:'APP_SWITCH'});
  wake.onclick=()=>void power('wake');sleep.onclick=()=>void power('sleep');expand.onclick=()=>{expanded=!expanded;root.classList.toggle('is-expanded',expanded);expand.textContent=expanded?'축소':'확대';expand.setAttribute('aria-label',expanded?'모바일 화면 축소':'모바일 화면 확대');onExpand(expanded);};

  const syncDraft=()=>{if(draftRevision!==(draft.revision||0)){input.value=draft.value||'';draftRevision=draft.revision||0;}};
  const saveDraft=()=>{draft.value=input.value;draft.revision=(draft.revision||0)+1;draftRevision=draft.revision;refreshControls();};
  async function chat() {
    if(chatBusy||!active()||!mobileChat?.load)return;chatBusy=true;
    try{const data=await mobileChat.load(roomId,{signal:abort.signal});if(!active())return;syncDraft();chatReady=true;if(!!data.readOnly!==readOnly)invalidateRegions();readOnly=!!data.readOnly;if(Boolean(data.busy)!==aiBusy){aiBusy=Boolean(data.busy);invalidateRegions();}const messages=(Array.isArray(data.messages)?data.messages:[]).slice(-50),version=JSON.stringify(messages);
      if(version!==chatVersion){const stick=chatVersion!==''&&scroller.scrollHeight-scroller.clientHeight-scroller.scrollTop<60;chatVersion=version;transcript.replaceChildren();for(const message of messages){const content=typeof message.content==='string'?message.content:typeof message.text==='string'?message.text:'';if(!content)continue;const row=node(document,'div',undefined,'mobile-chat-message');const role=message.role||(message.kind==='human'?'user':message.kind==='bot'?'assistant':'system');row.dataset.role=role;const author=node(document,'small',message.authorName||message.author||(role==='user'?'나':role==='assistant'?'AI':'알림')),text=node(document,'p',content);row.append(author,text);transcript.append(row);}if(stick)scroller.scrollTop=scroller.scrollHeight;}
      chatState.textContent=readOnly?'가지치기한 원본입니다. 새 가지에서 요청해주세요.':data.busy?'AI가 작업 중입니다. 추가 요청은 같은 대화에 이어집니다.':'';if(readOnly)keyboard.deactivate();refreshControls();tryAutoWake();
    }catch(cause){if(active())chatState.textContent=errorMessage(cause);}finally{chatBusy=false;if(active())schedule(chat,2500);}
  }
  input.addEventListener('input',saveDraft);input.addEventListener('keydown',event=>{if(event.key==='Enter'&&!event.shiftKey&&!event.isComposing&&!matchMedia('(pointer:coarse)').matches){event.preventDefault();form.requestSubmit();}});
  form.onsubmit=async event=>{event.preventDefault();const content=input.value.trim();if(!content||sending||draft.pending||readOnly||!active()||!chatReady||!mobileChat?.send)return;saveDraft();sending=true;draft.pending=true;refreshControls();chatState.textContent='';
    try{await mobileChat.send(roomId,content);if((draft.value||'').trim()===content){draft.value='';draft.revision=(draft.revision||0)+1;}if(!active())return;syncDraft();await chat();}
    catch(cause){if(active())chatState.textContent=errorMessage(cause);}finally{sending=false;draft.pending=false;if(active())refreshControls();}
  };
  listen(document,'visibilitychange',()=>{if(!active()){clearTimers();screenEpoch++;screenAbort?.abort();pointer=null;keyboard.deactivate();invalidateRegions();}else{void status();void chat();}refreshControls();});
  function destroy() {if(disposed)return;disposed=true;abort.abort();clearTimers();for(const remove of listeners)remove();signal?.removeEventListener('abort',destroy);keyboard.destroy();revokeFrame();pointer=null;root.remove();}
  if(signal?.aborted)destroy();else{signal?.addEventListener('abort',destroy,{once:true});refreshControls();void status();void chat();}
  return {destroy};
}
