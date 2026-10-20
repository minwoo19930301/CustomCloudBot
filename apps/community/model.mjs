import { BROWSER_TOOL_DEFINITIONS } from './browser-tools.mjs';
import { normalizeBotOutput } from './model-output.mjs';
import { usageEvent } from './usage.mjs';

const MAX_ATTEMPTS_PER_STEP = 8;
const MAX_CALLS = 32;
const TEXT_OUTPUT_TOKENS = 4096;
const WORK_OUTPUT_TOKENS = 8192;
const TEXT_TIMEOUT_MS = 30000;
const WORK_TIMEOUT_MS = 60000;
const LARGE_ARGUMENT_TOOLS = new Set(['host_exec','create_drawing']);
const RETRYABLE_STATUS = new Set([400,401,402,403,404,408,413,429,500,502,503,504]);
const GROQ_DEFAULT_TPM = 8000;
const GROQ_OUTPUT_CAP = 4096;
const GROQ_MIN_OUTPUT = 512;
const GROQ_TOKEN_MARGIN = 256;
const safeName = value => typeof value === 'string' && /^[\w.:/@+ -]{1,200}$/.test(value) ? value : 'unknown';
const endpointFor = baseUrl => {
  const endpoint = new URL(String(baseUrl).replace(/\/+$/, '') + '/chat/completions');
  if(endpoint.protocol !== 'https:' && !['localhost','127.0.0.1','[::1]'].includes(endpoint.hostname)) throw new Error('Model endpoint must use HTTPS');
  return endpoint;
};
const responseError = (reason, message) => Object.assign(new Error(message), { responseReason: reason });
const POLICY_REPLY = '이 요청에 대한 응답은 제공자 정책에 따라 제한되었습니다.';
const errorCode = value => typeof value === 'string' && /^[a-zA-Z0-9_.-]{1,80}$/.test(value) ? value.toLowerCase() : '';
const POLICY_CODES = new Set(['content_filter','content_policy_violation','policy_violation','policy_refusal','safety','safety_violation','moderation_blocked','moderation_error']);
const BILLING_CODES = new Set(['insufficient_quota','billing_hard_limit_reached','billing_not_active','organization_usage_limit_exceeded','organization_spend_limit_exceeded','project_spend_limit_exceeded','credit_balance_exhausted','insufficient_credits']);
const MODEL_CODES = new Set(['invalid_model','model_not_found','model_not_available','unsupported_model','model_decommissioned']);
const MODEL_ACCESS_CODES = new Set(['model_unavailable','model_permission_blocked_org','model_permission_blocked_project','model_access_denied']);
const CONTEXT_CODES = new Set(['context_length_exceeded','max_context_length_exceeded','input_too_long','prompt_too_long']);

// Read upstream error bodies only to produce these fixed categories. Never
// retain their messages, flagged input, raw metadata or credentials in hooks.
function classifyProviderError(status, payload) {
  const error=payload?.error;
  const codes=[errorCode(error?.code),errorCode(error?.type)];
  const metadata=error?.metadata;
  const policyMetadata=metadata && typeof metadata==='object' &&
    (typeof metadata.flagged_input==='string' || Array.isArray(metadata.patterns) ||
      Array.isArray(metadata.reasons) && metadata.reasons.length>0);
  const message=typeof error?.message==='string' ? error.message.slice(0,2000) : '';
  if(codes.some(code=>POLICY_CODES.has(code)) || policyMetadata ||
    [400,403].includes(status) && /\b(?:content policy|safety policy|moderation|prompt injection)\b/i.test(message)) {
    return {reason:'policy_refusal',scope:'request',refusal:true};
  }
  const billingMetadata=['openrouter_guardrail_budget','openrouter_workspace_budget','openrouter_key_limit'].includes(metadata?.limit_source);
  if(codes.some(code=>BILLING_CODES.has(code)) || billingMetadata) return {reason:'billing',scope:'key'};
  if(status===401) return {reason:'authentication',scope:'key'};
  if(status>=500) return {reason:'provider_error',scope:'provider'};
  if(status===408) return {reason:'timeout',scope:'model'};
  if(codes.some(code=>MODEL_CODES.has(code))) return {reason:'unsupported_model',scope:'model'};
  if(codes.some(code=>MODEL_ACCESS_CODES.has(code))) return {reason:'model_unavailable',scope:'model'};
  if(codes.some(code=>CONTEXT_CODES.has(code))) return {reason:'context_length',scope:'request'};
  if(status===413) return {reason:'request_too_large',scope:'request'};
  if(status===404) return {reason:'endpoint_not_found',scope:'provider'};
  if(status===402) return {reason:'billing',scope:'key'};
  if(status===403) return {reason:'authentication',scope:'key'};
  if(status===429) return {reason:'rate_limit',scope:'key'};
  return {reason:status===400?'invalid_request':'invalid_response',scope:'model'};
}
const failureMessage = reason => ({
  unsupported_model:'제공자가 이 모델을 지원하지 않습니다.',model_unavailable:'이 계정에서 해당 모델을 사용할 수 없습니다.',
  endpoint_not_found:'모델 제공자의 연결 주소를 찾지 못했습니다.',authentication:'모델 제공자 계정 인증을 확인해 주세요.',
  billing:'모델 제공자의 잔액 또는 사용 예산을 확인해 주세요.',rate_limit:'모델 제공자의 사용 한도에 도달했습니다.',
  provider_error:'모델 제공자 서버에 일시적인 오류가 발생했습니다.',timeout:'모델 응답 대기 시간이 초과되었습니다.',
  request_too_large:'이 요청은 모델이 한 번에 처리할 수 있는 크기 한도를 넘었습니다.',
  context_length:'이 요청은 모델의 컨텍스트 길이 한도를 넘었습니다.',invalid_request:'모델이 요청 형식을 처리하지 못했습니다.',
}[reason] || '모델 응답을 완료하지 못했습니다. 잠시 후 다시 시도해 주세요.');

