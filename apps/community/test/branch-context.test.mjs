import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startCommunity } from "../server.mjs";

function withoutActivity(data) {
  const {lastTouchedAt, ...room} = data.room;
  return {...data, room};
}

async function fixture(t, complete) {
  const dir = await mkdtemp(join(tmpdir(), "branch-context-")), calls = [];
  const app = await startCommunity({ dataDir: dir, port: 0, env: { COMMUNITY_BOOTSTRAP_TOKEN: "bootstrap" }, llm: {
    complete: async (request,signal) => { calls.push(request); return complete ? complete(request,signal) : 'SendMessage: '+JSON.stringify({content: request.isolation?.botId === "compact" ? "COMPACTED_DECISION" : "완료"}); },
  } });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
  async function call(path, auth, body, csrf = true) {
    const response = await fetch(app.url+path, { method: body === undefined ? "GET" : "POST", headers: {
      "content-type": "application/json", ...(auth ? {cookie:auth.cookie,...(csrf ? {"x-csrf-token":auth.csrf} : {})} : {}),
    }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10000) });
    return { status:response.status, data:await response.json(), response };
  }
  async function register(username, admin) {
    const inviteToken = admin ? (await call("/api/admin/invites",admin,{})).data.token : "bootstrap";
    const result = await call("/api/register",null,{username,displayName:username,password:"branch-test-password",inviteToken});
    assert.equal(result.status,201);
    return {id:result.data.user.id,csrf:result.data.csrfToken,cookie:result.response.headers.get("set-cookie").split(";")[0]};
  }
  async function room(auth) { const result=await call("/api/rooms",auth,{name:"branch"}); assert.equal(result.status,201); return result.data.room.id; }
  async function fork(auth,id) { const result=await call(`/api/rooms/${id}/fork`,auth,{}); assert.equal(result.status,201); return result.data.room.id; }
  async function merge(auth,id,sourceId) { const result=await call(`/api/rooms/${id}/merge`,auth,{sourceId}); assert.equal(result.status,201,JSON.stringify(result.data)); return result.data; }
  async function send(auth,id,text,extra={}) { const result=await call(`/api/rooms/${id}/messages`,auth,{text,botIds:[],clientNonce:randomUUID(),...extra}); assert.equal(result.status,202); return result.data.messageId; }
  async function bot(auth,id,text) { await send(auth,id,text,{botIds:["bot-analyst"]}); const response=await fetch(`${app.url}/api/rooms/${id}/progress`,{headers:{cookie:auth.cookie},signal:AbortSignal.timeout(10000)}); assert.match(await response.text(),/event: done/); return calls.findLast(item=>item.isolation.roomId===id); }
  async function upload(auth,id,name) {
    const bytes=Buffer.from("89504e470d0a1a0a01020304","hex"),form=new FormData();
    form.append("file",new Blob([bytes],{type:"image/png"}),name);
    const response=await fetch(`${app.url}/api/rooms/${id}/attachments`,{method:"POST",headers:{cookie:auth.cookie,"x-csrf-token":auth.csrf},body:form});
    assert.equal(response.status,201); return (await response.json()).attachment;
  }
  const saved = id => JSON.parse(app.db.prepare("SELECT value FROM settings WHERE key=?").get("context:"+id)?.value || "{}");
  return {app,db:app.db,calls,call,register,room,fork,merge,send,bot,upload,saved};
}

