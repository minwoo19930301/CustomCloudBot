import {createWorkspaceTerminal} from './workspace-terminal.js';
import {configureDesktopInput,enterDesktopScreen} from './desktop-screen.js';
import {createWorkspaceWindows,workspaceBounds} from './workspace-windows.js';
import {createRemoteKeyboard} from './remote-keyboard.js';
import {createMobileWorkspace} from './mobile-workspace.js';
let popupLayer=40;
const VIEWS=[['browser','브라우저'],['mobile','모바일'],['terminal','터미널'],['files','파일']];
const el=(tag,text,className)=>{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;if(className)node.className=className;return node;};
const actionButton=(label,text=label)=>{const button=el('button',text,'workspace-button');button.type='button';button.setAttribute('aria-label',label);button.title=label;return button;};

// X11 keysyms carry case: a lowercase keysym can cancel Shift in x11vnc.
export function sendChromeShortcut(rfb,key,shift=false) {
  const letter=shift?key.toUpperCase():key.toLowerCase(),code='Key'+key.toUpperCase();
  rfb.sendKey(0xffe3,'ControlLeft',true);
  if(shift)rfb.sendKey(0xffe1,'ShiftLeft',true);
  rfb.sendKey(letter.charCodeAt(0),code);
  if(shift)rfb.sendKey(0xffe1,'ShiftLeft',false);
  rfb.sendKey(0xffe3,'ControlLeft',false);
  rfb.focus();
}

export function browserFramePoint(rect,width,height,clientX,clientY) {
  if(!(width>0&&height>0&&rect.width>0&&rect.height>0))return null;
  const scale=Math.min(rect.width/width,rect.height/height),left=rect.left+(rect.width-width*scale)/2,top=rect.top+(rect.height-height*scale)/2;
  const x=(clientX-left)/scale,y=(clientY-top)/scale;
  return x>=0&&y>=0&&x<width&&y<height?{x:Math.floor(x),y:Math.floor(y)}:null;
}
async function boundedFile(url,signal,max=8*1024*1024) {
  const response=await fetch(url,{credentials:'same-origin',signal,redirect:'error'});
  if(!response.ok)throw new Error('파일을 불러오지 못했습니다.');
  if(Number(response.headers.get('content-length'))>max){await response.body?.cancel();throw new Error('미리보기는 8 MiB 이하 파일만 지원합니다.');}
  const reader=response.body?.getReader();if(!reader)throw new Error('파일 응답이 없습니다.');
  const parts=[];let size=0;
  try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>max)throw new Error('미리보기는 8 MiB 이하 파일만 지원합니다.');parts.push(value);}}
  finally{await reader.cancel().catch(()=>{});}
  return new Blob(parts,{type:response.headers.get('content-type')||'application/octet-stream'});
}

