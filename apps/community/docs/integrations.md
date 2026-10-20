# 관리자 연결 서비스

`/integrations`에서 사이트 관리자만 개인 서비스 연결을 조회한다. 개인 메일/캘린더 응답은 공동 방 메시지에 전달하지 않는다. 관리자별 개인 비서 방은 등록된 모든 조회 도구를 제공하고, 본인만 접근하며 초대가 금지된다. 개인 비서 답변은 해당 방에 저장된다. 관리자 전용 질문창에서 요청한 조회 결과만 모델 프롬프트에 전달하며, 응답은 DB에 저장하지 않는다. 모든 실행 API는 로그인, 관리자 역할, 동일 출처, CSRF 검증을 거친다. 이 API 연동에 저장된 키와 계정을 브라우저나 데스크톱 컨테이너에 자동 전달하지 않는다. 아래의 웹사이트 로그인 Vault는 별도로 사용자가 선택·확인한 계정만 해당 사이트의 입력칸에 전달한다.

## 저장/배포

각 설치의 운영자가 자신의 모델 키와 외부 서비스 계정을 등록한다. [빈 연결 예시](../integrations.example.json)를 Git에서 제외한 비공개 경로에 복사하고 필요한 값만 채운 뒤 `COMMUNITY_INTEGRATIONS_FILE`에 그 파일의 절대 경로를 지정한다. 예시 자체는 모든 인증 값이 비어 있다.

모델 환경 변수는 서버의 비공개 env 파일로 전달한다. Compose를 사용하는 경우 자신의 private manifest에서 env 파일과 Vault의 읽기 범위를 지정한다. Vault 파일은 앱 실행 계정만 읽고 필요한 토큰 갱신을 저장할 수 있도록 소유권과 `0600` 권한을 설정한다. 실제 경로·계정·키는 공개 템플릿에 고정하지 않는다.

두 설정은 Git·이미지·빌드 컨텍스트 밖에서 관리한다. 기존 설치의 원본 파일은 변경 전에 별도로 백업하고 운영 중인 키를 임의로 삭제하거나 새 예시로 덮어쓰지 않는다. 선택적 관리자 개인 맥락은 `COMMUNITY_AGENT_CONTEXT_FILE`로 명시하며, Fork의 기본값은 비활성 상태다.

## 모델

Groq, Gemini, Hugging Face, NVIDIA NIM, Cohere, OpenRouter 및 기존 OpenAI/xAI 호환 연결. 번호가 붙은 키를 모두 읽고 동일 키를 중복 제거한다. Gemini 모델 목록의 `models/` 접두사를 정규화한다. 자동 모드는 공급자별 모델을 선택하고 OpenRouter는 `:free` 모델만 선택한다. 모델을 지정하면 해당 모델이 있는 공급자/키만 시도한다.

자동 모드는 한 단계에서 최대 8회, 전체 요청에서 최대 32회 안에서 연결된 후보를 시도한다. 추가 시도도 사용량 제한에 포함된다. 오류 응답은 고정된 원인으로 분류하며 원문 오류나 인증 정보는 전환 안내에 넣지 않는다. 미지원 모델은 해당 키·모델만 6시간 이상 제외하고, 인증·잔액·한도 및 연결 주소 오류는 해당 키의 연결 전체에 적용한다. 일시 실패는 짧은 대기부터 시작해 반복 시 늘린다. 요청 크기·컨텍스트 초과는 다음 대화의 모델까지 차단하지 않는다. 정책 거절은 자동 전환으로 우회하지 않는다. 이미 실행된 도구는 재실행하지 않으며, 중단·모델 변경 시에는 현재 요청만 취소한다. 실패 상태는 설정·목록 갱신에도 유지되지만 서버 프로세스 재시작 시 초기화된다. 모델 목록 조회 성공은 키 인증/잔여 한도의 증거가 아니므로 실제 응답을 별도로 검증한다.

## 개인 서비스 범위

