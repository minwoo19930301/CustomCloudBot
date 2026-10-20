import test from 'node:test';
import assert from 'node:assert/strict';
import { ApiLlm } from '../model.mjs';

const candidate=(model,slot=0)=>({model,provider:'groq',slot,baseUrl:'https://fixture.test/v1',apiKey:`private-key-${slot}`});
const choose=(...names)=>({attempts:names.map((name,index)=>candidate(name,index)),effort:'high'});
const message=value=>Response.json({choices:[{message:value}]});
const text=value=>message({content:value});
const tool=(id='read')=>({id,type:'function',function:{name:'browser_snapshot',arguments:'{}'}});
const llm=()=>new ApiLlm({COMMUNITY_LLM_MODEL:'fixture',COMMUNITY_LLM_BASE_URL:'https://fixture.test/v1',COMMUNITY_LLM_API_KEY:'private-default'});
const request=extra=>({system:'original instructions',user:'original task',beforeAdditionalModelCall:async()=>{},...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});return {promise,resolve,reject};};
function control(choice) {
  let revision=0,controller=new AbortController();
  const events=[];
  return {
    events,
    getSelection:()=>({revision,choice,signal:controller.signal}),
    onTransition:event=>events.push(event),
    switch(next) {const old=controller;choice=next;revision++;controller=new AbortController();old.abort();},
  };
}
async function withFetch(fetchImpl,run) {
  const original=globalThis.fetch;
  globalThis.fetch=fetchImpl;
  try { return await run(); } finally { globalThis.fetch=original; }
}

test('invalid, empty, oversized and empty-envelope 200 responses fail over and account for every response',async()=>{
  const bodies=[],events=[],failures=[],usage=[];
  let charged=0;
  const responses=[new Response('not json'),Response.json({choices:[]}),text(' '),text('x'.repeat(131072)),text('{"type":"text","content":""}'),text('final answer')];
  const modelControl=control(choose('a','b','c','d','e','f'));
  modelControl.onTransition=event=>events.push(event);
  modelControl.getSelection().choice.onProviderFailure=(...args)=>failures.push(args);
  await withFetch(async(_url,options)=>{bodies.push(JSON.parse(options.body));return responses.shift();},async()=>{
    const result=await llm().complete(request({modelControl,onUsage:event=>usage.push(event),beforeAdditionalModelCall:async()=>{charged++;}}));
    assert.match(result,/final answer/);
  });
  assert.equal(charged,5);
  assert.equal(usage.length,6);
  assert.ok(usage.every(event=>event.status===200));
  assert.deepEqual(failures.map(([,status,,scope])=>[status,scope]),['invalid_response','invalid_response','empty_response','response_too_large','empty_response'].map(reason=>[502,{scope:'model',reason}]));
  assert.deepEqual(events.filter(event=>event.stage==='failure').map(event=>event.reason),['invalid_response','invalid_response','empty_response','response_too_large','empty_response']);
  assert.deepEqual(events.filter(event=>event.stage==='attempt').map(event=>event.attempt),[1,2,3,4,5,6]);
  assert.deepEqual(events.at(-1),{stage:'finish',model:'f',provider:'groq',attempt:6,reason:'complete'});
  assert.ok(bodies.every(body=>JSON.stringify(body.messages)===JSON.stringify(bodies[0].messages)));
  assert.doesNotMatch(JSON.stringify(events),/private|fixture\.test|apiKey|baseUrl/);
});

test('all tool calls are validated before any executes, so malformed batches can safely fail over',async()=>{
  let calls=0,actions=0;
  await withFetch(async()=>++calls===1?message({tool_calls:[tool('valid'),{...tool('invalid'),function:{name:'browser_snapshot',arguments:'{'}}]}):text('recovered'),async()=>{
    const result=await llm().complete(request({...choose('a','b'),browser:async()=>{actions++;return 'read result';}}));
    assert.match(result,/recovered/);
  });
  assert.equal(calls,2);
  assert.equal(actions,0);
});

