let activeRelay = null;
const userMessage = error => error?.name === 'NotAllowedError'
  ? '마이크 권한이 허용되지 않았습니다. 브라우저 설정에서 허용한 뒤 다시 연결해주세요.'
  : error?.name === 'NotFoundError' ? '이 기기에서 마이크를 찾지 못했습니다.'
    : error?.message || '마이크를 연결하지 못했습니다.';

/** A deliberate, visible, short-lived bridge into the shared PC's virtual mic. */
export function createMicrophoneRelay({api, roomId, onState = () => {}, environment = globalThis}) {
  let current = null, destroyed = false;
  const controller = {start, stop, destroy() {destroyed = true; stop();}};
  function stop(message = '') {
    const resources = current;
    current = null;
    if (activeRelay === controller) activeRelay = null;
    if (resources) {
      resources.abort.abort();
      clearTimeout(resources.timer);
      resources.cancelReady?.();
      resources.node?.disconnect();
      resources.node?.port.close();
      resources.source?.disconnect();
      for (const track of resources.stream?.getTracks() || []) track.stop();
      if (resources.socket) {resources.socket.onmessage = resources.socket.onclose = resources.socket.onerror = null; resources.socket.close();}
      void resources.context?.close().catch(() => {});
    }
    if (!destroyed) onState({state:'off', message});
  }
  async function start() {
    if (destroyed || current) return;
    if (activeRelay && activeRelay !== controller) {onState({state:'off',message:'다른 작업 공간의 마이크 연결을 먼저 끊어주세요.'}); return;}
    const AudioContext = environment.AudioContext || environment.webkitAudioContext;
    if (!AudioContext || !environment.AudioWorkletNode || !environment.navigator?.mediaDevices?.getUserMedia) {
      onState({state:'off',message:'이 브라우저에서는 마이크 연결을 지원하지 않습니다.'}); return;
    }
    const resources = {abort:new AbortController()};
    current = resources; activeRelay = controller;
    const live = () => !destroyed && current === resources && !resources.abort.signal.aborted;
    onState({state:'connecting',message:'마이크 연결 중…'});
    try {
      // Create/resume within the click gesture for Safari. Permissions are never requested on load.
      resources.context = new AudioContext({sampleRate:48000});
      const resumed = resources.context.resume();
      resumed.catch(() => {});
      const media = environment.navigator.mediaDevices.getUserMedia({video:false,audio:{channelCount:1,echoCancellation:true,noiseSuppression:true}}).then(stream => {
        if (!live()) {for (const track of stream.getTracks()) track.stop(); return null;}
        resources.stream = stream; return stream;
      });
      const [ticket, stream] = await Promise.all([
        api(`/api/rooms/${encodeURIComponent(roomId)}/workspace/media/microphone/ticket`, {method:'POST',body:'{}',signal:resources.abort.signal}), media,
      ]);
      if (!live() || !stream) return;
      const endpoint = new URL(ticket.websocketPath, environment.location.href);
      if (endpoint.origin !== environment.location.origin || endpoint.pathname !== `/api/rooms/${roomId}/workspace/media/microphone/ws`) throw new Error('마이크 연결 주소를 확인할 수 없습니다.');
      endpoint.protocol = environment.location.protocol === 'https:' ? 'wss:' : 'ws:';
      resources.socket = new environment.WebSocket(endpoint.href);
      await new Promise((resolve, reject) => {
        resources.cancelReady = () => reject(new DOMException('Stopped', 'AbortError'));
        resources.timer = setTimeout(() => reject(new Error('PC 마이크 연결 시간이 초과됐습니다.')), 8000);
        resources.socket.onmessage = event => {
          let value; try {value = JSON.parse(event.data);} catch {return reject(new Error('마이크 연결 응답을 확인할 수 없습니다.'));}
          if (value.type !== 'ready' || value.format !== 's16le' || value.sampleRate !== 48000 || value.channels !== 1) return reject(new Error('지원하지 않는 마이크 형식입니다.'));
          clearTimeout(resources.timer); resources.cancelReady = null; resolve();
        };
        resources.socket.onerror = () => reject(new Error('PC 마이크에 연결하지 못했습니다.'));
        resources.socket.onclose = () => reject(new Error('PC 마이크 연결이 종료됐습니다.'));
      });
      if (!live()) return;
      resources.socket.onmessage = null;
      resources.socket.onclose = resources.socket.onerror = () => {if (live()) stop('마이크 연결이 종료됐습니다. 다시 연결해주세요.');};
      await resources.context.audioWorklet.addModule('/desktop-microphone-worklet.js');
      await resumed;
      if (!live()) return;
      if (resources.context.state !== 'running') throw new Error('마이크 오디오를 시작하지 못했습니다. 다시 연결해주세요.');
      if (stream.getTracks().every(track => track.readyState === 'ended')) throw new Error('기기의 마이크 연결이 끊겼습니다.');
      resources.source = resources.context.createMediaStreamSource(stream);
      resources.node = new environment.AudioWorkletNode(resources.context, 'desktop-microphone', {channelCount:1,channelCountMode:'explicit',numberOfInputs:1,numberOfOutputs:1,outputChannelCount:[1]});
      resources.node.port.onmessage = ({data}) => {
        if (!live()) return;
        if (resources.socket.readyState !== 1 || resources.socket.bufferedAmount > 128 * 1024) return stop('연결이 느려 마이크 전송을 중단했습니다.');
        if (!(data instanceof ArrayBuffer) || data.byteLength === 0 || data.byteLength > 8192 || data.byteLength % 2) return stop('마이크 오디오 형식을 확인할 수 없습니다.');
        resources.socket.send(data);
      };
      resources.node.onprocessorerror = () => {if (live()) stop('마이크 오디오 처리가 중단됐습니다.');};
      for (const track of stream.getTracks()) track.addEventListener('ended', () => {if (live()) stop('기기의 마이크 연결이 끊겼습니다.');}, {once:true});
      resources.context.onstatechange = () => {if (live() && resources.context.state !== 'running') stop('마이크 오디오가 일시 중지되어 연결을 끊었습니다.');};
      resources.source.connect(resources.node); resources.node.connect(resources.context.destination);
      onState({state:'connected',message:'내 마이크 → 공유 PC · PC 안의 앱에서 사용할 수 있습니다.'});
    } catch (error) {if (live()) stop(userMessage(error));}
  }
  return controller;
}

