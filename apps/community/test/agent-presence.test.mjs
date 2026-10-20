import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolveAgentPresence } from '../public/agent-presence.js';
import { failedOutcome } from '../public/conversation-ui.mjs';

const source = readFileSync(new URL('../public/agent-presence.js', import.meta.url), 'utf8').replaceAll('export function ', 'function ');
function setup() {
  const makeNode = () => ({ attributes: {}, listeners: new Map(), dataset: {}, children: [], classes: new Set(), setAttribute(k, v) { this.attributes[k] = v; }, removeAttribute(k) { delete this.attributes[k]; if (k === 'src') this.src = null; }, addEventListener(k, fn) { this.listeners.set(k, fn); }, removeEventListener(k) { this.listeners.delete(k); }, append(...nodes) { this.children.push(...nodes); }, replaceChildren() { this.children = []; } });
  const mount = makeNode();
  mount.classList = { toggle(k, on) { if (on) mount.classes.add(k); else mount.classes.delete(k); } };
  const document = { ...makeNode(), hidden: false, createElement(tag) { return { ...makeNode(), tag }; } };
  const motion = { ...makeNode(), matches: false };
  const timers = new Map(); let timerId = 0;
  const context = { document, matchMedia: () => motion,
    setTimeout(callback) { const id=++timerId; timers.set(id,callback); return id; },
    clearTimeout(id) { timers.delete(id); } };
  const finishReaction = () => { for(const [id,callback] of [...timers]) { timers.delete(id); callback(); } };
  vm.runInNewContext(`${source}\nthis.createAgentPresence = createAgentPresence;`, context);
  const controller = context.createAgentPresence({ mount });
  return { mount, character: mount.children[0], motion, document, controller, timers, finishReaction };
}

test('completed errors remain visible without overriding a new active request', () => {
  assert.equal(resolveAgentPresence(), 'idle');
  assert.equal(resolveAgentPresence({ hasError: true }), 'error');
  assert.equal(resolveAgentPresence({ rooms: [{ busy: false, stage: 'error' }] }), 'error');
  assert.equal(resolveAgentPresence({ sending: true, hasError: true, rooms: [{ busy: false, stage: 'error' }] }), 'working');
  assert.equal(resolveAgentPresence({ rooms: [{ busy: true, stage: 'model' }] }), 'working');
  assert.equal(resolveAgentPresence({ rooms: [{ busy: true, stage: 'tool' }] }), 'working');
  assert.equal(resolveAgentPresence({ rooms: [{ busy: true, stage: 'error' }] }), 'error');
});

test('one transparent animation switches state without restarting the same state', () => {
  const app = setup();
  assert.equal(app.character.tag, 'img');
  assert.equal(app.character.src, '/media/agent/idle-poster.webp');
  app.controller.set('idle');
  assert.equal(app.character.src, '/media/agent/idle.webp');
  let writes = 0;
  Object.defineProperty(app.character, 'src', { configurable: true, get() { return '/media/agent/idle.webp'; }, set() { writes++; } });
  app.controller.set('idle');
  assert.equal(writes, 0);
  assert.equal(app.mount.children.length, 2);
  assert.equal(app.mount.attributes['aria-label'], '에이전트 · 쉬고 있어요');
});

test('hidden pages and reduced motion use transparent state posters and restore on return', () => {
  const app = setup();
  app.controller.set('error');
  assert.equal(app.character.src, '/media/agent/error.webp');
  app.document.hidden = true;
  app.document.listeners.get('visibilitychange')();
  assert.equal(app.character.src, '/media/agent/error-poster.webp');
  app.document.hidden = false;
  app.document.listeners.get('visibilitychange')();
  assert.equal(app.character.src, '/media/agent/error.webp');
  app.motion.matches = true;
  app.motion.listeners.get('change')();
  assert.equal(app.character.src, '/media/agent/error-poster.webp');
  app.controller.set('working');
  assert.equal(app.character.src, '/media/agent/working-poster.webp');
  app.controller.reset();
  assert.equal(app.character.src, '/media/agent/idle-poster.webp');
  assert.equal(app.mount.children[1].textContent, '');
});

