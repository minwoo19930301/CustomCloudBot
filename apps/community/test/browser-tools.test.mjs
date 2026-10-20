import test from "node:test";
import assert from "node:assert/strict";
import dns from "node:dns/promises";
import { runInNewContext } from "node:vm";
import { createBrowserTools, assertSafeUrl, isPrivateAddress, BROWSER_TOOL_DEFINITIONS } from "../browser-tools.mjs";

test("browser URL validation blocks credentials, private DNS, and metadata ranges", async () => {
  assert.equal(isPrivateAddress("127.0.0.1"), true);
  assert.equal(isPrivateAddress("169.254.169.254"), true);
  assert.equal(isPrivateAddress("100.100.10.1"), true);
  assert.equal(isPrivateAddress("::1"), true);
  assert.equal(isPrivateAddress("2001:db8::1"), true);
  assert.equal(isPrivateAddress("2002:c000:0204::1"), true);
  await assert.rejects(() => assertSafeUrl("http://user:pass@example.com", async () => [{ address: "93.184.216.34" }]), /not allowed/);
  await assert.rejects(() => assertSafeUrl("http://example.com", async () => [{ address: "10.0.0.4" }]), /private/);
  assert.equal(await assertSafeUrl("https://example.com/path", async () => [{ address: "93.184.216.34" }]), "https://example.com/path");
});

test("unconfigured rooms return 503 and definitions stay bounded", async () => {
  const tools = createBrowserTools({ desktops: new Map() });
  assert.equal(tools.configured("missing"), false);
  await assert.rejects(() => tools.execute("missing", "browser_snapshot"), (e) => e.status === 503);
  assert.equal(BROWSER_TOOL_DEFINITIONS.length, 6);
  assert.ok(BROWSER_TOOL_DEFINITIONS.every((d) => d.function.parameters.additionalProperties === false));
  await tools.close();
});

test("fake CDP browser keeps one page per room and refs are snapshot scoped", async () => {
  const nodes = [
    { tagName: "BUTTON", innerText: "Send", getAttribute: (k) => k === "aria-label" ? "Send" : null },
    { tagName: "INPUT", value: "", getAttribute: (k) => k === "type" ? "text" : null },
  ];
  const page = {
    closed: false, isClosed() { return this.closed; }, async bringToFront() {},
    url() { return "https://example.com"; },
    locator(selector) { return { async evaluateAll() { return []; }, async evaluate(fn) { return fn({innerText:"hello"}); }, async elementHandles() { return nodes.map((node, i) => ({ async evaluate(fn) { return String(fn).includes("getComputedStyle") ? { i, tag: node.tagName.toLowerCase(), role: "", text: node.innerText || "", href: "", type: node.getAttribute("type") || "", visible: true } : true; }, async click() { this.clicked = i; }, async fill(text) { nodes[i].value = text; }, async dispose() {} })); }, async innerText() { return "hello"; }, nth(i) { return { async click() { this.clicked = i; }, async fill(text) { nodes[i].value = text; } }; } }; },
    async screenshot() { return Buffer.from("png"); }, async goto(url) { this.url = url; }, keyboard: { async press() {} }, mouse: { async wheel() {} },
  };
  const context = { pages: () => [page], async setDefaultTimeout() {}, async setDefaultNavigationTimeout() {}, async addInitScript() {}, async route() {}, async unroute() {} };
  const browser = { contexts: () => [context], isConnected: () => true, async close() {} };
  const tools = createBrowserTools({ desktops: new Map([["room", { cdpUrl: "http://cdp", wsUrl: "ws://127.0.0.1:6080/websockify" }]]), fetchImpl: async () => ({ ok: true, async json() { return { webSocketDebuggerUrl: "ws://127.0.0.1:9223/devtools/browser/fake-id" }; } }), playwright: { chromium: { async connectOverCDP() { return browser; } } } });
  const snapshot = await tools.execute("room", "browser_snapshot");
  assert.match(snapshot, /\[s1-0\]/);
  await tools.execute("room", "browser_type", { ref: "s1-1", text: "hello" });
  assert.equal(nodes[1].value, "hello");
  await tools.close();
});

