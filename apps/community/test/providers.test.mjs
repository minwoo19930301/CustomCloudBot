import test from "node:test";
import assert from "node:assert/strict";
import { createProviderPool, formatModelList, publicModels, readProviders } from "../providers.mjs";

const modelsResponse = (ids, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => ({ data: ids.map((id) => ({ id })) }),
  body: { cancel: async () => {} },
});

test("provider reader keeps named keys and numbered keys, and drops secrets from duplicates", () => {
  const providers = readProviders({
    GROQ_API_KEY: "groq-a",
    GROQ_API_KEY_2: "groq-b",
    OPENROUTER_API_KEY: "route-a",
    COMMUNITY_LLM_BASE_URL: "https://api.groq.com/openai/v1",
    COMMUNITY_LLM_API_KEY: "groq-a",
    COMMUNITY_LLM_PROVIDERS: JSON.stringify([
      { name: "extra", baseUrl: "https://api.example.test/v1", apiKey: "extra-key" },
      { name: "bad", baseUrl: "http://example.test/v1", apiKey: "nope" },
    ]),
  });
  assert.deepEqual(providers.map((provider) => provider.name), ["groq", "groq", "openrouter", "extra"]);
  assert.equal(JSON.stringify(providers).includes("groq-a"), true);
});

test("model listing reads each API at call time and rotation stays on keys that have the model", async () => {
  const seen = [];
  const pool = createProviderPool({
    GROQ_API_KEY: "secret-one",
    GROQ_API_KEY_2: "secret-two",
    OPENAI_API_KEY: "secret-openai",
  }, async (url, options) => {
    seen.push({ url, authorization: options.headers.authorization });
    if (url.includes("openai.com")) return modelsResponse(["gpt-4o-mini"]);
    if (options.headers.authorization.endsWith("secret-two")) return modelsResponse([], 429);
    return modelsResponse(["llama-3.1-8b-instant", "openai/gpt-oss-120b"]);
  });
  const listed = await pool.listModels();
  assert.equal(seen.length, 3);
  assert.equal(seen.every((call) => call.url.endsWith("/models")), true);
  const text = formatModelList(listed);
  const published = publicModels(listed);
  assert.match(text, /llama-3\.1-8b-instant/);
  assert.equal(text.includes("secret-"), false);
  assert.equal(JSON.stringify(published).includes("secret-"), false);
  assert.equal(published.some((model) => model.id === "llama-3.1-8b-instant"), true);
  const first = pool.choose("llama-3.1-8b-instant", "high");
  const second = pool.choose("llama-3.1-8b-instant", "high");
  assert.equal(first.model, "llama-3.1-8b-instant");
  assert.equal(first.apiKey, "secret-one");
  assert.equal(second.apiKey, "secret-one");
  assert.equal(first.effort, "high");
  assert.equal(pool.choose("gpt-4o-mini", "").apiKey, "secret-openai");
});

test("automatic rotation starts after a live list when no single model is selected", async () => {
  const pool = createProviderPool({
    GROQ_API_KEY: "secret-one",
    OPENROUTER_API_KEY: "secret-two",
  }, async (url) => modelsResponse(url.includes("groq") ? ["groq-model"] : ["route-model:free"]));
  assert.equal(pool.choose("", ""), null);
  await pool.listModels();
  const picks = [pool.choose("", ""), pool.choose("", "")];
  assert.deepEqual(picks.map((pick) => pick.model).sort(), ["groq-model", "route-model:free"]);
  assert.equal(new Set(picks.map((pick) => pick.apiKey)).size, 2);
});

test("chat catalog excludes audio and moderation models and keeps automatic choice stable", async () => {
  const pool = createProviderPool({GROQ_API_KEY:"test-key"}, async () => modelsResponse(["whisper-large-v3", "canopylabs/orpheus-v1-english", "meta-llama/llama-prompt-guard-2-22m", "openai/gpt-oss-20b", "openai/gpt-oss-120b"]));
  const listed = await pool.listModels();
  assert.equal(listed.models.length, 2);
  assert.equal(pool.choose("", "").model, "openai/gpt-oss-120b");
});