export function createDesktopMediaControls({mount,api,roomId,signal}) {
  const document = mount.ownerDocument;
  const group = document.createElement('div'); group.className = 'workspace-media-controls'; group.hidden = true;
  const microphone = document.createElement('button'); microphone.type = 'button'; microphone.className = 'workspace-button'; microphone.textContent = '마이크 연결'; microphone.disabled = true;
  const camera = document.createElement('span'); camera.className = 'workspace-camera-unavailable'; camera.textContent = '카메라 준비 필요'; camera.title = 'PC 가상 카메라 드라이버와 영상 연결을 준비한 뒤 사용할 수 있습니다.';
  const status = document.createElement('span'); status.className = 'workspace-media-status'; status.setAttribute('role','status');
  group.append(microphone,camera,status); mount.append(group);
  let state = 'off', available = false, destroyed = false;
  const relay = createMicrophoneRelay({api,roomId,onState:update => {
    state = update.state; group.dataset.state = state; status.textContent = update.message;
    microphone.textContent = state === 'off' ? '마이크 연결' : '마이크 끊기';
    microphone.setAttribute('aria-pressed', String(state !== 'off'));
    microphone.disabled = state === 'off' && !available;
  }});
  microphone.title = '내 기기의 마이크를 공유 PC에 연결';
  microphone.onclick = () => state === 'off' ? void relay.start() : relay.stop();
  const visibility = () => {if (document.hidden) relay.stop();};
  const pagehide = () => relay.stop();
  document.addEventListener('visibilitychange',visibility); globalThis.addEventListener?.('pagehide',pagehide);
  const destroy = () => {if (destroyed) return; destroyed = true; relay.destroy(); group.remove(); document.removeEventListener('visibilitychange',visibility); globalThis.removeEventListener?.('pagehide',pagehide); signal?.removeEventListener('abort',destroy);};
  signal?.addEventListener('abort',destroy,{once:true});
  if (signal?.aborted) destroy();
  else void api(`/api/rooms/${encodeURIComponent(roomId)}/workspace/media`,{signal}).then(result => {
    if (destroyed) return;
    group.hidden = false; available = result.microphone?.available === true;
    microphone.disabled = !available;
    if (!available) status.textContent = 'PC 마이크 실행 환경을 준비해야 합니다.';
    else if (result.microphone.connected) status.textContent = '다른 마이크가 연결되어 있습니다.';
  }).catch(error => {
    if (destroyed || error?.name === 'AbortError' || [401,403,404,409].includes(error.status)) return;
    group.hidden = false; status.textContent = 'PC 마이크에 연결할 수 없습니다. 다시 연결해주세요.';
  });
  return {destroy};
}