function workspaceBrowserFixture(t,{shared=false}={}) {
  const calls=[],metrics={connections:0,routes:0,closes:0};
  let dimensions={width:1280,height:800},image=Buffer.from([0xff,0xd8,0xff,0xd9]),capture=async()=>image;
  const page={
    isClosed:()=>false,async bringToFront(){},url:()=>"https://example.com/",title:async()=>"Workspace page",
    evaluate:async()=>({...dimensions}),
    async screenshot(options){calls.push({type:"frame",options});return capture();},
    async goto(url,options){calls.push({type:"navigate",url,options});},
    async goBack(options){calls.push({type:"back",options});},
    async goForward(options){calls.push({type:"forward",options});},
    async reload(options){calls.push({type:"reload",options});},
    keyboard:{async insertText(text){calls.push({type:"type",text});},async press(key){calls.push({type:"key",key});}},
    mouse:{async click(x,y){calls.push({type:"click",x,y});},async wheel(deltaX,deltaY){calls.push({type:"scroll",deltaX,deltaY});}},
  };
  const context={pages:()=>[page],async setDefaultTimeout(){},async setDefaultNavigationTimeout(){},async addInitScript(){},async route(){metrics.routes++;},async unroute(){}};
  const browser={contexts:()=>[context],isConnected:()=>true,async close(){metrics.closes++;}};
  const endpoint={cdpUrl:"http://cdp"},desktops=new Map([["room",endpoint]]);
  if(shared){desktops.sharedRoomId="room";desktops.get=()=>endpoint;desktops.has=()=>true;}
  const tools=createBrowserTools({desktops,fetchImpl:async()=>({ok:true,json:async()=>({webSocketDebuggerUrl:"ws://127.0.0.1:9223/devtools/browser/workspace-test"})}),playwright:{chromium:{connectOverCDP:async()=>{metrics.connections++;return browser;}}}});
  t.after(()=>tools.close());
  return {tools,page,calls,metrics,setDimensions:value=>{dimensions=value;},setImage:value=>{image=value;},setCapture:value=>{capture=value;}};
}

test("private Vault capture shares the desktop queue and later model snapshots redact submitted credentials", async t => {
  t.mock.method(dns, "lookup", async () => [{address:"93.184.216.34"}]);
  const f=workspaceBrowserFixture(t,{shared:true}),username="private-login-fixture@example.com",password="private-password-fixture";
  let release,captures=0,filled;
  const wait=new Promise(resolve=>{release=resolve;});
  f.setCapture(()=>wait);
  f.page.evaluateHandle=async()=>{
    captures++;
    return {evaluate:async(_callback,args)=>{
      if(args){filled=args;return {status:"filled",nextStep:"submit"};}
      return {href:f.page.url(),origin:"https://example.com"};
    },dispose:async()=>{}};
  };
  f.page.locator=()=>({elementHandles:async()=>[],evaluate:async fn=>fn({innerText:`Page echoed ${username} and ${password}`})});
  const frame=f.tools.frame("room-A");
  await new Promise(resolve=>setImmediate(resolve));
  const capturing=f.tools.captureLoginTarget("room-B");
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(captures,0,"login target capture must wait for the same shared PC queue");
  release(Buffer.from([0xff,0xd8,0xff,0xd9]));await frame;
  const target=await capturing;
  const result=await f.tools.fillLogin({roomId:"room-B",...target,username,password,authorize:async()=>{}});
  assert.deepEqual(result,{status:"filled",nextStep:"submit"});
  assert.equal(filled.password,password);
  const snapshot=await f.tools.execute("room-A","browser_snapshot");
  assert.ok(!snapshot.includes(username));assert.ok(!snapshot.includes(password));
  assert.match(snapshot,/비공개 로그인 정보/);
  assert.ok(BROWSER_TOOL_DEFINITIONS.every(tool=>!["captureLoginTarget","fillLogin"].includes(tool.function.name)));
});