test('HF token aliases and provider failover exclude cooled keys and paid auto routes', async()=>{
 const pool=createProviderPool({HUGGINGFACE_TOKEN_2:'hf',GROQ_API_KEY:'g',OPENROUTER_API_KEY:'o'}, async url=>modelsResponse(url.includes('openrouter')?['paid-model','free-model:free']:['chat-model']));
 await pool.listModels(); const choice=pool.choose('','');
 assert.equal(choice.attempts.length,3);assert.equal(choice.attempts.some(p=>p.model==='paid-model'),false);
 choice.onProviderFailure(choice.attempts[0],429,90000);
 assert.equal(pool.choose('','').attempts.some(p=>p.slot===choice.slot),false);
 assert.equal(pool.choose('paid-model','').provider,'openrouter');
});

test('explicit model prefers its direct provider over a paid router duplicate',async()=>{
 const pool=createProviderPool({GROQ_API_KEY:'groq',OPENROUTER_API_KEY:'router'},async()=>modelsResponse(['qwen/test']));
 await pool.listModels();for(let i=0;i<5;i++)assert.deepEqual(pool.choose('qwen/test','').attempts.map(p=>p.provider),['groq']);
});

test('each custom endpoint keeps its own configured model ahead of shared defaults',async()=>{
 const env={COMMUNITY_LLM_MODEL:'shared-default',CUSTOM_MODEL:'shared-default',COMMUNITY_LLM_PROVIDERS:JSON.stringify([
  {name:'custom',baseUrl:'https://first.example/v1',apiKey:'first-private-key',model:'first-chat'},
  {name:'custom',baseUrl:'https://second.example/v1',apiKey:'second-private-key',model:'second-chat'},
 ])};
 const pool=createProviderPool(env,async()=>modelsResponse(['shared-default','first-chat','second-chat']));
 await pool.listModels();
 assert.deepEqual(pool.providers.map(p=>p.model),['first-chat','second-chat']);
 assert.deepEqual(pool.choose('','').attempts.slice(0,2).map(p=>[p.baseUrl,p.model]),[
  ['https://first.example/v1','first-chat'],['https://second.example/v1','second-chat'],
 ]);
});

test('missing discovery endpoints expose configured models without claiming a verified catalog',async()=>{
 for (const status of [404,405,501]) {
  const pool=createProviderPool({COMMUNITY_LLM_PROVIDERS:JSON.stringify([
   {name:'first',baseUrl:'https://first.example/v1',apiKey:'first-private-key',model:'first-chat'},
   {name:'second',baseUrl:'https://second.example/v1',apiKey:'second-private-key',model:'second-chat'},
  ])},async()=>modelsResponse([],status));
  const listed=await pool.listModels();
  assert.equal(listed.failures.length,2);assert.equal(listed.models.length,2);
  assert.ok(listed.models.every(model=>model.configured===true));
  assert.deepEqual(pool.choose('first-chat','').attempts.map(p=>p.apiKey),['first-private-key']);
  assert.deepEqual(pool.choose('second-chat','').attempts.map(p=>p.apiKey),['second-private-key']);
  assert.ok(publicModels(listed).every(model=>model.configured===true));
  assert.match(formatModelList(listed),/수동 설정/);
  assert.ok(!JSON.stringify(publicModels(listed)).includes('private-key'));
 }
});

test('an explicitly empty successful catalog permits only the administrator configured model',async()=>{
 const pool=createProviderPool({COMMUNITY_LLM_PROVIDERS:JSON.stringify([
  {name:'custom',baseUrl:'https://custom.example/v1',apiKey:'private-key',model:'known-deployment'},
 ])},async()=>modelsResponse([]));
 const listed=await pool.listModels();
 assert.equal(listed.models[0].configured,true);assert.equal(listed.failures.length,1);
 assert.equal(pool.choose('','').model,'known-deployment');assert.equal(pool.choose('other',''),null);
});

test('auth, quota, server, network and invalid payload failures never use configured discovery fallback',async()=>{
 const env={COMMUNITY_LLM_PROVIDERS:JSON.stringify([{name:'custom',baseUrl:'https://custom.example/v1',apiKey:'private-key',model:'known-deployment'}])};
 const fetches=[...([401,403,429,500,503].map(status=>async()=>modelsResponse([],status))),
  async()=>{throw Error('network unavailable');},async()=>({ok:true,status:200,json:async()=>({unexpected:true})})];
 for (const fetchImpl of fetches) {
  const pool=createProviderPool(env,fetchImpl);const listed=await pool.listModels();
  assert.equal(listed.models.length,0);assert.equal(pool.choose('known-deployment',''),null);
 }
});