test('a model change interrupts the HTTP request and continues the exact request with the new choice',async()=>{
  const modelControl=control(choose('old')),started=deferred(),bodies=[],failures=[];
  let charged=0;
  modelControl.getSelection().choice.onProviderFailure=(...args)=>failures.push(args);
  await withFetch(async(_url,options)=>{
    bodies.push(JSON.parse(options.body));
    if(bodies.length===1) {
      started.resolve();
      return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
    }
    return text('new answer');
  },async()=>{
    const pending=llm().complete(request({modelControl,beforeAdditionalModelCall:async()=>{charged++;}}));
    await started.promise;
    modelControl.switch({...choose('selected'),effort:'low'});
    assert.match(await pending,/new answer/);
  });
  assert.deepEqual(bodies.map(body=>body.model),['old','selected']);
  assert.deepEqual(bodies[1].messages,bodies[0].messages);
  assert.equal(bodies[1].reasoning_effort,'low');
  assert.equal(charged,1);
  assert.equal(failures.length,0);
  assert.equal(modelControl.events.filter(event=>event.stage==='attempt')[1].reason,'switched');
});

test('switching during an already running tool preserves its result and never aborts or repeats it',async()=>{
  const modelControl=control(choose('old')),toolStarted=deferred(),toolFinished=deferred(),bodies=[];
  const turn=new AbortController();
  let actions=0,toolSignal;
  await withFetch(async(_url,options)=>{
    bodies.push(JSON.parse(options.body));
    return bodies.length===1?message({tool_calls:[tool()]}):text('continued');
  },async()=>{
    const pending=llm().complete(request({modelControl,browser:async(_name,_args,{signal})=>{
      actions++;toolSignal=signal;toolStarted.resolve();return toolFinished.promise;
    }}),turn.signal);
    await toolStarted.promise;
    modelControl.switch(choose('new'));
    assert.equal(toolSignal,turn.signal);
    assert.equal(toolSignal.aborted,false);
    toolFinished.resolve('completed once');
    assert.match(await pending,/continued/);
  });
  assert.equal(actions,1);
  assert.deepEqual(bodies.map(body=>body.model),['old','new']);
  assert.equal(bodies[1].messages.at(-1).role,'tool');
  assert.equal(bodies[1].messages.at(-1).content,'completed once');
});

test('after a tool result, failing providers retain the complete tool transcript on every retry',async()=>{
  const bodies=[];let actions=0;
  await withFetch(async(_url,options)=>{
    bodies.push(JSON.parse(options.body));
    if(bodies.length===1)return message({tool_calls:[tool()]});
    if(bodies.length===2)return text('');
    if(bodies.length===3)return new Response('broken json');
    return text('finished');
  },async()=>{
    await llm().complete(request({...choose('a','b','c'),browser:async()=>{actions++;return 'important retained result';}}));
  });
  assert.equal(actions,1);
  assert.deepEqual(bodies.map(body=>body.model),['a','a','b','c']);
  assert.deepEqual(bodies[1].messages,bodies[2].messages);
  assert.deepEqual(bodies[2].messages,bodies[3].messages);
  assert.equal(bodies[3].messages.at(-1).content,'important retained result');
});

test('Stop aborts an active fetch without retry, or an exhaustion wait even when its hook ignores the signal',async()=>{
  const started=deferred(),turn=new AbortController();let calls=0;
  await withFetch(async(_url,options)=>{
    calls++;started.resolve();
    return new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
  },async()=>{
    const pending=llm().complete(request({...choose('a','b')}),turn.signal);
    await started.promise;turn.abort();
    await assert.rejects(pending,{name:'AbortError'});
  });
  assert.equal(calls,1);
  const waiting=deferred(),secondTurn=new AbortController(),modelControl=control(choose('a'));
  modelControl.onExhausted=async()=>{waiting.resolve();return new Promise(()=>{});};
  await withFetch(async()=>text(''),async()=>{
    const pending=llm().complete(request({modelControl}),secondTurn.signal);
    await waiting.promise;secondTurn.abort();
    await assert.rejects(pending,{name:'AbortError'});
  });
});

