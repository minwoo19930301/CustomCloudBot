// The server owns retries. This panel reports observed attempts and only sends
// explicit user choices; a poll or an unanswered notice never starts a request.
const PHASES = new Set(['switching', 'trying', 'waiting', 'exhausted', 'stopped']);
const TERMINAL = new Set(['exhausted', 'stopped']);
const REASONS = new Set(['limit','connection','response','switch','unavailable','authentication','billing','endpoint','provider','timeout','size','request']);

function normalizedStatus(value) {
  if (!value || typeof value.runId !== 'string' || !value.runId || !PHASES.has(value.phase)) return null;
  if (value.visible !== true && value.phase !== 'waiting' && !TERMINAL.has(value.phase)) return null;
  return {
    runId: value.runId,
    userId: value.userId,
    phase: value.phase,
    model: typeof value.model === 'string' ? value.model.replace(/[\p{Cc}\p{Bidi_Control}]/gu, '').trim().slice(0, 120) : '',
    reason: REASONS.has(value.reason) ? value.reason : 'response',
    automatic: value.automatic === true,
    canControl: value.canControl === true,
  };
}

function notice(status) {
  if (status.phase === 'waiting') return '사용 가능한 모델에서 답변을 받지 못했어요. 모델을 선택하거나 자동으로 다시 시도할 수 있어요.';
  if (status.phase === 'exhausted') return '연결된 모델에서 답변을 받지 못했어요.';
  if (status.phase === 'stopped') return '모델 응답을 중지했어요.';
  // During switching, model may still name the failed attempt. Name a model
  // only after the server confirms an actual attempt has started.
  if (status.phase === 'switching') return '응답을 이어갈 모델을 바꾸고 있어요.';
  if (status.reason === 'switch') return `${status.model || '선택한 모델'}로 이어서 시도하고 있어요.`;
  const reason = {
    limit:'모델 사용 한도에 도달해', connection:'모델 연결이 원활하지 않아',
    authentication:'제공자 계정 인증에 문제가 있어', billing:'제공자 잔액 또는 사용 예산이 부족해',
    unavailable:'이 모델을 사용할 수 없어', endpoint:'제공자 연결 주소를 찾지 못해',
    provider:'제공자 서버에 일시적인 오류가 있어', timeout:'모델 응답 시간이 초과되어',
    size:'이 요청이 모델의 처리 크기 한도를 넘어', request:'모델이 요청 형식을 처리하지 못해',
    response:'모델 응답을 받지 못해',
  }[status.reason] || '모델 응답을 받지 못해';
  return `${reason} ${status.model || '다른 모델'}로 이어서 시도하고 있어요.`;
}