test('configured fallback respects authentication/quota cooldown across catalog refresh',async()=>{
 for (const status of [401,403,429]) {
  const pool=createProviderPool({COMMUNITY_LLM_PROVIDERS:JSON.stringify([{name:'custom',baseUrl:'https://custom.example/v1',apiKey:'private-key',model:'known-deployment'}])},async()=>modelsResponse([],404));
  await pool.listModels();const choice=pool.choose('','');
  choice.onProviderFailure(choice,status,60000);
  await pool.listModels();assert.equal(pool.choose('',''),null);assert.equal(pool.choose('known-deployment',''),null);
 }
});

test('OpenRouter configured paid models remain excluded from automatic fallback',async()=>{
 const pool=createProviderPool({OPENROUTER_API_KEY:'router-key',OPENROUTER_MODEL:'paid-model'},async()=>modelsResponse([],404));
 const listed=await pool.listModels();assert.equal(listed.models[0].configured,true);
 assert.equal(pool.choose('',''),null);assert.equal(pool.choose('paid-model','').model,'paid-model');
});

test('a discovered duplicate makes the public model verified while manual-only entries stay marked',()=>{
 const models=publicModels({models:[
  {id:'same',name:'same',provider:'manual',configured:true},
  {id:'same',name:'same',provider:'discovered'},
  {id:'manual-only',name:'manual-only',provider:'manual',configured:true},
 ]});
 assert.equal(models[0].configured,undefined);assert.equal(models[1].configured,true);
});

test('provider-specific models survive deduplication and invalid model identifiers are not used',()=>{
 const providers=readProviders({COMMUNITY_LLM_BASE_URL:'https://custom.example/v1',COMMUNITY_LLM_API_KEY:'private-key',COMMUNITY_LLM_MODEL:'old-model',
  COMMUNITY_LLM_PROVIDERS:JSON.stringify([
   {name:'custom',baseUrl:'https://custom.example/v1',apiKey:'private-key',model:'provider-model'},
   {name:'invalid',baseUrl:'https://other.example/v1',apiKey:'other-key',model:'bad\nmodel'},
  ])});
 assert.equal(providers.length,2);assert.equal(providers[0].model,'provider-model');assert.equal(providers[1].model,undefined);
});

test('automatic attempts try diverse chat models before duplicate keys and stay within eight requests',async()=>{
 const env={NVIDIA_NIM_API_KEY:'nvidia-a',NVIDIA_NIM_API_KEY_2:'nvidia-b',NVIDIA_NIM_API_KEY_3:'nvidia-c',GROQ_API_KEY:'groq',OPENROUTER_API_KEY:'router'};
 const catalogs={nvidia:['000-unclassified','openai/gpt-oss-120b','openai/gpt-oss-20b','meta/llama-3.3-70b-instruct','meta/llama-3.1-8b-instruct','nvidia/nemo-retriever','nvidia/llama-reward','nvidia/maisi-ct','black-forest-labs/flux-dev','whisper-large-v3'],
  groq:['openai/gpt-oss-120b','openai/gpt-oss-20b'],router:['paid-model','meta-llama/llama-3.3-70b-instruct:free','openrouter/free']};
 const pool=createProviderPool(env,async url=>modelsResponse(catalogs[url.includes('nvidia')?'nvidia':url.includes('groq')?'groq':'router']));
 await pool.listModels();const choice=pool.choose('','high'),attempts=choice.attempts;
 assert.equal(choice.automatic,true);assert.equal(attempts.length,8);
 assert.equal(new Set(attempts.slice(0,3).map(candidate=>candidate.provider)).size,3,'each endpoint gets a preferred attempt first');
 const pairs=attempts.map(candidate=>candidate.provider+':'+candidate.model);
 assert.equal(new Set(pairs.slice(0,7)).size,7,'three NVIDIA, two Groq, two free router models precede key duplication');
 assert.equal(new Set(attempts.filter(candidate=>candidate.provider==='nvidia').map(candidate=>candidate.model)).size,3);
 for(const candidate of attempts){
  assert.equal(candidate.effort,'high');assert.equal(choice.isCandidateAvailable(candidate),true);
  assert.ok(!/paid-model|000-unclassified|retriever|reward|maisi|flux|whisper/.test(candidate.model));
  if(candidate.provider==='openrouter')assert.ok(candidate.model.endsWith(':free')||candidate.model==='openrouter/free');
 }
 const next=pool.choose('','');
 assert.notEqual(next.provider,choice.provider,'provider rotation remains available');
});

