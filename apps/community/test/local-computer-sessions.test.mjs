import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import {startCommunity} from '../server.mjs';
import {createExecutor} from '../../desktop/executor.mjs';

async function fixture(t) {
  const root=await mkdtemp(join(tmpdir(),'ccb-native-integration-'));
  let complete;
  const turns=[];
  const app=await startCommunity({dataDir:join(root,'cloud'),port:0,env:{COMMUNITY_BOOTSTRAP_TOKEN:'native-test-bootstrap'},llm:{name:'native-integration',complete:async request=>{
    if(request.isolation?.botId==='title')return 'SendMessage: {"content":"내 컴퓨터 확인"}';
    const turn={request};turns.push(turn);
    try {await complete?.(request,turn);} finally {turn.finished=true;}
    return 'SendMessage: {"content":"연결 확인"}';
  }}});
  t.after(async()=>{await app.close();await rm(root,{recursive:true,force:true});});
  async function call(path,actor,body,{method=body===undefined?'GET':'POST',headers={}}={}) {
    const response=await fetch(app.url+path,{method,headers:{'content-type':'application/json',...(actor?{cookie:actor.cookie,'x-csrf-token':actor.csrf}:{}),...headers},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(10000)});
    return {status:response.status,data:await response.json(),response};
  }
  async function register(username,owner) {
    const inviteToken=owner?(await call('/api/admin/invites',owner,{})).data.token:'native-test-bootstrap';
    const result=await call('/api/register',null,{username,displayName:username,password:'native-integration-password',inviteToken});
    assert.equal(result.status,201);
    return {id:result.data.user.id,csrf:result.data.csrfToken,cookie:result.response.headers.get('set-cookie').split(';')[0]};
  }
  const owner=await register('native_owner'),other=await register('native_other',owner);
  const room=async actor=>{const r=await call('/api/rooms',actor,{name:'내 컴퓨터'});assert.equal(r.status,201);return r.data.room.id;};
  const pair=async(actor=owner,capabilities=['fs','terminal'])=>{const r=await call('/api/local-computers',actor,{name:'Test Mac',platform:'darwin',capabilities});assert.equal(r.status,201,JSON.stringify(r.data));return r.data;};
  const native=(path,token,body,options={})=>call(path,null,body,{...options,headers:{authorization:'Bearer '+token,...options.headers}});
  async function send(actor,roomId) {
    const before=turns.length;
    const r=await call(`/api/rooms/${roomId}/messages`,actor,{text:'이 요청은 내 컴퓨터에서 처리해줘',clientNonce:randomUUID(),botIds:['bot-analyst']});
    assert.equal(r.status,202,JSON.stringify(r.data));
    const end=Date.now()+10000;
    while(Date.now()<end) {
      if(turns.length>before && turns.slice(before).every(x=>x.finished) && !(await call(`/api/rooms/${roomId}`,actor)).data.busy)return turns.slice(before);
      await new Promise(resolve=>setTimeout(resolve,10));
    }
    assert.fail('Native integration turn did not finish');
  }
  return {app,root,owner,other,call,native,room,pair,send,setComplete:fn=>{complete=fn;}};
}

test('native registration needs session and CSRF; device tokens cannot access account APIs or another owner device',async t=>{
  const f=await fixture(t),body={name:'Mac',platform:'darwin',capabilities:['fs']};
  assert.equal((await f.call('/api/local-computers',null,body)).status,401);
  assert.equal((await f.call('/api/local-computers',f.owner,body,{headers:{'x-csrf-token':''}})).status,403);
  const paired=await f.pair();
  assert.equal((await f.native('/api/local-computers',paired.token)).status,401);
  assert.equal((await f.call(`/api/local-computers/${paired.device.id}`,f.other,undefined,{method:'DELETE'})).status,404);
  assert.equal((await f.native('/api/local-computers/poll',paired.token,undefined,{headers:{origin:'https://untrusted.example'}})).status,403);
  assert.equal((await f.native('/api/local-computers/poll',paired.token)).status,200);
  const paused=await f.native('/api/local-computers/pause',paired.token,{});
  assert.equal(paused.status,200);
  assert.equal(paused.data.device.online,false);
  assert.equal((await f.call('/api/local-computers',f.owner)).data.devices[0].online,false);
  assert.equal((await f.native('/api/local-computers/poll',paired.token)).data.device.online,true);
  assert.equal((await f.native('/api/local-computers/disconnect',paired.token,{})).status,200);
  assert.equal((await f.native('/api/local-computers/poll',paired.token)).status,401);
});

