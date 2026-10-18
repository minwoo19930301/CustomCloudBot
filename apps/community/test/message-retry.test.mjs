import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const tick = () => new Promise(resolve => setImmediate(resolve));
function functionSource(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Application function range ${start}`);
  return source.slice(from, to);
}

function fixture({ paneMode = false, text = '사진을 확인해 줘', busy = false, optimisticDelay = null } = {}) {
  const roomId = 'original room/1';
  const input = { value: text, disabled: false, style: {}, focus() {} };
  const image = { id: 'original-image', name: 'screenshot.png', mimeType: 'image/png' };
  const form = {};
  const pane = { roomId, data: { room: { id: roomId }, busy }, draft: text, pendingAttachments: [{ attachment: image }], attachmentGeneration: 0, sending: false };
  const state = {
    session: { user: { id: 'owner' }, csrfToken: 'session-1' }, selectedRoom: paneMode ? 'other-main-room' : roomId,
    roomData: { room: { id: paneMode ? 'other-main-room' : roomId }, busy },
    selectedBots: ['researcher', 'writer'], pendingAttachments: paneMode ? [] : [{ attachment: image }],
    attachmentGeneration: 0, sending: false, extra: paneMode ? [pane] : [],
  };
  const owner = paneMode ? pane : state;
  const model = { value: 'original-model' }, effort = { value: 'high' }, sendButton = { disabled: false };
  const pendingMessages = new Map(), calls = [], paints = [], notices = [], refreshes = [], clearCalls = [];
  const responses = [];
  let nonce = 0, availabilityChanges = 0, refreshFailure = null;
  const context = { agentPresence: { react() {} },
    state, composerRecorder: { status: 'idle', context: null }, pendingMessages, MONITOR_ROOM: 'monitor', modelChanges: new Map(), branchOperations: new Set(),
    topicPrompts: new Set(), presenceErrors: new Set(), Map, Set, JSON, Object,
    crypto: { randomUUID: () => `nonce-${++nonce}` },
    $: selector => ({ '#message-input': input, textarea: input, '#model-select': model, '.model-select': model,
      '#effort-select': effort, '.effort-select': effort, '#send-button': sendButton })[selector],
    roomContextOwner: current => ({ roomId: current ? current.roomId : state.selectedRoom, data: current ? current.data : state.roomData }),
    contextOwnerCurrent: (id, userId, current) => state.session?.user?.id === userId &&
      (current ? state.extra.includes(current) && current.roomId === id : state.selectedRoom === id),
    offerTopicChoice: async () => false,
    updateModelAvailability: () => { availabilityChanges++; },
    optimisticMessage: async (id, content, clientNonce, attachments) => {
      const message = { id: `pending:${clientNonce}`, text: content, kind: 'human', pending: 'sending', attachments };
      pendingMessages.set(id, message);
      if (optimisticDelay) await optimisticDelay;
      return message;
    },
    api: async (path, options) => {
      calls.push({ path, options });
      const response = responses.shift();
      if (!response) throw new Error('Test did not provide an API response');
      return response(path, options);
    },
    clearPendingAttachments: current => {
      const target = current || state;
      clearCalls.push(target);
      target.pendingAttachments = [];
      target.attachmentGeneration++;
    },
    refreshRoom: async () => { refreshes.push('main'); if (refreshFailure) throw refreshFailure; },
    refreshExtra: async index => { refreshes.push(`pane:${index}`); if (refreshFailure) throw refreshFailure; },
    loadRooms: async () => { refreshes.push('rooms'); },
    applyModels() {}, paintPending: id => paints.push(id), toast: text => notices.push(text),
    clearThinking() {}, els: { sendingStatus: {} },
  };
  // The VM globals object holds the exported wrappers and the real app functions.
  const runtime = { ...context, form };
  vm.runInNewContext(
    functionSource('function recordingBlocksSend(', 'function syncRecordingButtons(') +
    functionSource('async function submitMessage(', 'async function authSubmit(') +
    functionSource('async function submitPane(', 'async function refreshExtra(') +
    functionSource('async function retryPendingMessage(', 'function renderBotPicker(') +
    functionSource('function composerBlocked(', 'function updateModelAvailability(') +
    '\nthis.submit=()=> ' + (paneMode ? 'submitPane({preventDefault(){},currentTarget:form},0,true)' : 'submitMessage({preventDefault(){}},true)') + ';' +
    '\nthis.retry=retryPendingMessage;this.discard=discardPendingMessage;', runtime,
  );
  return {
    roomId, state, pane, owner, input, image, model, effort, sendButton, calls, paints, notices, refreshes,
    pendingMessages, clearCalls, submit: runtime.submit, retry: runtime.retry, discard: runtime.discard,
    respond: response => responses.push(response),
    refreshError: error => { refreshFailure = error; },
    activity: () => ({ paints: paints.length, notices: notices.length, refreshes: refreshes.length, clears: clearCalls.length, availabilityChanges }),
    switchRoom(id) { owner.pendingAttachments = []; owner.attachmentGeneration++; if (paneMode) pane.roomId = id; else state.selectedRoom = id; },
  };
}

async function failSend(app) {
  app.respond(() => { throw new Error('response connection lost'); });
  await app.submit();
  const message = app.pendingMessages.get(app.roomId);
  assert.equal(message?.pending, 'failed');
  return message;
}

for (const paneMode of [false, true]) {
  const surface = paneMode ? 'split' : 'main';

  test(`${surface}: photo/text and photo-only retries retain the original request after changing rooms`, async () => {
    for (const text of ['사진을 확인해 줘', '']) {
      const app = fixture({ paneMode, text }), message = await failSend(app);
      const original = app.calls[0], payload = JSON.parse(original.options.body);
      assert.equal(app.input.value, '');
      assert.equal(app.owner.pendingAttachments.length, 0);
      assert.deepEqual(message.attachments, [app.image]);
      assert.ok(Object.isFrozen(message.retry));
      assert.equal(payload.text, text);
      assert.deepEqual(payload.attachmentIds, ['original-image']);
      assert.deepEqual(payload.botIds, ['researcher', 'writer']);
      assert.equal(payload.model, 'original-model');
      assert.equal(payload.effort, 'high');
      assert.equal(payload.clientNonce, 'nonce-1');

      app.switchRoom('another room');
      app.input.value = '다른 방에서 쓰던 내용';
      app.switchRoom(app.roomId);
      const laterAttachment = { attachment: { id: 'new-image' } };
      app.owner.pendingAttachments = [laterAttachment];
      app.input.value = '현재 작성 중인 별개 요청'; app.pane.draft = app.input.value;
      app.state.selectedBots = ['different-bot']; app.model.value = 'new-model'; app.effort.value = 'low';
      const waiting = deferred(); app.respond(() => waiting.promise);
      const retry = app.retry(message); await tick();
      await app.retry(message);
      await app.submit();
      app.discard(message, app.roomId);
      assert.equal(app.calls.length, 2, 'double click and composer submit cannot duplicate a running retry');
      assert.equal(app.pendingMessages.get(app.roomId), message, 'cannot discard a running retry');
      assert.equal(app.calls[1].path, `/api/rooms/${encodeURIComponent(app.roomId)}/messages`);
      assert.equal(app.calls[1].options.body, original.options.body);
      waiting.resolve({ accepted: true, messageId: 'server-message' }); await retry;
      assert.equal(message.id, 'server-message');
      assert.notEqual(message.pending, 'failed');
      assert.equal(app.input.value, '현재 작성 중인 별개 요청');
      assert.deepEqual(app.owner.pendingAttachments, [laterAttachment]);
    }
  });

  test(`${surface}: retry after an accepted response was lost reuses the nonce without a second server effect`, async () => {
    const app = fixture({ paneMode }), nonces = new Set(); let effects = 0;
    const server = (_, { body }) => {
      const { clientNonce } = JSON.parse(body);
      if (!nonces.has(clientNonce)) { nonces.add(clientNonce); effects++; throw new Error('accepted, but response was lost'); }
      return { accepted: true, messageId: 'already-created' };
    };
    app.respond(server); await app.submit();
    const message = app.pendingMessages.get(app.roomId); assert.equal(message.pending, 'failed');
    app.respond(server); await app.retry(message);
    assert.equal(effects, 1); assert.equal(app.calls.length, 2);
    assert.equal(message.id, 'already-created');
    assert.equal(app.calls[1].options.body, app.calls[0].options.body);
  });

  test(`${surface}: new composer sends cannot overwrite the failed request and its attachments`, async () => {
    const app = fixture({ paneMode }), message = await failSend(app);
    const freshAttachment = { attachment: { id: 'different-image' } };
    app.input.value = '별개의 새 요청'; app.pane.draft = app.input.value;
    app.owner.pendingAttachments = [freshAttachment];
    await app.submit();
    assert.equal(app.calls.length, 1);
    assert.equal(app.pendingMessages.get(app.roomId), message);
    assert.deepEqual(message.attachments, [app.image]);
    assert.equal(app.input.value, '별개의 새 요청');
    assert.deepEqual(app.owner.pendingAttachments, [freshAttachment]);
  });

  test(`${surface}: an identical fresh message after successful retry gets a new nonce`, async () => {
    const app = fixture({ paneMode });
    app.owner.pendingAttachments = [];
    const message = await failSend(app);
    const firstNonce = JSON.parse(app.calls[0].options.body).clientNonce;
    app.respond(() => ({ accepted: true, messageId: 'first-message' })); await app.retry(message);
    // Refresh normally removes an outbox entry after the matching server message arrives.
    app.pendingMessages.delete(app.roomId);
    app.input.value = '사진을 확인해 줘'; app.pane.draft = app.input.value;
    app.respond(() => ({ accepted: true, messageId: 'second-message' })); await app.submit();
    assert.equal(app.calls.length, 3);
    assert.notEqual(JSON.parse(app.calls[2].options.body).clientNonce, firstNonce);
    assert.equal(JSON.parse(app.calls[2].options.body).text, JSON.parse(app.calls[0].options.body).text);
  });

  test(`${surface}: failed busy enqueue retains the composer text and attachment without a retry bubble`, async () => {
    const app = fixture({ paneMode, busy: true });
    app.respond(() => { throw new Error('queue full'); }); await app.submit();
    assert.equal(app.input.value, '사진을 확인해 줘');
    assert.equal(app.owner.pendingAttachments[0].attachment, app.image);
    assert.equal(app.pendingMessages.size, 0);
  });

  test(`${surface}: refresh failure after acceptance never turns the message into a failed retry`, async () => {
    for (const retrying of [false, true]) {
      const app = fixture({ paneMode });
      const message = retrying ? await failSend(app) : null;
      app.refreshError(new Error('refresh unavailable'));
      app.respond(() => ({ accepted: true, messageId: 'accepted-message' }));
      await (retrying ? app.retry(message) : app.submit());
      const pending = app.pendingMessages.get(app.roomId);
      assert.equal(pending.id, 'accepted-message');
      assert.notEqual(pending.pending, 'failed');
      assert.match(app.notices.at(-1), /접수됐습니다/);
    }
  });

  test(`${surface}: logout and same-account relogin ignore late retry successes and failures`, async () => {
    for (const relogin of [false, true]) for (const fail of [false, true]) {
      const app = fixture({ paneMode }), message = await failSend(app), waiting = deferred();
      app.respond(() => waiting.promise); const retry = app.retry(message); await tick();
      app.state.session = null; app.pendingMessages.clear();
      if (relogin) app.state.session = { user: { id: 'owner' }, csrfToken: 'session-2' };
      const before = app.activity();
      if (fail) waiting.reject(new Error('late retry failure'));
      else waiting.resolve({ accepted: true, messageId: 'late-message' });
      await retry;
      assert.deepEqual(app.activity(), before, 'a retired retry must not repaint or notify the new login');
      assert.equal(app.pendingMessages.size, 0);
    }
  });

  test(`${surface}: initial sends cannot alter a new same-account login after their pending map is cleared`, async () => {
    for (const fail of [false, true]) {
      const app = fixture({ paneMode }), waiting = deferred();
      app.respond(() => waiting.promise); const sending = app.submit(); await tick();
      app.state.session = null; app.pendingMessages.clear();
      app.state.session = { user: { id: 'owner' }, csrfToken: 'session-2' };
      const freshAttachment = { attachment: { id: 'new-login-image' } };
      app.owner.pendingAttachments = [freshAttachment];
      app.input.value = '새 로그인에서 작성 중';
      const before = app.activity();
      if (fail) waiting.reject(new Error('late send failure'));
      else waiting.resolve({ accepted: true, messageId: 'retired-send' });
      await sending;
      assert.deepEqual(app.activity(), before, 'old submit must not clear or refresh new session UI');
      assert.deepEqual(app.owner.pendingAttachments, [freshAttachment]);
      assert.equal(app.input.value, '새 로그인에서 작성 중');
    }
  });

  test(`${surface}: refreshing same-login settings while sending still completes and releases locks`, async () => {
    for (const retrying of [false, true]) for (const fail of [false, true]) {
      const app = fixture({ paneMode }), message = retrying ? await failSend(app) : null;
      const waiting = deferred(); app.respond(() => waiting.promise);
      const request = retrying ? app.retry(message) : app.submit(); await tick();
      app.state.session = { user: { id: 'owner', displayName: 'Updated profile' }, csrfToken: 'session-1' };
      if (fail) waiting.reject(new Error('current-session failure'));
      else waiting.resolve({ accepted: true, messageId: 'current-session-message' });
      await request;
      const pending = app.pendingMessages.get(app.roomId);
      assert.equal(app.owner.sending, false);
      assert.equal(app.input.disabled, false);
      assert.notEqual(pending.retrying, true);
      if (fail) {
        assert.equal(pending.pending, 'failed');
        assert.equal(app.notices.at(-1), 'current-session failure');
      } else {
        assert.equal(pending.id, 'current-session-message');
        assert.notEqual(pending.pending, 'failed');
        assert.ok(app.refreshes.length > 0);
      }
    }
  });

  test(`${surface}: account rotation during optimistic digest preparation prevents the API POST`, async () => {
    for (const nextUserId of ['owner', 'another-user']) {
      const digest = deferred(), app = fixture({ paneMode, optimisticDelay: digest.promise });
      const sending = app.submit(); await tick();
      assert.equal(app.calls.length, 0);
      assert.equal(app.pendingMessages.size, 1, 'optimistic bubble exists before digest completes');
      app.state.session = null; app.pendingMessages.clear();
      app.state.session = { user: { id: nextUserId }, csrfToken: 'session-2' };
      const freshAttachment = { attachment: { id: 'new-login-photo' } };
      app.owner.pendingAttachments = [freshAttachment]; app.input.value = '새 계정의 초안';
      const before = app.activity();
      digest.resolve(); await sending;
      assert.equal(app.calls.length, 0, 'old payload must never be sent with the new authentication');
      assert.equal(app.pendingMessages.size, 0);
      assert.deepEqual(app.activity(), before);
      assert.deepEqual(app.owner.pendingAttachments, [freshAttachment]);
      assert.equal(app.input.value, '새 계정의 초안');
    }
  });
}

test('discard removes only the exact failed message and stale retry handlers cannot send it', async () => {
  const app = fixture(), message = await failSend(app);
  const other = { pending: 'failed' }; app.pendingMessages.set('other', other);
  app.discard(message, app.roomId);
  assert.equal(app.pendingMessages.has(app.roomId), false);
  assert.equal(app.pendingMessages.get('other'), other);
  await app.retry(message);
  assert.equal(app.calls.length, 1);
  const replacement = { pending: 'failed' }; app.pendingMessages.set(app.roomId, replacement);
  app.discard(message, app.roomId);
  assert.equal(app.pendingMessages.get(app.roomId), replacement);
});