test('automatic ranking keeps configured and established chat choices ahead of arbitrary catalog ordering',async()=>{
 const models=['000-other-deployment','chat-experimental','meta/llama-3.3-70b-instruct','openai/gpt-oss-20b','openai/gpt-oss-120b','my-deployment'];
 const pool=createProviderPool({NVIDIA_NIM_API_KEY:'key',NVIDIA_MODEL:'my-deployment'},async()=>modelsResponse([...models].reverse()));
 await pool.listModels();assert.deepEqual(pool.choose('','').attempts.map(candidate=>candidate.model),['my-deployment','openai/gpt-oss-120b','openai/gpt-oss-20b']);
 const plain=createProviderPool({NVIDIA_NIM_API_KEY:'key'},async()=>modelsResponse(models));
 await plain.listModels();assert.deepEqual(plain.choose('','').attempts.map(candidate=>candidate.model),['openai/gpt-oss-120b','openai/gpt-oss-20b','meta/llama-3.3-70b-instruct']);
});

test('explicit model retries only the same discovered ID on eligible keys, never automatic alternatives',async()=>{
 const pool=createProviderPool({GROQ_API_KEY:'first',GROQ_API_KEY_2:'second',GROQ_API_KEY_3:'third'},async(url,options)=>modelsResponse(options.headers.authorization.endsWith('third')?['other-chat']:['chosen-chat','other-chat']));
 await pool.listModels();
 const first=pool.choose('chosen-chat',''),second=pool.choose('chosen-chat','');
 assert.equal(first.automatic,false);assert.equal(first.attempts.length,2);
 assert.ok(first.attempts.every(candidate=>candidate.model==='chosen-chat' && candidate.apiKey!=='third'));
 assert.notEqual(first.apiKey,second.apiKey,'same-model keys rotate');
 for(const id of ['missing-model','bad model',123])assert.equal(pool.choose(id,''),null);
 first.onProviderFailure(first.attempts[0],404);
 assert.equal(first.isCandidateAvailable(first.attempts[0]),false);assert.equal(first.isCandidateAvailable(first.attempts[1]),true);
 assert.deepEqual(pool.choose('chosen-chat','').attempts.map(candidate=>candidate.apiKey),[first.attempts[1].apiKey]);
});

test('candidate model eligibility remains specific to each key catalog',async()=>{
 const allowed=new Map([['Bearer first',['openai/gpt-oss-120b','first-chat']],['Bearer second',['openai/gpt-oss-20b','second-chat']]]);
 const pool=createProviderPool({GROQ_API_KEY:'first',GROQ_API_KEY_2:'second',GROQ_MODEL:'not-discovered'},async(url,options)=>modelsResponse(allowed.get(options.headers.authorization)));
 await pool.listModels();
 for(let turn=0;turn<3;turn++)for(const candidate of pool.choose('','').attempts){
  assert.ok(allowed.get('Bearer '+candidate.apiKey).includes(candidate.model));assert.notEqual(candidate.model,'not-discovered');
 }
});

test('model failures cool only that key/model pair, survive catalog refresh and expire',async t=>{
 let now=1000000;t.mock.method(Date,'now',()=>now);
 for(const [status,details] of [[400,undefined],[404,undefined],[502,{scope:'model'}]]){
  const pool=createProviderPool({GROQ_API_KEY:'one'},async()=>modelsResponse(['openai/gpt-oss-120b','openai/gpt-oss-20b']));
  await pool.listModels();const choice=pool.choose('','');
  choice.onProviderFailure(choice,status,60000,details);
  assert.equal(choice.isCandidateAvailable(choice),false);assert.equal(choice.isCandidateAvailable(choice.attempts[1]),true);
  assert.equal(pool.choose(choice.model,''),null);assert.equal(pool.choose('','').model,'openai/gpt-oss-20b');
  await pool.listModels();assert.equal(pool.choose('','').model,'openai/gpt-oss-20b');
  now+=60001;assert.equal(choice.isCandidateAvailable(choice),true);assert.equal(pool.choose('','').model,'openai/gpt-oss-120b');
 }
});

