const DEFAULT_NAME = "CustomCloudBot";
const CLOUDS = [
  ["", "아직 선택하지 않음"], ["local", "내 컴퓨터 / 로컬 서버"],
  ["oci", "Oracle Cloud (OCI)"], ["aws", "Amazon Web Services"],
  ["gcp", "Google Cloud"], ["azure", "Microsoft Azure"], ["other", "기타 클라우드"],
];
const BACKENDS = { auto: "자동 연결 · API 우선", gateway: "OpenClaw Gateway", api: "API 직접 연결", demo: "데모", none: "아직 연결하지 않음" };

export function applyBrand(brand = {}) {
  const name = typeof brand.name === "string" && brand.name.trim() ? brand.name.trim().slice(0, 80) : DEFAULT_NAME;
  document.querySelectorAll("[data-product-name]").forEach(element => { element.textContent = name; });
  document.title = document.body.dataset.pageTitle ? `${document.body.dataset.pageTitle} · ${name}` : name;
  document.querySelector("#startup-view")?.setAttribute("aria-label", `${name} 불러오는 중`);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function button(text, callback, className = "outline-button") {
  const node = element("button", className, text);
  node.type = "button";
  if (callback) node.addEventListener("click", callback);
  return node;
}
function field(parent, text, name, options = {}) {
  const label = element("label", "setup-field");
  label.append(element("span", "", text));
  const input = document.createElement(options.options ? "select" : "input");
  input.name = name;
  if (options.options) {
    for (const [value, title] of options.options) {
      const option = element("option", "", title); option.value = value; input.append(option);
    }
  } else {
    input.type = options.type || "text";
    input.maxLength = options.maxLength || 500;
    input.autocomplete = "off";
    if (options.type === "password") {
      input.spellcheck = false;
      input.setAttribute("autocapitalize", "none");
    }
    if (options.placeholder) input.placeholder = options.placeholder;
  }
  // Credential inputs are always blank. The server sends only credential presence.
  if (!options.options || options.value !== undefined) input.value = options.type === "password" ? "" : options.value || "";
  input.required = Boolean(options.required);
  label.append(input);
  if (options.note) label.append(element("small", "setup-note", options.note));
  parent.append(label);
  return input;
}
function section(title, description) {
  const node = element("section", "setup-section");
  node.append(element("h3", "", title));
  if (description) node.append(element("p", "setup-note", description));
  return node;
}
function safeLink(label, candidate) {
  try {
    const url = new URL(candidate);
    if (url.protocol !== "https:") return null;
    const link = element("a", "setup-link", label);
    link.href = url.href; link.target = "_blank"; link.rel = "noopener noreferrer";
    return link;
  } catch { return null; }
}

export function createBotSetupUI({ api, getSession, onSaved, toast }) {
  let dialog, content, status, epoch = 0, busy = false;
  const promptedUsers = new Set();
  const isAdmin = () => getSession()?.user?.role === "admin";
  const current = (requestEpoch, userId) => requestEpoch === epoch && isAdmin() && getSession()?.user?.id === userId;
  const clearSecrets = () => dialog?.querySelectorAll('input[type="password"]').forEach(input => { input.value = ""; });
  function reset() {
    epoch += 1; busy = false;
    clearSecrets();
    if (dialog?.open) dialog.close();
    content?.replaceChildren();
  }
  function ensureDialog() {
    if (dialog) return;
    dialog = element("dialog", "setup-dialog");
    dialog.id = "bot-setup-dialog";
    dialog.setAttribute("aria-labelledby", "bot-setup-title");
    const header = element("header", "setup-header");
    const logo = element("img", "setup-logo");
    logo.src = "/icons/cloud-agent-v1-192.png"; logo.alt = ""; logo.width = 44; logo.height = 44;
    const copy = element("div");
    const title = element("h2", "", "내 봇 설정"); title.id = "bot-setup-title";
    copy.append(title, element("p", "setup-note", "내 이름, 내 클라우드, 내가 연결한 AI"));
    const close = button("×", reset, "icon-button setup-close");
    close.setAttribute("aria-label", "설정 닫기");
    header.append(logo, copy, close);
    status = element("p", "setup-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    content = element("div", "setup-content");
    dialog.append(header, status, content);
    dialog.addEventListener("close", () => { if (!dialog.open) { epoch += 1; busy = false; clearSecrets(); content.replaceChildren(); } });
    dialog.addEventListener("cancel", event => { event.preventDefault(); reset(); });
    dialog.addEventListener("click", event => { if (event.target === dialog && !busy) reset(); });
    document.body.append(dialog);
  }
  function setBusy(value) {
    busy = value;
    dialog?.querySelectorAll("fieldset").forEach(node => { node.disabled = value || node.dataset.unavailable === "true"; });
    dialog?.querySelectorAll("[data-setup-action]").forEach(node => { node.disabled = value || node.dataset.unavailable === "true"; });
  }
  async function save(path, body, message, connectionChanged = false) {
    if (busy || !isAdmin() || !dialog?.open) return;
    const requestEpoch = epoch, userId = getSession().user.id;
    setBusy(true); status.textContent = "저장하고 있어요…";
    clearSecrets();
    try {
      const data = await api(path, { method: "POST", body: JSON.stringify(body) });
      if (!current(requestEpoch, userId) || !dialog.open) return;
      render(data); setBusy(true);
      status.textContent = message;
      await onSaved?.(data, { connectionChanged });
    } catch (error) {
      if (current(requestEpoch, userId) && dialog.open) status.textContent = error.message || "설정을 저장하지 못했습니다.";
    } finally {
      if (current(requestEpoch, userId) && dialog.open) setBusy(false);
    }
  }
  function submitForm(parent, label, handler) {
    const form = element("form", "setup-form"), fields = element("fieldset");
    const submit = button(label, null, "primary-button"); submit.type = "submit";
    submit.dataset.setupAction = "";
    form.append(fields, submit);
    form.addEventListener("submit", event => { event.preventDefault(); if (!busy) handler(fields, form); });
    parent.append(form);
    return fields;
  }
  function renderProfile(data) {
    const block = section("나만의 봇", "이름은 로그인 화면과 앱에 표시됩니다. 클라우드·도메인·메일은 배포 기록이며, 저장해도 서버나 계정이 생성되지 않습니다.");
    const profile = data.profile || {};
    const fields = submitForm(block, "기본 설정 저장", (_, form) => {
      const value = new FormData(form);
      void save("/api/admin/setup", Object.fromEntries(["displayName", "cloud", "domain", "mail"].map(key => [key, String(value.get(key) || "").trim()])), "기본 설정을 저장했습니다.");
    });
    field(fields, "봇 이름", "displayName", { value: profile.displayName || DEFAULT_NAME, maxLength: 48, required: true });
    field(fields, "내 배포 환경", "cloud", { options: CLOUDS, value: profile.cloud });
    const advanced = element("details", "setup-details"); advanced.append(element("summary", "", "도메인·메일 기록 (선택)"));
    field(advanced, "서비스 도메인", "domain", { value: profile.domain, placeholder: "bot.example.com", maxLength: 200 });
    field(advanced, "운영 메일", "mail", { value: profile.mail, type: "email", maxLength: 200 });
    fields.append(advanced); content.append(block);
  }
  function renderProviders(data) {
    const block = section("AI API 연결", "키는 이 서버의 Vault에 저장합니다. 저장된 키를 브라우저로 다시 보내거나 브라우저 저장소에 보관하지 않습니다.");
    const providers = Array.isArray(data.providers) ? data.providers : [];
    const catalog = Array.isArray(data.catalog) ? data.catalog : [];
    const list = element("div", "setup-connections");
    let editingId = null;
    const fields = submitForm(block, "API 연결 저장", (_, form) => {
      const value = new FormData(form), provider = String(value.get("provider") || "");
      const body = { provider, apiKey: String(value.get("apiKey") || "").trim(), baseUrl: String(value.get("baseUrl") || "").trim(), model: String(value.get("model") || "").trim() };
      if (editingId) body.id = editingId;
      void save("/api/admin/setup/providers", body, "API 연결을 저장했습니다. 아래에서 사용할 연결 방식을 선택하세요.", true);
    });
    const editing = element("p", "setup-note", "새 API 연결"); fields.append(editing);
    const providerInput = field(fields, "공급자", "provider", { options: catalog.map(item => [item.id, item.name]), required: true });
    const apiKey = field(fields, "API 키", "apiKey", { type: "password", maxLength: 8192, required: true, placeholder: "새 키 입력", note: "기존 연결을 보존합니다. 연결 변경 시 키를 비우면 유지되며, 공급자나 주소를 바꾸면 새 키가 필요합니다." });
    const advanced = element("details", "setup-details"); advanced.append(element("summary", "", "연결 주소·기본 모델 (선택)"));
    const baseUrl = field(advanced, "API 주소", "baseUrl", { type: "url", value: catalog[0]?.baseUrl, placeholder: "https://api.example.com/v1" });
    const model = field(advanced, "기본 모델 ID", "model", { placeholder: "공급자의 모델 ID", maxLength: 200 });
    fields.append(advanced);
    const newConnection = button("새 연결 추가", () => {
      editingId = null; editing.textContent = "새 API 연결"; apiKey.value = ""; apiKey.required = true; apiKey.placeholder = "새 키 입력";
      providerInput.value = catalog[0]?.id || ""; baseUrl.value = catalog[0]?.baseUrl || ""; model.value = ""; providerInput.focus();
    }, "text-button"); newConnection.dataset.setupAction = "";
    block.insertBefore(list, block.querySelector("form")); block.insertBefore(newConnection, block.querySelector("form"));
    providerInput.addEventListener("change", () => { baseUrl.value = catalog.find(item => item.id === providerInput.value)?.baseUrl || ""; });
    for (const item of providers) {
      const row = element("div", "setup-connection");
      const copy = element("div"); copy.append(element("strong", "", item.name || item.provider), element("p", "setup-note", `${item.hasKey ? "키 등록됨" : "키 없음"} · ${item.source === "environment" ? "서버 환경 설정" : item.source === "imported" ? "가져온 키 모음" : "서버 Vault"}${item.model ? ` · ${item.model}` : ""}`)); row.append(copy);
      if (item.source === "vault") {
        const edit = button("변경", () => {
          editingId = item.id; editing.textContent = `${item.name || item.provider} 연결 변경`;
          providerInput.value = item.provider; baseUrl.value = item.baseUrl || ""; model.value = item.model || "";
          apiKey.value = ""; apiKey.required = false; apiKey.placeholder = "비워두면 기존 키 유지"; apiKey.focus();
        }, "text-button"); edit.dataset.setupAction = ""; row.append(edit);
      }
      list.append(row);
    }
    if (!providers.length) list.append(element("p", "setup-note", "아직 등록한 API 키가 없습니다."));
    if (!catalog.length) {
      fields.disabled = true; fields.dataset.unavailable = "true";
      const submit = block.querySelector('button[type="submit"]'); submit.disabled = true; submit.dataset.unavailable = "true";
      block.append(element("p", "setup-note", "현재 서버에서 API 공급자 목록을 제공하지 않습니다."));
    }
    content.append(block);
  }
  function renderDesktopDownloads(data) {
    const download = (Array.isArray(data.desktopDownloads) ? data.desktopDownloads : []).find(item => item.platform === "macos" && item.arch === "arm64");
    const block = section("데스크톱 앱 배포", "Mac · Apple Silicon 설치 파일을 연결합니다. 저장한 공개 링크는 모든 사용자의 ‘앱 받기’에 표시됩니다.");
    const fields = submitForm(block, "다운로드 설정 저장", (_, form) => {
      const value = new FormData(form), url = String(value.get("downloadUrl") || "").trim();
      const downloads = url ? [{ platform: "macos", arch: "arm64", version: String(value.get("downloadVersion") || "").trim(), url, notarized: download?.notarized === true }] : [];
      void save("/api/admin/setup/desktop-downloads", { downloads }, url ? "데스크톱 다운로드를 연결했습니다." : "데스크톱 다운로드 링크를 숨겼습니다.");
    });
    field(fields, "공개 다운로드 주소", "downloadUrl", { type: "url", value: download?.url, maxLength: 2048, placeholder: "https://…", note: "실제 설치 파일의 HTTPS 주소를 넣어주세요. 비워서 저장하면 다운로드 링크를 숨깁니다." });
    field(fields, "버전", "downloadVersion", { value: download?.version || "0.1.0", maxLength: 80 });
    if (download?.notarized !== true) block.append(element("p", "setup-note", "Apple 공증 전 버전으로 안내됩니다. macOS에서 실행이 차단될 수 있습니다."));
    content.append(block);
  }
  function renderResources(data) {
    const resources = Array.isArray(data.resources) ? data.resources : [];
    const block = section("키 보관함", "가져온 키 모음을 서버 Vault에 암호화해 보관합니다. 키 값은 표시하지 않습니다. 위 AI API 목록의 연결만 AI 실행에 사용되며, 그 밖의 항목은 해당 서비스 연결이 필요합니다.");
    block.append(element("p", "setup-connection-state", `${resources.filter(item => item.hasValue).length}개 값 보관 · ${resources.length}개 설정 항목`));
    if (!resources.length) block.append(element("p", "setup-note", "아직 가져온 키 모음이 없습니다. 기존 서버 환경 설정과 AI 연결은 유지됩니다."));
    const categories = { ai: "AI", mail: "메일", infrastructure: "서버·클라우드", service: "외부 서비스", other: "기타" };
    for (const [category, title] of Object.entries(categories)) {
      const items = resources.filter(item => item.category === category);
      if (!items.length) continue;
      const details = element("details", "setup-details");
      details.append(element("summary", "", `${title} · ${items.length}개`));
      const list = element("div", "setup-connections");
      for (const item of items) {
        const row = element("div", "setup-connection"), copy = element("div");
        copy.append(element("strong", "", item.name), element("p", "setup-note", `${item.hasValue ? "보관됨" : "값 없음"} · ${item.source || "키 모음"}`));
        row.append(copy); list.append(row);
      }
      details.append(list); block.append(details);
    }
    content.append(block);
  }
  function renderGateway(data) {
    const gateway = data.gateway || {};
    const block = section("OpenClaw Gateway", "이미 운영 중인 OpenClaw 엔진에 연결합니다. Gateway 인증과 AI 서비스 구독 인증은 별개입니다.");
    block.append(element("p", "setup-connection-state", `${gateway.configured ? "연결 정보 등록됨" : "연결 정보 없음"}${gateway.source === "environment" ? " · 서버 환경 설정" : gateway.source === "vault" ? " · 서버 Vault" : ""}`));
    const fields = submitForm(block, "Gateway 연결 저장", (_, form) => {
      const value = new FormData(form);
      void save("/api/admin/setup/gateway", { baseUrl: String(value.get("baseUrl") || "").trim(), token: String(value.get("token") || "").trim(), agentId: String(value.get("agentId") || "").trim(), enabled: true }, "Gateway 연결을 저장했습니다. 아래에서 사용할 연결 방식을 선택하세요.", true);
    });
    field(fields, "Gateway 주소", "baseUrl", { type: "url", value: gateway.baseUrl, required: true, placeholder: "http://openclaw:18789" });
    field(fields, "Gateway 토큰", "token", { type: "password", maxLength: 8192, required: !gateway.hasToken, placeholder: gateway.hasToken ? "비워두면 기존 토큰 유지" : "Gateway 토큰 입력", note: "서버 주소를 바꾸는 경우 새 토큰을 입력하세요." });
    field(fields, "에이전트 ID (선택)", "agentId", { value: gateway.agentId, maxLength: 80, placeholder: "default" });
    content.append(block);
  }
  function renderBackend(data) {
    const block = section("사용할 AI 연결", `현재: ${BACKENDS[data.activeBackend] || "연결 상태 확인 필요"}. 연결 정보를 저장한 뒤 여기서 실제 사용할 방식을 선택하세요.`);
    const actions = element("div", "setup-actions");
    for (const [backend, label, available] of [["api", "API 직접 연결 사용", (data.providers || []).some(item => item.hasKey)], ["gateway", "Gateway 사용", Boolean(data.gateway?.configured)]]) {
      const action = button(data.activeBackend === backend ? `${label} 중` : label, () => void save("/api/admin/setup/backend", { backend }, "사용할 AI 연결을 변경했습니다.", true));
      action.dataset.setupAction = ""; action.dataset.unavailable = String(!available || data.activeBackend === backend); action.disabled = !available || data.activeBackend === backend;
      actions.append(action);
    }
    block.append(actions); content.append(block);
    const verify = button(data.activeBackend === "gateway" ? "Gateway 설정 상태 확인" : "연결 확인", () => void verifyConnection(), "text-button");
    verify.dataset.setupAction = ""; verify.dataset.unavailable = String(!["api", "gateway", "auto"].includes(data.activeBackend));
    verify.disabled = verify.dataset.unavailable === "true";
    block.append(verify, element("p", "setup-note", "API는 모델 목록을 조회하고, Gateway는 저장된 연결 정보만 확인합니다. AI 답변 생성이나 구독 권한 검사는 하지 않습니다."));
  }
  function renderSubscriptions(data) {
    const block = section("구독 계정 연결", "브라우저에서 서비스에 로그인한 것만으로 API를 사용할 수 있지는 않습니다. 엔진과 공급자가 지원하는 공식 인증 절차를 사용하세요.");
    const guide = element("a", "setup-link", "이 버전의 구독 설치 가이드 ↗"); guide.href = "/setup-guide"; guide.target = "_blank"; guide.rel = "noopener noreferrer"; block.append(guide);
    const subscriptions = Array.isArray(data.subscriptions) ? data.subscriptions : [];
    if (!subscriptions.length) block.append(element("p", "setup-note", "현재 서버에서 지원하는 구독 로그인 흐름이 없습니다. API 키 또는 설정된 Gateway를 사용하세요."));
    for (const item of subscriptions) {
      const row = element("div", "setup-subscription");
      row.append(element("strong", "", item.name || item.id), element("p", "setup-note", item.description || "공급자와 엔진의 공식 설정 안내를 확인하세요."));
      if (Array.isArray(item.steps) && item.steps.length) {
        const details = element("details", "setup-details"); details.append(element("summary", "", "연결 절차 보기"));
        const steps = element("ol", "setup-note"); item.steps.forEach(step => steps.append(element("li", "", step))); details.append(steps);
        if (item.command) details.append(element("code", "setup-command", item.command));
        row.append(details);
      }
      const link = safeLink("공식 연결 안내 ↗", item.docsUrl);
      if (link) row.append(link);
      block.append(row);
    }
    content.append(block);
  }
  function renderGuide() {
    const details = element("details", "setup-guide"); details.append(element("summary", "", "처음 만드는 경우: 설치 예시"));
    const list = element("ol");
    for (const text of [
      "OCI 등 원하는 서버에 이 앱과 필요하면 OpenClaw Gateway를 설치합니다. 로컬 서버도 사용할 수 있습니다.",
      "Cloudflare Tunnel 또는 직접 관리하는 HTTPS 도메인으로 연결합니다. 선택한 클라우드와 도메인은 위에 기록해 두세요.",
      "Groq, Gemini, Hugging Face 등에서 본인 API 키를 발급받아 등록하고 ‘API 직접 연결 사용’을 선택합니다.",
    ]) list.append(element("li", "", text));
    details.append(list, element("p", "setup-note", "무료 할당이 있는 서비스도 계정·모델·지역·사용량에 따라 과금될 수 있습니다. 무료 운영을 보장하지 않으며 각 공급자의 현재 한도와 요금을 확인하세요."));
    content.append(details);
  }
  function render(data) {
    content.replaceChildren();
    renderProfile(data); renderDesktopDownloads(data); renderProviders(data); renderResources(data); renderGateway(data); renderBackend(data); renderSubscriptions(data); renderGuide();
    const exportButton = button("설정 레시피 내보내기", () => void exportRecipe(), "text-button"); exportButton.dataset.setupAction = "";
    const exportRow = element("div", "setup-export"); exportRow.append(exportButton, element("p", "setup-note", "봇 이름·배포 기록·AI 연결 주소를 JSON으로 저장합니다. 키와 토큰은 포함되지 않습니다.")); content.append(exportRow);
  }
  async function verifyConnection() {
    if (busy || !isAdmin()) return;
    const requestEpoch = epoch, userId = getSession().user.id;
    setBusy(true); status.textContent = "연결을 확인하고 있어요…";
    try {
      const data = await api("/api/admin/setup/verify", { method: "POST", body: "{}" });
      if (current(requestEpoch, userId) && dialog.open) status.textContent = data.message || (data.ok ? "연결을 확인했습니다." : "연결을 확인하지 못했습니다.");
    } catch (error) {
      if (current(requestEpoch, userId) && dialog.open) status.textContent = error.message || "연결을 확인하지 못했습니다.";
    } finally { if (current(requestEpoch, userId) && dialog.open) setBusy(false); }
  }
  async function exportRecipe() {
    if (busy || !isAdmin()) return;
    const requestEpoch = epoch, userId = getSession().user.id;
    setBusy(true); status.textContent = "설정 레시피를 준비하고 있어요…";
    try {
      const data = await api("/api/admin/setup/recipe");
      if (!current(requestEpoch, userId) || !dialog.open) return;
      const source = data.recipe || {};
      // Allowlist the portable metadata so credentials can never enter the download.
      const recipe = { version: 1, profile: { displayName: source.profile?.displayName || "", cloud: source.profile?.cloud || "", domain: source.profile?.domain || "", mail: source.profile?.mail || "" }, ai: { backend: source.ai?.backend || "none", providers: (source.ai?.providers || []).map(item => ({ provider: item.provider, baseUrl: item.baseUrl, model: item.model })), gateway: { baseUrl: source.ai?.gateway?.baseUrl || "", agentId: source.ai?.gateway?.agentId || "" } }, workspace: { browser: Boolean(source.workspace?.browser), terminal: Boolean(source.workspace?.terminal), files: Boolean(source.workspace?.files) } };
      const url = URL.createObjectURL(new Blob([JSON.stringify(recipe, null, 2) + "\n"], { type: "application/json" }));
      const link = document.createElement("a"); link.href = url; link.download = "my-cloud-bot.recipe.json"; document.body.append(link); link.click(); link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = "키와 토큰을 제외한 설정 레시피를 내보냈습니다.";
    } catch (error) {
      if (current(requestEpoch, userId) && dialog.open) status.textContent = error.message || "레시피를 내보내지 못했습니다.";
    } finally { if (current(requestEpoch, userId) && dialog.open) setBusy(false); }
  }
  async function open({ onboarding = false } = {}) {
    if (!isAdmin()) { toast?.("사이트 관리자만 봇을 설정할 수 있습니다."); return; }
    ensureDialog();
    if (dialog.open) { dialog.focus(); return; }
    epoch += 1; const requestEpoch = epoch, userId = getSession().user.id;
    content.replaceChildren(); status.textContent = "설정을 불러오고 있어요…";
    if (!onboarding) dialog.showModal();
    try {
      const data = await api("/api/admin/setup");
      if (!current(requestEpoch, userId)) return;
      if (onboarding && data.setupRequired !== true) return;
      render(data);
      status.textContent = onboarding ? "이름과 AI 연결을 설정해 내 봇을 시작하세요. 지금 닫고 나중에 설정해도 됩니다." : "";
      if (!dialog.open) dialog.showModal();
    } catch (error) {
      if (!current(requestEpoch, userId)) return;
      if (onboarding) { toast?.("봇 설정을 불러오지 못했습니다. ‘내 봇 설정’에서 다시 열 수 있습니다."); return; }
      status.textContent = error.message || "설정을 불러오지 못했습니다.";
    }
  }
  function maybePrompt() {
    const session = getSession(), userId = session?.user?.id;
    if (!isAdmin() || session.setupRequired !== true || promptedUsers.has(userId)) return;
    promptedUsers.add(userId); void open({ onboarding: true });
  }
  return { open, reset, maybePrompt };
}