function groqOutputBudget(messages, tools, desired, limit) {
  // Groq reserves prompt + maximum output against TPM before generating. This
  // byte estimate includes tool schemas and completed tool results, but is not
  // a tokenizer. A measured TPM 413 below can correct it once without dropping
  // instructions or tools. Never reserve the entire free-tier 8K as output.
  const estimatedInput=Math.ceil(Buffer.byteLength(JSON.stringify({messages,...(tools?{tools}:{})}))/3)+128;
  return Math.max(GROQ_MIN_OUTPUT,Math.min(desired,GROQ_OUTPUT_CAP,limit-estimatedInput-GROQ_TOKEN_MARGIN));
}

function groqTpmRejection(payload) {
  const error=payload?.error, message=error?.message;
  if(typeof message!=='string' || (error.type!=='tokens' && error.code!=='rate_limit_exceeded') ||
    !/request too large/i.test(message) || !/(?:tokens per minute|\bTPM\b)/i.test(message)) return null;
  const numbers=/\bLimit\s+([\d,]+)\b[\s\S]{0,100}\bRequested\s+([\d,]+)\b/i.exec(message);
  const limit=Number(numbers?.[1].replaceAll(',','')), requested=Number(numbers?.[2].replaceAll(',',''));
  return Number.isSafeInteger(limit) && Number.isSafeInteger(requested) && limit>0 && requested>limit && requested<=1e9
    ? {limit,requested} : {};
}

// Hooks and body reads must still stop promptly if a caller neglects the signal.
function withSignal(promise, signal) {
  if(!signal) return promise;
  return new Promise((resolve,reject) => {
    const abort = () => { cleanup(); reject(signal.reason); };
    const cleanup = () => signal.removeEventListener('abort', abort);
    signal.addEventListener('abort', abort, {once:true});
    Promise.resolve(promise).then(value => { cleanup(); resolve(value); }, error => { cleanup(); reject(error); });
    if(signal.aborted) abort();
  });
}

async function readPayload(response, signal, maxBytes=131072) {
  if(!response.body) throw responseError('empty_response', 'Empty model response');
  const reader=response.body.getReader(), chunks=[];
  let bytes=0;
  try {
    for(;;) {
      const result=await withSignal(reader.read(), signal);
      if(result.done) break;
      bytes+=result.value.byteLength;
      if(bytes>maxBytes) throw responseError('response_too_large', 'Model response too large');
      chunks.push(Buffer.from(result.value));
    }
  } finally {
    // A broken upstream stream must not hold a model switch or Stop open.
    void reader.cancel().catch(()=>{});
  }
  try { return JSON.parse(Buffer.concat(chunks).toString()); }
  catch { throw responseError('invalid_response', 'Invalid model response'); }
}

