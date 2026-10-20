import test from 'node:test';import assert from 'node:assert/strict';
import {recommendedModels,filterModels,modelLabel,modelBrand,modelDetail,createModelIcon} from '../public/model-picker.mjs';
import {sortModelsNewest,modelMakerId} from '../public/model-catalog.mjs';
import {MODEL_ICON_SVGS} from '../public/model-icons.mjs';
const model=(id,providers=['groq'],metadata={})=>({id,value:id,name:id,providers,...metadata});
const created=date=>Date.parse(date+'T00:00:00Z')/1000;
test('recommendations stay within live catalog, bounded and prefer useful distinct families',()=>{
 const catalog=[model('unused-preview'),model('gemini-3.8-flash',['gemini'],{catalogCreatedAt:created('2026-09-01')}),model('openai/gpt-oss-120b',['groq'],{catalogCreatedAt:created('2026-10-01')}),model('openai/gpt-oss-20b'),model('command-a-03-2025',['cohere']),...Array.from({length:100},(_,i)=>model('other-'+i))];
 const picks=recommendedModels(catalog);assert.equal(picks.length,5);assert.equal(new Set(picks).size,5);assert.equal(picks[0].id,'openai/gpt-oss-120b');assert.ok(picks.every(p=>catalog.includes(p)));assert.ok(!picks.some(p=>p.id==='unused-preview'));
 assert.ok(new Set(picks.map(modelMakerId)).size>=4);
 assert.deepEqual(picks,sortModelsNewest(picks));
 assert.deepEqual(recommendedModels([]),[]);
});
test('full model search matches all query terms across ID and providers without altering catalog',()=>{
 const catalog=[model('openai/gpt-oss-120b',['groq','huggingface']),model('gemini-3.8-flash',['gemini'])];
 assert.deepEqual(filterModels(catalog,' GROQ 120B '),[catalog[0]]);assert.deepEqual(filterModels(catalog,'missing'),[]);assert.equal(filterModels(catalog,'').length,2);assert.equal(modelLabel(catalog[1]),'Gemini 3.8 Flash');
});

test('recommendations replace older hardcoded picks with the newest live family entry without selecting paid router-only models',()=>{
 const older=model('command-a-03-2025',['cohere'],{catalogCreatedAt:created('2025-03-01')});
 const newer=model('command-a-plus-05-2026',['cohere'],{catalogCreatedAt:created('2026-05-01')});
 const paid=model('openai/gpt-5',['openrouter'],{catalogCreatedAt:created('2026-10-01')});
 const free=model('meta-llama/llama-3.3-70b-instruct:free',['openrouter'],{catalogCreatedAt:created('2026-09-01')});
 const catalog=[older,newer,paid,free,model('openrouter/free',['openrouter']),model('gemini-3.8-flash',['gemini']),model('qwen/qwen3.8-27b')];
 const picks=recommendedModels(catalog);
 assert.ok(picks.includes(newer));assert.ok(!picks.includes(older));assert.ok(!picks.includes(paid));
 assert.ok(picks.includes(free));assert.ok(picks.includes(catalog[4]));
 assert.deepEqual(catalog[0],older);
});

test('the full library and filtered results preserve newest order and search maker names',()=>{
 const old=model('google/gemini-2.5-flash',['openrouter'],{catalogCreatedAt:created('2025-06-01')});
 const recent=model('google/gemini-3.8-flash',['openrouter'],{catalogCreatedAt:created('2026-09-01')});
 const catalog=[old,model('openai/gpt-oss-120b'),recent],original=[...catalog];
 assert.deepEqual(filterModels(catalog,'Google OpenRouter'),[recent,old]);
 assert.deepEqual(filterModels(catalog,''),sortModelsNewest(catalog));
 assert.deepEqual(catalog,original);
});

test('model family icons describe the maker even when a different provider serves the model',()=>{
 const routed=model('openai/gpt-oss-120b',['groq','openrouter']);
 assert.deepEqual(modelBrand(routed),{id:'openai',label:'OpenAI',icon:'openai'});
 assert.equal(modelDetail(routed),'OpenAI · 연결: Groq · OpenRouter');
 assert.equal(modelBrand(model('google/gemma-3-27b-it',['openrouter'])).icon,'gemma');
 assert.equal(modelBrand(model('gemini-3.8-flash',['gemini'])).icon,'gemini');
 assert.equal(modelBrand(model('anthropic/claude-sonnet-4',['openrouter'])).icon,'claude');
 assert.equal(modelBrand(model('mystery-model',['groq'])).id,'other');
 assert.equal(modelDetail(model('mystery-model',['groq'])),'연결: Groq');
 assert.equal(modelDetail(model('openai/gpt-oss-120b',['groq','groq'])),'OpenAI · 연결: Groq');
 assert.equal(modelBrand({id:'',value:''}).id,'auto');
});

class Element {
 constructor(tag) { this.tagName=tag;this.children=[];this.attributes=new Map();this.dataset={}; }
 append(...nodes) { this.children.push(...nodes); }
 setAttribute(name,value) { this.attributes.set(name,String(value)); }
 getAttribute(name) { return this.attributes.get(name); }
}
const document={createElement:tag=>new Element(tag)};
test('icons remain decorative, local and cannot use a catalog-supplied URL or markup',()=>{
 for(const entry of [
   model('openai/gpt-oss-120b',['groq']),model('google/gemini-3.8-flash',['openrouter']),
   {id:'unknown',makerId:'https://tracker.invalid/logo',icon:'https://tracker.invalid/logo',name:'<img src=x onerror=alert(1)>'},
   {value:''},
 ]) {
   const icon=createModelIcon(entry,{document}),image=icon.children[0];
   assert.equal(icon.getAttribute('aria-hidden'),'true');assert.ok(icon.title);
   assert.equal(icon.tagName,'span');assert.equal(image.tagName,'img');assert.equal(image.alt,'');
   assert.equal(image.draggable,false);assert.equal(icon.onclick,undefined);
   assert.match(image.src,/^data:image\/svg\+xml;charset=utf-8,/);
   const svg=decodeURIComponent(image.src.split(',').slice(1).join(','));
   assert.doesNotMatch(svg,/tracker\.invalid|onerror|<script|<foreignObject|<iframe/);
 }
});

test('every bundled brand asset is a self-contained SVG with no executable or remote references',()=>{
 assert.ok(Object.keys(MODEL_ICON_SVGS).length>=15);
 for(const svg of Object.values(MODEL_ICON_SVGS)) {
   assert.match(svg,/^<svg\b/);assert.match(svg,/\bviewBox=/);
   assert.doesNotMatch(svg,/<(?:script|foreignObject|iframe|image|use|a)\b|\b(?:href|src|on\w+)\s*=/i);
   assert.doesNotMatch(svg,/url\(\s*['"]?(?!#)[^)]+\)/i);
 }
});

import {safeLink} from '../public/message-format.mjs';
test('message links never enable scripts, data URLs or embedded credentials',()=>{
 for(const url of ['javascript:alert(1)','data:text/html,test','https://user:password@example.com','//example.com'])assert.equal(safeLink(url),null);
 assert.equal(safeLink('https://example.com/docs'),'https://example.com/docs');
});