test('authentication and quota failures cool the whole key including already-created fallback candidates',async()=>{
 for(const status of [401,402,403,429]){
  const pool=createProviderPool({GROQ_API_KEY:'one',GROQ_API_KEY_2:'two'},async()=>modelsResponse(['openai/gpt-oss-120b','openai/gpt-oss-20b']));
  await pool.listModels();const choice=pool.choose('','');
  choice.onProviderFailure(choice,status,60000,{scope:'model'});
  assert.ok(choice.attempts.filter(candidate=>candidate.slot===choice.slot).every(candidate=>!choice.isCandidateAvailable(candidate)));
  const next=pool.choose('','');assert.ok(next.attempts.every(candidate=>candidate.slot!==choice.slot));
  next.onProviderFailure(next,status,60000);assert.equal(pool.choose('',''),null);
 }
});

test('discovery excludes specialty endpoints even when their IDs do not say embedding or audio',async()=>{
 const pool=createProviderPool({GEMINI_API_KEY:'key'},async()=>({ok:true,status:200,json:async()=>({models:[
  {name:'models/gemini-chat',supportedGenerationMethods:['generateContent']},
  {name:'models/gemini-vectors',supportedGenerationMethods:['embedContent']},
  {name:'models/custom-text',endpoints:['embed','rerank']},
  {name:'models/meta/llama-guard-3-8b'},
 ]})}));
 assert.deepEqual((await pool.listModels()).models.map(model=>model.id),['gemini-chat']);
 assert.equal(pool.choose('','').model,'gemini-chat');
});

test('live catalog metadata reaches the picker without adding models or changing automatic routes',async()=>{
 const pool=createProviderPool({GROQ_API_KEY:'groq-private',OPENROUTER_API_KEY:'router-private'},async url=>({
  ok:true,status:200,json:async()=>({data:url.includes('groq')?[
   {id:'openai/gpt-oss-120b',created:1754000000,owned_by:'OpenAI'},
   {id:'openai/gpt-oss-20b',created:1754000000,owned_by:'OpenAI'},
  ]:[
   {id:'openai/gpt-oss-120b',name:'OpenAI: GPT-OSS 120B',created:1756000000},
   {id:'google/gemma-3-27b-it:free',name:'Google: Gemma 3',created:1742000000},
   {id:'anthropic/claude-sonnet-4-5',name:'Anthropic: Claude Sonnet 4.5',created:1759000000},
  ]}),
 }));
 const listed=await pool.listModels(), published=publicModels(listed);
 assert.deepEqual(published.map(model=>model.id),[
  'anthropic/claude-sonnet-4-5','openai/gpt-oss-120b','openai/gpt-oss-20b','google/gemma-3-27b-it:free',
 ]);
 const oss=published.find(model=>model.id==='openai/gpt-oss-120b');
 assert.equal(oss.makerId,'openai');assert.equal(oss.catalogCreatedAt,1754000000);
 assert.equal(oss.name,'OpenAI: GPT-OSS 120B');assert.deepEqual(oss.providers,['groq','openrouter']);
 assert.ok(!JSON.stringify(published).includes('private'));
 assert.deepEqual(publicModels({models:[...listed.models].reverse()}),published,'parallel completion order cannot shuffle the public catalog');
 for(let i=0;i<3;i++) {
  const choice=pool.choose('','');
  assert.ok(choice.attempts.every(model=>model.provider!=='openrouter'||model.model.endsWith(':free')||model.model==='openrouter/free'));
  assert.equal(choice.attempts.find(model=>model.provider==='groq').model,'openai/gpt-oss-120b');
 }
 assert.equal(pool.choose('anthropic/claude-sonnet-4-5','').provider,'openrouter','paid model stays explicitly selectable');
 assert.equal(pool.choose('not-returned-by-any-api',''),null);
});

test('Gemini display names and missing timestamps survive discovery honestly',async()=>{
 const pool=createProviderPool({GEMINI_API_KEY:'private-key'},async()=>({
  ok:true,status:200,json:async()=>({models:[
   {name:'models/gemini-2.0-flash',displayName:'Gemini 2.0 Flash',supportedGenerationMethods:['generateContent']},
   {name:'models/gemini-2.5-flash',displayName:'Gemini 2.5 Flash',supportedGenerationMethods:['generateContent']},
  ]}),
 }));
 const published=publicModels(await pool.listModels());
 assert.deepEqual(published.map(model=>model.id),['gemini-2.5-flash','gemini-2.0-flash']);
 assert.equal(published[0].name,'Gemini 2.5 Flash');assert.equal(published[0].makerId,'google');
 assert.ok(published.every(model=>model.catalogCreatedAt===undefined && model.snapshotDate===undefined));
});