- 네이버 메일: SSL IMAP, 읽기 전용 INBOX, 최근 20개 제목/보낸사람/날짜. 읽음 표시 변경·발송 없음.
- 카카오: 캘린더 목록, 토큰 갱신 및 새 토큰 원자적 보관. `talk_calendar` 동의와 유효한 refresh token 필요.
- Meta: 공식 Graph API 앱 또는 사용자/페이지 프로필. 앱 토큰만 있으면 앱 인증까지만 가능. 브라우저 쿠키/비공개 API 우회 없음.
- Tavily: 관리자 검색, 최대 5개 결과.
- ElevenLabs: 음성 목록; 번호 키 재시도.
- Replicate: 계정 확인.
- Firecrawl: 잔여 크레딧; 번호 키 재시도.
- Resend: 등록 도메인 조회.
- Cloudinary: 이미지 메타데이터 목록.
- Telegram: 봇 프로필 확인. 메시지 발송/업데이트 소비/웹훅 변경 없음.
- Cohere: 모델 목록 및 대화 모델 풀.
- Naver Commerce: bcrypt 서명 기반 서버 인증 확인. 토큰 값은 반환하지 않는다.
- Fal: 모델 목록 조회. 생성·결제 호출 없음.
- Jina: 검색 결과 최대 5개 조회.

클라우드/DB 관리키(OCI, Cloudflare, Vercel, GitHub, Turso, Supabase 등)를 공동 대화에 일괄 주입하지 않는다. 서비스 실행에 필요한 최소 인증 정보만 관리자 연결 저장소에 넣는다.

## 공식 API 참고

- https://developers.kakao.com/docs/ko/talkcalendar/rest-api
- https://help.naver.com/service/30029/contents/21351?osType=COMMONOS
- https://huggingface.co/docs/inference-providers/en/index
- https://docs.cohere.com/docs/compatibility-api
- https://docs.firecrawl.dev/api-reference/endpoint/credit-usage
- https://resend.com/docs/api-reference/domains/list-domains
- https://cloudinary.com/documentation/admin_api
- https://core.telegram.org/bots/api#getme

## 웹사이트 로그인 Vault

명시적으로 서버 관리자 권한을 부여한 운영자 계정에서 현재 채팅으로 로그인을 요청하면, 이미 열린 로그인 화면에 대해 비공개 계정 선택 창을 띄운다. 이동이 필요한 경우 AI는 브라우저로 로그인 화면을 연 뒤 `request_browser_login`을 호출한다. 이 도구는 비밀번호·주소 인자를 받지 않는다. 서버가 실제 HTTPS 페이지와 로그인 입력칸을 직접 확인한다.

계정 목록과 저장·선택은 본인 인증·방 접근·쓰기 권한·CSRF를 확인하는 별도 경로를 사용한다. 정확한 origin(호스트·포트)이 같은 저장 계정만 제시한다. 사용자는 공유 PC라는 점을 확인한 뒤 계정을 전달하며, 현재 페이지가 바뀌거나 로그인 요청이 만료되거나 로그아웃하면 입력을 거부한다. 로그인 버튼은 자동 제출하지 않는다. 아이디만 있는 단계는 아이디만 입력하고 다음 화면에서 새 요청을 받는다. 2단계 인증·CAPTCHA는 사용자가 완료한다.

비밀번호는 모델 도구 인자·답변·공동 채팅에 넣지 않는다. 개인 웹 로그인 계정은 데이터 디렉터리의 `browser-login-vault.json`에 AES-256-GCM으로 저장하고 키는 별도 `browser-login-vault.key`에 둔다(둘 다 0600). Git·Docker 컨텍스트에서 제외한다. 기존 API 설정 Vault와 합치지 않는다. 이 저장소는 서버 관리자에 대한 보호를 의미하지 않으며, 공유 브라우저에서 로그인한 사이트의 세션은 그 브라우저의 다른 이용자도 사용할 수 있다.
