import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startCommunity} from '../server.mjs';

const envelope = content => 'SendMessage: '+JSON.stringify({content});

async function fixture(t, complete) {
  const dataDir=await mkdtemp(join(tmpdir(),'session-customization-')),calls=[];
  const options={dataDir,port:0,env:{COMMUNITY_BOOTSTRAP_TOKEN:'bootstrap'},llm:{
    async complete(request,signal) {calls.push(request);return complete ? complete(request,signal) : envelope('자동 요약 제목');},
  }};
  let app=await startCommunity(options);
  t.after(async()=>{await app.close();await rm(dataDir,{recursive:true,force:true});});
  async function call(path,{auth,body,method=body===undefined?'GET':'POST',csrf=true}={}) {
    const response=await fetch(app.url+path,{method,headers:{'content-type':'application/json',...(auth?{cookie:auth.cookie,...(csrf?{'x-csrf-token':auth.csrf}:{})}:{})},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(5000)});
    return {status:response.status,data:await response.json(),response};
  }
  async function register(username,admin) {
    const inviteToken=admin?(await call('/api/admin/invites',{auth:admin,body:{}})).data.token:'bootstrap';
    const response=await call('/api/register',{body:{username,displayName:username,password:'session-custom-test-password',inviteToken}});
    assert.equal(response.status,201);
    return {id:response.data.user.id,csrf:response.data.csrfToken,cookie:response.response.headers.get('set-cookie').split(';')[0]};
  }
  async function room(auth,name) {
    const response=await call('/api/rooms',{auth,body:name===undefined?{}:{name}});
    assert.equal(response.status,201);return response.data.room.id;
  }
  async function joinRoom(owner,member,id) {
    const invite=(await call(`/api/rooms/${id}/invites`,{auth:owner,body:{}})).data.token;
    assert.equal((await call('/api/rooms/join',{auth:member,body:{token:invite}})).status,200);
  }
  async function send(auth,id,text) {
    const response=await call(`/api/rooms/${id}/messages`,{auth,body:{text,botIds:[],clientNonce:randomUUID()}});
    assert.equal(response.status,202);return response;
  }
  return {get app(){return app;},calls,call,register,room,joinRoom,send,
    async restart(){await app.close();app=await startCommunity(options);},
  };
}

test('room titles are owner-controlled, shared, validated and persistent across restart',async t=>{
  const f=await fixture(t),admin=await f.register('admin'),owner=await f.register('owner',admin),outsider=await f.register('outsider',admin);
  const id=await f.room(owner,'원래 이름'),path=`/api/rooms/${id}`;
  await f.joinRoom(owner,admin,id);
  const rename=(auth,name,extra={})=>f.call(path,{auth,body:{name},method:'PATCH',...extra});
  assert.equal((await rename(null,'실패')).status,401);
  assert.equal((await rename(owner,'실패',{csrf:false})).status,403);
  assert.equal((await rename(outsider,'실패')).status,404);
  assert.equal((await rename(admin,'실패')).status,403,'site admin role does not replace room ownership');
  for(const name of ['', '   ', null, 123, '가'.repeat(81), '두\n줄', '제어\u0000문자'])assert.equal((await rename(owner,name)).status,400,String(name));
  const changed=await rename(owner,'  직접 정한 공유 제목  ');
  assert.equal(changed.status,200);assert.equal(changed.data.room.name,'직접 정한 공유 제목');assert.equal(changed.data.room.pendingTitle,false);
  assert.equal((await f.call(path,{auth:admin})).data.room.name,'직접 정한 공유 제목');
  assert.equal((await f.call('/api/rooms',{auth:admin})).data.rooms.find(room=>room.id===id).name,'직접 정한 공유 제목');
  await f.restart();
  assert.equal((await f.call(path,{auth:owner})).data.room.name,'직접 정한 공유 제목');
  assert.equal(f.app.db.prepare('SELECT value FROM settings WHERE key=?').get('manual-title:'+id).value,'1');
  assert.equal((await rename(owner,'가'.repeat(80))).status,200);
});

