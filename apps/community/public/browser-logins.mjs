const BASE = '/api/browser-logins';
const text = (value, max = 160) => typeof value === 'string' ? value.slice(0, max) : '';

function pendingRequest(value, now) {
  if (!value || value.status !== 'pending' || !text(value.id) || !text(value.roomId)) return null;
  const expiresAt = typeof value.expiresAt === 'number' ? value.expiresAt : Date.parse(value.expiresAt);
  if (!Number.isFinite(expiresAt) || expiresAt <= now) return null;
  try {
    const url = new URL(value.origin);
    if (url.protocol !== 'https:' || url.origin !== value.origin) return null;
    return {id:text(value.id), roomId:text(value.roomId), origin:url.origin, siteLabel:text(value.siteLabel) || url.hostname, expiresAt, status:'pending'};
  } catch { return null; }
}

/**
 * Only server-issued, owner-scoped requests can open this private form.
 * getContext() => {userId, roomId, isOwner}. No credentials enter callbacks,
 * chat messages, browser storage, URLs, or GET requests.
 */
export function createLoginRequestUI({
  api, getContext, onPendingChange = () => {}, onResolved = () => {},
  toast = () => {}, document = globalThis.document, now = Date.now,
}) {
  let actor = '', room = '', requests = [], epoch = 0, active = null, destroyed = false;
  let dialog, content, status, title, abort, expiryTimer;
  const seen = new Set();
  const context = () => {
    const value = getContext() || {};
    return value.isOwner === true && value.userId && value.roomId ? {userId:String(value.userId), roomId:String(value.roomId)} : null;
  };
  const isCurrent = (generation, request) => {
    const value = context();
    return !destroyed && generation === epoch && value?.userId === actor && value.roomId === request.roomId && active?.id === request.id && request.expiresAt > now() && dialog?.open;
  };
  const clearInputs = () => {
    content?.querySelectorAll('input').forEach(input => {
      if (input.type !== 'radio' && input.type !== 'checkbox') input.value = '';
      input.checked = false;
    });
  };
  const notify = () => onPendingChange({count:requests.length, request:requests[0] ? {...requests[0]} : null});
  function dismiss() {
    epoch += 1;
    abort?.abort(); abort = null;
    clearTimeout(expiryTimer); expiryTimer = null;
    clearInputs(); active = null;
    content?.replaceChildren();
    if (status) status.textContent = '';
    if (dialog?.open) dialog.close();
  }
  function reset() {
    dismiss(); actor = ''; room = ''; requests = []; seen.clear(); notify();
  }
  function node(tag, className, value) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (value !== undefined) item.textContent = value;
    return item;
  }
  function button(label, handler, className = '') {
    const item = node('button', className, label); item.type = 'button';
    if (handler) item.addEventListener('click', handler);
    return item;
  }
  function ensureDialog() {
    if (dialog) return;
    dialog = node('dialog', 'browser-login-dialog');
    dialog.setAttribute('aria-labelledby', 'browser-login-title');
    dialog.setAttribute('aria-describedby', 'browser-login-privacy');
    const header = node('header', 'browser-login-header');
    title = node('h2', '', '로그인 계정'); title.id = 'browser-login-title';
    const close = button('×', dismiss, 'browser-login-close'); close.setAttribute('aria-label', '로그인 창 닫기');
    header.append(title, close);
    const privacy = node('p', 'browser-login-note', '비밀번호는 채팅이나 AI에 전달되지 않습니다.');
    privacy.id = 'browser-login-privacy';
    status = node('p', 'browser-login-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
    content = node('div', 'browser-login-content');
    dialog.append(header, privacy, status, content);
    dialog.addEventListener('cancel', event => { event.preventDefault(); dismiss(); });
    dialog.addEventListener('close', () => { if (!dialog.open && active) dismiss(); });
    document.body.append(dialog);
  }
  function forget(id) { requests = requests.filter(item => item.id !== id); notify(); }
  function safeFailure(error, fallback) {
    if (error?.status === 404 || error?.status === 410) return '로그인 요청이 만료되었거나 종료되었습니다. 채팅에서 다시 요청해 주세요.';
    if (error?.status === 409) return '브라우저의 페이지가 바뀌었거나 요청을 진행할 수 없습니다. 로그인할 페이지를 확인하고 다시 요청해 주세요.';
    return fallback;
  }
  async function cancel(request, generation, controls) {
    if (!isCurrent(generation, request) || controls.disabled) return;
    controls.disabled = true; clearInputs(); status.textContent = '요청을 취소하고 있어요…';
    try {
      await api(`${BASE}/${encodeURIComponent(request.id)}`, {method:'DELETE', signal:abort.signal});
      if (!isCurrent(generation, request)) return;
      forget(request.id); dismiss();
    } catch (error) {
      if (!isCurrent(generation, request)) return;
      controls.disabled = false;
      status.textContent = safeFailure(error, '취소하지 못했습니다. 잠시 뒤 다시 시도해 주세요.');
    }
  }
  function render(request, accounts, generation) {
    const form = node('form', 'browser-login-form'); form.autocomplete = 'off';
    const controls = node('fieldset');
    const origin = node('div', 'browser-login-site');
    origin.append(node('strong', '', request.siteLabel), node('span', 'browser-login-origin', request.origin));
    controls.append(origin);
    const options = node('div', 'browser-login-accounts');
    let selection = null;
    const makeChoice = (value, label, detail) => {
      const row = node('label', 'browser-login-account');
      const radio = node('input'); radio.type = 'radio'; radio.name = 'browser-login-account'; radio.value = value;
      const copy = node('span', 'browser-login-account-copy');
      copy.append(node('strong', '', label));
      if (detail) copy.append(node('small', '', detail));
      row.append(radio, copy); options.append(row);
      radio.addEventListener('change', () => {
        if (!radio.checked) return;
        selection = value;
        newFields.hidden = value !== 'new';
        newFields.disabled = value !== 'new';
        clearNewInputs();
        submit.textContent = value === 'new' ? '저장하고 입력하기' : '선택한 계정 입력하기';
        updateSubmit();
      });
      return radio;
    };
    for (const account of accounts) makeChoice(`saved:${account.id}`, account.label || '저장된 계정', account.maskedUsername);
    const add = makeChoice('new', '새 계정 저장', '서버 Vault에 암호화해 보관합니다.');
    controls.append(options);
    const newFields = node('fieldset', 'browser-login-new'); newFields.hidden = true; newFields.disabled = true;
    const input = (label, name, type, maxLength, required) => {
      const wrapper = node('label', 'browser-login-field'); wrapper.append(node('span', '', label));
      const item = node('input'); item.name = name; item.type = type; item.maxLength = maxLength; item.required = required;
      item.autocomplete = type === 'password' ? 'new-password' : 'off';
      item.spellcheck = false; item.setAttribute('autocapitalize', 'none');
      wrapper.append(item); newFields.append(wrapper); return item;
    };
    const label = input('계정 이름 (선택)', 'label', 'text', 80, false);
    const username = input('아이디 또는 이메일', 'username', 'text', 320, true);
    const password = input('비밀번호', 'password', 'password', 4096, true);
    const clearNewInputs = () => { label.value = ''; username.value = ''; password.value = ''; };
    controls.append(newFields);
    const consent = node('label', 'browser-login-consent'), confirm = node('input');
    confirm.type = 'checkbox'; confirm.name = 'sharedDeviceConfirmed'; confirm.required = true;
    consent.append(confirm, node('span', '', '공유 PC에 이 계정으로 입력하기'));
    controls.append(consent, node('p', 'browser-login-note', '같은 PC를 보는 사람에게 로그인 상태가 보일 수 있습니다.'));
    const actions = node('div', 'browser-login-actions');
    const cancelButton = button('요청 취소', () => { void cancel(request, generation, controls); }, 'browser-login-secondary');
    const submit = button('선택한 계정 입력하기', null, 'browser-login-submit'); submit.type = 'submit'; submit.disabled = true;
    const updateSubmit = () => { submit.disabled = !selection || !confirm.checked; };
    confirm.addEventListener('change', updateSubmit);
    actions.append(cancelButton, submit); controls.append(actions); form.append(controls); content.replaceChildren(form);
    if (!accounts.length) { add.checked = true; selection = 'new'; newFields.hidden = false; newFields.disabled = false; submit.textContent = '저장하고 입력하기'; }
    form.addEventListener('submit', async event => {
      event.preventDefault();
      if (!isCurrent(generation, request) || controls.disabled || !confirm.checked || !selection) return;
      const saved = accounts.find(account => `saved:${account.id}` === selection);
      if (!saved && (selection !== 'new' || !username.value.trim() || !password.value)) return;
      let body = saved
        ? {accountId:saved.id, sharedDeviceConfirmed:true}
        : {action:'save', username:username.value.trim(), password:password.value, label:label.value.trim(), sharedDeviceConfirmed:true};
      controls.disabled = true;
      request.submitting = true;
      clearInputs();
      status.textContent = '공유 PC에 입력하고 있어요…';
      try {
        const response = await api(`${BASE}/${encodeURIComponent(request.id)}/resolve`, {method:'POST', body:JSON.stringify(body), signal:abort.signal});
        if (!isCurrent(generation, request)) return;
        if (response?.status !== 'filled') throw new Error('Unexpected login status');
        const result = {requestId:request.id, roomId:request.roomId, status:'filled', ...(response.nextStep === 'continue' ? {nextStep:'continue'} : {})};
        forget(request.id); dismiss();
        toast(response.nextStep === 'continue'
          ? '아이디를 입력했습니다. 브라우저에서 다음 단계로 이동한 뒤 다시 Vault를 열어 주세요.'
          : '계정을 입력했습니다. 브라우저에서 로그인·추가 인증을 마무리해 주세요.');
        onResolved(result);
      } catch (error) {
        if (!isCurrent(generation, request)) return;
        controls.disabled = false; selection = null; newFields.disabled = true; newFields.hidden = true;
        status.textContent = safeFailure(error, '계정을 입력하지 못했습니다. 브라우저를 확인한 뒤 계정을 다시 선택해 주세요.');
        updateSubmit();
      } finally { body = null; request.submitting = false; }
    });
  }
  async function open(id = requests[0]?.id) {
    if (destroyed) return;
    const value = context();
    if (!value || value.userId !== actor || value.roomId !== room) { reset(); return; }
    const request = requests.find(item => item.id === id && item.expiresAt > now());
    if (!request) return;
    dismiss(); ensureDialog();
    active = request; seen.add(request.id);
    const generation = epoch;
    abort = new AbortController();
    title.textContent = '로그인 계정';
    status.textContent = '저장된 계정을 확인하고 있어요…';
    dialog.showModal();
    expiryTimer = setTimeout(() => {
      if (active?.id !== request.id) return;
      forget(request.id); dismiss(); toast('로그인 요청이 만료되었습니다. 채팅에서 다시 요청해 주세요.');
    }, Math.min(2147483647, Math.max(1, request.expiresAt - now())));
    expiryTimer.unref?.();
    try {
      const data = await api(`${BASE}/${encodeURIComponent(request.id)}`, {signal:abort.signal});
      if (!isCurrent(generation, request)) return;
      const detail = pendingRequest(data, now());
      if (!detail || detail.id !== request.id || detail.roomId !== request.roomId || detail.origin !== request.origin) throw new Error('Login request changed');
      const accountIds = new Set();
      const accounts = (Array.isArray(data.accounts) ? data.accounts : []).slice(0, 100).flatMap(item => {
        const accountId = text(item?.id);
        if (!accountId || accountIds.has(accountId)) return [];
        accountIds.add(accountId);
        return [{id:accountId, label:text(item.label, 100), maskedUsername:text(item.maskedUsername, 320)}];
      });
      status.textContent = '';
      render(request, accounts, generation);
    } catch (error) {
      if (!isCurrent(generation, request)) return;
      clearInputs(); content.replaceChildren();
      status.textContent = safeFailure(error, '계정 목록을 불러오지 못했습니다. 창을 닫고 다시 열어 주세요.');
    }
  }
  function sync(items) {
    if (destroyed) return;
    const value = context();
    if (!value) { reset(); return; }
    if (actor !== value.userId) { reset(); actor = value.userId; }
    if (room !== value.roomId) { dismiss(); room = value.roomId; }
    requests = (Array.isArray(items) ? items : []).map(item => pendingRequest(item, now())).filter(item => item?.roomId === room);
    // The server moves this request to filling, then removes it from the pending
    // list. Polling must not abort our own POST before its outcome arrives.
    if (active?.submitting && active.expiresAt > now() && !requests.some(item => item.id === active.id)) {
      requests.push(pendingRequest(active, now()));
    }
    if (active && !requests.some(item => item.id === active.id && item.origin === active.origin)) dismiss();
    notify();
    const next = requests.find(item => !seen.has(item.id));
    if (!dialog?.open && next) void open(next.id);
  }
  return {
    sync, open, reset,
    destroy() { reset(); destroyed = true; dialog?.remove(); dialog = null; },
  };
}
