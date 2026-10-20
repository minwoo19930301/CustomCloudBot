import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogModelMetadata,modelMakerId,compareModelsNewest,sortModelsNewest} from '../public/model-catalog.mjs';

const at=Date.parse('2026-01-01T00:00:00Z');
const row=(id,extra={})=>({id,value:id,...extra});

test('model authors stay separate from hosting APIs and aliases are normalized',()=>{
  for(const [id,provider,maker] of [
    ['openai/gpt-oss-120b','groq','openai'],
    ['meta-llama/llama-3.3-70b-instruct:free','openrouter','meta'],
    ['google/gemma-3-27b-it','nvidia','google'],
    ['Qwen/Qwen3-235B-A22B','huggingface','qwen'],
    ['nvidia/llama-3.1-nemotron-70b-instruct','nvidia','nvidia'],
    ['claude-sonnet-4-5','custom','anthropic'],
    ['gemini-2.5-flash','gemini','google'],
    ['grok-4','xai','xai'],
    ['moonshotai/kimi-k2','openrouter','moonshot'],
    ['NousResearch/Hermes-3-Llama-3.1-405B','huggingface','nousresearch'],
    ['hermes-3-llama-3.1-405b','custom','nousresearch'],
    ['unknown/deployment','openrouter','other'],
    ['unknown-deployment','nvidia','other'],
  ]) assert.equal(modelMakerId({id,provider}),maker,id);
  assert.equal(modelMakerId({id:'private-deployment',owned_by:'Anthropic',provider:'custom'}),'anthropic');
  assert.equal(modelMakerId({id:'gpt-4.1',makerId:'<script>'}),'openai');
});

test('catalog timestamps and full snapshot dates are retained without inferring unknown launch dates',()=>{
  assert.deepEqual(catalogModelMetadata({created:1744000000},'gpt-4.1-2025-04-14','openai',at),
    {makerId:'openai',catalogCreatedAt:1744000000,snapshotDate:'2025-04-14'});
  assert.equal(catalogModelMetadata({},'claude-sonnet-4-20250514','custom',at).snapshotDate,'2025-05-14');
  for(const created of [0,1,-1,Infinity,NaN,'1744000000',1744000000000,at/1000+86401]) {
    assert.equal(catalogModelMetadata({created},'gpt-4.1','openai',at).catalogCreatedAt,undefined);
  }
  for(const id of ['gemini-2.5-flash','gemini-2.5-flash-preview-05-20','qwen3-235b-a22b-2507','model-2025-02-30']) {
    const metadata=catalogModelMetadata({},id,'custom',at);
    assert.equal(metadata.snapshotDate,undefined,id);
    assert.equal(metadata.catalogCreatedAt,undefined,id);
    assert.equal(metadata.releaseDate,undefined,'catalog creation is not advertised as launch date');
  }
});

test('dated entries sort newest first without mutating the returned catalog',()=>{
  const models=[
    row('gpt-4o-2024-08-06',{catalogCreatedAt:1760000000}),
    row('claude-sonnet-4-20250514',{catalogCreatedAt:1740000000}),
    row('new-catalog-entry',{catalogCreatedAt:1750000000}),
    row('gemini-2.5-flash'),
    row('manually-configured',{configured:true,catalogCreatedAt:1760000000}),
  ];
  const original=structuredClone(models), sorted=sortModelsNewest(models);
  assert.deepEqual(models,original);
  assert.deepEqual(sorted.map(model=>model.id),[
    'new-catalog-entry','claude-sonnet-4-20250514','gpt-4o-2024-08-06','gemini-2.5-flash','manually-configured',
  ]);
  assert.notEqual(sorted,models);
});

test('undated model versions use numeric comparison within a family and deterministic tie breaking',()=>{
  const models=['gemini-2.5-flash','gemini-2.0-flash','gemini-1.5-flash',
    'claude-sonnet-4-5','claude-sonnet-4','claude-3-7-sonnet','gpt-4.1','gpt-4o'].map(id=>row(id));
  const sorted=sortModelsNewest(models).map(model=>model.id);
  assert.ok(sorted.indexOf('gemini-2.5-flash')<sorted.indexOf('gemini-2.0-flash'));
  assert.ok(sorted.indexOf('gemini-2.0-flash')<sorted.indexOf('gemini-1.5-flash'));
  assert.ok(sorted.indexOf('claude-sonnet-4-5')<sorted.indexOf('claude-sonnet-4'));
  assert.ok(sorted.indexOf('claude-sonnet-4')<sorted.indexOf('claude-3-7-sonnet'));
  assert.deepEqual(sortModelsNewest([...models].reverse()).map(model=>model.id),sorted);
});

test('latest comparator remains transitive across known dates, missing dates, families and manual models',()=>{
  const models=[
    row('gpt-4.1'),row('gpt-4o'),row('gemini-2.5-flash'),
    row('model-2025-01-01'),row('other',{catalogCreatedAt:1744000000}),
    row('manual',{configured:true,catalogCreatedAt:1750000000}),row('unknown'),
  ];
  for(const a of models)for(const b of models) {
    assert.equal(Math.sign(compareModelsNewest(a,b)),-Math.sign(compareModelsNewest(b,a)) || 0);
    for(const c of models)if(compareModelsNewest(a,b)<=0 && compareModelsNewest(b,c)<=0) {
      assert.ok(compareModelsNewest(a,c)<=0);
    }
  }
});