function validateMessage(payload, useTools, definitions, actions) {
  const choice=payload?.choices?.[0], message=choice?.message;
  // Provider safety decisions are final responses, never a reason to try a
  // different model. Ordinary natural-language refusals follow the normal path.
  const refusal=typeof message?.refusal==='string' ? message.refusal.trim() : '';
  if(refusal || choice?.finish_reason==='content_filter') {
    return {message,output:normalizeBotOutput(refusal || POLICY_REPLY)};
  }
  // Even valid JSON can describe an incomplete command. Reject the whole
  // response before dispatch so a truncated batch has no side effects.
  if(choice?.finish_reason==='length') throw responseError('incomplete_response', '모델 응답이 출력 길이 제한으로 끝났습니다.');
  if(!message || typeof message!=='object' || Array.isArray(message)) throw responseError('invalid_response', 'Invalid model response');
  if(message.tool_calls != null && !Array.isArray(message.tool_calls)) throw responseError('invalid_response', 'Invalid browser tool call');
  if(message.tool_calls?.length) {
    if(!useTools || message.tool_calls.length>4-actions) throw responseError('invalid_response', 'Browser action budget exceeded');
    const allowed=new Set(definitions.map(tool=>tool.function.name)), ids=new Set();
    const calls=message.tool_calls.map(call=>{
      if(!call || typeof call.id!=='string' || !call.id || call.id.length>200 || ids.has(call.id) ||
        !allowed.has(call.function?.name) || typeof call.function?.arguments!=='string' ||
        (LARGE_ARGUMENT_TOOLS.has(call.function.name)?Buffer.byteLength(call.function.arguments)>32768:call.function.arguments.length>10000)) {
        throw responseError('invalid_response', 'Invalid browser tool call');
      }
      ids.add(call.id);
      let args;
      try { args=JSON.parse(call.function.arguments); }
      catch { throw responseError('invalid_response', 'Invalid browser tool call'); }
      if(!args || typeof args!=='object' || Array.isArray(args)) throw responseError('invalid_response', 'Invalid browser tool call');
      return {id:call.id,type:'function',function:{name:call.function.name,arguments:call.function.arguments},args};
    });
    return {message,calls};
  }
  if(typeof message.content!=='string' || !message.content.trim()) throw responseError('empty_response', 'Empty model response');
  const output=normalizeBotOutput(message.content);
  if(!JSON.parse(output.slice('SendMessage: '.length)).content.trim()) throw responseError('empty_response', 'Empty model response');
  return {message,output};
}

