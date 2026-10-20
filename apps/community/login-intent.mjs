import net from 'node:net';

const NONE = Object.freeze({ requested: false, currentPage: false, continuation: false });
const LOGIN_KO = /로그인(?:을)?\s*(?:좀\s*)?(?:(?:직접|네가|너가)\s*)?(?:해\s*(?:줘|주세요|줄래|줄\s*수\s*있(?:어|나요|을까)|주실래)|시켜\s*(?:줘|주세요)|하자|하기|부탁(?:해|합니다))/i;
const LOGIN_EN = /(?:^|\b(?:please|then|and|can you|could you|would you|i want you to)\s+)(?:log|sign)(?:\s+me)?[ -]+in\b/i;
const LOGIN_MENTION = /로그인|\b(?:log[ -]?in|sign[ -]?in)\b/i;
const VAULT_ACTION = /\bvault\s*(?:계정\s*선택\s*)?(?:창|화면|팝업)?(?:을|를)?\s*(?:열어|띄워|보여)\s*(?:줘|주세요|줄래)|\b(?:open|show)\s+(?:the\s+)?(?:private\s+)?vault(?:\s+(?:chooser|window|popup))?\b/i;
const STOP = /(?:로그인|log[ -]?in|sign[ -]?in).{0,30}(?:하지\s*마|말고|대신|필요\s*없|안\s*해도)|(?:하지\s*마|그만(?:해|하자|해줘)?|취소|멈춰|안\s*해도\s*돼)|\b(?:do not|don't|stop|cancel|never mind|no need)\b/i;
const META = /(?:라는|라고\s*(?:한|하는|말한)|이란)\s*(?:말|문장|표현|뜻|요청)|(?:문장|표현|예문|인용).{0,30}(?:설명|번역|분석|예시)|\b(?:how (?:do|can|to)|explain|translate|meaning of|what does|example of)\b/i;
const LEADING = /^(?:(?:아니|그럼|그러면|그래|응|네|아|일단|그냥|좀|제발|다시|계속|직접|너가|네가|니가|너|당신이|지금)\s*[,!.~]?\s*)+/;
const OFFER = /\s*[,;.!?~]?\s*(?:내가|제가|내|제)?\s*(?:(?:아이디|비번|비밀번호|계정|로그인\s*정보)(?:\s*(?:랑|와|과|하고|및|,)?\s*(?:아이디|비번|비밀번호|계정|정보))?\s*(?:를|을|는|은|도)?)?\s*(?:알려\s*줄(?:게|께|테니|테니까|거야)|줄(?:게|께|테니|테니까)|입력할(?:게|테니|테니까)|넣어\s*줄(?:게|테니|테니까)|제공할(?:게|테니|테니까))[.!?~\s]*$/;
const HERE_KO = /^(?:여기(?:에|서)?|(?:이|현재)\s*(?:브라우저|화면|페이지|사이트)(?:에|에서)?)\s*/;
const SIMPLE_EN = /^(?:please\s+)?(?:log|sign)(?:\s+me)?[ -]+in(?:\s+(?:here|on (?:this|the current) (?:page|site|browser)))?[.!?\s]*$/i;
const CONTINUE = /^(?:해\s*(?:줘|주세요|줄래)|진행해\s*(?:줘|주세요)|계속해\s*(?:줘|주세요)|부탁해|(?:please\s+)?(?:do it(?: yourself)?|go ahead|continue|try again))[.!?~\s]*$/i;
const LOGIN_ONLY = new RegExp(`^(?:${LOGIN_KO.source})[.!?~\\s]*$`, 'i');

function safeTarget(value) {
  if (value.length > 2048 || /[\x00-\x20\x7f\\]/.test(value)) return null;
  try {
    const url = new URL(value.includes('://') ? value : 'https://' + value);
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'https:' || url.username || url.password || net.isIP(host.replace(/^\[|\]$/g, '')) ||
        host.length > 253 || !host.includes('.') || host.endsWith('.') ||
        /(?:^|\.)(?:localhost|local|internal|lan|home|corp|test|invalid|example|onion)$/.test(host) ||
        host.split('.').some(label => !/^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label)) ||
        !/^(?:[a-z]{2,63}|xn--[a-z\d-]+)$/i.test(host.split('.').at(-1))) return null;
    return url.href;
  } catch { return null; }
}

