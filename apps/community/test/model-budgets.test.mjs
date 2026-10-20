import test from 'node:test';
import assert from 'node:assert/strict';
import {ApiLlm} from '../model.mjs';
import {OpenClawHttpAdapter} from '../lib/backend/openclaw-http.mjs';
import {createContinuation,beginTool,finishTool,snapshotContinuation,continuationPrompt} from '../message-continuation.mjs';
import {BROWSER_TOOL_DEFINITIONS} from '../browser-tools.mjs';
import {HOST_ADMIN_TOOLS,HOST_ADMIN_PROMPT} from '../host-admin.mjs';
import {MOBILE_TOOL_DEFINITIONS,MOBILE_TOOL_PROMPT} from '../mobile.mjs';
import {DRAWING_TOOLS,DRAWING_PROMPT} from '../drawings.mjs';
import {assistantInstructions} from '../assistant-instructions.mjs';

const api=()=>new ApiLlm({COMMUNITY_LLM_MODEL:'chat-fixture',COMMUNITY_LLM_BASE_URL:'https://fixture.test/v1',COMMUNITY_LLM_API_KEY:'fixture-key'});
const candidate=model=>({model,baseUrl:'https://fixture.test/v1',apiKey:'fixture-key'});
const request=extra=>({system:'instructions',user:'current request',beforeAdditionalModelCall:async()=>{},...extra});
const definition=name=>({type:'function',function:{name,parameters:{type:'object'}}});
const call=(name,args)=>({id:'call-1',type:'function',function:{name,arguments:JSON.stringify(args)}});
const answer=(message,finish_reason='stop')=>Response.json({choices:[{message,finish_reason}]});
const resultText=result=>JSON.parse(result.slice('SendMessage: '.length)).content;
async function withFetch(fetchImpl,run) {
  const previous=globalThis.fetch;globalThis.fetch=fetchImpl;
  try{return await run();}finally{globalThis.fetch=previous;}
}
const gateway=(fetchImpl,extra={})=>new OpenClawHttpAdapter({baseUrl:'http://127.0.0.1:18789',token:'gateway-fixture-token',fetchImpl,...extra});
const gatewayRequest=extra=>request({isolation:{userId:'owner',roomId:'room',botId:'agent'},...extra});
const gatewayCall=(name,args)=>({type:'function_call',call_id:'call-1',name,arguments:JSON.stringify(args)});
const groqCandidate=()=>({...candidate('openai/gpt-oss-120b'),provider:'groq'});
const tpmRejection=(limit,requested)=>Response.json({error:{type:'tokens',code:'rate_limit_exceeded',
  message:`Request too large for model on tokens per minute (TPM): Limit ${limit}, Requested ${requested}, please reduce your message size.`}},
  {status:413,headers:{'x-ratelimit-limit-tokens':String(limit)}});

test('completion budgets leave space for reasoning and tools while each HTTP attempt stays bounded',async t=>{
  const deadlines=[];
  t.mock.method(AbortSignal,'timeout',ms=>{deadlines.push(ms);return new AbortController().signal;});
  const variants=[
    [{},4096,30000],
    [{images:['data:image/png;base64,AA==']},2048,30000],
    [{effort:'high'},8192,60000],
    [{model:'openai/gpt-oss-120b'},8192,60000],
    [{browser:async()=>'',toolDefinitions:[definition('host_exec')]},8192,60000],
    [{browser:async()=>'',toolDefinitions:[]},4096,30000],
  ];
  for(const [extra,tokens,timeout]of variants) {
    await withFetch(async(_url,options)=>{
      assert.equal(JSON.parse(options.body).max_tokens,tokens);
      assert.equal(deadlines.at(-1),timeout);
      return answer({content:'done'});
    },()=>api().complete(request(extra)));
  }
});