test('an exhausted attempt set waits for a new choice then resumes the same messages',async()=>{
  const modelControl=control(choose('old')),bodies=[],waits=[];
  modelControl.onExhausted=async event=>{waits.push(event);modelControl.switch(choose('new'));return true;};
  await withFetch(async(_url,options)=>{bodies.push(JSON.parse(options.body));return bodies.length===1?text(''):text('resumed');},async()=>{
    assert.match(await llm().complete(request({modelControl})),/resumed/);
  });
  assert.deepEqual(waits,[{revision:0,reason:'empty_response',attempt:1}]);
  assert.deepEqual(bodies.map(body=>body.model),['old','new']);
  assert.deepEqual(bodies[1].messages,bodies[0].messages);
});

test('exhaustion cannot spin without a new revision and the global 32-call cap includes resumed choices',async()=>{
  const same=control(choose('a'));let calls=0,waits=0;
  same.onExhausted=async()=>{waits++;return true;};
  await withFetch(async()=>{calls++;return text('');},async()=>{
    await assert.rejects(llm().complete(request({modelControl:same})),/Empty model response/);
  });
  assert.equal(calls,1);assert.equal(waits,1);
  const modelControl=control(choose(...Array.from({length:10},(_,i)=>`m${i}`)));
  calls=0;waits=0;let charges=0;
  modelControl.onExhausted=async()=>{waits++;modelControl.switch(choose(...Array.from({length:10},(_,i)=>`m${waits}-${i}`)));return true;};
  await withFetch(async()=>{calls++;return text('');},async()=>{
    await assert.rejects(llm().complete(request({modelControl,beforeAdditionalModelCall:async()=>{charges++;}})),/Empty model response/);
  });
  assert.equal(calls,32);assert.equal(charges,31);assert.equal(waits,3);
});

test('ordinary failover is capped at eight calls and rechecks cooldowns between each attempt',async()=>{
  let calls=0;
  await withFetch(async()=>{calls++;return text('');},async()=>{
    await assert.rejects(llm().complete(request(choose(...Array.from({length:12},(_,i)=>`m${i}`)))),/Empty model response/);
  });
  assert.equal(calls,8);
  const seen=[],cooled=new Set(),choices=choose('a','same-key','b');
  choices.isCandidateAvailable=item=>!cooled.has(item.model);
  choices.onProviderFailure=()=>{cooled.add('same-key');};
  await withFetch(async(_url,options)=>{
    seen.push(JSON.parse(options.body).model);return seen.length===1?new Response('',{status:429}):text('done');
  },async()=>{await llm().complete(request(choices));});
  assert.deepEqual(seen,['a','b']);
});

test('explicit model selection uses only its provided same-model candidates',async()=>{
  const bodies=[],choice={...choose('selected','selected'),automatic:false};
  await withFetch(async(_url,options)=>{bodies.push(JSON.parse(options.body));return bodies.length===1?new Response('',{status:429}):text('success');},async()=>{
    await llm().complete(request({attempts:[candidate('unrelated')],modelControl:control(choice)}));
  });
  assert.deepEqual(bodies.map(body=>body.model),['selected','selected']);
});

test('switching while quota is reserved does not double charge the replacement fetch',async()=>{
  const modelControl=control(choose('a','b')),charging=deferred(),releaseQuota=deferred(),bodies=[];
  let charges=0;
  await withFetch(async(_url,options)=>{bodies.push(JSON.parse(options.body));return bodies.length===1?text(''):text('done');},async()=>{
    const pending=llm().complete(request({modelControl,beforeAdditionalModelCall:async()=>{charges++;charging.resolve();await releaseQuota.promise;}}));
    await charging.promise;modelControl.switch(choose('new'));releaseQuota.resolve();
    await pending;
  });
  assert.equal(charges,1);
  assert.deepEqual(bodies.map(body=>body.model),['a','new']);
});