export function createModelFailoverUI({api, getSession, onSelectModel, onRefresh, toast}) {
  const entries = new Map(), operations = new Map();
  let generation = 0, destroyed = false;
  const identity = () => {
    const session = getSession?.();
    return {userId: session?.user?.id ?? null, token: session?.csrfToken ?? null};
  };
  const sameIdentity = (first, second) => first.userId === second.userId && first.token === second.token;
  const element = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };
  const setText = (node, value) => { if (node.textContent !== value) node.textContent = value; };
  const keyFor = entry => `${entry.roomId}\0${entry.status.runId}`;
  const current = entry => !destroyed && entry.generation === generation && entries.get(entry.host) === entry &&
    entry.host.isConnected && entry.panel.isConnected && sameIdentity(entry.viewer, identity());
  const canControl = entry => current(entry) && entry.status.canControl &&
    Boolean(entry.viewer.userId) && entry.status.userId === entry.viewer.userId && !TERMINAL.has(entry.status.phase);

  function paint(entry) {
    const status = entry.status, controllable = canControl(entry), pending = operations.has(keyFor(entry));
    entry.panel.dataset.phase = status.phase;
    entry.panel.dataset.automatic = String(status.automatic);
    setText(entry.message, notice(status));
    entry.actions.hidden = !controllable;
    entry.select.disabled = !controllable || pending || entry.selecting || typeof onSelectModel !== 'function';
    entry.stop.disabled = !controllable || pending;
    entry.auto.disabled = !controllable || pending || (status.automatic && ['switching', 'trying'].includes(status.phase));
    entry.auto.setAttribute('aria-pressed', String(status.automatic && ['switching', 'trying'].includes(status.phase)));
    entry.actions.setAttribute('aria-busy', String(pending));
  }

  function paintRun(key) {
    for (const entry of entries.values()) if (keyFor(entry) === key && current(entry)) paint(entry);
  }

  async function act(entry, action, model) {
    if (!canControl(entry) || !['auto', 'stop', 'select'].includes(action)) return false;
    if (action === 'select' && (typeof model !== 'string' || !model.trim())) return false;
    if (action === 'auto' && entry.auto.disabled) return false;
    const key = keyFor(entry);
    if (operations.has(key)) return false;
    const operation = Symbol(key), runId = entry.status.runId;
    operations.set(key, operation); paintRun(key);
    let accepted = false;
    try {
      await api(`/api/rooms/${encodeURIComponent(entry.roomId)}/model-control`, {
        method: 'POST', body: JSON.stringify({runId, action, ...(action === 'select' ? {model: model.trim()} : {})}),
      });
      accepted = true;
      if (current(entry)) await onRefresh?.(entry.roomId);
      return true;
    } catch (error) {
      if (current(entry)) {
        toast?.(accepted ? '선택은 반영됐어요. 응답 상태를 다시 확인하고 있어요.' :
          [404, 409].includes(error?.status) ? '응답 상태가 바뀌었어요. 현재 상태를 다시 확인해 주세요.' :
            '모델 설정을 적용하지 못했어요. 다시 시도해 주세요.');
        if (!accepted && [404, 409].includes(error?.status)) await Promise.resolve().then(() => onRefresh?.(entry.roomId)).catch(() => {});
      }
      return accepted;
    } finally {
      if (operations.get(key) === operation) operations.delete(key);
      paintRun(key);
    }
  }

  async function choose(entry) {
    if (!canControl(entry) || entry.select.disabled || typeof onSelectModel !== 'function') return;
    entry.selecting = true; paint(entry);
    try {
      await onSelectModel({roomId: entry.roomId, runId: entry.status.runId, model: entry.status.model,
        select: model => act(entry, 'select', model)});
    } catch {
      if (current(entry)) toast?.('모델 선택 창을 열지 못했어요. 다시 시도해 주세요.');
    } finally {
      entry.selecting = false;
      if (current(entry)) paint(entry);
    }
  }

  function remove(entry) {
    entry.panel.remove();
    if (entries.get(entry.host) === entry) entries.delete(entry.host);
  }

  function render(host, roomId, value) {
    if (!host || destroyed) return;
    for (const entry of entries.values()) if (!entry.host.isConnected) remove(entry);
    const status = normalizedStatus(value), viewer = identity();
    let entry = entries.get(host);
    if (entry && (!status || !roomId || entry.roomId !== roomId || entry.status.runId !== status.runId ||
      !sameIdentity(entry.viewer, viewer) || entry.panel.parentNode !== host)) { remove(entry); entry = null; }
    if (!status || !roomId) return;
    if (!entry) {
      const panel = element('section', 'model-failover');
      panel.setAttribute('aria-label', '모델 응답 상태');
      const message = element('p', 'model-failover-message');
      message.setAttribute('role', 'status'); message.setAttribute('aria-live', 'polite'); message.setAttribute('aria-atomic', 'true');
      const actions = element('div', 'model-failover-actions');
      const select = element('button', 'model-failover-select', '직접 모델 선택');
      const stop = element('button', 'model-failover-stop', '중지');
      const auto = element('button', 'model-failover-auto', '자동으로 계속');
      for (const button of [select, stop, auto]) button.type = 'button';
      actions.append(select, stop, auto); panel.append(message, actions); host.prepend(panel);
      entry = {host, panel, message, actions, select, stop, auto, roomId, status, viewer, generation, selecting: false};
      entries.set(host, entry);
      select.onclick = () => choose(entry);
      stop.onclick = () => act(entry, 'stop');
      auto.onclick = () => act(entry, 'auto');
    }
    entry.status = status; paint(entry);
    return entry.panel;
  }

  function reset() {
    generation++; operations.clear();
    for (const entry of entries.values()) remove(entry);
  }
  return {render, reset, destroy() { reset(); destroyed = true; }};
}