test('failed animations fall back to a transparent poster and cleanup removes listeners', () => {
  const app = setup();
  app.controller.set('waiting');
  app.character.listeners.get('error')();
  assert.equal(app.character.src, '/media/agent/waiting-poster.webp');
  app.controller.set('waiting');
  assert.equal(app.character.src, '/media/agent/waiting-poster.webp');
  app.controller.destroy();
  assert.equal(app.mount.children.length, 0);
  assert.equal(app.document.listeners.size, 0);
  assert.equal(app.motion.listeners.size, 0);
  assert.equal(app.character.listeners.size, 0);
});


test('real queues wait while model generation and unlabelled running jobs work', () => {
  for (const stage of ['accepted','queued','waiting'])
    assert.equal(resolveAgentPresence({ rooms: [{ busy:true, stage }] }), 'waiting');
  for (const stage of ['model','tool','streaming',undefined])
    assert.equal(resolveAgentPresence({ rooms: [{ busy:true, stage }] }), 'working');
  assert.equal(resolveAgentPresence({ rooms: [{busy:true,stage:'queued'},{busy:true,stage:'model'}] }), 'working');
});

test('typing immediately uses listening motion, extends its timeout and returns to idle', () => {
  const app=setup();app.controller.set('idle');
  app.controller.react('typing');
  assert.equal(app.character.src,'/media/agent/waiting.webp');
  assert.equal(app.mount.dataset.reaction,'typing');
  assert.equal(app.mount.attributes['aria-label'],'에이전트 · 메시지를 기다리고 있어요');
  let writes=0;
  Object.defineProperty(app.character,'src',{configurable:true,get(){return '/media/agent/waiting.webp';},set(){writes++;}});
  app.controller.react('typing');
  assert.equal(writes,0,'keystrokes do not restart the animation file');
  assert.equal(app.timers.size,1,'one idle timeout survives repeated input');
  app.finishReaction();
  assert.equal(writes,1);assert.equal(app.mount.dataset.reaction,'');
  assert.equal(app.mount.attributes['aria-label'],'에이전트 · 쉬고 있어요');
});

test('sending interrupts typing, generation remains working, success briefly acknowledges completion', () => {
  const app=setup();app.controller.set('idle');app.controller.react('typing');
  app.controller.set('working');app.controller.react('send');
  assert.equal(app.character.src,'/media/agent/working.webp');
  assert.equal(app.mount.dataset.reaction,'send');
  app.controller.react('typing');
  assert.equal(app.mount.dataset.reaction,'send','typing a queued message does not interrupt work');
  app.finishReaction();
  assert.equal(app.character.src,'/media/agent/working.webp');
  app.controller.react('complete');app.controller.set('idle');
  assert.equal(app.mount.dataset.reaction,'complete');
  assert.equal(app.mount.attributes['aria-label'],'에이전트 · 답변을 마쳤어요');
  app.finishReaction();
  assert.equal(app.mount.dataset.reaction,'');
  assert.equal(app.character.src,'/media/agent/idle.webp');
});

test('error and negative outcomes remain visible while typing until another request starts', () => {
  const app=setup();app.controller.set('idle');app.controller.react('typing');
  app.controller.set('error');
  for(const reaction of ['typing','complete','send'])app.controller.react(reaction);
  assert.equal(app.mount.dataset.reaction,'');assert.equal(app.timers.size,0);
  assert.equal(app.character.src,'/media/agent/error.webp');
  app.controller.set('working');app.controller.react('send');
  assert.equal(app.character.src,'/media/agent/working.webp');
});

test('reactions respect hidden/reduced motion and cannot survive logout or destruction', () => {
  const app=setup();app.controller.set('idle');app.motion.matches=true;
  app.controller.react('typing');
  assert.equal(app.character.src,'/media/agent/waiting-poster.webp');
  assert.equal(app.mount.classes.has('is-paused'),true);
  app.controller.reset();
  assert.equal(app.timers.size,0);assert.equal(app.mount.dataset.reaction,'');
  app.controller.react('send');assert.equal(app.timers.size,0);
  app.controller.set('working');app.controller.react('send');app.controller.destroy();
  assert.equal(app.timers.size,0);
  app.controller.set('idle');app.controller.react('typing');app.finishReaction();
  assert.equal(app.character.src,null);assert.equal(app.mount.children.length,0);
});


