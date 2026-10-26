import { pathToFileURL } from 'node:url';

export function normalizeAppUrl(input) {
  const url = new URL(String(input || '').trim());
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('HTTPS 서비스 주소를 입력해 주세요.');
  if (url.pathname !== '/' || url.search) throw new Error('경로를 제외한 서비스 주소를 입력해 주세요.');
  return url.origin;
}

export function isTrustedSender(event, contents, localPath) {
  return event.sender === contents && event.senderFrame === contents.mainFrame
    && event.senderFrame?.url === pathToFileURL(localPath).href;
}

export function isSameOriginUrl(value, origin) {
  try { return new URL(value).protocol === 'https:' && new URL(value).origin === origin; } catch { return false; }
}

export function externalHttpsUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function validJob(value) {
  return Boolean(value && /^[a-f0-9-]{36}$/.test(value.id) && typeof value.tool === 'string'
    && /^computer_[a-z_]+$/.test(value.tool) && Number.isFinite(value.expiresAt)
    && (!value.args || (typeof value.args === 'object' && !Array.isArray(value.args))));
}

export function isStaleResultError(error) {
  return error?.status === 404 || error?.status === 409 || ['HTTP_404', 'HTTP_409'].includes(error?.code);
}

export function capabilityList(policy) {
  return [['files', 'fs'], ['terminal', 'terminal'], ['browser', 'browser']]
    .filter(([name]) => policy[name] === true).map(([, wireName]) => wireName);
}

export function consentDetails({ name, origin, capabilities, roots }) {
  const lines = [`연결할 서비스: ${origin}`, `컴퓨터 이름: ${name}`, '', '허용할 권한:'];
  if (capabilities.files) lines.push(`• 파일: 선택한 폴더 안의 목록·읽기·쓰기\n${roots.map(root => `  ${root}`).join('\n')}`);
  if (capabilities.terminal) lines.push('• 터미널: 현재 로그인한 컴퓨터 계정으로 명령 실행. 선택 폴더 밖의 파일·프로그램에도 접근할 수 있습니다. sudo 권한을 자동으로 부여하지 않습니다.');
  if (capabilities.browser) lines.push('• 브라우저: 기본 브라우저에서 HTTPS 주소 열기');
  lines.push('', '이 서비스의 내 계정에서 요청한 작업을 이 컴퓨터가 실행합니다. 파일 내용과 명령 결과는 연결한 서비스로 전송됩니다.', '앱이 실행 중이고 연결을 허용한 동안만 작동합니다. 일시정지 또는 연결 해제로 즉시 새 작업을 차단할 수 있습니다. 이미 실행된 변경은 되돌리지 않습니다.');
  return lines.join('\n');
}

export function safeError(error) {
  const code = String(error?.code || '').slice(0, 60);
  if (code === 'UNAUTHORIZED') return '로그인 상태 또는 컴퓨터 연결 권한을 확인해 주세요.';
  if (code === 'ABORT_ERR' || error?.name === 'AbortError') return '작업이 중단되었습니다.';
  if (error?.message === 'disconnect_before_changing_service') return '다른 서비스로 바꾸려면 먼저 연결을 해제해 주세요.';
  if (error?.message === 'pause_before_configuring') return '설정을 바꾸려면 먼저 연결을 일시정지해 주세요.';
  if (error?.message === 'secure_storage_unavailable') return '운영체제 암호 저장소를 사용할 수 없습니다.';
  if (['HTTPS 서비스 주소를 입력해 주세요.', '경로를 제외한 서비스 주소를 입력해 주세요.'].includes(error?.message)) return error.message;
  return '연결을 완료하지 못했습니다. 서비스 주소와 네트워크를 확인해 주세요.';
}
