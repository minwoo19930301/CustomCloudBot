const isStandalone = () => window.matchMedia?.("(display-mode: standalone)")?.matches || navigator.standalone === true;

export function installationHelp({ userAgent = "", platform = "", maxTouchPoints = 0 } = {}) {
  if (/iphone|ipad|ipod/i.test(userAgent) || (platform === "MacIntel" && maxTouchPoints > 1)) {
    return { title: "홈 화면에 추가", message: "Safari에서 이 사이트를 열고 공유 버튼 → ‘홈 화면에 추가’를 선택해주세요. ‘웹 앱으로 열기’ 옵션이 보이면 켜주세요. 설치 후 알림은 홈 화면의 앱을 열어 설정할 수 있어요." };
  }
  if (/Mac/i.test(platform) && /Safari/i.test(userAgent) && !/Chrome|Chromium|Edg|Firefox/i.test(userAgent)) {
    return { title: "Dock에 추가", message: "macOS Sonoma 14 이상에서는 Safari의 ‘파일 → Dock에 추가’를 선택하면 앱으로 열 수 있어요. 메뉴가 보이지 않으면 macOS 버전을 확인하거나 설치를 지원하는 다른 브라우저를 사용해주세요." };
  }
  if (/Android/i.test(userAgent)) return { title: "앱으로 만들기", message: "브라우저 메뉴에서 ‘앱 설치’ 또는 ‘홈 화면에 추가’를 확인해주세요. 메뉴가 보이지 않으면 Chrome에서 이 사이트를 열어볼 수 있어요. 이 화면에서는 설치가 완료되지 않습니다." };
  if (/Edg/i.test(userAgent)) return { title: "앱으로 만들기", message: "Edge 메뉴의 ‘앱’에서 이 사이트를 앱으로 설치하는 항목을 확인해주세요. 메뉴가 없다면 현재 환경에서 설치를 지원하지 않을 수 있어요. 웹사이트는 그대로 사용할 수 있습니다." };
  if (/Chrome|Chromium/i.test(userAgent)) return { title: "앱으로 만들기", message: "Chrome 메뉴(⋮) → ‘전송, 저장 및 공유’ → ‘페이지를 앱으로 설치’를 확인해주세요. 주소창의 설치 아이콘으로도 설치할 수 있어요. 메뉴가 없다면 현재 환경에서 설치를 지원하지 않을 수 있습니다." };
  return { title: "앱으로 만들기", message: "이 브라우저에서는 설치 창을 직접 열 수 없어요. 브라우저 메뉴의 앱 설치 또는 홈 화면 추가 항목을 확인해주세요. 해당 메뉴가 없다면 설치를 지원하는 Chrome, Edge 또는 Safari에서 열어주세요. 웹사이트는 그대로 사용할 수 있습니다." };
}

const base64ToBytes = (value) => {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const decoded = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(decoded, (character) => character.charCodeAt(0));
};

