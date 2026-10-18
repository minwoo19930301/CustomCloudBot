const STATES = { idle: '쉬고 있어요', working: '작업 중', waiting: '응답을 기다리고 있어요', error: '작업을 확인해 주세요' };
const REACTIONS = { typing: { duration: 1400, media: 'waiting', label: '메시지를 기다리고 있어요' }, send: { duration: 650, media: 'working' }, complete: { duration: 1300, media: 'idle', label: '답변을 마쳤어요' } };
export function resolveAgentPresence({ sending = false, rooms = [], hasError = false } = {}) {
  const busy = rooms.filter(room => room.busy);
  if (busy.some(room => room.stage === 'error')) return 'error';
  // Generating a model reply is work too; only an actual queue/wait stays still.
  if (sending || busy.some(room => !['accepted', 'queued', 'waiting'].includes(room.stage))) return 'working';
  if (busy.length) return 'waiting';
  // Finishing a failed request must not immediately replace its error pose with idle.
  return hasError || rooms.some(room => room.stage === 'error') ? 'error' : 'idle';
}
export function createAgentPresence({ mount, poster = '/media/agent/idle-poster.webp' }) {
  // Animated WebP retains the supplied videos' motion and alpha across browsers.
  // The matte is removed once when preparing the assets, never per browser frame.
  const character = document.createElement('img');
  character.className = 'agent-presence-image'; character.alt = ''; character.decoding = 'async';
  character.setAttribute('aria-hidden', 'true'); character.draggable = false;
  const label = document.createElement('span'); label.className = 'sr-only'; label.setAttribute('role', 'status');
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  let active = false, state = 'idle', source = null, reaction = '', reactionTimer = null, destroyed = false;
  const failedSources = new Set();
  mount.append(character, label); mount.dataset.state = state;
  function playback() {
    if (destroyed) return;
    const animate = active && !document.hidden && !motion.matches;
    const response = active && state !== 'error' && (state === 'idle' || reaction === 'send') ? reaction : '';
    const media = REACTIONS[response]?.media || state;
    const description = active ? REACTIONS[response]?.label || STATES[state] : '';
    mount.dataset.reaction = response;
    if (label.textContent !== description) label.textContent = description;
    mount.setAttribute('aria-label', description ? `에이전트 · ${description}` : '에이전트');
    const still = `/media/agent/${media}-poster.webp`;
    const candidates = animate ? [`/media/agent/${media}.webp`, still, poster] : [still, poster];
    const next = candidates.find(path => !failedSources.has(path)) || poster;
    mount.classList.toggle('is-paused', !animate);
    if (source !== next) { source = next; character.src = next; }
  }
  function clearReaction() {
    if (reactionTimer !== null) clearTimeout(reactionTimer);
    reactionTimer = null; reaction = '';
  }
  function set(next = 'idle', visible = true) {
    if (destroyed) return;
    active = visible; state = Object.hasOwn(STATES, next) ? next : 'idle';
    if (!active || state === 'error') clearReaction();
    // An input gesture must not reappear when a subsequent request finishes.
    if (state !== 'idle' && reaction === 'typing') clearReaction();
    mount.dataset.state = state;
    playback();
  }
  function react(kind) {
    if (destroyed || !active || state === 'error' || !Object.hasOwn(REACTIONS, kind)) return;
    if (kind === 'typing' && state !== 'idle') return;
    clearReaction(); reaction = kind;
    reactionTimer = setTimeout(() => { reactionTimer = null; reaction = ''; playback(); }, REACTIONS[kind].duration);
    playback();
  }
  function mediaError() {
    failedSources.add(source);
    playback();
  }
  character.addEventListener('error', mediaError);
  document.addEventListener('visibilitychange', playback);
  motion.addEventListener?.('change', playback);
  playback();
  return { set, react, reset: () => set('idle', false), destroy() { clearReaction(); destroyed = true; active = false; character.removeEventListener('error', mediaError); character.removeAttribute('src'); document.removeEventListener('visibilitychange', playback); motion.removeEventListener?.('change', playback); mount.replaceChildren(); } };
}
