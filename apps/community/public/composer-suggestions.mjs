const IDLE = '무엇을 함께 해볼까요?';
const QUEUED = '다음 요청을 입력하세요. Enter를 누르면 대기열에 추가됩니다.';

/** Suggestions are placeholders, never messages or automatically filled drafts. */
export function createComposerSuggestions({api, getSession, isVisible = () => !document.hidden}) {
  const bindings = new Map(), cache = new Map();
  let generation = 0, session = null;
  const connected = input => input.isConnected !== false;
  function reset() {
    generation++;
    for (const entry of cache.values()) entry.controller?.abort();
    cache.clear();
    for (const [input, binding] of bindings) {
      input.removeEventListener('input', binding.onInput);
      input.removeEventListener('keydown', binding.onKey);
      input.placeholder = IDLE;
      delete input.dataset.suggestion;
      input.removeAttribute('aria-description');
      input.removeAttribute('title');
    }
    bindings.clear(); session = null;
  }
  function current(binding) {
    return connected(binding.input) && getSession() === session && session?.user;
  }
  function paint(binding) {
    const {input, queued, key} = binding;
    const suggestion = current(binding) && !input.value && !input.disabled && key ? cache.get(key)?.suggestion || '' : '';
    input.placeholder = suggestion ? '제안: ' + suggestion : queued ? QUEUED : IDLE;
    if (suggestion) {
      input.dataset.suggestion = suggestion;
      input.setAttribute('aria-description', '다음 메시지 제안입니다. Tab 키를 누르면 입력됩니다. 자동으로 전송되지 않습니다.');
      input.title = 'Tab 키로 제안 입력';
    } else {
      delete input.dataset.suggestion;
      input.removeAttribute('aria-description'); input.removeAttribute('title');
    }
  }
  function request(binding) {
    if (!current(binding) || binding.input.value || binding.input.disabled || !binding.key || !isVisible()) return;
    const {key, roomId, afterMessageId, model, effort} = binding;
    if (cache.has(key)) return;
    const epoch = generation, controller = new AbortController();
    const entry = {suggestion: '', controller}; cache.set(key, entry);
    if (cache.size > 64) {
      const oldest = cache.keys().next().value;
      cache.get(oldest)?.controller?.abort(); cache.delete(oldest);
    }
    Promise.resolve().then(() => api(`/api/rooms/${encodeURIComponent(roomId)}/suggestion`, {
      method: 'POST', body: JSON.stringify({afterMessageId, model, effort}), signal: controller.signal,
    })).then(result => {
      if (epoch !== generation || cache.get(key) !== entry || controller.signal.aborted) return;
      const text = typeof result?.suggestion === 'string' ? result.suggestion.trim() : '';
      if (result?.revision === afterMessageId && text.length <= 100 && !/[\r\n\x00-\x1f]/.test(text)) entry.suggestion = text;
    }).catch(() => {
      // Suggestions are optional: failed providers leave the normal composer usable.
    }).finally(() => {
      if (epoch !== generation || cache.get(key) !== entry) return;
      entry.controller = null;
      for (const item of bindings.values()) if (item.key === key && current(item)) paint(item);
    });
  }
  function sync({input, roomId, data, model = '', effort = '', blocked = false, queued = false, hasAttachments = false}) {
    if (!input) return;
    const nextSession = getSession();
    if (nextSession !== session) { reset(); session = nextSession; }
    for (const [node, binding] of bindings) if (!connected(node)) {
      node.removeEventListener('input', binding.onInput); node.removeEventListener('keydown', binding.onKey); bindings.delete(node);
    }
    let binding = bindings.get(input);
    if (!binding) {
      binding = {input};
      binding.onInput = () => { paint(binding); request(binding); };
      binding.onKey = event => {
        if (event.key !== 'Tab' || event.shiftKey || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.defaultPrevented || input.value || input.disabled || !current(binding)) return;
        const suggestion = input.dataset.suggestion;
        if (!suggestion) return;
        event.preventDefault(); input.value = suggestion;
        input.dispatchEvent(new Event('input', {bubbles: true}));
        input.setSelectionRange?.(suggestion.length, suggestion.length);
      };
      input.addEventListener('input', binding.onInput); input.addEventListener('keydown', binding.onKey);
      bindings.set(input, binding);
    }
    const last = data?.messages?.at(-1);
    // Reset/Compact retain the message IDs but change what the next turn sees.
    // Keep their public context metadata in the key so an old placeholder cannot
    // be accepted after the conversation scope has changed.
    const context = data?.context;
    const contextKey = context ? [context.usedChars, context.messageTokens, context.summaryTokens, Boolean(context.compacted), Boolean(context.merged)] : null;
    const eligible = session?.user && roomId && data?.room?.id === roomId && last?.kind === 'bot' &&
      context?.usedChars !== 0 && !blocked && !queued && !data.busy && !data.queue?.length && !hasAttachments;
    Object.assign(binding, {roomId, model, effort, queued, afterMessageId: last?.id,
      key: eligible ? JSON.stringify([roomId, last.id, model, effort, contextKey]) : ''});
    paint(binding); request(binding);
  }
  return {sync, reset};
}
