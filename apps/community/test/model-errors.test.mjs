import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiLlm} from '../model.mjs';
import {createProviderPool} from '../providers.mjs';

const candidate=model=>({model,provider:'fixture',baseUrl:'https://fixture.test/v1',apiKey:'private-key'});
const llm=()=>new ApiLlm({COMMUNITY_LLM_MODEL:'first',COMMUNITY_LLM_BASE_URL:'https://fixture.test/v1',COMMUNITY_LLM_API_KEY:'private-key'});
const request=extra=>({system:'instructions',user:'current task',attempts:[candidate('first'),candidate('second')],...extra});
const answer=()=>Response.json({choices:[{message:{content:'finished'}}]});
async function withFetch(fetcher,run) {
  const previous=globalThis.fetch;globalThis.fetch=fetcher;
  try {return await run();} finally {globalThis.fetch=previous;}
}

test('provider HTTP failures report bounded fixed reasons with correct model/key/request scope',async()=>{
  for(const [status,error,reason,scope] of [
    [400,{code:'invalid_model'},'unsupported_model','model'],
    [404,{code:'model_not_found'},'unsupported_model','model'],
    [404,{type:'not_found_error'},'endpoint_not_found','provider'],
    [500,{code:'invalid_model'},'provider_error','provider'],
    [503,{code:'server_is_overloaded'},'provider_error','provider'],
    [401,{code:'invalid_api_key'},'authentication','key'],
    [402,{},'billing','key'],
    [429,{code:'rate_limit_exceeded'},'rate_limit','key'],
    [429,{type:'insufficient_quota'},'billing','key'],
    [403,{code:'model_permission_blocked_org'},'model_unavailable','model'],
    [403,{code:'model_permission_blocked_project'},'model_unavailable','model'],
    [403,{metadata:{limit_source:'openrouter_key_limit'}},'billing','key'],
    [403,{},'authentication','key'],
    [408,{},'timeout','model'],
    [413,{},'request_too_large','request'],
    [400,{code:'context_length_exceeded'},'context_length','request'],
    [422,{code:'input_too_long'},'context_length','request'],
    [400,{code:'invalid_parameter'},'invalid_request','model'],
  ]) {
    let count=0,charges=0;const failures=[],successes=[],events=[],usage=[];
    await withFetch(async()=>++count===1?Response.json({error:{message:'private raw key and user content',...error}},
      {status,headers:{'retry-after':'2'}}):answer(),async()=>{
      assert.match(await llm().complete(request({onProviderFailure:(...args)=>failures.push(args),
        onProviderSuccess:value=>successes.push(value.model),beforeAdditionalModelCall:()=>{charges++;},
        onUsage:value=>usage.push(value),
        modelControl:{getSelection:()=>({revision:0}),onTransition:event=>events.push(event)},
      })),/finished/);
    });
    assert.equal(count,2);assert.equal(charges,1);
    assert.deepEqual(failures.map(([,status,delay,details])=>[status,delay,details]),[[status,2000,{scope,reason}]]);
    assert.deepEqual(successes,['second']);
    assert.equal(events.find(event=>event.stage==='failure').reason,reason);
    assert.deepEqual(usage.map(value=>value.status),[status,200]);
    assert.doesNotMatch(JSON.stringify([failures.map(args=>args.slice(1)),events,usage]),/private raw|user content/);
  }
});

test('policy errors stay final across HTTP status and compatible HTTP 200 envelopes',async()=>{
  for(const [status,error] of [
    [400,{code:'content_policy_violation'}],
    [403,{type:'moderation_error'}],
    [413,{code:'content_filter'}],
    [403,{metadata:{flagged_input:'private input',reasons:['blocked']}}],
    [403,{metadata:{patterns:['private injection text']}}],
    [403,{message:'Request blocked: prompt injection patterns detected'}],
    [200,{code:403,metadata:{flagged_input:'private input'}}],
    [200,{code:'content_filter'}],
  ]) {
    let calls=0,actions=0,failures=0,successes=0;
    await withFetch(async()=>{calls++;return Response.json({error},{status});},async()=>{
      const result=await llm().complete(request({browser:async()=>{actions++;},
        onProviderFailure:()=>{failures++;},onProviderSuccess:()=>{successes++;}}));
      assert.match(result,/제공자 정책/);assert.doesNotMatch(result,/private/);
    });
    assert.equal(calls,1);assert.equal(actions,0);assert.equal(failures,0);assert.equal(successes,0);
  }
});

