import test from 'node:test';
import assert from 'node:assert/strict';
import {createRunModelControl} from '../model-control.mjs';

const choice=(model='chat-one',automatic=true)=>({model,provider:'fixture',automatic,apiKey:'private-api-key',baseUrl:'https://private-endpoint.example/v1',attempts:[{apiKey:'other-private-key'}]});
function fixture(options={}) {
  const turn=new AbortController(),events=[];
  const control=createRunModelControl({userId:'member-id',choice:choice(),signal:turn.signal,publish:event=>events.push(event),...options});
  return {turn,events,control};
}

test('switching revisions aborts only the old model request and preserves the turn/tool signal',()=>{
  const {turn,control,events}=fixture(),first=control.getSelection();
  assert.equal(first.revision,0);assert.equal(first.signal.aborted,false);assert.equal(control.status.visible,false);
  const next=choice('chat-two',false);
  assert.equal(control.switchChoice(next),true);
  const second=control.getSelection();
  assert.equal(second.revision,1);assert.equal(second.choice,next);
  assert.equal(first.signal.aborted,true);assert.equal(second.signal.aborted,false);
  assert.equal(turn.signal.aborted,false,'running tools keep the original turn signal');
  assert.equal(control.active,true);assert.equal(control.status.phase,'switching');assert.equal(control.status.automatic,false);
  assert.equal(events.length,1);assert.equal(events[0].reason,'switch');
  assert.equal(control.switchChoice(choice('chat-three')),true);
  assert.equal(control.getSelection().revision,2);assert.equal(second.signal.aborted,true);assert.equal(turn.signal.aborted,false);
  control.finish('complete');
});

test('exhausted selections wait for a genuinely new revision and wake all waiters after a choice',async()=>{
  const {control,events}=fixture();
  const first=control.onExhausted({revision:0,reason:'rate_limit',attempt:8});
  const second=control.onExhausted({revision:0,reason:'rate_limit',attempt:8});
  assert.equal(control.status.phase,'waiting');assert.equal(control.status.reason,'limit');assert.equal(control.status.visible,true);
  control.switchChoice(choice('replacement',false));
  assert.deepEqual(await Promise.all([first,second]),[true,true]);
  const published=events.length;
  assert.equal(await control.onExhausted({revision:0,reason:'network',attempt:8}),true,'a stale exhaustion event resumes without entering waiting again');
  assert.equal(events.length,published);assert.equal(control.status.phase,'switching');
  control.onTransition({stage:'attempt',model:'replacement',provider:'second-provider',attempt:9});
  assert.equal(control.status.model,'replacement');assert.equal(control.status.phase,'trying');assert.equal(control.status.automatic,false);
  control.finish('complete');
});

test('waiting expires without issuing a new choice and its timeout is bounded',async t=>{
  t.mock.timers.enable({apis:['setTimeout']});
  const short=fixture({waitMs:25}),waiting=short.control.onExhausted({revision:0,reason:'network',attempt:3});
  let settled=false;waiting.then(()=>{settled=true;});
  t.mock.timers.tick(24);await Promise.resolve();assert.equal(settled,false);
  t.mock.timers.tick(1);assert.equal(await waiting,false);assert.equal(short.control.getSelection().revision,0);
  short.control.finish('exhausted');assert.equal(short.control.active,false);
  const long=fixture({waitMs:900000}),bounded=long.control.onExhausted({revision:0,reason:'network',attempt:3});
  t.mock.timers.tick(120000);assert.equal(await bounded,false,'an exhausted turn does not wait longer than two minutes');
  long.control.finish('exhausted');
});

test('turn abort resolves waiting promptly and blocks late events and switches',async()=>{
  const {turn,control,events}=fixture(),waiting=control.onExhausted({revision:0,reason:'empty_response',attempt:2});
  turn.abort();assert.equal(await waiting,false);assert.equal(control.active,false);
  const before=control.status,count=events.length;
  control.onTransition({stage:'attempt',model:'late-model',provider:'late-provider',attempt:3});
  assert.equal(control.switchChoice(choice('must-not-run')),false);
  assert.equal(await control.onExhausted({revision:0,reason:'network',attempt:3}),false);
  assert.deepEqual(control.status,before);assert.equal(events.length,count);
  control.finish('stopped');assert.equal(control.status.phase,'stopped');assert.equal(control.active,false);
});