test('chat tool request travels through authenticated polling and performs a real bounded local file operation',async t=>{
  const f=await fixture(t),room=await f.room(f.owner),paired=await f.pair();
  const target=join(f.root,'desktop-proof.txt');
  const executor=createExecutor({getPolicy:()=>({enabled:true,roots:[f.root],capabilities:{files:true,terminal:true,browser:false}}),openExternal:async()=>{},describeMachine:()=>({platform:'darwin',hostname:'Test Mac'})});
  await f.native('/api/local-computers/poll',paired.token);
  f.setComplete(async(request,turn)=>{
    assert.ok(request.toolDefinitions.some(x=>x.function.name==='computer_write_file'));
    assert.ok(!request.toolDefinitions.some(x=>x.function.name==='computer_open_url'));
    assert.match(request.system,/NOT OCI/);
    turn.result=JSON.parse(await request.browser('computer_write_file',{path:target,content:'연결된 Mac에서 작성했습니다.'}));
  });
  let stop=false;let delivered=0;let pollError;
  const poller=(async()=>{while(!stop){const r=await f.native('/api/local-computers/poll',paired.token);assert.equal(r.status,200);if(r.data.job){delivered++;const job=r.data.job;let payload;try {payload={ok:true,result:await executor.execute(job.tool,job.args,{})};} catch(error){pollError=error;payload={ok:false,error:error.message};}const done=await f.native(`/api/local-computers/jobs/${job.id}/result`,paired.token,payload);assert.equal(done.status,200,JSON.stringify(done.data));}await new Promise(resolve=>setTimeout(resolve,10));}})().catch(error=>{pollError=error;});
  try {await f.send(f.owner,room);} finally {stop=true;await poller;}
  if(pollError)throw pollError;
  assert.equal(delivered,1);
  assert.equal(await readFile(target,'utf8'),'연결된 Mac에서 작성했습니다.');
});

test('local tools stay out of other users and shared conversations, even if the model tries to call them',async t=>{
  const f=await fixture(t),room=await f.room(f.owner),otherRoom=await f.room(f.other),paired=await f.pair();
  await f.native('/api/local-computers/poll',paired.token);
  f.setComplete(async request=>{
    assert.ok(!request.toolDefinitions.some(x=>x.function.name.startsWith('computer_')));
    await assert.rejects(request.browser('computer_exec',{command:'printf forbidden'}),{status:403});
  });
  await f.send(f.other,otherRoom);
  const invite=await f.call(`/api/rooms/${room}/invites`,f.owner,{});
  assert.equal((await f.call('/api/rooms/join',f.other,{token:invite.data.token})).status,200);
  await f.send(f.owner,room);
  assert.equal((await f.native('/api/local-computers/poll',paired.token)).data.job,null);
});

test('an expired device owner cannot poll for local commands',async t=>{
  const f=await fixture(t),paired=await f.pair();
  if(!f.app.db.prepare('PRAGMA table_info(users)').all().some(column=>column.name==='expires_at'))
    f.app.db.exec('ALTER TABLE users ADD COLUMN expires_at INTEGER');
  f.app.db.prepare('UPDATE users SET expires_at=? WHERE id=?').run(Date.now()-1000,f.owner.id);
  assert.equal((await f.native('/api/local-computers/poll',paired.token)).status,401);
});