export function createPwaController({ api, getSession, toast = () => {} }) {
  const installButtons = [document.querySelector("#install-button"), document.querySelector("#auth-install-button")].filter(Boolean);
  const pushButton = document.querySelector("#push-button");
  const testPushButton = document.querySelector("#test-push-button");
  const pushStatus = document.querySelector("#push-status");
  const dialog = document.querySelector("#pwa-dialog");
  const dialogTitle = document.querySelector("#pwa-dialog-title");
  const dialogMessage = document.querySelector("#pwa-dialog-message");
  const installDialog = document.querySelector("#app-install-dialog");
  const pwaInstallButton = document.querySelector("#install-pwa-button");
  const pwaInstallStatus = document.querySelector("#install-pwa-status");
  const desktopDownload = document.querySelector("#install-desktop-link");
  const desktopDownloadStatus = document.querySelector("#install-desktop-status");
  const desktopDownloadNote = document.querySelector("#install-desktop-note");
  const state = { session: null, registration: null, config: null, subscription: null, deferredInstall: null, epoch: 0, downloadEpoch: 0, pushBusy: false, installBusy: false, installed: false, destroyed: false, installHelpShown: false,
    supported: window.isSecureContext !== false && "serviceWorker" in navigator && "PushManager" in window && "Notification" in window };
  const current = (epoch) => !state.destroyed && state.epoch === epoch && Boolean(state.session?.user?.id) && (!getSession || getSession()?.user?.id === state.session.user.id);
  const showDialog = (title, message) => {
    if (!dialog || !dialogTitle || !dialogMessage) { toast(message); return; }
    dialogTitle.textContent = title;
    dialogMessage.textContent = message;
    if (!dialog.open) dialog.showModal();
  };
  const showInstallHelp = () => {
    const help = installationHelp(navigator);
    showDialog(help.title, `${help.message}\n\n앱은 현재 열어 둔 주소(${window.location.origin})로 설치됩니다.`);
  };
  const renderInstall = () => {
    if (typeof window.customCloudBotDesktop?.openSettings === "function") {
      installButtons.forEach(button => { button.hidden = true; button.classList.add("is-hidden"); });
      return;
    }
    const standalone = isStandalone();
    installButtons.forEach((button) => {
      button.classList.remove("is-hidden");
      button.hidden = false;
      button.disabled = state.installBusy;
      button.textContent = "앱 받기";
    });
    if (pwaInstallButton) pwaInstallButton.disabled = state.installBusy || standalone || state.installed;
    if (pwaInstallStatus) pwaInstallStatus.textContent = standalone ? "PWA로 사용 중" : state.installed ? "PWA 설치됨" : "브라우저에서 홈 화면이나 Dock에 추가";
  };
  const setDesktopDownload = (download, message) => {
    if (desktopDownload) {
      desktopDownload.removeAttribute("href");
      desktopDownload.setAttribute("aria-disabled", String(!download));
      desktopDownload.tabIndex = download ? 0 : -1;
      if (download) desktopDownload.setAttribute("href", download.url);
    }
    if (desktopDownloadStatus) desktopDownloadStatus.textContent = message;
    if (desktopDownloadNote) {
      desktopDownloadNote.hidden = !download || download.notarized === true;
      desktopDownloadNote.textContent = download && download.notarized !== true ? "Apple 공증 전 초기 버전입니다. macOS에서 실행이 차단될 수 있습니다." : "";
    }
  };
  const showInstallChoices = async () => {
    if (state.destroyed || state.installBusy || typeof window.customCloudBotDesktop?.openSettings === "function") return;
    if (!installDialog) { showInstallHelp(); return; }
    renderInstall();
    setDesktopDownload(null, "다운로드 확인 중…");
    if (!installDialog.open) installDialog.showModal();
    const epoch = ++state.downloadEpoch;
    try {
      const result = await api("/api/desktop/downloads");
      if (state.destroyed || epoch !== state.downloadEpoch) return;
      const download = result?.downloads?.find((item) => {
        if (item?.platform !== "macos" || item.arch !== "arm64" || typeof item.url !== "string") return false;
        try { const url = new URL(item.url); return url.protocol === "https:" && !url.username && !url.password; }
        catch { return false; }
      });
      if (!download) { setDesktopDownload(null, "데스크톱 다운로드를 아직 준비 중입니다."); return; }
      setDesktopDownload(download, `Mac · Apple Silicon${typeof download.version === "string" && download.version ? ` · v${download.version}` : ""}`);
    } catch {
      if (!state.destroyed && epoch === state.downloadEpoch) setDesktopDownload(null, "다운로드 정보를 불러오지 못했습니다. 잠시 후 다시 열어주세요.");
    }
  };
  const renderPush = () => {
    const permission = state.supported ? Notification.permission : "default";
    if (pushButton) {
      pushButton.classList.toggle("is-hidden", !state.session);
      pushButton.disabled = state.pushBusy;
      pushButton.textContent = state.subscription ? "기기 알림 끄기" : permission === "denied" ? "기기 알림 차단 안내" : "기기 알림 켜기";
      pushButton.setAttribute("aria-pressed", String(Boolean(state.subscription)));
    }
    if (testPushButton) {
      testPushButton.classList.toggle("is-hidden", !state.session || !state.subscription);
      testPushButton.disabled = state.pushBusy;
    }
    if (pushStatus) pushStatus.textContent = !state.session ? "" : state.subscription ? "앱을 닫아도 이 기기로 알려줘요. 소리는 기기 설정을 따라요." : !state.supported ? "이 환경의 알림 지원 방법을 확인할 수 있어요." : permission === "denied" ? "브라우저 설정에서 이 사이트의 알림을 허용해주세요." : state.config && !state.config.configured ? "서버의 푸시 알림 설정이 아직 준비되지 않았어요." : "앱을 닫았을 때도 받으려면 기기 알림을 켜주세요.";
  };
  const syncSubscription = async (subscription, epoch) => {
    if (!subscription || !current(epoch)) return false;
    await api("/api/push/subscriptions", { method: "POST", body: JSON.stringify({ subscription: subscription.toJSON() }) });
    return current(epoch);
  };
  const readyRegistration = async (epoch) => {
    const registration = state.registration || await navigator.serviceWorker.register("/sw.js", { scope: "/" });
    if (!current(epoch)) return null;
    const ready = await navigator.serviceWorker.ready;
    if (!current(epoch)) return null;
    state.registration = ready || registration;
    return state.registration;
  };
  const loadPushConfig = async () => {
    const epoch = state.epoch;
    if (!state.supported || !current(epoch)) return;
    try {
      const config = await api("/api/push/config");
      if (!current(epoch)) return;
      state.config = config;
      if (!config?.configured || !config.publicKey) return;
      const registration = await readyRegistration(epoch);
      if (!registration) return;
      const subscription = await registration.pushManager.getSubscription();
      if (!current(epoch)) return;
      if (subscription) {
        try { if (await syncSubscription(subscription, epoch)) state.subscription = subscription; }
        catch (error) {
          if (!current(epoch)) return;
          if (error.status !== 409) throw error;
          await subscription.unsubscribe().catch(() => {});
          if (!current(epoch)) return;
          state.subscription = null;
          toast("이 기기의 기존 알림 구독을 정리했습니다. 알림을 다시 켜주세요.");
        }
      }
    } catch {
      if (current(epoch)) { state.config = null; toast("알림 설정을 확인하지 못했습니다."); }
    } finally { if (current(epoch)) renderPush(); }
  };
  const enablePush = async () => {
    const epoch = state.epoch;
    if (!current(epoch) || state.pushBusy) return;
    if (!state.supported) { showDialog("기기 알림 안내", "이 브라우저에서는 푸시 알림을 사용할 수 없어요. iPhone·iPad는 Safari에서 홈 화면에 추가한 앱을 열어주세요. 다른 기기는 HTTPS와 알림을 지원하는 브라우저가 필요해요. 앱 안의 알림함은 계속 사용할 수 있습니다."); return; }
    if (!state.config?.configured || !state.config.publicKey) { showDialog("알림 설정 확인", "서버의 알림 설정이 아직 준비되지 않았거나 불러오지 못했어요. 잠시 후 다시 열어주세요. 앱 안의 알림함은 계속 사용할 수 있습니다."); loadPushConfig(); return; }
    if (Notification.permission === "denied") { showDialog("알림이 차단되어 있습니다", "브라우저 설정에서 이 사이트의 알림을 허용한 뒤 다시 시도해주세요."); return; }
    state.pushBusy = true;
    renderPush();
    try {
      const permission = await Notification.requestPermission();
      if (!current(epoch) || permission !== "granted") return;
      const registration = await readyRegistration(epoch);
      if (!registration) return;
      const subscription = await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: base64ToBytes(state.config.publicKey) });
      if (!current(epoch)) return;
      try { if (!(await syncSubscription(subscription, epoch))) return; state.subscription = subscription; }
      catch (error) { if (current(epoch)) { await subscription.unsubscribe().catch(() => {}); if (current(epoch)) state.subscription = null; } throw error; }
      toast("이제 새 메시지 알림을 받을 수 있어요.");
    } catch { if (current(epoch)) toast("알림을 켜지 못했습니다."); }
    finally { if (current(epoch)) { state.pushBusy = false; renderPush(); } }
  };
  const disablePush = async () => {
    const epoch = state.epoch;
    if (!current(epoch) || state.pushBusy) return;
    state.pushBusy = true;
    renderPush();
    try {
      const subscription = state.subscription || await state.registration?.pushManager.getSubscription();
      if (!subscription || !current(epoch)) return;
      await api("/api/push/subscriptions", { method: "DELETE", body: JSON.stringify({ endpoint: subscription.endpoint }) });
      if (!current(epoch)) return;
      await subscription.unsubscribe();
      if (!current(epoch)) return;
      state.subscription = null;
      toast("메시지 알림을 껐어요.");
    } catch { if (current(epoch)) toast("알림을 끄지 못했습니다."); }
    finally { if (current(epoch)) { state.pushBusy = false; renderPush(); } }
  };
  const testPush = async () => {
    const epoch = state.epoch;
    if (!current(epoch) || !state.subscription || state.pushBusy) return;
    state.pushBusy = true;
    renderPush();
    try {
      await api("/api/push/test", { method: "POST", body: JSON.stringify({ endpoint: state.subscription.endpoint }) });
      if (current(epoch)) toast("테스트 알림을 요청했습니다. 기기에서 확인해주세요.");
    } catch { if (current(epoch)) toast("테스트 알림을 요청하지 못했습니다."); }
    finally { if (current(epoch)) { state.pushBusy = false; renderPush(); } }
  };
  const install = async () => {
    if (state.installBusy) return;
    if (isStandalone() || state.installed) return;
    const prompt = state.deferredInstall;
    if (!prompt) { installDialog?.close(); showInstallHelp(); return; }
    state.deferredInstall = null;
    state.installBusy = true;
    renderInstall();
    try { const prompted = prompt.prompt(); installDialog?.close(); await prompted; await prompt.userChoice; }
    catch { installDialog?.close(); showInstallHelp(); }
    finally { state.installBusy = false; renderInstall(); }
  };
  const onPrompt = (event) => { event.preventDefault(); state.deferredInstall = event; renderInstall(); };
  const onInstalled = () => { state.deferredInstall = null; state.installed = true; renderInstall(); toast("앱이 설치되었습니다."); };
  const onPush = () => state.subscription ? disablePush() : enablePush();
  const onBackdrop = (event) => { if (event.target === dialog) dialog.close(); };
  const onInstallBackdrop = (event) => { if (event.target === installDialog) installDialog.close(); };
  const onDesktopDownload = (event) => { if (!desktopDownload?.getAttribute("href")) event.preventDefault(); };
  installButtons.forEach((button) => button.addEventListener("click", showInstallChoices));
  pwaInstallButton?.addEventListener("click", install);
  desktopDownload?.addEventListener("click", onDesktopDownload);
  installDialog?.addEventListener("click", onInstallBackdrop);
  pushButton?.addEventListener("click", onPush);
  testPushButton?.addEventListener("click", testPush);
  dialog?.addEventListener("click", onBackdrop);
  window.addEventListener("beforeinstallprompt", onPrompt);
  window.addEventListener("appinstalled", onInstalled);
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/sw.js", { scope: "/" }).then((registration) => { if (!state.destroyed) state.registration ||= registration; }).catch(() => {});
  renderInstall();
  renderPush();
  return {
    setAppOrigin(_value) {
      // Compatibility hook for the session's legacy app-origin setting. That
      // server allowlist does not choose where this browser installs its PWA.
      // Each permitted origin installs its own manifest without cross-origin navigation.
      renderInstall();
      if(!isStandalone() && window.location?.search?.includes("install=1") && !state.installHelpShown) {
        state.installHelpShown=true;void showInstallChoices();
      }
      return false;
    },
    setSession(session) {
      if (state.session?.user?.id === session?.user?.id && state.session?.csrfToken === session?.csrfToken) { state.session = session; renderPush(); return; }
      state.epoch++;
      state.session = session;
      state.config = null;
      state.subscription = null;
      state.pushBusy = false;
      renderInstall();
      renderPush();
      if (session) loadPushConfig();
    },
    async clearSession({ keepSession = false } = {}) {
      const session = state.session;
      const epoch = ++state.epoch;
      state.pushBusy = false;
      const subscription = state.subscription || (session && state.registration ? await state.registration.pushManager.getSubscription().catch(() => null) : null);
      if (epoch !== state.epoch || state.destroyed) return;
      if (subscription && session) {
        try { await api("/api/push/subscriptions", { method: "DELETE", body: JSON.stringify({ endpoint: subscription.endpoint }) }); } catch {}
        if (epoch !== state.epoch || state.destroyed) return;
        await subscription.unsubscribe().catch(() => {});
        if (epoch !== state.epoch || state.destroyed) return;
      }
      state.subscription = null;
      if (!keepSession) { state.session = null; state.config = null; }
      renderInstall();
      renderPush();
    },
    destroy() {
      state.destroyed = true;
      state.epoch++;
      state.downloadEpoch++;
      installButtons.forEach((button) => button.removeEventListener("click", showInstallChoices));
      pwaInstallButton?.removeEventListener("click", install);
      desktopDownload?.removeEventListener("click", onDesktopDownload);
      installDialog?.removeEventListener("click", onInstallBackdrop);
      pushButton?.removeEventListener("click", onPush);
      testPushButton?.removeEventListener("click", testPush);
      dialog?.removeEventListener("click", onBackdrop);
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    },
  };
}
