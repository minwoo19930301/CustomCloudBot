const $ = selector => document.querySelector(selector);
let lastState;
let dirty = false;
const fields = ['#service-url', '#computer-name', '#cap-files', '#cap-terminal', '#cap-browser'];
function form() {
  return { origin: $('#service-url').value, name: $('#computer-name').value,
    capabilities: { files: $('#cap-files').checked, terminal: $('#cap-terminal').checked, browser: $('#cap-browser').checked } };
}
function render(state) {
  lastState = state;
  if (!dirty) {
    $('#service-url').value = state.origin;
    $('#computer-name').value = state.name;
    for (const capability of ['files', 'terminal', 'browser']) $(`#cap-${capability}`).checked = state.capabilities[capability];
  }
  $('#folder-panel').hidden = !$('#cap-files').checked;
  $('#folders').replaceChildren(...state.roots.map(folder => { const li = document.createElement('li'); li.textContent = folder; return li; }));
  $('#message').textContent = state.message;
  $('#setup').hidden = !state.settingsVisible;
  $('#show-settings').hidden = state.settingsVisible;
  $('#show-app').hidden = !state.settingsVisible || !state.origin;
  $('#pause').hidden = !state.enabled;
  $('#toolbar-pause').hidden = !state.enabled;
  $('#revoke').hidden = !state.paired;
  $('#connect').textContent = state.busy ? '연결 확인 중…' : state.enabled ? '이 컴퓨터 연결됨' : '연결 허용 ↗';
  $('#connect').disabled = state.busy || state.enabled;
  $('#login').disabled = state.enabled || state.busy;
  $('#choose-folders').disabled = state.enabled || state.busy;
  for (const selector of fields) $(selector).disabled = state.enabled || state.busy;
  $('#connection-label').textContent = `${state.job ? '작업 중' : state.enabled ? '연결됨' : state.paired ? '일시정지' : '연결 준비'}${state.ownerLabel ? ' · ' + state.ownerLabel : ''}`;
  $('#status-dot').className = `status-dot${state.job ? ' working' : state.enabled ? ' connected' : ''}`;
  $('#external-link').hidden = !state.externalHost;
  $('#external-link').textContent = state.externalHost ? `${state.externalHost} 열기 ↗` : '외부 링크 열기';
  $('#os-permissions').hidden = state.permissions.platform !== 'darwin';
}
async function invoke(method, ...args) {
  try { const response = await window.desktop[method](...args); if (response.state) render(response.state); }
  catch { $('#message').textContent = '요청을 처리하지 못했습니다. 다시 시도해 주세요.'; }
}
for (const selector of fields) $(selector).addEventListener('input', () => { dirty = true; $('#folder-panel').hidden = !$('#cap-files').checked; });
$('#login').addEventListener('click', () => { const value = form(); dirty = false; void invoke('configure', value); });
$('#connect').addEventListener('click', () => { const value = form(); dirty = false; void invoke('connect', value); });
$('#choose-folders').addEventListener('click', () => void invoke('chooseFolders'));
$('#pause').addEventListener('click', () => void invoke('pause'));
$('#toolbar-pause').addEventListener('click', () => void invoke('pause'));
$('#revoke').addEventListener('click', () => void invoke('revoke'));
$('#show-app').addEventListener('click', () => void invoke('showApp'));
$('#show-settings').addEventListener('click', () => void invoke('showSettings'));
$('#external-link').addEventListener('click', () => void invoke('openPendingLink'));
document.querySelectorAll('[data-permission]').forEach(button => button.addEventListener('click', () => void invoke('openPermissionSettings', button.dataset.permission)));
document.addEventListener('keydown', event => { if (event.key === 'Escape' && lastState?.enabled) void invoke('pause'); });
window.desktop.onState(render);
void invoke('status');