test("merge snapshots effective reset/compacted contexts without an AI call or modifying originals", async t => {
  const f=await fixture(t),owner=await f.register("merge_owner"),root=await f.room(owner);
  await f.send(owner,root,"OLD_COMMON_EXCLUDED");
  const branch=await f.fork(owner,root);
  assert.equal((await f.call(`/api/rooms/${root}/context-reset`,owner,{})).status,200);
  assert.equal((await f.call(`/api/rooms/${branch}/context-reset`,owner,{})).status,200);
  await f.send(owner,root,"LEFT_CURRENT");
  await f.send(owner,branch,"RAW_COMPACT_EXCLUDED ".repeat(50));
  assert.equal((await f.call(`/api/rooms/${branch}/compact`,owner,{})).status,200);
  await f.send(owner,branch,"RIGHT_CURRENT");
  const before=[await f.call(`/api/rooms/${root}`,owner),await f.call(`/api/rooms/${branch}`,owner)];
  const count=f.calls.length,merged=await f.merge(owner,root,branch),id=merged.room.id;
  assert.equal(f.calls.length,count,"merge must not call an AI or tools");
  assert.equal(merged.contextTruncated,false);
  assert.match(f.saved(id).summary,/LEFT_CURRENT/);
  assert.match(f.saved(id).summary,/RIGHT_CURRENT/);
  assert.match(f.saved(id).summary,/COMPACTED_DECISION/);
  assert.doesNotMatch(f.saved(id).summary,/OLD_COMMON_EXCLUDED|RAW_COMPACT_EXCLUDED/);
  assert.deepEqual(withoutActivity((await f.call(`/api/rooms/${root}`,owner)).data),withoutActivity(before[0].data));
  assert.deepEqual(withoutActivity((await f.call(`/api/rooms/${branch}`,owner)).data),withoutActivity(before[1].data));
  const transcript=(await f.call(`/api/rooms/${id}`,owner)).data.messages;
  assert.ok(transcript.some(message=>message.text==='OLD_COMMON_EXCLUDED'),"visible history remains recoverable");
  const request=await f.bot(owner,id,"CONTINUE_MERGE");
  assert.match(request.user,/LEFT_CURRENT/);
  assert.match(request.user,/RIGHT_CURRENT/);
  assert.doesNotMatch(request.user,/OLD_COMMON_EXCLUDED|RAW_COMPACT_EXCLUDED/);
  const child=await f.fork(owner,id);
  assert.match(f.saved(child).summary,/COMPACTED_DECISION/);
  assert.equal((await f.call(`/api/rooms/${child}/context-reset`,owner,{})).status,200);
  assert.doesNotMatch((await f.bot(owner,child,"EMPTY_NEW_CONTEXT")).user,/LEFT_CURRENT|RIGHT_CURRENT|COMPACTED_DECISION/);
});

test("independent accessible sessions merge into a new context while originals and membership stay unchanged", async t => {
  const f=await fixture(t),admin=await f.register("independent_admin"),member=await f.register("independent_member",admin);
  const first=await f.room(admin),second=await f.room(member),hidden=await f.room(admin);
  const invite=(await f.call(`/api/rooms/${first}/invites`,admin,{})).data.token;
  assert.equal((await f.call("/api/rooms/join",member,{token:invite})).status,200);
  await f.send(member,first,"TRAVEL_PLAN_IN_FIRST_SESSION");
  await f.send(member,second,"PROJECT_PLAN_IN_SECOND_SESSION");
  const firstBefore=(await f.call(`/api/rooms/${first}`,member)).data,secondBefore=(await f.call(`/api/rooms/${second}`,member)).data;
  assert.equal((await f.call(`/api/rooms/${first}/merge`,member,{sourceId:hidden})).status,404,"source membership is required");
  assert.equal((await f.call(`/api/rooms/${hidden}/merge`,member,{sourceId:second})).status,404,"target membership is required");
  assert.equal((await f.call(`/api/rooms/${first}/merge`,admin,{sourceId:second})).status,404,"admin role does not bypass source membership");
  const callCount=f.calls.length,merged=await f.merge(member,first,second),id=merged.room.id;
  assert.notEqual(id,first);assert.notEqual(id,second);
  assert.equal(f.calls.length,callCount,"combining snapshots must not trigger a model request");
  assert.deepEqual(withoutActivity((await f.call(`/api/rooms/${first}`,member)).data),withoutActivity(firstBefore));
  assert.deepEqual(withoutActivity((await f.call(`/api/rooms/${second}`,member)).data),withoutActivity(secondBefore));
  assert.equal((await f.call(`/api/rooms/${id}`,admin)).status,404,"the new room does not inherit other participants");
  const link=(await f.call("/api/rooms",member)).data.forks.find(value=>value.id===id);
  assert.deepEqual(link.parents,[first,second]);assert.equal(link.operation,"merge");
  const messages=(await f.call(`/api/rooms/${id}`,member)).data.messages;
  assert.ok(messages.some(message=>message.text==="TRAVEL_PLAN_IN_FIRST_SESSION"));
  assert.ok(messages.some(message=>message.text==="PROJECT_PLAN_IN_SECOND_SESSION"));
  const request=await f.bot(member,id,"COMBINE_BOTH_PLANS");
  assert.match(request.user,/TRAVEL_PLAN_IN_FIRST_SESSION/);
  assert.match(request.user,/PROJECT_PLAN_IN_SECOND_SESSION/);
  assert.equal((await f.call(`/api/rooms/${first}/merge`,admin,{sourceId:first})).status,400);
  const monitor="00000000-0000-4000-8000-000000000001";
  f.db.prepare("INSERT INTO rooms VALUES(?,?,?,?,?)").run(monitor,"dashboard","",admin.id,Date.now());
  f.db.prepare("INSERT INTO room_members VALUES(?,?,?)").run(monitor,admin.id,"owner");
  assert.equal((await f.call(`/api/rooms/${first}/merge`,admin,{sourceId:monitor})).status,400);
  assert.equal((await f.call(`/api/rooms/${monitor}/merge`,admin,{sourceId:first})).status,400);
});

