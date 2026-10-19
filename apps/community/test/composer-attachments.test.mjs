import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { clipboardImageFiles, pasteComposerImages, uploadAttachmentFiles, clearAttachmentDraft, removeAttachmentDraft } from "../public/composer-attachments.mjs";

const file = (name = "screenshot.png", type = "image/png", size = 1024) => ({ name, type, size });
const deferred = () => { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; };
const tick = () => new Promise(resolve => setImmediate(resolve));

test("paste reads screenshot items or files once and leaves ordinary text/default browser paste alone", () => {
  const image = file(), uploadCalls = [];
  const event = { clipboardData: { items: [{ kind: "string", type: "text/plain" }, { kind: "file", type: image.type, getAsFile: () => image }], files: [image] }, preventDefault() { this.prevented = true; } };
  assert.deepEqual(clipboardImageFiles(event), [image]);
  assert.equal(pasteComposerImages(event, { enabled: true, upload: files => uploadCalls.push(files) }), true);
  assert.equal(event.prevented, true); assert.deepEqual(uploadCalls, [[image]]);
  assert.deepEqual(clipboardImageFiles({ clipboardData: { files: [image] } }), [image]);
  for (const clipboardData of [undefined, { items: [{ kind: "string", type: "text/plain" }], files: [] }, { files: [file("notes.txt", "text/plain")] }]) {
    const text = { clipboardData, preventDefault() { assert.fail("ordinary paste must not be intercepted"); } };
    assert.equal(pasteComposerImages(text, { enabled: true, upload() { assert.fail(); } }), false);
  }
  event.prevented = false;
  assert.equal(pasteComposerImages(event, { enabled: false, upload() { assert.fail(); } }), false);
  assert.equal(event.prevented, false);
});

function draft({ upload, current = () => true, owner = { pendingAttachments: [], attachmentGeneration: 0 } } = {}) {
  const changes = [], notices = [], calls = [], revoked = [];
  const options = { owner, roomId: "room-a", isCurrent: current, changed: () => changes.push(owner.pendingAttachments.map(item => ({ name: item.name, uploading: item.uploading }))), notify: message => notices.push(message),
    createPreview: file => `blob:${file.name}`, revokePreview: url => revoked.push(url), upload: async (...args) => { calls.push(args); return upload ? upload(...args) : { attachment: { id: args[0].name, name: args[1] } }; } };
  return { owner, changes, notices, calls, revoked, add: (files, extra = {}) => uploadAttachmentFiles({ ...options, files, ...extra }), remove: item => removeAttachmentDraft(owner, item, url => revoked.push(url)), clear: () => clearAttachmentDraft(owner, url => revoked.push(url)) };
}

test("all four previews appear immediately while uploads serialize across split composers", async () => {
  const first = deferred(); let running = 0, maxRunning = 0, n = 0;
  const upload = async image => { running++; maxRunning = Math.max(maxRunning, running); if (++n === 1) await first.promise; running--; return { attachment: { id: image.name } }; };
  const main = draft({ upload }), split = draft({ upload });
  const a = main.add([file("1.png"), file("2.png"), file("3.png"), file("4.png")]);
  const b = split.add([file("split.png")]);
  assert.equal(main.owner.pendingAttachments.length, 4); assert.equal(main.changes[0].every(item => item.uploading), true);
  assert.equal(split.owner.pendingAttachments.length, 1);
  await tick(); assert.equal(n, 1); first.resolve(); await Promise.all([a, b]);
  assert.equal(maxRunning, 1); assert.equal(n, 5);
  assert.equal(main.owner.pendingAttachments.every(item => item.attachment && !item.uploading), true);
});

test("overlapping paste batches share the four-file cap and reject unsupported/oversized files", async () => {
  const first = deferred(), app = draft({ upload: async image => { await first.promise; return { attachment: { id: image.name } }; } });
  const pending = app.add([file("1.png"), file("2.png"), file("3.png")]);
  await app.add([file("4.png"), file("5.png")]);
  assert.equal(app.owner.pendingAttachments.length, 3); assert.match(app.notices[0], /최대 4개/);
  await app.add([file("svg.svg", "image/svg+xml"), file("large.png", "image/png", 12 * 1024 * 1024 + 1), file("empty.png", "image/png", 0)]);
  assert.equal(app.owner.pendingAttachments.length, 3); assert.equal(app.notices.length, 4);
  first.resolve(); await pending;
  await app.add([file("voice.webm", "audio/webm;codecs=opus")]);
  assert.equal(app.owner.pendingAttachments.at(-1).kind, "audio");
});

