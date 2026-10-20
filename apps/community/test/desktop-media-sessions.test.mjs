import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {startCommunity} from '../server.mjs';

test('real media HTTP routes enforce authentication, owner, CSRF, room membership and fork read-only state',async t=>{
  const dir=await mkdtemp('/tmp/cloudbot-media-api-'),shared=randomUUID(),calls=[];
  let app;
  const env={COMMUNITY_BOOTSTRAP_TOKEN:'bootstrap',COMMUNITY_SHARED_DESKTOP_ROOM:shared,COMMUNITY_DESKTOP_MAP:JSON.stringify({[shared]:{wsUrl:'ws://127.0.0.1:6080/',cdpUrl:'http://127.0.0.1:9222/'}})};
  const start=extra=>startCommunity({dataDir:dir,port:0,env:{...env,...extra},desktopMediaFetch:async(url,options)=>{calls.push({url:String(url),options});return Response.json({ok:true,microphone:{supported:true,available:true,connected:false,muted:true}});}});
  app=await start({});
  t.after(async()=>{await app?.close();await rm(dir,{recursive:true,force:true});});
  const call=async(path,{auth,body,csrf=true}={})=>{
    const response=await fetch(app.url+path,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json',...(auth?{cookie:auth.cookie,...(csrf?{'x-csrf-token':auth.csrf}: {})}: {})},body:body===undefined?undefined:JSON.stringify(body)});
    return {status:response.status,response,data:await response.json().catch(()=>null)};
  };
  const registered=await call('/api/register',{body:{username:'owner',displayName:'Owner',password:'media-test-password',inviteToken:'bootstrap'}});
  assert.equal(registered.status,201);
  const owner={cookie:registered.response.headers.get('set-cookie').split(';')[0],csrf:registered.data.csrfToken};
  const invite=await call('/api/admin/invites',{auth:owner,body:{}});
  const memberReg=await call('/api/register',{body:{username:'member',displayName:'Member',password:'media-test-password',inviteToken:invite.data.token}});
  const member={cookie:memberReg.response.headers.get('set-cookie').split(';')[0],csrf:memberReg.data.csrfToken};
  await app.close();
  app=await start({COMMUNITY_HOST_ADMIN_SOCKET:'/tmp/nonexistent-media-test.sock',COMMUNITY_HOST_ADMIN_USER_IDS:registered.data.user.id});
  const room=(await call('/api/rooms',{auth:owner,body:{name:'Device connection'}})).data.room;
  const root=`/api/rooms/${room.id}/workspace/media`;
  assert.equal((await call(root)).status,401);
  assert.equal((await call(root,{auth:member})).status,403);
  assert.equal((await call(`/api/rooms/${randomUUID()}/workspace/media`,{auth:owner})).status,404);
  assert.equal((await call(root+'/microphone/ticket',{auth:owner,body:{},csrf:false})).status,403);
  assert.equal(calls.length,0);
  const status=await call(root,{auth:owner});assert.equal(status.status,200);assert.equal(status.data.microphone.available,true);assert.equal(status.data.camera.supported,false);
  assert.match(status.response.headers.get('cache-control'),/no-store/);
  const ticket=await call(root+'/microphone/ticket',{auth:owner,body:{}});assert.equal(ticket.status,201);assert.match(ticket.data.websocketPath,/workspace\/media\/microphone\/ws\?ticket=/);
  assert.ok(calls.every(item=>item.url==='http://127.0.0.1:6084/status'&&!item.options.headers));
  const fork=await call(`/api/rooms/${room.id}/fork`,{auth:owner,body:{branching:true}});assert.equal(fork.status,201);
  const count=calls.length;
  assert.equal((await call(root+'/microphone/ticket',{auth:owner,body:{}})).status,409);assert.equal(calls.length,count);
  for(const asset of ['/desktop-media.js','/desktop-microphone-worklet.js','/desktop-microphone-pcm.mjs']){
    const response=await fetch(app.url+asset);assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/javascript/);
  }
});
