import {modelMakerId, sortModelsNewest} from './model-catalog.mjs';
import {MODEL_ICON_SVGS} from './model-icons.mjs';

const MAKERS = Object.freeze({
  openai:'OpenAI', google:'Google', anthropic:'Anthropic', meta:'Meta', qwen:'Qwen',
  deepseek:'DeepSeek', mistral:'Mistral', nvidia:'NVIDIA', cohere:'Cohere', xai:'xAI',
  microsoft:'Microsoft', zai:'Z.ai', moonshot:'Moonshot AI', minimax:'MiniMax',
  amazon:'Amazon', allenai:'Allen AI', ai21:'AI21', ibm:'IBM', arcee:'Arcee AI',
  bytedance:'ByteDance', perplexity:'Perplexity', openrouter:'OpenRouter', groq:'Groq',
  nousresearch:'Nous Research',
});
const ROUTES = Object.freeze({
  openai:'OpenAI', gemini:'Google AI', google:'Google AI', anthropic:'Anthropic',
  groq:'Groq', openrouter:'OpenRouter', huggingface:'Hugging Face', cohere:'Cohere',
  mistral:'Mistral', xai:'xAI', deepseek:'DeepSeek', together:'Together AI',
});
const GENERIC_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="1.6"><rect x="5" y="5" width="14" height="14" rx="4"/><rect x="9" y="9" width="6" height="6" rx="1.5"/><path d="M9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3"/></svg>';
const AUTO_SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="1.6" stroke-linejoin="round"><path d="m12 3 2.6 6.4L21 12l-6.4 2.6L12 21l-2.6-6.4L3 12l6.4-2.6L12 3Z"/><path d="m20 2 .6 1.4L22 4l-1.4.6L20 6l-.6-1.4L18 4l1.4-.6L20 2Z" fill="#64748b" stroke="none"/></svg>';

/** The symbol belongs to the model maker/family, never its routing API. */
export function modelBrand(model) {
  const id=String(model?.id || model?.value || '').toLowerCase();
  if(!id) return {id:'auto',label:'자동 선택',icon:'auto'};
  const maker=modelMakerId(model);
  const icon={
    google:/(?:^|\/)gemma-/.test(id)?'gemma':'gemini', anthropic:'claude', xai:'grok',
    moonshot:'kimi', allenai:'ai2',
  }[maker] || maker;
  return {id:maker,label:MAKERS[maker] || '기타 모델',icon};
}

export function createModelIcon(model, {document:doc=globalThis.document}={}) {
  const brand=modelBrand(model), element=doc.createElement('span'), image=doc.createElement('img');
  element.className='model-family-icon';element.dataset.maker=brand.id;
  element.setAttribute('aria-hidden','true');element.title=brand.label;
  // Only bundled, reviewed assets can become image sources. Catalog metadata
  // never supplies SVG, markup or a URL, so opening a picker makes no CDN calls.
  const svg=brand.icon==='auto'?AUTO_SVG:MODEL_ICON_SVGS[brand.icon] || GENERIC_SVG;
  image.src='data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg);
  image.alt='';image.width=24;image.height=24;image.draggable=false;
  element.append(image);
  return element;
}

export function modelDetail(model) {
  if(!model?.id && !model?.value) return '연결된 모델 중에서 자동으로 선택';
  const brand=modelBrand(model);
  const providers=[...new Set((model.providers || (model.provider?[model.provider]:[])).filter(value=>typeof value==='string' && value))];
  const routes=providers.map(value=>ROUTES[value.toLowerCase()] || value);
  return [brand.id==='other'?'':brand.label,routes.length?'연결: '+routes.join(' · '):''].filter(Boolean).join(' · ') || '사용자 지정 모델';
}

// Recommend only live entries, in the same newest-first order as the library.
// Prefer distinct makers so one vendor's many snapshots cannot fill the menu.
export function recommendedModels(models, limit=5) {
  const available=sortModelsNewest(models).filter(model=>
    !/preview|experimental|image|audio|embed|rerank/i.test(model.id || model.value || '') &&
    !(model.providers?.length===1 && model.providers[0]==='openrouter' && !(model.id || model.value || '').endsWith(':free') && model.id!=='openrouter/free'));
  const picked=[], makers=new Set();
  for(const model of available) {
    if(picked.length>=limit) break;
    const maker=modelMakerId(model);
    if(makers.has(maker)) continue;
    makers.add(maker);picked.push(model);
  }
  for(const model of available) {
    if(picked.length>=limit) break;
    if(!picked.includes(model)) picked.push(model);
  }
  return sortModelsNewest(picked).slice(0,limit);
}
export function modelLabel(model) {
  const id=model.id || model.value || '';
  const known={'openai/gpt-oss-120b':'GPT-OSS 120B','openai/gpt-oss-20b':'GPT-OSS 20B','qwen/qwen3.8-27b':'Qwen 3.8 · 27B','command-a-03-2025':'Command A','command-a-plus-05-2026':'Command A+','openrouter/free':'OpenRouter Free'};
  return known[id] || id.replace(/^gemini-([\d.]+)-flash$/, 'Gemini $1 Flash').replace(/^[^/]+\//,'');
}
export function filterModels(models, query) {
  const terms=String(query || '').trim().toLowerCase().split(/\s+/).filter(Boolean);
  return sortModelsNewest(models).filter(model=>terms.every(term=>
    [model.id,model.name,modelLabel(model),modelBrand(model).label,...(model.providers||[])].join(' ').toLowerCase().includes(term)));
}