test('Groq reserves room for the real owner prompt and full drawing/browser/host/mobile schemas',async()=>{
  const tools=[...DRAWING_TOOLS,...BROWSER_TOOL_DEFINITIONS,...HOST_ADMIN_TOOLS,...MOBILE_TOOL_DEFINITIONS];
  const system=assistantInstructions({hostExecutor:true,hasBrowser:true,hasMobile:true,drawingTool:true,voiceCall:true})+
    HOST_ADMIN_PROMPT+MOBILE_TOOL_PROMPT+DRAWING_PROMPT;
  const user='현재 요청: 그림을 만들고 파일로 저장해 주세요.';
  const bodies=[];
  for(const toolDefinitions of [[],tools])await withFetch(async(_url,options)=>{
    bodies.push(JSON.parse(options.body));return answer({content:'done'});
  },()=>api().complete(request({system,user,attempts:[groqCandidate()],toolDefinitions,browser:async()=>''})));
  const full=bodies[1];
  assert.deepEqual(full.tools,tools);assert.deepEqual(full.messages,[{role:'system',content:system},{role:'user',content:user}]);
  assert.ok(full.max_tokens>=512 && full.max_tokens<=4096);
  assert.ok(full.max_tokens<bodies[0].max_tokens,'tool schemas must reduce the available output reservation');
  const estimatedInput=Math.ceil(Buffer.byteLength(JSON.stringify({messages:full.messages,tools:full.tools}))/3)+128;
  assert.ok(estimatedInput+full.max_tokens+256<=8000);
});

test('a directly configured Groq endpoint receives its budget even without provider metadata',async()=>{
  const direct=new ApiLlm({COMMUNITY_LLM_MODEL:'openai/gpt-oss-120b',COMMUNITY_LLM_BASE_URL:'https://api.groq.com/openai/v1',COMMUNITY_LLM_API_KEY:'fixture-key'});
  await withFetch(async(_url,options)=>{
    assert.equal(JSON.parse(options.body).max_tokens,4096);
    return answer({content:'done'});
  },()=>direct.complete(request()));
});

test('Groq TPM 413 retries once with a measured smaller budget, accounts both responses and keeps tools',async()=>{
  const bodies=[],usage=[],failures=[];let charged=0,actions=0;
  await withFetch(async(_url,options)=>{
    const body=JSON.parse(options.body);bodies.push(body);
    if(bodies.length===1)return tpmRejection(8000,6000+body.max_tokens);
    if(bodies.length===2)return answer({tool_calls:[call('host_exec',{command:'create one file'})]},'tool_calls');
    return answer({content:'saved'});
  },async()=>assert.equal(resultText(await api().complete(request({attempts:[groqCandidate()],toolDefinitions:[definition('host_exec')],
    browser:async()=>{actions++;return 'file-created';},beforeAdditionalModelCall:async()=>{charged++;},
    onUsage:value=>usage.push(value),onProviderFailure:(...args)=>failures.push(args)}))),'saved'));
  assert.equal(bodies[0].max_tokens,4096);assert.equal(bodies[1].max_tokens,1744);
  assert.equal(6000+bodies[1].max_tokens+256,8000);
  assert.deepEqual(bodies[0].messages,bodies[1].messages);assert.deepEqual(bodies[0].tools,bodies[1].tools);
  assert.equal(actions,1);assert.equal(charged,2);assert.deepEqual(usage.map(item=>item.status),[413,200,200]);
  assert.equal(failures.length,0);assert.equal(bodies[2].messages.at(-1).content,'file-created');
});

test('Groq input that alone exceeds TPM goes directly to the next model without truncation or key cooldown',async()=>{
  const bodies=[],failures=[];let charged=0;
  const user='CURRENT_INSTRUCTION'.padEnd(4000,'한');
  await withFetch(async(_url,options)=>{
    const body=JSON.parse(options.body);bodies.push(body);
    return bodies.length===1?tpmRejection(8000,9000+body.max_tokens):answer({content:'continued elsewhere'});
  },()=>api().complete(request({user,attempts:[groqCandidate(),candidate('other-provider')],
    toolDefinitions:[definition('create_drawing')],browser:async()=>'',beforeAdditionalModelCall:async()=>{charged++;},
    onProviderFailure:(...args)=>failures.push(args)})));
  assert.equal(bodies.length,2);assert.equal(charged,1);assert.equal(bodies[1].model,'other-provider');
  assert.equal(bodies[1].max_tokens,8192);assert.deepEqual(bodies[0].messages,bodies[1].messages);
  assert.equal(bodies[1].messages.at(-1).content,user);assert.deepEqual(bodies[0].tools,bodies[1].tools);
  assert.equal(failures[0][1],413);assert.deepEqual(failures[0][3],{scope:'model'});
});