test('switching during the response stream cancels the old body, accounts its response, and never uses stale content',async()=>{
  const modelControl=control(choose('old')),reading=deferred(),bodies=[],usage=[];
  let cancelled=0;
  const oldResponse=new Response(new ReadableStream({pull(){reading.resolve();return new Promise(()=>{});},cancel(){cancelled++;}}));
  await withFetch(async(_url,options)=>{bodies.push(JSON.parse(options.body));return bodies.length===1?oldResponse:text('new content');},async()=>{
    const pending=llm().complete(request({modelControl,onUsage:event=>usage.push(event)}));
    await reading.promise;modelControl.switch(choose('new'));
    assert.match(await pending,/new content/);
  });
  assert.equal(cancelled,1);
  assert.deepEqual(usage.map(event=>event.model),['old','new']);
});

test('network and timeout failures expose only fixed reason codes and retry with the same prompt',async()=>{
  const modelControl=control(choose('a','b','c')),failures=[],bodies=[];
  modelControl.getSelection().choice.onProviderFailure=(...args)=>failures.push(args);
  await withFetch(async(_url,options)=>{
    bodies.push(JSON.parse(options.body));
    if(bodies.length===1)throw new TypeError('private-key-and-upstream-url');
    if(bodies.length===2)throw new DOMException('private-timeout-details','TimeoutError');
    return text('done');
  },async()=>{await llm().complete(request({modelControl}));});
  assert.deepEqual(modelControl.events.filter(event=>event.stage==='failure').map(event=>event.reason),['network','timeout']);
  assert.deepEqual(failures.map(([,status])=>status),[503,503]);
  assert.doesNotMatch(JSON.stringify(modelControl.events),/private/);
  assert.deepEqual(bodies[0].messages,bodies[2].messages);
});

test('four executed tool actions leave one final model call, and further tool responses never execute',async()=>{
  let actions=0,fetches=0;
  const bodies=[];
  await withFetch(async(_url,options)=>{
    const body=JSON.parse(options.body);bodies.push(body);fetches++;
    return fetches<=4?message({tool_calls:[tool(`call-${fetches}`)]}):text('final');
  },async()=>{await llm().complete(request({...choose('a'),browser:async()=>{actions++;return 'result';}}));});
  assert.equal(actions,4);assert.equal(fetches,5);assert.equal(bodies.at(-1).tools,undefined);
  actions=0;fetches=0;
  await withFetch(async()=>{fetches++;return message({tool_calls:[tool(`call-${fetches}`)]});},async()=>{
    await assert.rejects(llm().complete(request({...choose('a'),browser:async()=>{actions++;return 'result';}})),/Browser action budget exceeded/);
  });
  assert.equal(actions,4);assert.equal(fetches,5);
});

test('a manual model generation gets a fresh eight-attempt step budget while all generations share the 32-call cap',async()=>{
  const modelControl=control(choose(...Array.from({length:8},(_,i)=>`old-${i}`)));
  const seen=[];
  await withFetch(async(_url,options)=>{
    const model=JSON.parse(options.body).model;seen.push(model);
    if(seen.length===7)modelControl.switch(choose(...Array.from({length:8},(_,i)=>`new-${i}`)));
    return model==='new-7'?text('continued with fresh choices'):text('');
  },async()=>{
    assert.match(await llm().complete(request({modelControl})),/continued with fresh choices/);
  });
  assert.equal(seen.length,15);
  assert.deepEqual(seen.slice(7),Array.from({length:8},(_,i)=>`new-${i}`));
  let calls=0;
  const switching=control(choose('m0'));
  await withFetch(async()=>{
    calls++;switching.switch(choose(`m${calls}`));return text('discarded response');
  },async()=>{await assert.rejects(llm().complete(request({modelControl:switching})));});
  assert.equal(calls,32);
});
