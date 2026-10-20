// Catalog timestamps describe the provider's model entry, not a guaranteed
// launch date. Only returned IDs/metadata participate; no model is invented.
const aliases = new Map([
  ['openai','openai'], ['google','google'], ['gemini','google'], ['google-deepmind','google'],
  ['anthropic','anthropic'], ['meta','meta'], ['meta-llama','meta'], ['qwen','qwen'],
  ['qwen-team','qwen'], ['deepseek','deepseek'], ['deepseek-ai','deepseek'],
  ['mistral','mistral'], ['mistralai','mistral'], ['nvidia','nvidia'], ['cohere','cohere'],
  ['cohereforai','cohere'], ['xai','xai'], ['x-ai','xai'], ['microsoft','microsoft'],
  ['zai','zai'], ['z-ai','zai'], ['zhipu','zai'], ['thudm','zai'],
  ['moonshot','moonshot'], ['moonshotai','moonshot'], ['minimax','minimax'],
  ['amazon','amazon'], ['allenai','allenai'], ['ai21','ai21'], ['ai21labs','ai21'],
  ['ibm','ibm'], ['ibm-granite','ibm'], ['arcee','arcee'], ['arcee-ai','arcee'],
  ['bytedance','bytedance'], ['bytedance-seed','bytedance'],
  ['perplexity','perplexity'], ['openrouter','openrouter'], ['groq','groq'],
  ['nousresearch','nousresearch'], ['nous-research','nousresearch'],
]);
const canonicalMaker = value => typeof value === 'string' ? aliases.get(value.toLowerCase()) : undefined;
const idOf = model => String(model?.id || model?.value || '').replace(/^models\//,'');
const plainCompare = (a,b) => a < b ? -1 : a > b ? 1 : 0;

/** The model author is separate from the API company hosting/routing it. */
export function modelMakerId(model) {
  const explicit = canonicalMaker(model?.makerId);
  if (explicit) return explicit;
  const id=idOf(model).toLowerCase(), namespace=id.includes('/')?id.split('/')[0]:'';
  const namespaced=canonicalMaker(namespace);
  if (namespaced) return namespaced;
  const owner=canonicalMaker(model?.owned_by);
  if (owner) return owner;
  const base=id.split('/').at(-1);
  for (const [pattern,maker] of [
    [/^(?:gpt-|chatgpt-|o[134](?:-|$))/,'openai'], [/^(?:gemini-|gemma-)/,'google'],
    [/^claude-/,'anthropic'], [/^llama-?/,'meta'], [/^qwen/,'qwen'],
    [/^deepseek/,'deepseek'], [/^(?:mistral|mixtral|ministral|codestral|devstral|magistral)/,'mistral'],
    [/^(?:nemotron|nemo-)/,'nvidia'], [/^command-/,'cohere'], [/^grok-/,'xai'],
    [/^phi-/,'microsoft'], [/^glm-/,'zai'], [/^kimi-/,'moonshot'],
    [/^minimax-/,'minimax'], [/^nova-/,'amazon'], [/^granite-/,'ibm'],
    [/^hermes-/,'nousresearch'],
  ]) if(pattern.test(base)) return maker;
  // First-party APIs can identify their own unrecognized deployment names.
  // Routing services cannot stand in for an unknown model author.
  const provider=canonicalMaker(model?.provider);
  return ['openai','google','anthropic','cohere','xai'].includes(provider) ? provider : 'other';
}

function timestamp(value, now=Date.now()) {
  return typeof value==='number' && Number.isSafeInteger(value) &&
    value>=946684800 && value<=Math.floor(now/1000)+86400 ? value : undefined;
}
function snapshotDate(id) {
  const match=/(?:^|[-_/])((?:19|20)\d{2})-?(\d{2})-?(\d{2})(?=$|[-_/:])/.exec(id);
  if(!match) return undefined;
  const date=`${match[1]}-${match[2]}-${match[3]}`, time=Date.parse(date+'T00:00:00Z');
  return Number.isFinite(time) && new Date(time).toISOString().slice(0,10)===date ? date : undefined;
}

export function catalogModelMetadata(row, id, provider, now=Date.now()) {
  const catalogCreatedAt=timestamp(row?.created,now), snapshot=snapshotDate(id);
  return {
    makerId:modelMakerId({id,provider,owned_by:row?.owned_by}),
    ...(catalogCreatedAt ? {catalogCreatedAt} : {}),
    ...(snapshot ? {snapshotDate:snapshot} : {}),
  };
}

function sortDate(model) {
  const snapshot=snapshotDate(idOf(model));
  return snapshot ? Date.parse(snapshot+'T00:00:00Z')/1000 : timestamp(model?.catalogCreatedAt) || 0;
}
function familyVersion(model) {
  const id=idOf(model).toLowerCase().replace(/:free$/,'').split('/').at(-1);
  const match=/^(gpt|chatgpt|gemini|gemma|llama|qwen|deepseek|grok|phi|glm)[-]?v?(\d+(?:\.\d+)*)/.exec(id) ||
    /^(claude)(?:-(?:opus|sonnet|haiku))?-(\d+(?:[.-]\d+)*)/.exec(id);
  return match ? {family:match[1],version:match[2].split(/[.-]/).map(Number)}
    : {family:id.replace(/(?:[-_/]20\d{2}[-]?\d{2}[-]?\d{2}).*$/,'').replace(/(?:[-_.]\d).*$/,''),version:[]};
}

/** Known snapshot/catalog dates first. Missing dates use family/version order,
 * never an invented release date or a cross-family claim about model quality. */
export function compareModelsNewest(a,b) {
  const verified=Number(Boolean(a?.configured))-Number(Boolean(b?.configured));
  if(verified) return verified;
  const dated=sortDate(b)-sortDate(a);
  if(dated) return dated;
  const maker=plainCompare(modelMakerId(a),modelMakerId(b));
  if(maker) return maker;
  const av=familyVersion(a), bv=familyVersion(b), family=plainCompare(av.family,bv.family);
  if(family) return family;
  for(let index=0;index<Math.max(av.version.length,bv.version.length);index++) {
    const delta=(bv.version[index]||0)-(av.version[index]||0);
    if(delta) return delta;
  }
  return plainCompare(idOf(a).toLowerCase(),idOf(b).toLowerCase()) || plainCompare(idOf(a),idOf(b));
}

export function sortModelsNewest(models) { return [...models].sort(compareModelsNewest); }