test("independent merges still wait for running or queued work in either session", async t => {
  const completion=Promise.withResolvers(),f=await fixture(t,()=>completion.promise),owner=await f.register("busy_merge_owner");
  const running=await f.room(owner),otherRunning=await f.room(owner),queued=await f.room(owner),idle=await f.room(owner);
  try {
    await f.send(owner,running,"RUNNING_FIRST",{botIds:["bot-analyst"]});
    await f.send(owner,otherRunning,"RUNNING_SECOND",{botIds:["bot-analyst"]});
    const waiting=await f.call(`/api/rooms/${queued}/messages`,owner,{text:"WAITING_ONLY",botIds:["bot-analyst"],clientNonce:randomUUID(),queueIfBusy:true});
    assert.equal(waiting.status,202);assert.equal(waiting.data.queued,true);
    assert.equal((await f.call(`/api/rooms/${idle}/merge`,owner,{sourceId:running})).status,409);
    assert.equal((await f.call(`/api/rooms/${running}/merge`,owner,{sourceId:idle})).status,409);
    assert.equal((await f.call(`/api/rooms/${idle}/merge`,owner,{sourceId:queued})).status,409);
    assert.equal((await f.call(`/api/rooms/${queued}/merge`,owner,{sourceId:idle})).status,409);
  } finally { completion.resolve('SendMessage: '+JSON.stringify({content:"완료"})); }
});

test("merge attachment snapshots keep only effective images and preserve mail privacy for nonadmin owners", async t => {
  const f=await fixture(t),admin=await f.register("image_admin"),owner=await f.register("image_member",admin),root=await f.room(owner);
  f.db.prepare("INSERT INTO settings VALUES(?,?)").run("mail-room:"+root,"1");
  const old=await f.upload(owner,root,"old.png");
  await f.send(owner,root,"OLD_IMAGE",{attachmentIds:[old.id]});
  const branch=await f.fork(owner,root);
  await f.call(`/api/rooms/${root}/context-reset`,owner,{});
  await f.call(`/api/rooms/${branch}/context-reset`,owner,{});
  const current=await f.upload(owner,branch,"current.png");
  await f.send(owner,branch,"CURRENT_IMAGE",{attachmentIds:[current.id]});
  const merged=await f.merge(owner,root,branch),id=merged.room.id;
  assert.equal(merged.room.personal,true);
  assert.equal(merged.room.sharing.canInvite,false);
  assert.equal((await f.call(`/api/rooms/${id}/invites`,owner,{})).status,403);
  assert.equal((await f.call(`/api/rooms/${id}`,admin)).status,404);
  const messages=(await f.call(`/api/rooms/${id}`,owner)).data.messages;
  const oldCopy=messages.find(message=>message.text==='OLD_IMAGE').attachments[0];
  const currentCopy=messages.find(message=>message.text==='CURRENT_IMAGE').attachments[0];
  assert.notEqual(currentCopy.id,current.id);
  assert.deepEqual(f.saved(id).imageIds,[currentCopy.id]);
  assert.equal((await fetch(f.app.url+oldCopy.url,{headers:{cookie:owner.cookie}})).status,200);
  assert.equal((await fetch(f.app.url+currentCopy.url,{headers:{cookie:admin.cookie}})).status,404);
  assert.match((await f.bot(owner,id,"画像を確認")).user,/현재 사용 가능한 이미지 인식 모델이 없습니다/);
  const child=await f.fork(owner,id);
  assert.equal(f.saved(child).imageIds.length,1);
  assert.notEqual(f.saved(child).imageIds[0],currentCopy.id);
  await f.call(`/api/rooms/${id}/context-reset`,owner,{});
  assert.doesNotMatch((await f.bot(owner,id,"TEXT_ONLY")).user,/현재 사용 가능한 이미지 인식 모델이 없습니다|OLD_IMAGE|CURRENT_IMAGE/);
});