test('a caller abort also releases its wait without changing the chosen model',async()=>{
  const {control,turn}=fixture(),request=new AbortController();
  const waiting=control.onExhausted({revision:0,reason:'network',attempt:1},request.signal);
  request.abort();assert.equal(await waiting,false);
  assert.equal(control.getSelection().revision,0);assert.equal(turn.signal.aborted,false);
  control.finish('stopped');
});

for(const outcome of ['complete','stopped','exhausted'])test(`terminal ${outcome} state cannot offer live controls or be overwritten by late events`,async()=>{
  const {control,events}=fixture(),waiting=control.onExhausted({revision:0,reason:'unavailable',attempt:4});
  const selection=control.getSelection();control.finish(outcome);
  assert.equal(await waiting,false);assert.equal(control.active,false);assert.equal(selection.signal.aborted,true);
  assert.equal(control.status.phase,outcome);assert.equal(control.status.visible,outcome!=='complete');
  const final=control.status,count=events.length;
  control.finish('complete');control.onTransition({stage:'failure',reason:'network',attempt:5});
  assert.equal(control.switchChoice(choice('late')),false);assert.equal(await control.onExhausted({revision:0,reason:'network',attempt:5}),false);
  assert.deepEqual(control.status,final);assert.equal(events.length,count);
});

test('published status contains only display metadata and copies cannot mutate live state',()=>{
  const {control,events}=fixture();
  control.onTransition({stage:'failure',reason:'authentication',apiKey:'event-secret',error:'private exception text'});
  control.onTransition({stage:'attempt',model:'<b>model</b>\n',provider:'provider<script>',attempt:2,apiKey:'event-secret',baseUrl:'https://event-secret.example'});
  const expected=['runId','userId','phase','visible','automatic','model','provider','attempt','reason','sequence','startedAt'].sort();
  for(const status of [control.status,...events]) {
    assert.deepEqual(Object.keys(status).sort(),expected);
    assert.doesNotMatch(JSON.stringify(status),/private-api-key|other-private-key|event-secret|private-endpoint|private exception|apiKey|baseUrl|attempts|<|>|\\n/);
    assert.match(status.runId,/^[a-f0-9-]{36}$/);
  }
  const snapshot=control.status;snapshot.phase='forged';events.at(-1).phase='forged';
  assert.equal(control.status.phase,'trying');assert.equal(control.status.model,'bmodel/b');
  assert.equal(control.status.reason,'authentication');assert.deepEqual(events.map(event=>event.sequence),[1,2]);
  control.finish('complete');
});

test('failure reasons distinguish unsupported models from temporary, account and request failures',()=>{
  const {control}=fixture();
  for(const [reason,expected] of [
    ['unsupported_model','unavailable'],['model_unavailable','unavailable'],['endpoint_not_found','endpoint'],
    ['provider_error','provider'],['authentication','authentication'],['billing','billing'],
    ['rate_limit','limit'],['timeout','timeout'],['network','connection'],
    ['context_length','size'],['request_too_large','size'],['incomplete_response','response'],
    ['invalid_request','request'],['private rate_limit secret','connection'],
  ]) {
    control.onTransition({stage:'failure',reason});
    assert.equal(control.status.reason,expected,reason);
    control.onTransition({stage:'attempt',model:'fallback',provider:'fixture',attempt:2});
    assert.equal(control.status.reason,expected,'the actual next attempt retains the fixed cause');
  }
  control.finish('complete');
});

test('failed notification delivery cannot interrupt model switching, wakeups or terminal cleanup',async()=>{
  let deliveries=0;
  const {control,turn}=fixture({publish:()=>{deliveries++;throw new Error('stream disconnected');}});
  assert.doesNotThrow(()=>control.onTransition({stage:'failure',reason:'network',attempt:1}));
  const old=control.getSelection(),waiting=control.onExhausted({revision:old.revision,reason:'network',attempt:1});
  assert.doesNotThrow(()=>assert.equal(control.switchChoice(choice('replacement')),true));
  assert.equal(await waiting,true);assert.equal(old.signal.aborted,true);assert.equal(turn.signal.aborted,false);
  const current=control.getSelection(),waitingAgain=control.onExhausted({revision:current.revision,reason:'empty_response',attempt:2});
  assert.doesNotThrow(()=>control.finish('exhausted'));
  assert.equal(await waitingAgain,false);assert.equal(current.signal.aborted,true);assert.equal(control.active,false);
  assert.equal(control.status.phase,'exhausted');assert.equal(deliveries,5);
});