test('HTTP 200 error envelopes cannot masquerade as successful responses or hide unsupported model codes',async()=>{
  const failures=[],successes=[];
  let calls=0;
  await withFetch(async()=>++calls===1?Response.json({error:{code:'invalid_model',message:'private provider message'}}):answer(),async()=>{
    assert.match(await llm().complete(request({onProviderFailure:(...args)=>failures.push(args),onProviderSuccess:item=>successes.push(item.model)})),/finished/);
  });
  assert.deepEqual(failures[0].slice(1),[502,undefined,{scope:'model',reason:'unsupported_model'}]);
  assert.deepEqual(successes,['second']);
});

test('oversized or non-JSON error bodies use the HTTP category and cancel reading',async()=>{
  for(const oversized of [false,true]) {
    let calls=0,cancelled=0;const failures=[];
    await withFetch(async()=>{
      if(++calls>1)return answer();
      return new Response(new ReadableStream({
        start(controller){controller.enqueue(new TextEncoder().encode(oversized?'x'.repeat(8193):'<h1>route missing</h1>'));if(!oversized)controller.close();},
        cancel(){cancelled++;},
      }),{status:404});
    },()=>llm().complete(request({onProviderFailure:(...args)=>failures.push(args)})));
    assert.deepEqual(failures[0][3],{scope:'provider',reason:'endpoint_not_found'});
    if(oversized)assert.equal(cancelled,1,'the 8KiB error body limit cancels the upstream stream');
  }
});

test('Stop during a stalled error body cancels reading without another attempt or availability mutation',async()=>{
  const turn=new AbortController();let started,readCancelled=0,calls=0,failures=0,successes=0;
  const ready=new Promise(resolve=>{started=resolve;});
  await withFetch(async()=>{
    calls++;
    return new Response(new ReadableStream({
      pull(){started();return new Promise(()=>{});},cancel(){readCancelled++;},
    }),{status:500});
  },async()=>{
    const pending=llm().complete(request({onProviderFailure:()=>{failures++;},onProviderSuccess:()=>{successes++;}}),turn.signal);
    await ready;turn.abort();await assert.rejects(pending,{name:'AbortError'});
  });
  assert.equal(calls,1);assert.equal(failures,0);assert.equal(successes,0);assert.equal(readCancelled,1);
});

test('successful validated tool responses rehabilitate their model; malformed or stale responses do not',async()=>{
  const successes=[];let calls=0,actions=0;
  const tool={type:'function',function:{name:'browser_snapshot',parameters:{type:'object'}}};
  await withFetch(async()=>{
    calls++;
    if(calls===1)return Response.json({choices:[{message:{tool_calls:[{id:'read',type:'function',function:{name:'browser_snapshot',arguments:'{}'}}]}}]});
    if(calls===2)return Response.json({choices:[{message:{content:''}}]});
    return answer();
  },()=>llm().complete(request({toolDefinitions:[tool],browser:async()=>{actions++;return 'read once';},onProviderSuccess:value=>successes.push(value.model)})));
  assert.equal(actions,1);assert.deepEqual(successes,['first','second']);

  let revision=0;const observed=[];
  const control={getSelection:()=>({revision,choice:{attempts:[candidate(revision?'new':'old')],onProviderSuccess:item=>observed.push(item.model)}})};
  await withFetch(answer,()=>llm().complete(request({
    modelControl:control,onUsage:()=>{revision=1;},
  })));
  assert.deepEqual(observed,['new'],'only a response for the current selection may reset availability');
  await withFetch(answer,async()=>assert.match(await llm().complete(request({onProviderSuccess:()=>{throw new Error('bookkeeping failure');}})),/finished/));
});

test('unsupported models are skipped by subsequent real completions and shared rebuilt pools',async()=>{
  const env={GROQ_API_KEY:'fixture-key'},catalog=async()=>({ok:true,json:async()=>({data:[{id:'openai/gpt-oss-120b'},{id:'openai/gpt-oss-20b'}]})});
  const pool=createProviderPool(env,catalog);await pool.listModels();
  const tried=[],failures=[];
  await withFetch(async(_url,options)=>{
    const model=JSON.parse(options.body).model;tried.push(model);
    return model.endsWith('120b')?Response.json({error:{code:'invalid_model'}},{status:400}):answer();
  },async()=>{
    for(let i=0;i<2;i++)await llm().complete(request({...pool.choose('','')}));
    const rebuilt=createProviderPool(env,catalog,{availability:pool.availability});await rebuilt.listModels();
    const choice=rebuilt.choose('','');
    await llm().complete(request({...choice,onProviderFailure:(...args)=>failures.push(args)}));
  });
  assert.deepEqual(tried,['openai/gpt-oss-120b','openai/gpt-oss-20b','openai/gpt-oss-20b','openai/gpt-oss-20b']);
  assert.deepEqual(failures,[]);
});
