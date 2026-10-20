import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,stat,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startCommunity} from '../server.mjs';

const picture={title:'내 그림',width:240,height:180,background:'#eef2ff',shapes:[{type:'circle',cx:120,cy:90,r:45,fill:'#8470ff'},{type:'text',x:120,y:150,text:'안녕 <script>',fill:'#222222',fontSize:20}]};
async function fixture(t,execute,env={}){
 const dir=await mkdtemp(join(tmpdir(),'drawing-delivery-'));
 const requests=[];
 let app;
 app=await startCommunity({dataDir:dir,port:0,env:{COMMUNITY_BOOTSTRAP_TOKEN:'bootstrap',...env},llm:{complete:async request=>{
   if(!request.toolDefinitions?.some(x=>x.function.name==='create_drawing'))return 'SendMessage: '+JSON.stringify({content:'그림 테스트'});
   requests.push(request);
   await execute(request,app);
   return 'SendMessage: '+JSON.stringify({content:'그림을 첨부했습니다.'});
 }}});
 t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true});});
 function client(){let cookie='',csrf='';return async(path,body)=>{const r=await fetch(app.url+path,{method:body?'POST':'GET',headers:{cookie,'content-type':'application/json','x-csrf-token':csrf},body:body?JSON.stringify(body):undefined});const type=r.headers.get('content-type')||'';const data=type.includes('application/json')?await r.json():await r.text();if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];if(data.csrfToken)csrf=data.csrfToken;return {status:r.status,data,headers:r.headers};};}
 const owner=client(),stranger=client();
 await owner('/api/register',{username:'owner',displayName:'Owner',password:'long-test-password',inviteToken:'bootstrap'});
 const invite=await owner('/api/admin/invites',{});
 await stranger('/api/register',{username:'other',displayName:'Other',password:'long-test-password',inviteToken:invite.data.token});
 const created=await owner('/api/rooms',{name:'그림 테스트'}),id=created.data.room.id;
 return {app,dir,owner,stranger,id,requests,async send(){const sent=await owner(`/api/rooms/${id}/messages`,{text:'보라색 원 그림을 만들어줘',clientNonce:crypto.randomUUID(),botIds:['bot-analyst']});assert.equal(sent.status,202);const progress=await owner(`/api/rooms/${id}/progress`);assert.equal(progress.status,200);assert.match(progress.data,/event: done/);const room=await owner(`/api/rooms/${id}`);assert.equal(room.status,200);return room.data;}};
}

test('drawing tool publishes an authenticated SVG attachment that survives fork and refresh',async t=>{
 let result;
 const f=await fixture(t,async request=>{result=JSON.parse(await request.browser('create_drawing',picture));});
 const room=await f.send();
 assert.equal(result.created,true);assert.equal(result.attached,true);
 const drawing=room.messages.find(m=>m.attachments?.length);
 assert.equal(drawing.kind,'bot');assert.equal(drawing.attachments[0].mime,'image/svg+xml');
 const attachment=drawing.attachments[0];
 const response=await f.owner(attachment.url);
 assert.equal(response.status,200);assert.match(response.data,/<svg/);assert.match(response.data,/&lt;script&gt;/);assert.doesNotMatch(response.data,/<script/);
 assert.match(response.headers.get('content-security-policy'),/default-src 'none'; sandbox/);
 assert.equal(response.headers.get('cross-origin-resource-policy'),'same-origin');
 assert.equal((await f.stranger(attachment.url)).status,404);
 const fork=await f.owner(`/api/rooms/${f.id}/fork`,{});assert.equal(fork.status,201);
 const forkRoom=await f.owner(`/api/rooms/${fork.data.room.id}`);
 const copy=forkRoom.data.messages.find(m=>m.attachments?.length).attachments[0];
 assert.notEqual(copy.url,attachment.url);assert.equal((await f.owner(copy.url)).data,response.data);
 assert.equal((await f.owner(`/api/rooms/${f.id}`)).data.messages.filter(m=>m.attachments?.length).length,1);
 const record=f.app.db.prepare('SELECT * FROM attachments WHERE id=?').get(attachment.id);
 assert.equal((await stat(record.path)).size,record.size);
 assert.equal(f.app.db.prepare('SELECT sum(bytes) bytes FROM media_usage').get().bytes,record.size);
});

for(const [setting,status] of [['COMMUNITY_MEDIA_DAILY_BYTES',429],['COMMUNITY_MEDIA_STORAGE_BYTES',507]]){
 test(`drawing respects ${setting} and removes rejected files`,async t=>{
  const f=await fixture(t,async request=>{
   await assert.rejects(request.browser('create_drawing',picture),error=>error.status===status);
  },{[setting]:'1'});
  await f.send();
  assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM attachments').get().n,0);
  assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM media_usage').get().n,0);
  assert.deepEqual(await readdir(join(f.dir,'media')),[]);
 });
}

test('a completed drawing stays available if the model fails while writing its summary',async t=>{
 const f=await fixture(t,async request=>{await request.browser('create_drawing',picture);throw new Error('provider disconnected');});
 const room=await f.send();
 const drawing=room.messages.find(m=>m.attachments?.length);
 assert.ok(drawing);assert.equal((await f.owner(drawing.attachments[0].url)).status,200);
 assert.ok(room.messages.some(m=>m.kind==='system'));
});

test('drawing validation and current membership are enforced before publication',async t=>{
 const f=await fixture(t,async (request,app)=>{
   await assert.rejects(request.browser('create_drawing',{...picture,shapes:[{type:'text',x:1,y:1,text:'x',href:'https://example.com'}]}),/./);
   app.db.prepare('DELETE FROM room_members WHERE room_id=? AND user_id=?').run(request.isolation.roomId,request.isolation.userId);
   await assert.rejects(request.browser('create_drawing',picture),error=>error.status===404);
   throw new Error('membership revoked');
 });
 await assert.rejects(f.send());
 assert.equal(f.app.db.prepare('SELECT COUNT(*) n FROM attachments WHERE room_id=?').get(f.id).n,0);
});