test("private snapshot redacts credentials cut at body, label and attribute boundaries without sending secrets into page readers", async t => {
  t.mock.method(dns, "lookup", async () => [{address:"93.184.216.34"}]);
  const f=workspaceBrowserFixture(t,{shared:true}),username="vault-owner@example.com",password="credential-only-$BOUNDARY-UNIQUE-Z9!";
  f.page.evaluateHandle=async()=>({
    evaluate:async(_callback,args)=>args?{status:"filled",nextStep:"submit"}:{href:f.page.url(),origin:"https://example.com"},
    dispose:async()=>{},
  });
  const target=await f.tools.captureLoginTarget("room");
  await f.tools.fillLogin({roomId:"room",...target,username,password,authorize:async()=>{}});
  let body="",nodes=[];
  const reads=[];
  const evaluate=(fn,node,arg)=>{
    reads.push(arg);
    return runInNewContext(`(${fn.toString()})(node, argument)`,{
      node,argument:arg,getComputedStyle:()=>({display:"block",visibility:"visible"}),
    });
  };
  f.page.locator=selector=>({
    evaluate:async(fn,arg)=>evaluate(fn,{innerText:body},arg),
    elementHandles:async()=>selector==="body"?[]:nodes.map(node=>({
      evaluate:async(fn,arg)=>evaluate(fn,node,arg),dispose:async()=>{},
    })),
  });
  const prefix=password.slice(0,10),safeText=`A normal ${prefix} word stays visible.`;
  const cutValue=max=>"X".repeat(max-prefix.length)+password+" after the boundary";
  for(const [field,max] of [["body",5000],["text",180],["href",2048],["type",40]]){
    body=field==="body"?safeText+"X".repeat(5000-safeText.length-prefix.length)+password+" after":safeText;
    const attrs={href:field==="href"?cutValue(max):"",type:field==="type"?cutValue(max):"button"};
    nodes=field==="body"?[]:[{
      tagName:"BUTTON",innerText:field==="text"?cutValue(max):"Continue",
      getAttribute:key=>attrs[key]||null,getBoundingClientRect:()=>({width:10,height:10}),
    }];
    const snapshot=await f.tools.execute("room","browser_snapshot");
    assert.ok(snapshot.includes(safeText),`${field}: a secret prefix inside ordinary text must stay intact`);
    assert.equal(snapshot.split(prefix).length-1,1,`${field}: only the uncut ordinary occurrence may remain`);
    assert.ok(!snapshot.includes(password),field);
    assert.match(snapshot,/비공개 로그인/,field);
    assert.ok(snapshot.length<=8000,field);
  }
  for(const length of [1,password.length-1]){
    body="X".repeat(5000-length)+password+" after";nodes=[];
    const snapshot=await f.tools.execute("room","browser_snapshot");
    assert.ok(!snapshot.includes("XXXXX"+password.slice(0,length)),
      `a ${length}-character secret fragment at the cut boundary must be removed`);
  }
  const overlappingUsername="overlap-token-A",overlappingPassword="lap-token-AB";
  const nextTarget=await f.tools.captureLoginTarget("room");
  await f.tools.fillLogin({roomId:"room",...nextTarget,username:overlappingUsername,password:overlappingPassword,authorize:async()=>{}});
  body="Before overlap-token-AB after.";nodes=[];
  assert.match(await f.tools.execute("room","browser_snapshot"),/Before \[비공개 로그인 정보\] after\./,
    "overlapping complete credentials must be redacted as one range without leftover fragments");
  body="X".repeat(4999)+password+" after";
  nodes=Array.from({length:30},()=>({
    tagName:"BUTTON",innerText:"X".repeat(170)+password+" after",
    getAttribute:()=>null,getBoundingClientRect:()=>({width:10,height:10}),
  }));
  const capped=await f.tools.execute("room","browser_snapshot");
  assert.equal(capped.length,8000);
  assert.ok(!capped.includes("XXXXX"+prefix),"final output clipping must happen after each component is redacted");
  assert.ok(reads.every(arg=>!JSON.stringify(arg)?.includes(password)&&!JSON.stringify(arg)?.includes(username)),
    "snapshot DOM evaluation must never receive saved credentials from any site");
});