test('manual names suppress future automatic titles even when they match a placeholder or old fork suffix',async t=>{
  const f=await fixture(t),owner=await f.register('manual_owner'),id=await f.room(owner);
  assert.equal((await f.call(`/api/rooms/${id}`,{auth:owner,method:'PATCH',body:{name:'새 대화'}})).status,200);
  await f.send(owner,id,'이 내용으로 제목을 덮어쓰면 안 됩니다');
  const fork=(await f.call(`/api/rooms/${id}/fork`,{auth:owner,body:{}})).data.room;
  assert.equal(fork.pendingTitle,true);
  assert.equal((await f.call(`/api/rooms/${fork.id}`,{auth:owner,method:'PATCH',body:{name:fork.name}})).data.room.pendingTitle,false);
  await f.restart();
  await f.send(owner,fork.id,'분기 대화도 수동 제목을 유지합니다');
  assert.equal((await f.call(`/api/rooms/${id}`,{auth:owner})).data.room.name,'새 대화');
  assert.equal((await f.call(`/api/rooms/${fork.id}`,{auth:owner})).data.room.name,fork.name);
  assert.equal(f.calls.length,0,'manual rooms never request a new AI title');
  const child=(await f.call(`/api/rooms/${fork.id}/fork`,{auth:owner,body:{}})).data.room;
  assert.equal(child.pendingTitle,true,'a new fork still gets its own first-message title');
  await f.send(owner,child.id,'자식 가지의 새 주제');
  await f.restart();
  assert.equal((await f.call(`/api/rooms/${child.id}`,{auth:owner})).data.room.name,'자동 요약 제목');
});

test('manual rename wins over an already-running title response even if the fallback title is unchanged',async t=>{
  const started=Promise.withResolvers(),finish=Promise.withResolvers();
  const f=await fixture(t,async request=>{started.resolve(request);return finish.promise;});
  const owner=await f.register('race_owner'),id=await f.room(owner),first='사용자가 직접 선택할 임시 제목';
  try {
    await f.send(owner,id,first);assert.equal((await started.promise).isolation.botId,'title');
    assert.equal((await f.call(`/api/rooms/${id}`,{auth:owner})).data.room.name,first);
    const renamed=await f.call(`/api/rooms/${id}`,{auth:owner,method:'PATCH',body:{name:first}});
    assert.equal(renamed.status,200);
  } finally {finish.resolve(envelope('늦게 도착한 자동 제목'));}
  await f.restart();
  assert.equal((await f.call(`/api/rooms/${id}`,{auth:owner})).data.room.name,first);
});

test('color preferences are member-specific, partial, validated, resettable and durable',async t=>{
  const f=await fixture(t),owner=await f.register('color_owner'),member=await f.register('color_member',owner),outsider=await f.register('color_outsider',owner);
  const id=await f.room(owner,'색상 확인'),path=`/api/rooms/${id}/preferences`;
  await f.joinRoom(owner,member,id);
  const color=(auth,value,extra={})=>f.call(path,{auth,body:{color:value},...extra});
  assert.equal((await color(null,'#123456')).status,401);
  assert.equal((await color(owner,'#123456',{csrf:false})).status,403);
  assert.equal((await color(outsider,'#123456')).status,404);
  for(const value of ['', '#abc', '#12345678', 'red', 'var(--secret)', '#12zz99', 123, false, {}, ' #123456'])assert.equal((await color(owner,value)).status,400,JSON.stringify(value));
  assert.equal((await f.call(path,{auth:owner,body:{}})).status,400);
  assert.equal((await f.call(path,{auth:owner,body:{pinned:null,color:'#123456'}})).status,400);
  const groupId=randomUUID();
  assert.equal((await f.call('/api/sidebar',{auth:owner,method:'PUT',body:{width:280,groups:[{id:groupId,name:'업무',collapsed:false}]}})).status,200);
  assert.equal((await f.call(path,{auth:owner,body:{pinned:true,archived:false,groupId}})).status,200);
  const changed=await color(owner,'#aBcDeF');
  const {lastTouchedAt,...preferences}=changed.data;
  assert.ok(Number.isSafeInteger(lastTouchedAt) && lastTouchedAt>0);
  assert.deepEqual(preferences,{pinned:true,archived:false,groupId,color:'#abcdef'});
  assert.equal((await color(member,'#123456')).status,200);
  // Old clients changing pin state must not erase a color saved by a newer UI.
  assert.equal((await f.call(path,{auth:owner,body:{pinned:false,archived:false}})).data.color,'#abcdef');
  await f.restart();
  for(const [auth,value] of [[owner,'#abcdef'],[member,'#123456']]) {
    assert.equal((await f.call(`/api/rooms/${id}`,{auth})).data.room.color,value);
    assert.equal((await f.call('/api/rooms',{auth})).data.rooms.find(room=>room.id===id).color,value);
  }
  assert.equal((await color(owner,null)).data.color,null);
  assert.equal((await f.call(`/api/rooms/${id}`,{auth:member})).data.room.color,'#123456');
  await f.restart();
  assert.equal((await f.call(`/api/rooms/${id}`,{auth:owner})).data.room.color,null);
});