test("stable message provenance deduplicates shared history without losing identical independent messages", async t => {
  const f=await fixture(t),owner=await f.register("dedup_owner"),root=await f.room(owner);
  await f.send(owner,root,"COMMON_ONCE");
  const branch=await f.fork(owner,root);
  const left=await f.send(owner,root,"SAME_TEXT"),right=await f.send(owner,branch,"SAME_TEXT");
  f.db.prepare("UPDATE messages SET created_at=? WHERE id IN (?,?)").run(12345,left,right);
  const merged=(await f.merge(owner,root,branch)).room.id;
  let messages=(await f.call(`/api/rooms/${merged}`,owner)).data.messages;
  assert.equal(messages.filter(message=>message.text==='COMMON_ONCE').length,1);
  assert.equal(messages.filter(message=>message.text==='SAME_TEXT').length,2);
  const again=(await f.merge(owner,merged,branch)).room.id;
  messages=(await f.call(`/api/rooms/${again}`,owner)).data.messages;
  assert.equal(messages.filter(message=>message.text==='COMMON_ONCE').length,1);
  assert.equal(messages.filter(message=>message.text==='SAME_TEXT').length,2);
});

test("deep descendants and two-parent merges stay related; inaccessible parent IDs never leak", async t => {
  const f=await fixture(t),owner=await f.register("graph_owner"),member=await f.register("graph_member",owner),root=await f.room(owner);
  const invite=(await f.call(`/api/rooms/${root}/invites`,owner,{})).data.token;
  await f.call("/api/rooms/join",member,{token:invite});
  const branch=await f.fork(member,root),child=await f.fork(member,branch),deep=await f.fork(member,child);
  const sibling=await f.fork(member,root);
  f.db.prepare("DELETE FROM room_members WHERE room_id=? AND user_id=?").run(root,member.id);
  const list=(await f.call("/api/rooms",member)).data;
  assert.ok(list.rooms.every(room=>Number.isFinite(room.createdAt)));
  assert.equal(JSON.stringify(list.forks).includes(root),false);
  assert.deepEqual(list.forks.find(link=>link.id===branch).parents,[]);
  assert.equal(list.forks.find(link=>link.id===branch).parent,null);
  assert.equal((await f.call(`/api/rooms/${deep}/merge`,member,{sourceId:root})).status,404);
  assert.equal((await f.call(`/api/rooms/${deep}/merge`,null,{sourceId:sibling})).status,401);
  assert.equal((await f.call(`/api/rooms/${deep}/merge`,member,{sourceId:sibling},false)).status,403);
  const merged=(await f.merge(member,deep,sibling)).room.id;
  const link=(await f.call("/api/rooms",member)).data.forks.find(item=>item.id===merged);
  assert.deepEqual(link.parents,[deep,sibling]);
  assert.equal(link.operation,"merge");
  await f.merge(member,merged,branch);
  f.db.prepare("DELETE FROM room_members WHERE room_id=? AND user_id=?").run(sibling,member.id);
  assert.equal(JSON.stringify((await f.call("/api/rooms",member)).data.forks).includes(sibling),false,"secondary merge parents must also be hidden");
  // Corrupt cyclic lineage cannot prevent merging two accessible conversations.
  f.db.prepare("UPDATE settings SET value=? WHERE key=?").run(JSON.stringify({parents:[deep]}),"lineage:"+branch);
  const unrelated=await f.room(member);
  const independentMerge=await f.merge(member,deep,unrelated);
  assert.notEqual(independentMerge.room.id,deep);
});