test('real room polling acknowledges only newly completed successful work, once', () => {
  const appSource=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
  const start=appSource.indexOf('function observeRoomOutcome(');
  const functionSource=appSource.slice(start,appSource.indexOf('async function optimisticMessage(',start));
  const reactions=[];
  const context={state:{rooms:[]},syncSessionActivity(){},failedOutcome,presenceTurns:new Map(),presenceErrors:new Set(),presenceBusy:new Set(),pendingMessages:new Map(),agentPresence:{react:kind=>reactions.push(kind)}};
  vm.runInNewContext(functionSource+'\nthis.observe=observeRoomOutcome;',context);
  const human={id:'human-1',kind:'human',text:'확인해줘'},reply={id:'bot-1',kind:'bot',text:'확인을 마쳤어요.'};
  const room={id:'room-1'};
  context.observe({room,busy:false,messages:[human,reply]});
  assert.deepEqual(reactions,[],'opening old history never celebrates it');
  context.observe({room,busy:true,messages:[human]});
  context.observe({room,busy:false,messages:[human,reply]});
  context.observe({room,busy:false,messages:[human,reply]});
  assert.deepEqual(reactions,['complete'],'subsequent polling never repeats completion');
  const next={...human,id:'human-2'};
  context.observe({room,busy:true,messages:[human,reply,next]});
  context.observe({room,busy:false,messages:[human,reply,next,{...reply,id:'bot-2',text:'처리할 수 없습니다.'}]});
  assert.deepEqual(reactions,['complete'],'negative results do not trigger a success gesture');
  assert.equal(context.presenceErrors.has('room-1'),true);
});

test('a polite refusal drives the actual error avatar and stays until the next request', () => {
  const app = setup(), appSource = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
  const start = appSource.indexOf('function observeRoomOutcome(');
  const functionSource = appSource.slice(start, appSource.indexOf('async function optimisticMessage(', start));
  const context = {state:{rooms:[]}, syncSessionActivity(){}, failedOutcome, presenceTurns:new Map(), presenceErrors:new Set(), presenceBusy:new Set(), pendingMessages:new Map(), agentPresence:app.controller};
  vm.runInNewContext(functionSource + '\nthis.observe=observeRoomOutcome;', context);
  const room = {id:'room-1'}, human = {id:'human-1', kind:'human', text:'작업해줘'};
  const refusal = {id:'bot-1', kind:'bot', text:'죄송합니다만, 해당 요청은 도와드릴 수 없습니다.'};
  const render = data => {
    context.observe(data);
    app.controller.set(resolveAgentPresence({rooms:[{busy:data.busy}], hasError:context.presenceErrors.has(room.id)}));
  };
  render({room, busy:true, messages:[human]});
  assert.equal(app.character.src, '/media/agent/working.webp');
  render({room, busy:false, messages:[human, refusal]});
  assert.equal(app.character.src, '/media/agent/error.webp');
  app.controller.react('complete'); app.finishReaction();
  app.controller.react('typing');
  render({room, busy:false, messages:[human, refusal]});
  assert.equal(app.character.src, '/media/agent/error.webp', 'polls and completion/typing gestures cannot dismiss a refusal');
  assert.equal(app.mount.dataset.reaction, '');
  const next = {...human, id:'human-2'};
  render({room, busy:true, messages:[human, refusal, next]});
  assert.equal(context.presenceErrors.has(room.id), false);
  assert.equal(app.character.src, '/media/agent/working.webp');
  render({room, busy:false, messages:[human, refusal, next, {id:'bot-2', kind:'bot', text:'확인을 마쳤습니다.'}]});
  app.finishReaction();
  assert.equal(app.character.src, '/media/agent/idle.webp');
});