export class ApiLlm {
  constructor(env) {
    this.name=env.COMMUNITY_LLM_MODEL;
    this.endpoint=endpointFor(env.COMMUNITY_LLM_BASE_URL);
    this.key=env.COMMUNITY_LLM_API_KEY;
  }
  async complete(request, signal) {
    const messages=[{role:'system',content:request.system},{role:'user',content:request.images?.length ? [{type:'text',text:request.user},...request.images.map(image=>({type:'image_url',image_url:{url:image}}))] : request.user}];
    const definitions=request.toolDefinitions || BROWSER_TOOL_DEFINITIONS;
    const hasTools=Boolean(request.browser) && definitions.length>0;
    const control=request.modelControl;
    const groqLimits=new Map();
    let actions=0, candidateIndex=0, totalCalls=0, stepCalls=0, callCredit=true, selection;
    let lastReason='start', lastError=new Error('사용 가능한 모델 한도 또는 인증을 확인해 주세요.');
    const syncSelection=()=>{
      const current=control?.getSelection?.() || {};
      const revision=current.revision ?? 0;
      if(selection && revision===selection.revision) return false;
      const changed=Boolean(selection);
      selection={revision,choice:current.choice || request,signal:current.signal};
      candidateIndex=0;
      if(changed) { stepCalls=0; lastReason='switched'; }
      return changed;
    };
    const changedSince=active=>{ syncSelection(); return active.revision!==selection.revision; };
    const transition=(stage,candidate,reason)=>{
      // UI telemetry contains identifiers and fixed reason codes only.
      try { control?.onTransition?.({stage,model:safeName(candidate.model),provider:safeName(candidate.provider || candidate.name || 'community'),attempt:totalCalls,reason}); }
      catch {}
    };
    syncSelection();
    for(let step=0;step<5;step++) {
      const useTools=hasTools && actions<4 && step<4;
      const sizeRetries=new Map();
      stepCalls=0;
      for(;;) {
        signal?.throwIfAborted();
        syncSelection();
        selection.signal?.throwIfAborted();
        if(totalCalls>=MAX_CALLS) throw lastError;
        const choice=selection.choice;
        const candidates=choice.attempts?.length ? choice.attempts : [{
          apiKey:choice.apiKey || request.apiKey || this.key,
          model:choice.model || request.model || this.name,
          provider:choice.provider,
          baseUrl:choice.baseUrl || request.baseUrl || this.endpoint.href.replace(/\/chat\/completions$/, ''),
        }];
        const available=choice.isCandidateAvailable || request.isCandidateAvailable;
        while(candidateIndex<candidates.length && available && !available(candidates[candidateIndex])) candidateIndex++;
        if(stepCalls>=MAX_ATTEMPTS_PER_STEP || candidateIndex>=candidates.length) {
          const revision=selection.revision;
          if(!control?.onExhausted) throw lastError;
          const resume=await withSignal(control.onExhausted({revision,reason:lastReason,attempt:totalCalls},signal),signal);
          signal?.throwIfAborted();
          syncSelection();
          // Requiring a new revision prevents a synchronous resume loop with no new choice.
          if(!resume || revision===selection.revision) throw lastError;
          stepCalls=0;
          continue;
        }
        const candidate=candidates[candidateIndex], active=selection;
        const target=endpointFor(candidate.baseUrl);
        const isGroq=/^groq$/i.test(candidate.provider || candidate.name || '') || target.hostname==='api.groq.com';
        const limitKey=JSON.stringify([target.origin,candidate.slot,candidate.model]);
        if(!callCredit) {
          await request.beforeAdditionalModelCall?.();
          callCredit=true;
        }
        signal?.throwIfAborted();
        if(changedSince(active)) continue;
        active.signal?.throwIfAborted();
        if(available && !available(candidate)) { candidateIndex++; continue; }
        const effort=['low','medium','high','xhigh'].includes(choice.effort) ? choice.effort : '';
        // Reasoning and generated tool arguments share the completion budget.
        // Keep this larger budget for the final reply after tool execution too.
        const workBudget=hasTools || Boolean(effort) || /(?:^|\/)(?:gpt-oss-|deepseek-r1|o[134](?:-|$)|gpt-5(?:[.-]|$))/i.test(candidate.model);
        const desiredTokens=workBudget?WORK_OUTPUT_TOKENS:request.images?.length?2048:TEXT_OUTPUT_TOKENS;
        const sizeRetry=sizeRetries.get(candidateIndex);
        let outputTokens=isGroq?groqOutputBudget(messages,useTools?definitions:null,desiredTokens,groqLimits.get(limitKey) || GROQ_DEFAULT_TPM):desiredTokens;
        if(sizeRetry?.revision===active.revision) outputTokens=Math.min(outputTokens,sizeRetry.tokens);
        const fetchSignal=AbortSignal.any([AbortSignal.timeout(workBudget?WORK_TIMEOUT_MS:TEXT_TIMEOUT_MS),...(signal?[signal]:[]),...(active.signal?[active.signal]:[])]);
        totalCalls++;stepCalls++;callCredit=false;
        transition('attempt',candidate,lastReason);
        request.onProgress?.('model',lastReason==='start'?'답변 작성 중':'다른 모델 연결 중');
        let response,payload,validated,failureReason,failureStatus,failureDelay,failureScope,retryTokens,successfulResponse=false;
        try {
          response=await fetch(target,{
            method:'POST',redirect:'error',signal:fetchSignal,
            headers:{'content-type':'application/json',authorization:'Bearer '+candidate.apiKey},
            body:JSON.stringify({model:candidate.model,messages,max_tokens:outputTokens,
              ...(effort && (!candidate.provider || /openai|groq/.test(candidate.provider)) ? {reasoning_effort:effort}:{}),
              ...(useTools?{tools:definitions,tool_choice:'auto'}:{})}),
          });
          if(isGroq) {
            const limit=Number(response.headers.get('x-ratelimit-limit-tokens'));
            if(Number.isSafeInteger(limit) && limit>0 && limit<=1e9) groqLimits.set(limitKey,limit);
          }
          if(response.ok) {
            request.onProgress?.('receiving','응답 수신 중');
            payload=await readPayload(response,fetchSignal);
            if(payload?.error && typeof payload.error==='object') {
              // Some compatible providers return an error envelope after an
              // HTTP 200. A moderation result is still final in that envelope.
              const embedded=payload.error.code;
              failureStatus=Number.isInteger(embedded) && embedded>=400 && embedded<=599?embedded:502;
              const category=classifyProviderError(failureStatus===embedded?embedded:200,payload);
              payload=undefined;
              if(category.refusal) validated={output:normalizeBotOutput(POLICY_REPLY)};
              else {
                failureReason=category.reason;failureScope={scope:category.scope,reason:category.reason};
                lastError=new Error(failureMessage(category.reason));
              }
            } else {
              validated=validateMessage(payload,useTools,definitions,actions);
              successfulResponse=true;
            }
          } else {
            const status=response.status;
            let category=classifyProviderError(status),size;
            try {
              const errorPayload=await readPayload(response,fetchSignal,8192);
              category=classifyProviderError(status,errorPayload);
              if(isGroq && status===413 && !category.refusal) size=groqTpmRejection(errorPayload);
            } catch { fetchSignal.throwIfAborted(); }
            if(category.refusal) {
              validated={output:normalizeBotOutput(POLICY_REPLY)};
            } else if(size) {
              failureReason='request_too_large';failureStatus=413;failureScope={scope:'request',reason:failureReason};
              lastError=new Error('이 요청은 모델이 한 번에 처리할 수 있는 토큰 한도를 넘었습니다.');
              // Requested includes our output reservation. Reduce only that
              // reservation once; input alone exceeding TPM must fail over.
              if(size.limit) {
                groqLimits.set(limitKey,size.limit);
                const measuredInput=size.requested-outputTokens;
                const smaller=Math.floor(size.limit-measuredInput-GROQ_TOKEN_MARGIN);
                if(sizeRetry?.revision!==active.revision && measuredInput>=0 && smaller>=GROQ_MIN_OUTPUT && smaller<outputTokens) retryTokens=smaller;
              }
            } else {
              if(!RETRYABLE_STATUS.has(status) && category.reason!=='context_length') throw new Error('Model provider rejected request ('+status+')');
              failureReason=category.reason;failureStatus=status;failureScope={scope:category.scope,reason:category.reason};
              const raw=response.headers.get('retry-after');
              failureDelay=raw ? (Number.isFinite(Number(raw)) ? Number(raw)*1000 : Date.parse(raw)-Date.now()) : 0;
              lastError=new Error(failureMessage(category.reason));
            }
          }
        } catch(error) {
          signal?.throwIfAborted();
          if(changedSince(active)) continue;
          active.signal?.throwIfAborted();
          if(error.responseReason) {
            failureReason=error.responseReason;failureStatus=502;failureScope={scope:'model',reason:failureReason};lastError=error;
          } else if(error.name==='TimeoutError' || error instanceof TypeError) {
            failureReason=error.name==='TimeoutError'?'timeout':'network';failureStatus=503;
            failureScope={scope:failureReason==='timeout'?'model':'provider',reason:failureReason};
            lastError=new Error('모든 모델 연결에 실패했습니다. 잠시 후 다시 시도해 주세요.');
          } else throw error;
        } finally {
          if(response) request.onUsage?.(usageEvent({provider:candidate.provider||candidate.name||'community',keySlot:candidate.slot,model:typeof payload?.model==='string'?payload.model:candidate.model,status:response.status,headers:response.headers,usage:payload?.usage}));
        }
        signal?.throwIfAborted();
        if(changedSince(active)) continue;
        active.signal?.throwIfAborted();
        if(failureReason) {
          lastReason=failureReason;
          transition('failure',candidate,failureReason);
          if(retryTokens) {
            sizeRetries.set(candidateIndex,{revision:active.revision,tokens:retryTokens});
            continue;
          }
          (choice.onProviderFailure || request.onProviderFailure)?.(candidate,failureStatus,failureDelay,failureScope);
          candidateIndex++;
          continue;
        }
        if(successfulResponse) {
          // A stale, aborted, malformed or rejected response cannot rehabilitate
          // a model. Availability bookkeeping must not cancel a valid result.
          try { (choice.onProviderSuccess || request.onProviderSuccess)?.(candidate); } catch {}
        }
        if(validated.calls) {
          // Validate the entire batch before any side effects. Selection changes do
          // not cancel tools: each completed result is kept for the next model.
          messages.push({role:'assistant',content:typeof validated.message.content==='string'?validated.message.content.slice(0,4000):null,tool_calls:validated.calls.map(({args,...call})=>call)});
          for(const call of validated.calls) {
            signal?.throwIfAborted();
            actions++;
            let result;
            try { result=await request.browser(call.function.name,call.args,{signal}); }
            catch(error) {
              signal?.throwIfAborted();
              result='Tool action failed: '+(error.status?error.message:'The requested tool action could not be completed.');
            }
            messages.push({role:'tool',tool_call_id:call.id,content:String(result).slice(0,8000)});
            signal?.throwIfAborted();
          }
          lastReason='start';
          break;
        }
        transition('finish',candidate,'complete');
        return validated.output;
      }
    }
    throw new Error('Browser turn budget exhausted');
  }
}
