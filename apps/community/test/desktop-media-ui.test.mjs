import test from 'node:test';
import assert from 'node:assert/strict';
import {MicrophonePCM} from '../public/desktop-microphone-pcm.mjs';
import {createMicrophoneRelay} from '../public/desktop-media.js';

const roomId='11111111-1111-4111-8111-111111111111';
const flush=()=>new Promise(resolve=>setImmediate(resolve));
function fixture(t,{media,api,ready=true,moduleReady=Promise.resolve()}={}) {
  const tracks=[new EventTarget()];tracks[0].stopped=0;tracks[0].stop=()=>tracks[0].stopped++;
  const stream={getTracks:()=>tracks},contexts=[],nodes=[],sockets=[],states=[],calls=[];
  class Context {
    constructor(){this.state='running';this.destination={};this.closed=0;this.audioWorklet={addModule:async()=>moduleReady};contexts.push(this);}
    async resume(){} async close(){this.closed++;this.state='closed';}
    createMediaStreamSource(){return {connect(){},disconnect(){}};}
  }
  class Node {constructor(){this.port={close(){},onmessage:null};nodes.push(this);}connect(){}disconnect(){this.disconnected=true;}}
  class Socket {
    constructor(url){this.url=url;this.readyState=1;this.bufferedAmount=0;this.sent=[];sockets.push(this);if(ready)setImmediate(()=>this.onmessage?.({data:JSON.stringify({type:'ready',sampleRate:48000,channels:1,format:'s16le'})}));}
    close(){this.readyState=3;this.closed=true;} send(data){this.sent.push(data);}
  }
  const environment={AudioContext:Context,AudioWorkletNode:Node,WebSocket:Socket,location:{origin:'https://bot.example',href:'https://bot.example/',protocol:'https:'},navigator:{mediaDevices:{getUserMedia:options=>{calls.push(options);return media?media(stream):Promise.resolve(stream);}}}};
  const relay=createMicrophoneRelay({roomId,environment,api:api|| (async()=>({websocketPath:`/api/rooms/${roomId}/workspace/media/microphone/ws?ticket=test`})),onState:state=>states.push(state)});
  t.after(()=>relay.destroy());
  return {relay,tracks,stream,contexts,nodes,sockets,states,calls};
}

test('PCM conversion bounds samples and emits little-endian mono at48k',()=>{
  const packets=[],pcm=new MicrophonePCM(48000,p=>packets.push(p),4);
  pcm.push(new Float32Array([-2,0,2,NaN]));assert.equal(packets.length,1);
  const result=new DataView(packets[0]);assert.deepEqual([0,2,4,6].map(i=>result.getInt16(i,true)),[-32768,0,32767,0]);
});
test('44.1k input resamples across arbitrary render quantum boundaries without duration drift',()=>{
  let samples=0;const pcm=new MicrophonePCM(44100,p=>samples+=p.byteLength/2,48);
  for(let i=0;i<44100;i+=128)pcm.push(new Float32Array(Math.min(128,44100-i)).fill(.25));
  assert.ok(samples>=47952&&samples<=48000);assert.ok(pcm.offset<48);
});
test('no microphone permission or connection occurs untilstart and no camera is requested',async t=>{
  const f=fixture(t);assert.equal(f.calls.length,0);assert.equal(f.contexts.length,0);
  await f.relay.start();assert.equal(f.calls[0].video,false);assert.equal(f.states.at(-1).state,'connected');
  assert.match(f.sockets[0].url,/^wss:\/\/bot.example\//);
  f.nodes[0].port.onmessage({data:new ArrayBuffer(4096)});assert.equal(f.sockets[0].sent.length,1);
  f.relay.stop();assert.equal(f.tracks[0].stopped,1);assert.equal(f.contexts[0].closed,1);assert.equal(f.sockets[0].closed,true);assert.equal(f.states.at(-1).state,'off');
});
test('slow network stops capture and does notretain a growingaudioqueue',async t=>{
  const f=fixture(t);await f.relay.start();f.sockets[0].bufferedAmount=200000;f.nodes[0].port.onmessage({data:new ArrayBuffer(4096)});
  assert.equal(f.tracks[0].stopped,1);assert.equal(f.sockets[0].sent.length,0);assert.match(f.states.at(-1).message,/느려/);
});
test('permission resolving after workspace destruction immediately stops thelate stream',async t=>{
  let resolve;const f=fixture(t,{media:stream=>new Promise(done=>{resolve=()=>done(stream);})});
  const starting=f.relay.start();f.relay.destroy();resolve();await starting;
  assert.equal(f.tracks[0].stopped,1);assert.equal(f.sockets.length,0);assert.equal(f.contexts[0].closed,1);
});
test('ticketfailure also cleans a microphone permission resolvinglater',async t=>{
  let resolve;const f=fixture(t,{media:stream=>new Promise(done=>{resolve=()=>done(stream);}),api:async()=>{throw new Error('unavailable');}});
  await f.relay.start();resolve();await flush();assert.equal(f.tracks[0].stopped,1);assert.equal(f.sockets.length,0);assert.equal(f.contexts[0].closed,1);
});
test('foreign microphone endpoint never receives audio',async t=>{
  const f=fixture(t,{api:async()=>({websocketPath:'https://outside.example/api/mic'})});await f.relay.start();
  assert.equal(f.sockets.length,0);assert.equal(f.tracks[0].stopped,1);assert.match(f.states.at(-1).message,/주소/);
});
test('stop during upstream handshake closes websocket and microphone immediately',async t=>{
  const f=fixture(t,{ready:false});const starting=f.relay.start();await flush();f.relay.stop();await starting;
  assert.equal(f.sockets[0].closed,true);assert.equal(f.tracks[0].stopped,1);assert.equal(f.nodes.length,0);
});
test('revokeddevice orclosed websocket stops capture rather than reconnecting',async t=>{
  const f=fixture(t);await f.relay.start();f.tracks[0].dispatchEvent(new Event('ended'));
  assert.equal(f.tracks[0].stopped,1);assert.equal(f.sockets[0].closed,true);assert.equal(f.sockets.length,1);
});
test('two workspacewindows cannot silently switch anactive microphone',async t=>{
  const first=fixture(t),second=fixture(t);await first.relay.start();await second.relay.start();
  assert.equal(second.calls.length,0);assert.match(second.states.at(-1).message,/먼저 끊어/);assert.equal(first.tracks[0].stopped,0);
});