function targetIn(text) {
  const candidates = [], covered = [];
  const add = (value, index) => {
    const cleaned = value.replace(/[.,!?;:)\]}]+$/, '');
    candidates.push(safeTarget(cleaned));
    covered.push([index, index + value.length]);
  };
  // A URL with an unsupported scheme or embedded credentials must never fall
  // back to a different destination inherited from an earlier request.
  for (const match of text.matchAll(/\b[a-z][a-z\d+.-]*:\/\/[^\s<>"'`]+/gi)) add(match[0], match.index);
  for (const match of text.matchAll(/(?:[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?\.)+(?:[a-z]{2,63}|xn--[a-z\d-]+)(?::\d{1,5})?(?:\/[^\s<>"'`]*)?/gi)) {
    const before = text[match.index - 1] || '';
    if (/[@\w/.-]/.test(before) || covered.some(([start, end]) => match.index >= start && match.index < end)) continue;
    add(match[0], match.index);
  }
  // Bare local/IP destinations are explicit targets too, but cannot become a
  // public website target or silently inherit the previous public website.
  if (/(?:^|\s)(?:localhost(?::\d+)?|\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?)(?=$|[\s/에로.,!?])/i.test(text)) candidates.push(null);
  const unique = [...new Set(candidates)];
  return { present: candidates.length > 0, url: unique.length === 1 && unique[0] ? unique[0] : null };
}

function classify(value) {
  if (typeof value !== 'string' || value.length > 4000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) return { kind: 'stop' };
  const text = value.trim().replace(/\s+/g, ' ');
  if (!text || STOP.test(text) || META.test(text) || /```|~~~/.test(text) ||
      /^(?:"[^"]*"|'[^']*'|“[^”]*”|‘[^’]*’|`[^`]*`)[.!?\s]*$/.test(text)) return { kind: 'stop' };
  const target = targetIn(text);
  if (target.present && !target.url) return { kind: 'stop' };
  const direct = LOGIN_KO.test(text) || LOGIN_EN.test(text) || LOGIN_MENTION.test(text) && VAULT_ACTION.test(text);
  const simple = text.replace(OFFER, '').trim().replace(LEADING, '');
  const here = HERE_KO.test(simple) || SIMPLE_EN.test(simple) && /\bhere\b|\b(?:this|the current) (?:page|site|browser)\b/i.test(simple);
  const generic = LOGIN_ONLY.test(simple.replace(HERE_KO, '')) || SIMPLE_EN.test(simple);
  if (direct) return { kind: 'login', generic, here, target: target.url };
  if (CONTINUE.test(simple)) return { kind: 'continue', target: target.url };
  return { kind: 'stop' };
}

/**
 * Determines wording only, never grants access or chooses a browser tab.
 * The caller must provide preceding human messages scoped to the authenticated
 * actor/room/current message, excluding copied history and expired intent.
 */
export function resolveLoginIntent({ text, previous = [], now = Date.now() } = {}) {
  const current = classify(text);
  if (current.kind === 'stop') return { ...NONE };
  if (current.kind === 'login' && current.target)
    return { requested: true, currentPage: false, continuation: false, targetUrl: current.target };
  if (current.kind === 'login' && current.here) return { requested: true, currentPage: true, continuation: false };
  if (current.kind === 'login' && !current.generic) return { requested: true, currentPage: false, continuation: false };
  let priorLogin = false;
  for (const row of (Array.isArray(previous) ? previous : []).slice(0, 6)) {
    // The server also filters this. Keeping the age bound here prevents a caller
    // from accidentally refreshing old intent with repeated short follow-ups.
    if (Number.isFinite(row?.created_at) && (row.created_at > now || now - row.created_at > 10 * 60_000)) break;
    const prior = classify(row?.text);
    if (prior.kind === 'stop') break;
    if (prior.kind === 'login') {
      priorLogin = true;
      if (prior.target) return { requested: true, currentPage: false, continuation: true, targetUrl: prior.target };
      if (!prior.generic || prior.here) break;
    }
  }
  if (current.kind !== 'login' && !priorLogin) return { ...NONE };
  return { requested: true, currentPage: current.kind === 'login' && current.generic && !priorLogin, continuation: priorLogin };
}
