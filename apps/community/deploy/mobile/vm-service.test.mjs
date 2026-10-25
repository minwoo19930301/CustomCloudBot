import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm,stat,readFile,open} from 'node:fs/promises';
import path from 'node:path';
import {startVMBroker} from './vm-service.mjs';
import {vmConfiguration} from './vm-pool.mjs';

const TOKEN='private-vm-service-token-at-least-32-characters';
const ROOM='12345678-1234-4234-8234-123456789abc';

test('host service only starts on an authenticated private socket and closes cleanly',async t=>{
  const directory=await mkdtemp('/tmp/ccb-vm-service-');
  const socket=path.join(directory,'socket/mobile.sock');
  const config=vmConfiguration({MOBILE_BROKER_TOKEN:TOKEN,MOBILE_VM_DATA_DIR:path.join(directory,'data'),MOBILE_LISTEN_SOCKET:socket});
  const running=new Set(),logs=[];
  const runtime={provision:async()=>{},start:async spec=>running.add(spec.roomId),stop:async spec=>running.delete(spec.roomId),isRunning:async spec=>running.has(spec.roomId)};
  const service=await startVMBroker({config,runtime,request:async(spec,request)=>request.path==='/health'?{ok:true}:{device:{roomId:spec.roomId,state:'running'}},log:line=>logs.push(line)});
  t.after(async()=>{await Promise.all([...service.pool.starts.values()]);await service.close();await rm(directory,{recursive:true,force:true});});
  assert.equal(service.server.address(),socket);
  assert.equal((await stat(socket)).mode&0o777,0o660);
  assert.equal((await stat(path.dirname(socket))).mode&0o777,0o750);
  const call=(route,{token=TOKEN,method='GET'}={})=>new Promise((resolve,reject)=>{
    const req=http.request({socketPath:socket,path:route,method,headers:{authorization:`Bearer ${token}`,...(method==='POST'?{'content-type':'application/json'}:{})}},res=>{
      let body='';res.on('data',chunk=>{body+=chunk;});res.on('end',()=>resolve({status:res.statusCode,data:JSON.parse(body)}));
    });req.on('error',reject);req.end(method==='POST'?'{}':undefined);
  });
  assert.equal((await call('/health',{token:'incorrect'})).status,401);
  assert.deepEqual((await call('/health')).data,{ok:true,slots:0,maxSlots:10,running:0,maxRunning:1});
  assert.equal((await call(`/devices/${ROOM}/wake`,{method:'POST'})).data.device.state,'starting');
  await service.pool.starts.get(ROOM);
  assert.equal((await call(`/devices/${ROOM}`)).data.device.state,'running');
  assert.ok(logs.every(line=>!line.includes(TOKEN)&&!line.includes(directory)));
});

test('host service rejects TCP-only configuration before provisioning or listening',async()=>{
  await assert.rejects(startVMBroker({config:{socket:null},runtime:{}}),/private Unix socket/);
});

test('host deployment preserves the socket directory inode and authenticated endpoint across broker restarts',async t=>{
  const unit=await readFile(new URL('./customcloudbot-mobile-vm-broker.service',import.meta.url),'utf8');
  assert.match(unit,/^RuntimeDirectoryPreserve=yes$/m,'systemd must not remove a directory already bind-mounted into the app');
  const directory=await mkdtemp('/tmp/ccb-vm-restart-');
  const socket=path.join(directory,'socket/mobile.sock');
  const config=vmConfiguration({MOBILE_BROKER_TOKEN:TOKEN,MOBILE_VM_DATA_DIR:path.join(directory,'data'),MOBILE_LISTEN_SOCKET:socket});
  const runtime={provision:async()=>{},start:async()=>{},stop:async()=>{},isRunning:async()=>false};
  let service,handle;
  t.after(async()=>{if(service)await service.close();if(handle)await handle.close();await rm(directory,{recursive:true,force:true});});
  service=await startVMBroker({config,runtime,log:()=>{}});
  handle=await open(path.dirname(socket),'r');
  const original=await handle.stat();
  await service.close();service=null;
  service=await startVMBroker({config,runtime,log:()=>{}});
  const current=await stat(path.dirname(socket));
  assert.equal(current.ino,original.ino);
  assert.equal(current.dev,original.dev);
  assert.equal(current.mode&0o777,0o750);
  assert.equal((await stat(socket)).mode&0o777,0o660);
  const status=token=>new Promise((resolve,reject)=>{
    const request=http.get({socketPath:socket,path:'/health',headers:{authorization:`Bearer ${token}`}},response=>{response.resume();response.on('end',()=>resolve(response.statusCode));});
    request.on('error',reject);
  });
  assert.equal(await status(TOKEN),200);
  assert.equal(await status('incorrect'),401);
});