test("removing an uploading preview aborts it and prevents late success from restoring it", async () => {
  const reply = deferred(), app = draft({ upload: () => reply.promise });
  const pending = app.add([file()]); await tick();
  const item = app.owner.pendingAttachments[0]; app.remove(item);
  assert.equal(app.calls[0][2].aborted, true); assert.deepEqual(app.revoked, ["blob:screenshot.png"]);
  reply.resolve({ attachment: { id: "late" } }); await pending;
  assert.deepEqual(app.owner.pendingAttachments, []); assert.equal(item.attachment, null);
});

test("room switch, pane removal and account change cannot start queued uploads or accept old results", async () => {
  for (const reason of ["room", "pane", "account", "same-account-new-session"]) {
    let current = true;
    const reply = deferred(), app = draft({ current: () => current, upload: () => reply.promise });
    const pending = app.add([file("active.png"), file("waiting.png")]); await tick();
    if (reason === "same-account-new-session") app.clear(); else { current = false; app.clear(); }
    reply.resolve({ attachment: { id: "late" } }); await pending;
    assert.equal(app.calls.length, 1, reason); assert.equal(app.calls[0][2].aborted, true, reason);
    assert.equal(app.owner.pendingAttachments.length, 0, reason); assert.equal(app.revoked.length, 2, reason);
  }
});

test("upload failure stays visible as an error and does not stop later uploads", async () => {
  const app = draft({ upload: async image => { if (image.name === "bad.png") throw new Error("연결 실패"); return { attachment: { id: "ok" } }; } });
  await app.add([file("bad.png"), file("ok.png")]);
  assert.match(app.owner.pendingAttachments[0].error, /연결 실패/);
  assert.equal(app.owner.pendingAttachments[0].uploading, false);
  assert.equal(app.owner.pendingAttachments[1].attachment.id, "ok");
});

const source = readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
function setupSubmit({ paneMode, busy = true, uploading = false, error = false, fail = false }) {
  const input = { value: "", style: {}, focus() {} }, pane = { roomId: "room-a", model: "m", effort: "high", data: { busy }, attachmentGeneration: 1, pendingAttachments: [{ uploading, error: error ? "failed" : undefined, attachment: uploading || error ? null : { id: "image-1" } }] };
  const state = { selectedRoom: "room-a", session: { user: { id: "u" } }, pendingAttachments: pane.pendingAttachments, attachmentGeneration: 1, selectedBots: ["bot"], roomData: pane.data, extra: [pane] };
  const calls = [], notices = [], bubbles = [];
  const context = { agentPresence: { react() {} }, state, composerRecorder: { status: "idle", context: null }, crypto: { randomUUID: () => "n" }, presenceErrors: new Set(), topicPrompts: new Set(), pendingMessages: new Map(), els: {},
    $: selector => selector === "textarea" || selector === "#message-input" ? input : { value: "m" },
    composerBlocked: () => false, offerTopicChoice: () => false, contextOwnerCurrent: () => true,
    api: async (path, options) => { calls.push({ path, body: JSON.parse(options.body) }); if (fail) throw new Error("retry"); return { queued: busy }; },
    optimisticMessage: async (...args) => { bubbles.push(args); return {}; },
    updateModelAvailability() {}, applyModels() {}, clearThinking() {}, paintPending() {}, toast: text => notices.push(text),
    refreshRoom: async () => {}, refreshExtra: async () => {}, loadRooms: async () => {},
    clearPendingAttachments: owner => { (owner || state).pendingAttachments = []; },
  };
  const start = paneMode ? "async function submitPane(" : "async function submitMessage(";
  const end = paneMode ? "async function refreshExtra(" : "async function authSubmit(";
  const recordingGuard = source.slice(source.indexOf("function recordingBlocksSend("), source.indexOf("function syncRecordingButtons(", source.indexOf("function recordingBlocksSend(")));
  const readOnlyGuards = source.slice(source.indexOf("function roomReadOnly("), source.indexOf("function clearPendingAttachments("));
  vm.runInNewContext(readOnlyGuards + recordingGuard + source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start))) + `\nthis.submit = () => ${paneMode ? "submitPane({preventDefault(){},currentTarget:{}},0,true)" : "submitMessage({preventDefault(){}},true)"};`, context);
  return { ...context, input, pane, calls, notices, bubbles, submit: context.submit };
}

test("image-only main and split submissions keep attachment IDs in the busy queue and optimistic message", async () => {
  for (const paneMode of [false, true]) for (const busy of [false, true]) {
    const app = setupSubmit({ paneMode, busy }); await app.submit();
    assert.equal(app.calls.length, 1); assert.deepEqual(JSON.parse(JSON.stringify(app.calls[0].body.attachmentIds)), ["image-1"]);
    assert.equal(app.calls[0].body.queueIfBusy, true); assert.equal(app.calls[0].body.text, "");
    assert.equal((paneMode ? app.pane : app.state).pendingAttachments.length, 0);
    if (!busy) assert.equal(app.bubbles[0][3][0].id, "image-1");
  }
});