/** Independent room popups share the existing remote computer. */
export function createDesktopUI({api,getRoomId,getRoomName=()=>'',toast=()=>{},mount=null,initialView='browser',onViewChange=()=>{},mobileChat=null}) {
  const topbar=mount?.querySelector('.pane-bar')||document.querySelector('.topbar-actions');
  const toggle=actionButton('작업 공간 열기','▣');toggle.className='icon-button desktop-button';toggle.setAttribute('aria-expanded','false');toggle.hidden=true;topbar?.append(toggle);
  const windows=createWorkspaceWindows({
    createWindow:(roomId,options)=>createWorkspaceWindow({api,roomId,getRoomName,initialView,onViewChange,mobileChat,...options}),
    onLimit:()=>toast('열어둔 작업 공간 하나를 닫은 뒤 다시 열어주세요.'),
    onChange:({roomId,open})=>{toggle.hidden=!roomId;toggle.setAttribute('aria-expanded',String(open));},
  });
  toggle.onclick=()=>windows.toggle();
  return {
    setRoom:roomId=>windows.setRoom(roomId),
    openRoom:roomId=>windows.openRoom(roomId||getRoomId?.()),
    closeRoom:roomId=>windows.closeRoom(roomId),
    reset:()=>windows.reset(),
    destroy(){windows.destroy();toggle.remove();},
  };
}
function createWorkspaceWindow({api,roomId,getRoomName,initialView,onViewChange,mobileChat,index,onClose}) {
  const state={roomId,view:VIEWS.some(([id])=>id===initialView)?initialView:'browser',generation:0,abort:null,cleanup:null,destroyed:false,keyboardOpen:false,mobileDraft:{value:'',pending:false,revision:0},paths:new Map()};
  const panel=el('aside',undefined,'desktop-panel workspace-popup');panel.setAttribute('aria-label','작업 공간');panel.setAttribute('role','dialog');panel.dataset.roomId=roomId;panel.hidden=true;
  const head=el('div',undefined,'desktop-head'),title=el('strong','작업 공간'),actions=el('div',undefined,'workspace-window-actions'),fullscreen=actionButton('작업 공간 전체 화면','⛶'),maximize=actionButton('작업 공간 확대','□'),close=actionButton('작업 공간 닫기','×');close.classList.add('workspace-close');actions.append(fullscreen,maximize,close);head.append(title,actions);head.tabIndex=0;head.title='드래그하여 이동 · 방향키로 위치 이동';head.setAttribute('aria-label','작업 공간 창 이동');
  const resize=actionButton('작업 공간 크기 조절','');resize.className='workspace-resize-handle';resize.title='드래그 또는 방향키로 크기 조절';
  const viewportSize=()=>({width:innerWidth,height:state.keyboardOpen&&globalThis.visualViewport?.scale===1?Math.min(innerHeight,visualViewport.height):innerHeight});
  let geometry=workspaceBounds({},viewportSize(),(index%5)*28),beforeMaximize=null,beforeKeyboard=null;
  const raise=()=>{panel.style.zIndex=String(++popupLayer);};
  const layout=next=>{geometry=workspaceBounds(next,viewportSize());for(const [key,value]of Object.entries(geometry))panel.style[key]=value+'px';};
  const keyboardLayout=enabled=>{state.keyboardOpen=enabled;if(enabled){beforeKeyboard||={...geometry};layout(geometry);}else if(beforeKeyboard){const previous=beforeKeyboard;beforeKeyboard=null;layout(previous);}};
  const restore=()=>{beforeMaximize=null;maximize.textContent='□';maximize.setAttribute('aria-label','작업 공간 확대');};
  const setMaximized=()=>{if(beforeMaximize){const previous=beforeMaximize;restore();layout(previous);}else{beforeMaximize={...geometry};layout({left:8,top:8,width:innerWidth-16,height:innerHeight-16});maximize.textContent='❐';maximize.setAttribute('aria-label','작업 공간 크기 복원');}};
  let drag=null;
  const pointerDown=event=>{if(event.button!==0||event.target.closest('button')&&event.currentTarget!==resize)return;event.preventDefault();raise();restore();drag={target:event.currentTarget,id:event.pointerId,x:event.clientX,y:event.clientY,...geometry,resize:event.currentTarget===resize};drag.target.setPointerCapture?.(event.pointerId);};
  const pointerMove=event=>{if(!drag||event.pointerId!==drag.id)return;const dx=event.clientX-drag.x,dy=event.clientY-drag.y;layout(drag.resize?{...drag,width:drag.width+dx,height:drag.height+dy}:{...drag,left:drag.left+dx,top:drag.top+dy});};
  const pointerUp=event=>{if(drag&&event.pointerId===drag.id){try{drag.target.releasePointerCapture?.(event.pointerId);}catch{}drag=null;}};
  for(const target of [head,resize]){target.addEventListener('pointerdown',pointerDown);target.addEventListener('pointermove',pointerMove);target.addEventListener('pointerup',pointerUp);target.addEventListener('pointercancel',pointerUp);target.addEventListener('keydown',event=>{if(event.target!==target||!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(event.key))return;event.preventDefault();restore();const amount=event.shiftKey?40:10,dx=event.key==='ArrowLeft'?-amount:event.key==='ArrowRight'?amount:0,dy=event.key==='ArrowUp'?-amount:event.key==='ArrowDown'?amount:0;layout(target===resize?{...geometry,width:geometry.width+dx,height:geometry.height+dy}:{...geometry,left:geometry.left+dx,top:geometry.top+dy});});}
  fullscreen.onclick=()=>void enterDesktopScreen(panel);maximize.onclick=setMaximized;head.ondblclick=event=>{if(!event.target.closest('button'))setMaximized();};panel.addEventListener('pointerdown',raise);
  const tabs=el('div',undefined,'workspace-tabs');tabs.setAttribute('role','tablist');tabs.setAttribute('aria-label','작업 공간 보기');
  const buttons=new Map();
  for(const [id,label] of VIEWS){const button=actionButton(label);button.setAttribute('role','tab');button.dataset.view=id;button.onclick=()=>{if(state.view!==id){state.view=id;onViewChange(id);void activate();}};buttons.set(id,button);tabs.append(button);}
  tabs.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const available=[...buttons.values()].filter(button=>!button.disabled),index=available.indexOf(document.activeElement);let next=event.key==='Home'?0:event.key==='End'?available.length-1:(index+(event.key==='ArrowRight'?1:-1)+available.length)%available.length;available[next]?.focus();available[next]?.click();});
  const bar=el('div',undefined,'workspace-statusbar'),status=el('span','','desktop-status'),retry=actionButton('작업 공간 다시 연결','다시 연결');status.setAttribute('role','status');bar.append(status,retry);
  const content=el('div',undefined,'workspace-content');content.setAttribute('role','tabpanel');
  panel.append(head,tabs,content,bar,resize);document.body.append(panel);layout(geometry);
  const setStatus=(message,kind='')=>{status.textContent=message;status.dataset.kind=kind;};
  const stop=()=>{state.generation++;state.abort?.abort();state.abort=null;state.cleanup?.();state.cleanup=null;};
  const current=generation=>!state.destroyed&&state.generation===generation&&!panel.hidden&&!document.hidden;
  const empty=message=>{content.replaceChildren(el('div',message,'workspace-empty'));};
  const fail=(error,generation)=>{if(current(generation)&&error?.name!=='AbortError'){setStatus(error.message||'연결하지 못했습니다. 다시 연결해주세요.','error');}};

  async function activate() {
    stop();if(state.destroyed||!state.roomId||panel.hidden||document.hidden)return;
    const generation=state.generation,roomId=state.roomId,abort=new AbortController();state.abort=abort;
    const base=`/api/rooms/${encodeURIComponent(roomId)}/workspace`;
    for(const [id,button] of buttons){button.setAttribute('aria-selected',String(id===state.view));button.tabIndex=id===state.view?0:-1;button.disabled=false;}
    content.setAttribute('aria-label',VIEWS.find(([id])=>id===state.view)?.[1]||'작업 공간');
    empty('작업 공간에 연결하는 중…');setStatus('연결 중…');
    try{
      if(state.view==='mobile'){
        const mobile=createMobileWorkspace({mount:content,api,roomId,signal:abort.signal,mobileChat,draft:state.mobileDraft,onStatus:(message,kind)=>{if(current(generation))setStatus(message,kind);},onExpand:expanded=>{if(expanded&&!beforeMaximize||!expanded&&beforeMaximize)setMaximized();},onKeyboard:keyboardLayout});
        state.cleanup=()=>mobile.destroy();return;
      }
      const available=await api(base,{signal:abort.signal});if(!current(generation))return;
      for(const [id,button] of buttons)button.disabled=id!=='mobile'&&available[id]!==true;
      if(available[state.view]!==true){empty('이 보기는 아직 연결되지 않았습니다.');setStatus('다시 연결하여 상태를 확인할 수 있습니다.');return;}
      if(state.view==='browser')state.cleanup=mountBrowser(base,generation,abort.signal);
      else if(state.view==='files')state.cleanup=mountFiles(base,roomId,generation,abort.signal);
      else{
        const terminal=el('div',undefined,'workspace-terminal');terminal.setAttribute('aria-label','터미널');content.replaceChildren(terminal);
        const instance=await createWorkspaceTerminal({mount:terminal,api,roomId,signal:abort.signal,onStatus:(message,kind)=>{if(current(generation))setStatus(message,kind);}});
        if(!current(generation)){instance.dispose();return;}state.cleanup=()=>instance.dispose();
      }
    }catch(error){if(current(generation)){empty('작업 공간에 연결하지 못했습니다.');fail(error,generation);}}
  }
  function mountBrowser(base,generation,signal) {
    const viewport=el('div',undefined,'workspace-chrome-viewport');viewport.setAttribute('aria-label','원격 Chrome 브라우저');content.replaceChildren(viewport);
    let rfb=null,keyboard=null,disposed=false,connected=false,regions=[],regionsAt=0,regionRequest=null,regionTimer=null,regionGeneration=0;
    // Native input bounds are prefetched: iOS must focus within touchend, not an
    // async fetch callback. Invalidating during scroll avoids stale hit targets.
    const refreshRegions=()=>{
      clearTimeout(regionTimer);
      if(!connected||!active()||regionRequest)return;
      const revision=regionGeneration;
      regionRequest=api(`${base}/browser/input-regions`,{signal}).then(result=>{
        if(active()&&revision===regionGeneration){regions=result.available?result.regions:[];regionsAt=Date.now();}
      }).catch(()=>{regions=[];regionsAt=0;}).finally(()=>{regionRequest=null;if(active()&&connected)regionTimer=setTimeout(refreshRegions,750);});
    };
    const invalidateRegions=({clear=true}={})=>{if(clear){regions=[];regionsAt=0;}regionGeneration++;clearTimeout(regionTimer);regionTimer=setTimeout(refreshRegions,80);};
    const active=()=>!disposed&&current(generation)&&!signal.aborted;
    void(async()=>{
      try{
        const [{default:RFB},ticket]=await Promise.all([import('/vendor/novnc.js'),api(`/api/rooms/${encodeURIComponent(roomId)}/desktop/ticket`,{method:'POST',body:JSON.stringify({view:'browser'}),signal})]);
        if(!active())return;
        const endpoint=new URL(ticket.websocketPath,location.href);
        if(endpoint.origin!==location.origin||endpoint.pathname!==`/api/rooms/${roomId}/desktop/ws`)throw new Error('브라우저 연결 주소를 확인할 수 없습니다.');
        endpoint.protocol=location.protocol==='https:'?'wss:':'ws:';
        rfb=new RFB(viewport,endpoint.href,{shared:true});configureDesktopInput(rfb,false);rfb.qualityLevel=7;rfb.compressionLevel=3;
        const readyStatus=()=>setStatus(keyboard?.enabled?'키보드 입력 중 · 입력칸을 누르면 이어서 입력할 수 있습니다.':matchMedia('(pointer:coarse)').matches?'입력칸을 누르면 키보드가 열립니다.':'Chrome · 탭과 프로필은 브라우저 메뉴에서 관리할 수 있습니다.','ready');
        keyboard=createRemoteKeyboard({rfb,viewport,canInput:()=>connected&&active(),onChange:enabled=>{keyboardLayout(enabled);if(connected&&active())readyStatus();}});
        rfb.addEventListener('connect',()=>{if(!active())return;connected=true;readyStatus();
          const canvas=viewport.querySelector('canvas');
          if(canvas)keyboard.bindCanvas(canvas,{getRegions:()=>Date.now()-regionsAt<1750?regions:[],onInvalidate:invalidateRegions});
          refreshRegions();
        });
        rfb.addEventListener('disconnect',()=>{connected=false;clearTimeout(regionTimer);regions=[];keyboard?.setEnabled(false);if(active())setStatus('Chrome 연결이 종료됐습니다. 다시 연결해주세요.','error');});
        rfb.addEventListener('securityfailure',()=>{if(active())setStatus('브라우저에 연결할 권한을 확인해주세요.','error');});
      }catch(error){if(active())fail(error,generation);}
    })();
    return()=>{disposed=true;connected=false;clearTimeout(regionTimer);regions=[];keyboard?.destroy();keyboard=null;rfb?.disconnect();rfb=null;viewport.replaceChildren();};
  }
  function mountFiles(base,roomId,generation,signal) {
    const toolbar=el('div',undefined,'workspace-files-toolbar'),up=actionButton('상위 폴더','↑'),root=actionButton('작업 폴더','⌂'),refresh=actionButton('파일 목록 새로고침','↻'),path=el('span','','workspace-file-path');toolbar.append(up,root,refresh,path);
    const list=el('div',undefined,'workspace-file-list');list.setAttribute('aria-label','작업 공간 파일');content.replaceChildren(toolbar,list);
    let directory=state.paths.get(roomId)||'',request=0,objectUrl=null,fileAbort=null;
    const revoke=()=>{if(objectUrl){URL.revokeObjectURL(objectUrl);objectUrl=null;}};
    const active=()=>current(generation)&&!signal.aborted;
    const load=async next=>{
      fileAbort?.abort();revoke();const id=++request;list.replaceChildren(el('p','파일을 불러오는 중…','workspace-empty'));setStatus('파일 목록 확인 중…');
      try{
        const data=await api(base+'/files?path='+encodeURIComponent(next),{signal});if(!active()||id!==request)return;
        directory=typeof data.path==='string'?data.path:next;state.paths.set(roomId,directory);path.textContent=directory?'/'+directory.replace(/^\/+/, ''):'작업 폴더';path.title=path.textContent;up.disabled=!directory||directory==='/';
        list.replaceChildren();const entries=Array.isArray(data.entries)?data.entries:[];
        for(const entry of entries){if(!entry||typeof entry.name!=='string'||typeof entry.path!=='string'||!['directory','file'].includes(entry.type))continue;
          const row=actionButton(entry.name);row.className='workspace-file-row';row.replaceChildren();row.append(el('span',entry.type==='directory'?'▱':'▤','workspace-file-icon'),el('span',entry.name,'workspace-file-name'));
          const size=entry.type==='directory'?'폴더':Number.isFinite(entry.size)?(entry.size>=1048576?(entry.size/1048576).toFixed(1)+' MiB':entry.size>=1024?(entry.size/1024).toFixed(1)+' KiB':entry.size+' B'):'';row.append(el('span',size,'workspace-file-size'));row.onclick=()=>entry.type==='directory'?void load(entry.path):void preview(entry);list.append(row);
        }
        if(!list.childElementCount)list.append(el('p','폴더가 비어 있습니다.','workspace-empty'));
        setStatus(data.truncated?'파일이 많아 일부만 표시합니다.':'작업 폴더 · '+entries.length+'개','ready');
      }catch(error){if(active()&&id===request){list.replaceChildren(el('p','파일 목록을 불러오지 못했습니다.','workspace-empty'));fail(error,generation);}}
    };
    const preview=async entry=>{
      fileAbort?.abort();revoke();fileAbort=new AbortController();const localSignal=AbortSignal.any([signal,fileAbort.signal]),id=++request;
      const header=el('div',undefined,'workspace-file-preview-head'),back=actionButton('파일 목록으로','← 목록'),name=el('strong',entry.name),download=el('a','다운로드','workspace-download');download.setAttribute('download',entry.name);header.append(back,name,download);back.onclick=()=>void load(directory);
      const body=el('div','파일을 불러오는 중…','workspace-file-preview-body');list.replaceChildren(header,body);setStatus('파일 확인 중…');
      try{
        const blob=await boundedFile(base+'/file?path='+encodeURIComponent(entry.path),localSignal);if(!active()||id!==request)return;
        objectUrl=URL.createObjectURL(blob);download.href=objectUrl;body.replaceChildren();
        const image=/^image\/(?:png|jpeg|gif|webp)$/.test(blob.type)||/\.(?:png|jpe?g|gif|webp)$/i.test(entry.name);
        const text=/^(?:text\/|application\/(?:json|xml))/.test(blob.type)||/\.(?:md|txt|log|json|csv|tsv|yaml|yml|toml|ini|conf|py|js|mjs|ts|tsx|jsx|css|html|sh|xml|sql)$/i.test(entry.name);
        if(image){const image=el('img');image.src=objectUrl;image.alt=entry.name;body.append(image);}
        else if(text){const value=await blob.slice(0,256*1024).text();if(!active()||id!==request)return;body.append(el('pre',value));if(blob.size>256*1024)body.append(el('p','앞부분만 표시합니다. 전체 내용은 다운로드해주세요.','workspace-file-note'));}
        else body.append(el('p','이 파일은 다운로드하여 열 수 있습니다.','workspace-empty'));
        setStatus('파일 미리보기','ready');
      }catch(error){if(active()&&id===request){body.textContent='파일을 미리 볼 수 없습니다.';fail(error,generation);}}
    };
    up.onclick=()=>void load(directory.replace(/\/+$/,'').split('/').slice(0,-1).join('/'));root.onclick=()=>void load('');refresh.onclick=()=>void load(directory);void load(directory);
    return ()=>{request++;fileAbort?.abort();revoke();};
  }
  const open=()=>{if(state.destroyed)return;title.textContent=(getRoomName(roomId)||'대화')+' · 작업 공간';panel.setAttribute('aria-label',title.textContent);raise();if(panel.hidden){panel.hidden=false;layout(geometry);void activate();}};
  const hide=()=>{stop();panel.hidden=true;drag=null;content.replaceChildren();if(document.fullscreenElement===panel)document.exitFullscreen?.().catch(()=>{});};
  close.onclick=onClose;retry.onclick=()=>void activate();
  panel.addEventListener('keydown',event=>{if(event.key==='Escape'&&event.target===head){event.preventDefault();onClose();}});
  const visibility=()=>{if(document.hidden)stop();else if(!panel.hidden)void activate();};document.addEventListener('visibilitychange',visibility);
  const viewportResize=()=>layout(beforeMaximize?{left:8,top:8,width:innerWidth-16,height:viewportSize().height-16}:geometry);window.addEventListener('resize',viewportResize);globalThis.visualViewport?.addEventListener('resize',viewportResize);
  return {open,close:hide,destroy(){if(state.destroyed)return;hide();state.destroyed=true;state.paths.clear();document.removeEventListener('visibilitychange',visibility);window.removeEventListener('resize',viewportResize);globalThis.visualViewport?.removeEventListener('resize',viewportResize);panel.remove();}};
}