test("workspace navigation rejects private and non-web targets before operating the page",async t=>{
  const f=workspaceBrowserFixture(t);
  for(const url of ["file:///etc/passwd","javascript:alert(1)","data:text/html,hello","http://localhost/","http://169.254.169.254/opc/v2/","http://[::1]/","https://user:secret@example.com/","invalid url","https://example.com/"+"x".repeat(2048)]){
    await assert.rejects(()=>f.tools.action("room",{type:"navigate",url}),error=>[400,403].includes(error.status),url);
  }
  assert.deepEqual(f.calls,[],"forbidden navigation must never reach page.goto");
  await f.tools.action("room",{type:"reload"});
  assert.equal(f.calls[0].type,"reload","a rejected action must not poison the room queue");
});

test("workspace pointer and scroll bounds prevent off-viewport or non-finite remote input",async t=>{
  const f=workspaceBrowserFixture(t);
  for(const [x,y] of [[-1,0],[0,-1],[1280,0],[0,800],[Infinity,0],[0,NaN],["1",2],[null,2]]){
    await assert.rejects(()=>f.tools.action("room",{type:"click",x,y}),error=>error.status===400);
  }
  for(const [deltaX,deltaY] of [[2001,0],[0,-2001],[NaN,0],[0,Infinity],["10",0]]){
    await assert.rejects(()=>f.tools.action("room",{type:"scroll",deltaX,deltaY}),error=>error.status===400);
  }
  assert.deepEqual(f.calls,[]);
  await f.tools.action("room",{type:"click",x:1279,y:799});
  await f.tools.action("room",{type:"scroll",deltaX:-2000,deltaY:2000});
  assert.deepEqual(f.calls,[{type:"click",x:1279,y:799},{type:"scroll",deltaX:-2000,deltaY:2000}]);
  f.setDimensions({width:640,height:480});
  await assert.rejects(()=>f.tools.action("room",{type:"click",x:700,y:100}),error=>error.status===400,"validate against the current viewport after resize");
});

test("workspace typing preserves IME text while rejecting oversized input and arbitrary key sequences",async t=>{
  const f=workspaceBrowserFixture(t);
  for(const text of ["x".repeat(4001),null,7,{}])await assert.rejects(()=>f.tools.action("room",{type:"type",text}),error=>error.status===400);
  for(const key of ["Control+Alt+Shift+A","Enter\n","F12",";exec","","a".repeat(4000),null])await assert.rejects(()=>f.tools.action("room",{type:"key",key}),error=>error.status===400);
  await assert.rejects(()=>f.tools.action("room",{type:"evaluate",script:"process.env"}),error=>error.status===400);
  assert.deepEqual(f.calls,[]);
  const text="한글 입력과 🙂";
  await f.tools.action("room",{type:"type",text});
  await f.tools.action("room",{type:"type",text:"x".repeat(4000)});
  await f.tools.action("room",{type:"key",key:"Shift+Tab"});
  await f.tools.action("room",{type:"key",key:"Control+A"});
  assert.deepEqual(f.calls[0],{type:"type",text});
  assert.equal(f.calls[1].text.length,4000);
  assert.deepEqual(f.calls.slice(2),[{type:"key",key:"Shift+Tab"},{type:"key",key:"Control+A"}]);
});