test('a second Groq size rejection cannot loop and completed tools survive model fallback',async()=>{
  const bodies=[],failures=[];let actions=0;
  await withFetch(async(_url,options)=>{
    const body=JSON.parse(options.body);bodies.push(body);
    if(bodies.length===1)return answer({tool_calls:[call('host_exec',{command:'already-completed'})]},'tool_calls');
    if(body.model==='openai/gpt-oss-120b')return tpmRejection(8000,8000+Math.ceil(body.max_tokens/2));
    return answer({content:'continued'});
  },()=>api().complete(request({attempts:[groqCandidate(),candidate('other-provider')],toolDefinitions:[definition('host_exec')],
    browser:async()=>{actions++;return 'already-completed';},onProviderFailure:(...args)=>failures.push(args)})));
  assert.equal(bodies.length,4);assert.equal(actions,1);assert.equal(failures.length,1);
  assert.ok(bodies[2].max_tokens<bodies[1].max_tokens);
  assert.deepEqual(bodies[1].messages,bodies[2].messages);assert.deepEqual(bodies[2].messages,bodies[3].messages);
  assert.equal(bodies[3].messages.at(-1).content,'already-completed');
});

test('unrelated 413 responses and provider refusals never use the TPM budget retry',async()=>{
  for(const payload of [
    {error:{type:'tokens',code:'rate_limit_exceeded',message:'Context length exceeded'}},
    {error:{type:'content_filter',code:'content_filter',message:'This request is restricted'}},
  ]) {
    let fetches=0;
    await withFetch(async()=>{fetches++;return Response.json(payload,{status:413});},async()=>{
      await assert.rejects(api().complete(request({attempts:[groqCandidate(),candidate('other-provider')]})),/rejected request \(413\)/);
    });
    assert.equal(fetches,1);
  }
  let fetches=0;
  await withFetch(async()=>{fetches++;return answer({refusal:'This request is restricted.',content:null});},
    ()=>api().complete(request({attempts:[groqCandidate(),candidate('other-provider')]})));
  assert.equal(fetches,1);
});

test('Stop after a Groq size rejection prevents its retry',async()=>{
  const controller=new AbortController();let fetches=0;
  await withFetch(async(_url,options)=>{fetches++;return tpmRejection(8000,6000+JSON.parse(options.body).max_tokens);},async()=>{
    await assert.rejects(api().complete(request({attempts:[groqCandidate()],onUsage:()=>controller.abort()}),controller.signal),{name:'AbortError'});
  });
  assert.equal(fetches,1);
});

test('a timed-out longer request still fails over with the original prompt and charges the retry',async t=>{
  const timers=[],bodies=[];let charges=0;
  t.mock.method(AbortSignal,'timeout',ms=>{const controller=new AbortController();timers.push({ms,controller});return controller.signal;});
  await withFetch(async(_url,options)=>{
    bodies.push(JSON.parse(options.body));
    if(bodies.length>1)return answer({content:'recovered'});
    const pending=new Promise((_resolve,reject)=>options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true}));
    queueMicrotask(()=>timers[0].controller.abort(new DOMException('deadline','TimeoutError')));
    return pending;
  },async()=>assert.match(await api().complete(request({effort:'high',attempts:[candidate('a'),candidate('b')],beforeAdditionalModelCall:async()=>{charges++;}})),/recovered/));
  assert.deepEqual(timers.map(item=>item.ms),[60000,60000]);
  assert.deepEqual(bodies[0].messages,bodies[1].messages);assert.equal(charges,1);
});

test('truncated text and even valid truncated commands never become a successful reply or execute',async()=>{
  for(const partial of [{content:'partial answer'}, {content:null,tool_calls:[call('host_exec',{command:'touch /tmp/partial'})]}]) {
    let actions=0,charges=0;const bodies=[],failures=[],usage=[];
    await withFetch(async(_url,options)=>{bodies.push(JSON.parse(options.body));return bodies.length===1?answer(partial,'length'):answer({content:'complete answer'});},async()=>{
      assert.equal(resultText(await api().complete(request({attempts:[candidate('a'),candidate('b')],toolDefinitions:[definition('host_exec')],
        browser:async()=>{actions++;return 'ran';},beforeAdditionalModelCall:async()=>{charges++;},onProviderFailure:(...args)=>failures.push(args),onUsage:value=>usage.push(value)}))),'complete answer');
    });
    assert.equal(actions,0);assert.equal(charges,1);assert.equal(failures.length,1);assert.equal(usage.length,2);
    assert.deepEqual(bodies[0].messages,bodies[1].messages);
  }
});

