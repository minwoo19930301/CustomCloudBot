import {callReply, speechText, callLink, createSpeechGate} from "/voice-session.mjs";

export function createVoiceCall({api, getSession, getRoom, getSelection, onMessages, toast, beforeStart = () => {}}) {
  const dialog = document.createElement("dialog");
  dialog.className = "voice-call-dialog";
  dialog.setAttribute("aria-labelledby", "voice-call-title");
  dialog.innerHTML = `<div class="voice-call-top">
      <button type="button" class="icon-button voice-minimize" aria-label="통화 창 접기" title="접어두고 대화 보기"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6"/></svg></button>
      <span>음성 통화</span>
      <button type="button" class="icon-button voice-call-link" aria-label="이 대화 통화 링크 복사" title="통화 링크 복사"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 13 4-4m-5 6-1 1a4 4 0 0 1-6-6l4-4a4 4 0 0 1 6 0m0 12a4 4 0 0 0 6 0l4-4a4 4 0 0 0-6-6l-1 1"/></svg></button>
    </div>
    <div class="voice-call-identity"><div class="voice-orb"><img src="/media/agent/idle-poster.webp" alt="" width="128" height="128" draggable="false"></div>
      <h2 id="voice-call-title"></h2><div class="voice-call-time" aria-label="통화 시간"></div></div>
    <div class="voice-call-activity"><div class="voice-wave" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
      <div class="voice-call-status" role="status" aria-live="polite"></div></div>
    <p class="voice-call-transcript"></p>
    <button type="button" class="voice-send" hidden>말 끝내기</button>
    <div class="voice-call-controls">
      <button type="button" class="voice-start" hidden>다시 통화</button>
      <button type="button" class="voice-mute" aria-label="마이크 끄기" aria-pressed="false" hidden><span class="voice-control-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/><path class="voice-mic-slash" d="m3 3 18 18"/></svg></span><span class="voice-control-label">음소거</span></button>
      <button type="button" class="voice-end" aria-label="통화 종료" hidden><span class="voice-control-icon"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 14v3a1 1 0 0 0 1 1l4-1v-4a15 15 0 0 1 8 0v4l4 1a1 1 0 0 0 1-1v-3c0-5-18-5-18 0Z"/></svg></span><span class="voice-control-label">종료</span></button>
    </div>
    <p class="voice-call-note"></p>`;
  const pill = document.createElement("button");
  pill.type = "button"; pill.className = "voice-call-pill"; pill.hidden = true;
  document.body.append(dialog, pill);
  const find = selector => dialog.querySelector(selector);
  const title = find("h2"), status = find(".voice-call-status"), transcript = find(".voice-call-transcript");
  const startButton = find(".voice-start"), muteButton = find(".voice-mute"), sendButton = find(".voice-send"), endButton = find(".voice-end");
  let target = null, active = null, nativeWait = null;
  const nativeBridge = () => window.webkit?.messageHandlers?.cloudbotCall;
  const nativeAudio = () => !!nativeBridge() && window.cloudbotNativeVoice?.version >= 2;
  function native(action, extra = {}) {
    if (active?.native) nativeBridge()?.postMessage({action, roomId:active.roomId, roomTitle:active.title, ...extra});
  }
  const current = call => {
    if (active !== call || call.controller.signal.aborted) return false;
    if (getRoom(call.roomId)?.readOnly) { end("가지치기한 원본입니다. 새 가지에서 통화해 주세요."); return false; }
    if (getSession()?.user?.id !== call.userId) { end("로그인이 바뀌어 통화를 종료했어요."); return false; }
    return true;
  };
  const requestSignal = (call, milliseconds = 20000) => AbortSignal.any([call.controller.signal, AbortSignal.timeout(milliseconds)]);
  function renderStage(stage, label) {
    dialog.dataset.stage = stage; status.textContent = label;
    sendButton.disabled = stage !== "listening";
    sendButton.hidden = stage !== "listening";
    if (stage !== "listening") dialog.style.setProperty("--voice-level", "0");
    renderMute();
    pill.textContent = `${active?.title || target?.name || "대화"} · ${label}`;
  }
  function renderMute() {
    const muted = !!active?.muted;
    dialog.dataset.muted = String(muted);
    muteButton.querySelector(".voice-control-label").textContent = muted ? "음소거 해제" : "음소거";
    muteButton.setAttribute("aria-label", muted ? "마이크 켜기" : "마이크 끄기");
    muteButton.setAttribute("aria-pressed", String(muted));
  }
  function show() { if (!dialog.open) dialog.showModal(); pill.hidden = true; }
  function minimize() { dialog.close(); pill.hidden = !active; }
  function updateNote() {
    find(".voice-call-note").textContent = nativeAudio()
      ? "이 대화의 맥락을 이어갑니다 · 화면을 꺼도 통화가 유지돼요"
      : "이 대화의 맥락을 이어갑니다 · 통화 중에는 앱을 열어두세요";
  }
  function showControls() {
    startButton.hidden = true; muteButton.hidden = sendButton.hidden = endButton.hidden = false;
    document.querySelectorAll(".voice-call-button").forEach(button => button.classList.add("is-active"));
  }
  function startClock(call) {
    clearInterval(call.clock);
    const update = () => {
      if (!current(call) || !call.startedAt) return;
      const seconds = Math.max(0, Math.floor((Date.now() - call.startedAt) / 1000));
      find(".voice-call-time").textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2,"0")}`;
    };
    update(); call.clock = setInterval(update, 1000);
  }
  function refreshTitle(call, name) {
    if (!name || !current(call) || call.title === name) return;
    call.title = name; title.textContent = name; native("title");
  }
  function releaseCapture(call) {
    call.captureVersion = (call.captureVersion || 0) + 1;
    call.finishUtterance = null;
    clearInterval(call.vadTimer); call.vadTimer = null;
    const recorder = call.recorder; call.recorder = null;
    if (recorder) { recorder.ondataavailable = null; recorder.onerror = null; }
    if (recorder?.state === "recording") { recorder.onstop = null; try { recorder.stop(); } catch {} }
    call.source?.disconnect(); call.source = null;
    call.stream?.getTracks().forEach(track => track.stop()); call.stream = null;
  }
  function end(message = "통화가 끝났어요.", notifyNative = true) {
    const call = active;
    if (call) {
      if (notifyNative) native("end");
      active = null;
      call.controller.abort(); releaseCapture(call); clearInterval(call.clock);
      call.context?.close().catch(() => {});
      if (!call.nativeAudio) window.speechSynthesis?.cancel();
      nativeWait?.reject(new Error("통화가 종료됐어요.")); nativeWait = null;
    }
    startButton.hidden = false; startButton.disabled = false; startButton.textContent = "다시 통화";
    muteButton.hidden = sendButton.hidden = endButton.hidden = true; pill.hidden = true;
    document.querySelectorAll(".voice-call-button").forEach(button => button.classList.remove("is-active"));
    renderStage("ended", message);
  }
  function fail(call, error) {
    if (!current(call)) return;
    const message = error?.name === "NotAllowedError" ? "마이크 권한을 허용한 뒤 다시 시작해 주세요." : (error.message || "통화 연결을 확인해 주세요.");
    native("failed", {message}); end(message, false); show();
  }
  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); };
      const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
      if (signal.aborted) abort(); else signal.addEventListener("abort", abort, {once:true});
    });
  }
  async function awaitReply(call, messageId) {
    const deadline = Date.now() + 180000;
    while (current(call) && Date.now() < deadline) {
      const data = await api(`/api/rooms/${call.roomId}`, {signal:requestSignal(call)});
      if (!current(call)) return;
      refreshTitle(call, data.room?.name);
      const reply = callReply(data, messageId);
      if (reply.state === "reply") { onMessages(call.roomId); return reply.text; }
      if (reply.state === "error") throw new Error(reply.text);
      if (reply.state === "interrupted") throw new Error("다른 메시지가 이어졌어요. 답변은 이 대화에서 확인해 주세요.");
      if (reply.state === "empty") throw new Error("음성 답변을 받지 못했어요. 대화에서 결과를 확인해 주세요.");
      await delay(1400, call.controller.signal);
    }
    if (current(call)) throw new Error("답변이 오래 걸리고 있어요. 작업 결과는 이 대화에 남습니다.");
  }
  async function speak(call, text) {
    if (!current(call)) return;
    renderStage("speaking", "답변을 들려드리고 있어요"); transcript.textContent = text;
    const content = speechText(text);
    if (!content) return;
    await new Promise((resolve, reject) => {
      const utterance = new SpeechSynthesisUtterance(content);
      utterance.lang = "ko-KR";
      const voice = speechSynthesis.getVoices().find(item => item.lang.startsWith("ko"));
      if (voice) utterance.voice = voice;
      let finished = false;
      const finish = error => { if (finished) return; finished = true; clearTimeout(timeout); call.controller.signal.removeEventListener("abort", abort); if (error) reject(error); else resolve(); };
      const abort = () => { speechSynthesis.cancel(); finish(); };
      utterance.onend = () => finish();
      utterance.onerror = () => finish(new Error("소리를 재생하지 못했어요. 답변은 대화에 저장됐습니다."));
      const timeout = setTimeout(() => { speechSynthesis.cancel(); finish(new Error("음성 재생이 멈췄어요. 답변은 대화에서 확인해 주세요.")); }, 180000);
      call.controller.signal.addEventListener("abort", abort, {once:true});
      speechSynthesis.speak(utterance);
    });
  }
  async function processAudio(call, blob, mime) {
    if (!current(call)) return;
    renderStage("transcribing", "말씀을 확인하고 있어요");
    const form = new FormData();
    const extension = mime.includes("mp4") ? "mp4" : mime.includes("ogg") ? "ogg" : "webm";
    form.append("file", blob, `call.${extension}`);
    try {
      const result = await api(`/api/rooms/${call.roomId}/voice/transcribe`, {method:"POST", body:form, signal:requestSignal(call, 55000)});
      if (!current(call)) return;
      const text = result.text?.trim();
      if (!text) { renderStage("listening", "잘 안 들렸어요. 다시 말씀해 주세요"); return await listen(call); }
      transcript.textContent = text;
      renderStage("waiting", "대화에 보내고 답변을 기다려요");
      // One nonce per utterance. A transport retry reuses it; never replay a command as a new turn.
      const body = JSON.stringify({text, clientNonce:`call:${call.id}:${++call.turn}`, botIds:call.botIds, model:call.model, effort:call.effort});
      let accepted;
      try { accepted = await api(`/api/rooms/${call.roomId}/messages`, {method:"POST", body, signal:requestSignal(call, 30000)}); }
      catch (error) {
        // Recheck the actor before retrying; a switched account must never inherit this command.
        if (!current(call) || error.status || error.name === "AbortError" || error.name === "TimeoutError") throw error;
        accepted = await api(`/api/rooms/${call.roomId}/messages`, {method:"POST", body, signal:requestSignal(call, 30000)});
      }
      if (!current(call)) return;
      if (!accepted.messageId) throw new Error("메시지 접수 결과를 확인하지 못했어요. 대화를 확인해 주세요.");
      onMessages(call.roomId);
      const answer = await awaitReply(call, accepted.messageId);
      if (!current(call)) return;
      await speak(call, answer);
      if (current(call)) await listen(call);
    } catch (error) { fail(call, error); }
  }
  async function listen(call) {
    if (!current(call) || !call.ready) return;
    releaseCapture(call);
    const captureVersion = call.captureVersion;
    const canCapture = () => current(call) && call.captureVersion === captureVersion && !call.muted;
    if (call.muted) { renderStage("muted", "마이크가 꺼져 있어요"); return; }
    renderStage("connecting", "마이크 연결 중");
    let stream;
    try { stream = await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true, noiseSuppression:true, autoGainControl:true}, video:false}); }
    catch (error) { if (canCapture()) throw error; return; }
    if (!canCapture()) { stream.getTracks().forEach(track => track.stop()); return; }
    call.stream = stream;
    try { await call.context.resume(); }
    catch (error) { if (canCapture()) throw error; stream.getTracks().forEach(track => track.stop()); return; }
    if (!canCapture()) { stream.getTracks().forEach(track => track.stop()); return; }
    const source = call.context.createMediaStreamSource(stream), analyser = call.context.createAnalyser();
    analyser.fftSize = 2048; source.connect(analyser); call.source = source;
    const mime = ["audio/webm;codecs=opus", "audio/mp4", "audio/ogg;codecs=opus", "audio/webm"].find(type => MediaRecorder.isTypeSupported(type));
    const recorder = new MediaRecorder(stream, mime ? {mimeType:mime} : undefined);
    const chunks = [], values = new Float32Array(analyser.fftSize), gate = createSpeechGate({maxMs:call.maxSeconds * 1000});
    let bytes = 0, submit = false;
    call.recorder = recorder;
    recorder.ondataavailable = event => { if (current(call) && call.recorder === recorder && event.data.size) { chunks.push(event.data); bytes += event.data.size; if (bytes > call.maxBytes) fail(call, new Error("한 번에 담을 수 있는 음성을 넘었어요. 짧게 나누어 말씀해 주세요.")); } };
    recorder.onerror = () => { if (current(call) && call.recorder === recorder) fail(call, new Error("마이크 연결이 끊겼어요. 다시 시작해 주세요.")); };
    recorder.onstop = () => {
      if (!current(call) || call.recorder !== recorder) return;
      call.recorder = null; releaseCapture(call);
      if (submit && chunks.length && bytes <= call.maxBytes) void processAudio(call, new Blob(chunks, {type:recorder.mimeType}), recorder.mimeType);
      else void listen(call).catch(error => fail(call, error));
    };
    call.finishUtterance = () => { if (!current(call) || recorder.state !== "recording") return; submit = gate.voiced; recorder.stop(); clearInterval(call.vadTimer); };
    recorder.start(400);
    call.vadTimer = setInterval(() => {
      if (!current(call)) return;
      analyser.getFloatTimeDomainData(values);
      const rms = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);
      dialog.style.setProperty("--voice-level", String(Math.min(1, rms * 8)));
      const decision = gate.sample(rms, performance.now());
      if (decision === "send" || decision === "discard") call.finishUtterance();
    }, 60);
    renderStage("listening", "듣고 있어요");
  }
  async function start() {
    if (active || !target || !getSession()?.user) return;
    if (getRoom(target.id)?.readOnly) { startButton.hidden = true; renderStage("ended", "가지치기한 원본입니다. 새 가지에서 통화해 주세요."); return; }
    const usesNativeAudio = nativeAudio();
    if (!usesNativeAudio && (!window.MediaRecorder || !navigator.mediaDevices?.getUserMedia || !(window.AudioContext || window.webkitAudioContext) || !window.speechSynthesis)) {
      startButton.hidden = false;
      renderStage("error", "이 브라우저에서는 통화를 지원하지 않아요. 최신 Safari 또는 Chrome을 사용해 주세요."); return;
    }
    const selection = getSelection(target.id);
    if (!usesNativeAudio && !selection.botIds?.length) { startButton.hidden = false; renderStage("error", "응답할 봇 연결을 먼저 확인해 주세요."); return; }
    beforeStart();
    const call = {id:crypto.randomUUID(), roomId:target.id, title:target.name, userId:getSession().user.id, controller:new AbortController(), turn:0, muted:false, ready:false, native:!!nativeBridge(), nativeAudio:usesNativeAudio, ...selection};
    active = call;
    updateNote(); showControls();
    renderStage("connecting", "통화를 연결하고 있어요");
    if (call.nativeAudio) {
      // CallKit owns capture, networking and speech. This page only displays its state.
      // A suspended/reloaded WebView cannot interrupt or duplicate an utterance.
      native("start", {model:call.model, effort:call.effort});
      return;
    }
    if (!call.native) {
      call.context = new (window.AudioContext || window.webkitAudioContext)();
      // Unlock browser output during Start; native audio waits for CallKit activation.
      void call.context.resume().catch(() => {});
      const unlock = new SpeechSynthesisUtterance(" "); speechSynthesis.speak(unlock);
    }
    try {
      const [capability, data] = await Promise.all([api("/api/voice", {signal:requestSignal(call)}), api(`/api/rooms/${call.roomId}`, {signal:requestSignal(call)})]);
      if (!current(call)) return;
      if (!capability.configured) throw new Error("음성 인식 연결이 필요해요. 내 봇 설정에서 Groq 키를 확인해 주세요.");
      if (data.room?.readOnly) throw new Error("가지치기한 원본입니다. 새 가지에서 통화해 주세요.");
      if (data.busy) throw new Error("이 대화의 작업이 끝나면 통화를 시작해 주세요.");
      call.maxSeconds = Math.min(30, Number(capability.maxSeconds) || 30); call.maxBytes = Math.min(10 * 1024 * 1024, Number(capability.maxBytes) || 10 * 1024 * 1024);
      refreshTitle(call, data.room?.name);
      if (call.native) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { nativeWait = null; reject(new Error("아이폰 통화 연결 시간이 초과됐어요.")); }, 15000);
          nativeWait = {roomId:call.roomId, resolve:() => { clearTimeout(timer); resolve(); }, reject:error => { clearTimeout(timer); reject(error); }};
          native("start");
        });
      }
      if (!current(call)) return;
      call.context ??= new (window.AudioContext || window.webkitAudioContext)();
      call.ready = true;
      await listen(call);
      if (!current(call)) return;
      native("connected");
      call.startedAt = Date.now();
      startClock(call);
    } catch (error) { fail(call, error); }
  }
  function open(room, {startImmediately = true} = {}) {
    updateNote();
    if (active) { show(); if (room?.id !== active.roomId) toast(`현재 통화는 ‘${active.title}’에 연결되어 있어요.`); return; }
    if (!getSession()?.user) { toast("로그인한 뒤 통화를 시작해 주세요."); return; }
    if (!room || room.archived || room.id === "00000000-0000-4000-8000-000000000001") { toast("전화할 대화를 먼저 선택해 주세요."); return; }
    if (room.readOnly || getRoom(room.id)?.readOnly) { toast("가지치기한 원본입니다. 새 가지에서 통화해 주세요."); return; }
    target = {id:room.id, name:room.name}; title.textContent = room.name; transcript.textContent = ""; find(".voice-call-time").textContent = "";
    startButton.hidden = startImmediately; startButton.textContent = "통화 연결";
    renderStage("ready", startImmediately ? "통화를 연결하고 있어요" : "눌러서 이 대화에 연결하세요"); show();
    if (startImmediately) void start();
  }
  startButton.onclick = () => void start();
  endButton.onclick = () => { end(); dialog.close(); };
  sendButton.onclick = () => { if (active?.nativeAudio) native("finish"); else active?.finishUtterance?.(); };
  function setMuted(muted) {
    if (!active) return;
    if (active.nativeAudio) { native("mute", {muted}); return; }
    active.muted = muted;
    if (active.ready && active.muted && ["listening", "connecting"].includes(dialog.dataset.stage)) { releaseCapture(active); renderStage("muted", "마이크가 꺼져 있어요"); }
    else if (active.ready && !active.muted && dialog.dataset.stage === "muted") { const call = active; void listen(call).catch(error => fail(call,error)); }
    renderMute();
  }
  muteButton.onclick = () => { if (active) setMuted(!active.muted); };
  find(".voice-minimize").onclick = minimize; pill.onclick = show;
  dialog.addEventListener("cancel", event => { event.preventDefault(); minimize(); });
  find(".voice-call-link").onclick = async () => { try { await navigator.clipboard.writeText(callLink(location.origin, active?.roomId || target.id)); toast("통화 링크를 복사했어요. 대화 참여자만 연결할 수 있어요."); } catch { toast("링크를 복사하지 못했어요."); } };
  window.addEventListener("pagehide", () => { if (!active?.nativeAudio) end(); });
  document.addEventListener("visibilitychange", () => {
    if (nativeAudio()) { if (!document.hidden) nativeBridge().postMessage({action:"status"}); return; }
    // Browsers suspend timers/audio in the background: never keep a hidden microphone active.
    if (document.hidden && active) { end("앱이 화면에서 벗어나 통화를 종료했어요. 다시 시작해 주세요."); }
  });
  window.addEventListener("cloudbot:native-call", event => {
    const detail = event.detail;
    if (nativeAudio() && detail?.action === "state") {
      if (!getSession()?.user) return;
      if (detail.userId && detail.userId !== getSession().user.id) return;
      if (getRoom(detail.roomId)?.readOnly) {
        nativeBridge()?.postMessage({action:"end", roomId:detail.roomId});
        if (active?.roomId === detail.roomId) end("가지치기한 원본입니다. 새 가지에서 통화해 주세요.", false);
        return;
      }
      if (!detail.roomId) { if (active?.nativeAudio) end("통화가 끝났어요.", false); return; }
      if (active && (active.roomId !== detail.roomId || !current(active))) return;
      if (!active) {
        // Reattach display after a page reload only to a server-validated call by this actor.
        if (["ended", "error"].includes(detail.state) || detail.userId !== getSession().user.id) return;
        active = {roomId:detail.roomId, title:detail.title || "대화", userId:detail.userId,
          controller:new AbortController(), native:true, nativeAudio:true, muted:false};
        target = {id:active.roomId, name:active.title};
        updateNote(); showControls();
        pill.hidden = dialog.open;
      }
      const call = active;
      if (detail.title) { call.title = detail.title; title.textContent = detail.title; }
      if (["ended", "error"].includes(detail.state)) {
        onMessages(call.roomId); end(detail.text || "통화가 끝났어요.", false); return;
      }
      call.muted = !!detail.muted;
      if (detail.text != null) transcript.textContent = detail.text;
      const labels = {connecting:"통화를 연결하고 있어요", listening:"듣고 있어요", muted:"마이크가 꺼져 있어요",
        transcribing:"말씀을 확인하고 있어요", waiting:"대화에 보내고 답변을 기다려요", speaking:"답변을 들려드리고 있어요", paused:"통화를 잠시 기다리고 있어요"};
      const previous = dialog.dataset.stage;
      renderStage(detail.state, labels[detail.state] || "통화 중");
      if (detail.startedAt && call.startedAt !== detail.startedAt) { call.startedAt = detail.startedAt; startClock(call); }
      if (previous !== detail.state && ["speaking", "listening"].includes(detail.state)) onMessages(call.roomId);
      return;
    }
    if (!active?.native || detail?.roomId !== active.roomId) return;
    if (detail.action === "active") { nativeWait?.resolve(); nativeWait = null; }
    if (detail.action === "muted" || detail.action === "unmuted") setMuted(detail.action === "muted");
    if (detail.action === "ended" || detail.action === "error") { nativeWait?.reject(new Error(detail.message || "통화가 종료됐어요.")); nativeWait = null; end(detail.message || "통화가 끝났어요.", false); }
  });
  return {open, syncSession:() => { if (nativeAudio() && getSession()?.user) nativeBridge().postMessage({action:"session"}); },
    reset:() => { if (nativeAudio()) nativeBridge().postMessage({action:"logout"}); end(); dialog.close(); target = null; transcript.textContent = ""; },
    get roomId() { return active?.roomId || null; }, handleLink() {
    if (active && !current(active)) return;
    if (nativeAudio() && getSession()?.user) nativeBridge().postMessage({action:"status"});
    const url = new URL(location.href);
    if (url.searchParams.get("call") !== "1" || !getSession()?.user) return;
    const room = getRoom(url.searchParams.get("room"));
    url.searchParams.delete("call"); history.replaceState(null,"",url);
    // Opening an external link has no audio user gesture. Joining here grants it;
    // the in-app phone button calls open() directly and needs no extra click.
    if (room) open(room, {startImmediately:false}); else toast("이 통화 대화에 참여한 계정으로 로그인해 주세요.");
  }};
}