test("main and split uploads cannot be sent before success or lost on failed send", async () => {
  for (const paneMode of [false, true]) {
    for (const condition of [{ uploading: true }, { error: true }]) {
      const app = setupSubmit({ paneMode, ...condition }); await app.submit();
      assert.equal(app.calls.length, 0); assert.equal(app.notices.length, 1);
    }
    const app = setupSubmit({ paneMode, fail: true }); await app.submit();
    assert.equal((paneMode ? app.pane : app.state).pendingAttachments[0].attachment.id, "image-1");
  }
});


test("recording cancellation removes only its batch, aborts its upload and ignores late success", async () => {
  const reply = deferred(), app = draft({ upload: () => reply.promise }), cancel = new AbortController();
  const existing = { name: "keep.png", attachment: { id: "keep" }, previewUrl: "blob:keep.png", controller: new AbortController() };
  app.owner.pendingAttachments.push(existing);
  const generation = app.owner.attachmentGeneration;
  const pending = app.add([file("voice.mp4", "audio/mp4")], { signal: cancel.signal });
  await tick(); const recording = app.owner.pendingAttachments[1];
  cancel.abort();
  assert.equal(app.calls[0][2].aborted, true);
  assert.deepEqual(app.owner.pendingAttachments, [existing]);
  assert.equal(existing.controller.signal.aborted, false);
  assert.equal(app.owner.attachmentGeneration, generation);
  assert.deepEqual(app.revoked, ["blob:voice.mp4"]);
  reply.resolve({ attachment: { id: "late-voice" } }); await pending;
  assert.equal(recording.attachment, null); assert.deepEqual(app.owner.pendingAttachments, [existing]);
  assert.equal(app.notices.length, 0);
});

test("an aborted recording cannot reserve a preview or start an upload queued behind another draft", async () => {
  const before = new AbortController(); before.abort();
  const ready = draft(); await ready.add([file("voice.mp4", "audio/mp4")], { signal: before.signal });
  assert.equal(ready.owner.pendingAttachments.length, 0); assert.equal(ready.calls.length, 0); assert.equal(ready.changes.length, 0);
  const reply = deferred(), app = draft({ upload: () => reply.promise });
  const first = app.add([file("keep.png")]); await tick();
  const cancel = new AbortController(), recording = app.add([file("voice.mp4", "audio/mp4")], { signal: cancel.signal });
  cancel.abort(); reply.resolve({ attachment: { id: "keep" } }); await Promise.all([first, recording]);
  assert.equal(app.calls.length, 1); assert.equal(app.owner.pendingAttachments.length, 1);
  assert.equal(app.owner.pendingAttachments[0].attachment.id, "keep");
  assert.deepEqual(app.revoked, ["blob:voice.mp4"]);
});

test("completed upload removes its cancellation listener so an old signal cannot delete the attachment", async () => {
  const app = draft(), cancel = new AbortController();
  await app.add([file("voice.mp4", "audio/mp4")], { signal: cancel.signal });
  const item = app.owner.pendingAttachments[0]; cancel.abort();
  assert.equal(app.owner.pendingAttachments[0], item); assert.equal(item.controller.signal.aborted, false); assert.deepEqual(app.revoked, []);
});


test("an active recording blocks main and split sends without clearing text or photo drafts", async () => {
  for (const paneMode of [false, true]) for (const status of ["requesting", "recording", "stopping", "uploading"]) {
    const app = setupSubmit({ paneMode }), owner = paneMode ? app.pane : app.state;
    app.input.value = "함께 보낼 설명"; app.pane.draft = app.input.value;
    const attachments = owner.pendingAttachments;
    app.composerRecorder.status = status; app.composerRecorder.context = { pane: paneMode ? app.pane : null };
    await app.submit();
    assert.equal(app.calls.length, 0, `${paneMode ? "split" : "main"}: ${status}`);
    assert.equal(app.bubbles.length, 0); assert.equal(app.input.value, "함께 보낼 설명");
    assert.equal(app.pane.draft, "함께 보낼 설명"); assert.equal(owner.pendingAttachments, attachments);
    assert.equal(owner.pendingAttachments[0].attachment.id, "image-1");
    assert.match(app.notices[0], /녹음을 마치거나 취소/);
  }
});

test("a recording in another composer does not block main or split text and photo sends", async () => {
  for (const paneMode of [false, true]) {
    const app = setupSubmit({ paneMode }); app.input.value = "다른 대화의 요청";
    app.composerRecorder.status = "recording";
    app.composerRecorder.context = { pane: paneMode ? null : { roomId: "another-pane" } };
    await app.submit();
    assert.equal(app.calls.length, 1); assert.equal(app.calls[0].body.text, "다른 대화의 요청");
    assert.deepEqual(Array.from(app.calls[0].body.attachmentIds), ["image-1"]); assert.equal(app.notices.length, 0);
  }
});