test('a truncated continuation retains already executed work without replaying it',async()=>{
  const bodies=[];let actions=0;
  await withFetch(async(_url,options)=>{
    bodies.push(JSON.parse(options.body));
    if(bodies.length===1)return answer({tool_calls:[call('host_exec',{command:'create-file'})]},'tool_calls');
    if(bodies.length===2)return answer({content:'unfinished'},'length');
    return answer({content:'saved'});
  },async()=>assert.match(await api().complete(request({attempts:[candidate('a'),candidate('b')],toolDefinitions:[definition('host_exec')],browser:async()=>{actions++;return 'file-created';}})),/saved/));
  assert.equal(actions,1);assert.equal(bodies.length,3);
  assert.deepEqual(bodies[1].messages,bodies[2].messages);
  assert.equal(bodies[2].messages.at(-1).content,'file-created');
});

test('tool failures describe the tool generically and do not disclose private exceptions',async()=>{
  for(const name of ['host_exec','create_drawing']) {
    const bodies=[];
    await withFetch(async(_url,options)=>{
      bodies.push(JSON.parse(options.body));
      return bodies.length===1?answer({tool_calls:[call(name,{})]},'tool_calls'):answer({content:'failed safely'});
    },()=>api().complete(request({toolDefinitions:[definition(name)],browser:async()=>{throw new Error('private-credential-fixture');}})));
    const error=bodies[1].messages.at(-1).content;
    assert.match(error,/^Tool action failed:/);assert.doesNotMatch(error,/Browser|page|private-credential/);
  }
});

test('natural refusals, structured refusals and content filters never trigger another model or tool',async()=>{
  const variants=[
    [{content:'이 요청은 도와드릴 수 없습니다.'},'stop'],
    [{content:null,refusal:'This request is restricted.'},'stop'],
    [{content:null},'content_filter'],
    [{content:null,tool_calls:[call('host_exec',{command:'must-not-run'})]},'content_filter'],
  ];
  for(const [message,reason]of variants) {
    let fetches=0,actions=0,charges=0,failures=0;
    await withFetch(async()=>{fetches++;return answer(message,reason);},async()=>{
      const result=await api().complete(request({attempts:[candidate('a'),candidate('b')],toolDefinitions:[definition('host_exec')],
        browser:async()=>{actions++;},beforeAdditionalModelCall:async()=>{charges++;},onProviderFailure:()=>{failures++;}}));
      assert.ok(resultText(result).length>0);
    });
    assert.equal(fetches,1);assert.equal(actions,0);assert.equal(charges,0);assert.equal(failures,0);
  }
});

test('only advertised host and drawing tools accept larger bounded arguments in both adapters',async()=>{
  for(const kind of ['api','gateway'])for(const name of ['host_exec','create_drawing']) {
    const args=name==='host_exec'?{command:'printf "illustration"\n'.repeat(650)}:{shapes:Array.from({length:100},(_,x)=>({type:'text',x,y:10,text:'diagram label '.repeat(6)}))};
    assert.ok(JSON.stringify(args).length>10000);assert.ok(Buffer.byteLength(JSON.stringify(args))<32768);
    let fetches=0,actions=0;const bodies=[];
    const execute=async(tool,received)=>{assert.equal(tool,name);assert.deepEqual(received,args);actions++;return 'saved';};
    if(kind==='api')await withFetch(async(_url,options)=>{
      bodies.push(JSON.parse(options.body));return ++fetches===1?answer({tool_calls:[call(name,args)]},'tool_calls'):answer({content:'done'});
    },()=>api().complete(request({toolDefinitions:[definition(name)],browser:execute})));
    else await gateway(async(_url,options)=>{
      bodies.push(JSON.parse(options.body));return Response.json(++fetches===1?{output:[gatewayCall(name,args)]}:{output_text:'done'});
    }).complete(gatewayRequest({toolDefinitions:[definition(name)],browser:execute}));
    assert.equal(actions,1);assert.equal(fetches,2);
    assert.ok(bodies.every(body=>(body.max_tokens??body.max_output_tokens)===8192));
  }
});

test('oversized Unicode arguments and large unrelated-tool arguments are rejected before execution',async()=>{
  for(const kind of ['api','gateway'])for(const [name,args]of [['host_exec',{command:'한'.repeat(11000)}],['create_drawing',{text:'x'.repeat(32768)}],['browser_type',{text:'x'.repeat(10001)}]]) {
    let actions=0;
    const execute=async()=>{actions++;};
    if(kind==='api')await withFetch(async()=>answer({tool_calls:[call(name,args)]},'tool_calls'),async()=>{
      await assert.rejects(api().complete(request({toolDefinitions:[definition(name)],browser:execute})),/Invalid browser tool call/);
    });
    else await assert.rejects(gateway(async()=>Response.json({output:[gatewayCall(name,args)]})).complete(gatewayRequest({toolDefinitions:[definition(name)],browser:execute})),/Invalid OpenClaw client tool call/);
    assert.equal(actions,0);
  }
});