test("historical fork of an interleaved merge excludes later messages from either parent", async t => {
  const f=await fixture(t),owner=await f.register("ordered_owner"),root=await f.room(owner);
  const common=await f.send(owner,root,"COMMON_T1");
  f.db.prepare("UPDATE messages SET created_at=1000 WHERE id=?").run(common);
  const branch=await f.fork(owner,root);
  const leftEarlier=await f.send(owner,root,"LEFT_T3"),rightMiddle=await f.send(owner,branch,"RIGHT_T4"),leftFuture=await f.send(owner,root,"LEFT_T5_EXCLUDED");
  for (const [id,at] of [[leftEarlier,3000],[rightMiddle,4000],[leftFuture,5000]]) f.db.prepare("UPDATE messages SET created_at=? WHERE id=?").run(at,id);
  const merged=(await f.merge(owner,root,branch)).room.id;
  const messages=(await f.call(`/api/rooms/${merged}`,owner)).data.messages;
  const point=messages.find(message=>message.text==='RIGHT_T4').id;
  const result=await f.call(`/api/rooms/${merged}/fork`,owner,{throughMessageId:point});
  assert.equal(result.status,201);
  const child=(await f.call(`/api/rooms/${result.data.room.id}`,owner)).data;
  assert.deepEqual(child.messages.map(message=>message.text),['COMMON_T1','LEFT_T3','RIGHT_T4']);
  assert.doesNotMatch((await f.bot(owner,child.room.id,"CONTINUE_EARLIER_BRANCH")).user,/LEFT_T5_EXCLUDED/);
});

test("personal admin sessions merged with independent sessions retain the private invite boundary", async t => {
  const f=await fixture(t),owner=await f.register("personal_merge"),other=await f.register("personal_other",owner);
  const root=(await f.call("/api/rooms",owner)).data.rooms.find(room=>room.personal).id;
  const branch=await f.room(owner),merged=(await f.merge(owner,root,branch)).room;
  assert.equal(merged.personal,true);
  assert.equal(merged.sharing.canInvite,false);
  assert.equal((await f.call(`/api/rooms/${merged.id}/invites`,owner,{})).status,403);
  assert.equal((await f.call(`/api/rooms/${merged.id}`,other)).status,404);
});

test("active-room cap is consistent for new/fork/merge/restore and reset leaves a forkable recoverable root", async t => {
  const f=await fixture(t),admin=await f.register("cap_admin"),owner=await f.register("cap_member",admin);
  const root=await f.room(owner),branch=await f.fork(owner,root);
  await f.send(owner,root,"RECOVERABLE_MESSAGE");
  while (f.db.prepare("SELECT count(*) n FROM rooms WHERE owner_id=?").get(owner.id).n < 20) {
    const id=randomUUID();f.db.prepare("INSERT INTO rooms VALUES(?,?,?,?,?)").run(id,"saved","",owner.id,Date.now());f.db.prepare("INSERT INTO room_members VALUES(?,?,?)").run(id,owner.id,"owner");
  }
  assert.equal((await f.call("/api/rooms",owner,{name:"over cap"})).status,409);
  assert.equal((await f.call(`/api/rooms/${root}/fork`,owner,{})).status,409);
  assert.equal((await f.call(`/api/rooms/${root}/merge`,owner,{sourceId:branch})).status,409);
  await f.call(`/api/rooms/${branch}/preferences`,owner,{pinned:false,archived:true});
  await f.fork(owner,root);
  assert.equal((await f.call(`/api/rooms/${branch}/preferences`,owner,{pinned:false,archived:false})).status,409);
  const other=await f.room(admin);
  const before=(await f.call(`/api/rooms/${other}`,admin)).data;
  const reset=await f.call("/api/sessions/reset",owner,{});
  assert.equal(reset.status,201);
  assert.equal(reset.data.archived,21);
  await f.fork(owner,reset.data.room.id);
  assert.equal((await f.call(`/api/rooms/${root}/preferences`,owner,{pinned:false,archived:false})).status,200);
  assert.ok((await f.call(`/api/rooms/${root}`,owner)).data.messages.some(message=>message.text==='RECOVERABLE_MESSAGE'));
  assert.deepEqual((await f.call(`/api/rooms/${other}`,admin)).data,before);
});

test("large merge snapshots retain both branches and report truncation honestly", async t => {
  const f=await fixture(t),owner=await f.register("large_owner"),root=await f.room(owner),branch=await f.fork(owner,root);
  for (let i=0;i<7;i++) { await f.send(owner,root,`LEFT_${i} `+'L'.repeat(1190)); await f.send(owner,branch,`RIGHT_${i} `+'R'.repeat(1190)); }
  const merged=await f.merge(owner,root,branch),saved=f.saved(merged.room.id);
  assert.equal(merged.contextTruncated,true);
  assert.ok(saved.summary.length<8000);
  assert.match(saved.summary,/LEFT_6/);assert.match(saved.summary,/RIGHT_6/);
  assert.match(saved.summary,/일부 맥락 생략/);
});