test("workspace frames report the CSS viewport and reject oversized screenshots",async t=>{
  const f=workspaceBrowserFixture(t);
  f.setDimensions({width:1440,height:900});
  const frame=await f.tools.frame("room");
  assert.equal(frame.width,1440);assert.equal(frame.height,900);
  assert.equal(frame.url,"https://example.com/");assert.equal(frame.title,"Workspace page");
  assert.deepEqual(Buffer.from(frame.image.split(",")[1],"base64"),Buffer.from([0xff,0xd8,0xff,0xd9]));
  assert.match(frame.image,/^data:image\/jpeg;base64,/);
  assert.equal(f.calls[0].options.fullPage,false,"a tall page must not change click coordinate space");
  f.setImage(Buffer.alloc(2*1024*1024+1));
  await assert.rejects(()=>f.tools.frame("room"),error=>error.status===413);
  await assert.rejects(()=>f.tools.frame("unconfigured"),error=>error.status===503);
});

test("workspace frame and action requests serialize so input cannot race an unfinished frame",async t=>{
  const f=workspaceBrowserFixture(t);
  let started,release;
  const captureStarted=new Promise(resolve=>{started=resolve;}),captureGate=new Promise(resolve=>{release=resolve;});
  t.after(()=>release());
  f.setCapture(async()=>{started();await captureGate;return Buffer.from("jpeg");});
  const frame=f.tools.frame("room");
  await captureStarted;
  const action=f.tools.action("room",{type:"type",text:"after frame"});
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.calls.map(call=>call.type),["frame"],"no input while screenshot is being produced");
  release();await Promise.all([frame,action]);
  assert.deepEqual(f.calls.map(call=>call.type),["frame","type"]);
});

test("shared-room frames coalesce and all views serialize on one CDP connection",async t=>{
  const f=workspaceBrowserFixture(t,{shared:true});
  let started,release;
  const captureStarted=new Promise(resolve=>{started=resolve;}),captureGate=new Promise(resolve=>{release=resolve;});
  t.after(()=>release());
  f.setCapture(async()=>{started();await captureGate;return Buffer.from("shared-frame");});
  const first=f.tools.frame("room-a");await captureStarted;
  const second=f.tools.frame("room-b");
  assert.equal(second,first,"the same shared frame request must not take a second screenshot");
  const action=f.tools.action("room-b",{type:"key",key:"Enter"});
  const agent=f.tools.execute("room-c","browser_press",{key:"invalid"});
  const rejected=assert.rejects(()=>agent,error=>error.status===400);
  await new Promise(resolve=>setImmediate(resolve));
  assert.deepEqual(f.calls.map(call=>call.type),["frame"]);
  release();const frames=await Promise.all([first,second]);await action;await rejected;
  assert.equal(frames[0],frames[1]);
  assert.deepEqual(f.calls.map(call=>call.type),["frame","key"]);
  assert.equal(f.metrics.connections,1,"shared rooms must not create competing CDP sessions");
  assert.equal(f.metrics.routes,1,"network protection must be installed only once per shared context");
  await f.tools.close();assert.equal(f.metrics.closes,1);
});

test("shared workspace bounds pending work and recovers after overload",async t=>{
  const f=workspaceBrowserFixture(t,{shared:true});
  let started,release;
  const captureStarted=new Promise(resolve=>{started=resolve;}),captureGate=new Promise(resolve=>{release=resolve;});
  t.after(()=>release());
  f.setCapture(async()=>{started();await captureGate;return Buffer.from("frame");});
  const first=f.tools.frame("room-a");await captureStarted;
  const pending=Array.from({length:7},(_,index)=>f.tools.action("room-"+index,{type:"type",text:String(index)}));
  await assert.rejects(()=>f.tools.action("extra-room",{type:"reload"}),error=>error.status===429);
  await assert.rejects(()=>f.tools.execute("agent-room","browser_snapshot"),error=>error.status===429);
  assert.equal(f.tools.frame("another-room"),first,"coalesced viewers must not consume pending operation slots");
  release();await Promise.all([first,...pending]);
  assert.deepEqual(f.calls.filter(call=>call.type==="type").map(call=>call.text),["0","1","2","3","4","5","6"]);
  await f.tools.action("room-b",{type:"reload"});
  assert.equal(f.calls.at(-1).type,"reload","overload must not permanently block the shared target");
});