test('gateway keeps the current request after long history and rejects oversized user input without submission',async()=>{
  const bodies=[];
  const adapter=gateway(async(_url,options)=>{bodies.push(JSON.parse(options.body));return Response.json({output_text:'done'});});
  const current='CURRENT REQUEST';
  await adapter.complete(gatewayRequest({system:'s'.repeat(9000),context:'c'.repeat(9000),user:'h'.repeat(10000)+current}));
  assert.equal(bodies[0].input[0].content.length,8000);assert.equal(bodies[0].input[1].content.length,8000);
  assert.ok(bodies[0].input[2].content.endsWith(current));assert.equal(bodies[0].max_output_tokens,4096);
  await adapter.complete(gatewayRequest({user:'u'.repeat(48000)}));
  assert.equal(bodies[1].input.at(-1).content.length,48000);
  await assert.rejects(adapter.complete(gatewayRequest({user:'u'.repeat(48001)})),/user input exceeds 48000/);
  assert.equal(bodies.length,2);
});

test('gateway preserves a full steering handoff including completed tools and the latest instruction',async()=>{
  let state=createContinuation({requestText:'ORIGINAL_GOAL'.padEnd(3990,'.')});
  for(let i=0;i<2;i++)state=createContinuation({continuation:snapshotContinuation(state,`earlier instruction ${i}`.padEnd(3990,'.'))});
  for(let i=0;i<4;i++) {
    const handle=beginTool(state,'host_exec',{command:`command-${i}`.padEnd(900,'.')});
    finishTool(state,handle,`FILE_ALREADY_CREATED_${i}`.padEnd(2350,'.'));
  }
  const snapshot=snapshotContinuation(state,'LATEST_INSTRUCTION_DO_NOT_REPEAT'.padEnd(3990,'.'));
  const handoff=continuationPrompt(snapshot);
  const user='현재 인증된 사용자의 요청:\n'+handoff+'\n이전 대화:\n'+'h'.repeat(8000)+'\n이미지 판독:\n'+'i'.repeat(4000)+'\n다른 봇 답변:\n'+'b'.repeat(4000);
  assert.ok(user.length>40000);assert.ok(user.length<=48000);
  let received;
  await gateway(async(_url,options)=>{received=JSON.parse(options.body).input.at(-1).content;return Response.json({output_text:'continued'});}).complete(gatewayRequest({user}));
  assert.equal(received,user);assert.ok(received.includes('ORIGINAL_GOAL'));
  assert.ok(received.includes('LATEST_INSTRUCTION_DO_NOT_REPEAT'));
  for(const record of snapshot.checkpoints)assert.ok(received.includes(JSON.stringify(record)));
  assert.ok(received.includes('FILE_ALREADY_CREATED_3'));
});

test('gateway rejects incomplete text and calls, and returns provider refusals without executing mixed calls',async()=>{
  for(const output of [{output_text:'partial'}, {output:[gatewayCall('host_exec',{command:'partial'})]}]) {
    let actions=0,fetches=0;
    await assert.rejects(gateway(async()=>{fetches++;return Response.json({status:'incomplete',incomplete_details:{reason:'max_output_tokens'},...output});}).complete(gatewayRequest({toolDefinitions:[definition('host_exec')],browser:async()=>{actions++;}})),/incomplete/);
    assert.equal(actions,0);assert.equal(fetches,1);
  }
  for(const payload of [
    {status:'incomplete',incomplete_details:{reason:'content_filter'},output:[gatewayCall('host_exec',{command:'must-not-run'})]},
    {output:[{type:'message',content:[{type:'refusal',refusal:'Cannot fulfill this request.'}]},gatewayCall('host_exec',{command:'must-not-run'})]},
  ]) {
    let actions=0,fetches=0;
    const result=await gateway(async()=>{fetches++;return Response.json(payload);}).complete(gatewayRequest({toolDefinitions:[definition('host_exec')],browser:async()=>{actions++;}}));
    assert.ok(resultText(result).length>0);assert.equal(actions,0);assert.equal(fetches,1);
  }
});
