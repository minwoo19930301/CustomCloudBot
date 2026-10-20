const MONITOR_ROOM = "00000000-0000-4000-8000-000000000001";
import { createComposerRecorder } from "/composer-recorder.mjs";
import { createComposerSuggestions } from "/composer-suggestions.mjs";
import { renderMessageText } from "/message-format.mjs";
import { renderTranscript, disposeTranscript } from "/transcript.mjs";
import { recommendedModels, modelLabel, filterModels, createModelIcon, modelDetail } from "/model-picker.mjs";
import { createDesktopUI } from "/desktop.js";
import { createPwaController } from "/pwa.js";
import { applyBrand, createBotSetupUI } from "/setup.js";
import { createMailUI } from "/mail.js";
import { createAgentPresence, resolveAgentPresence } from "/agent-presence.js";
import { createNotificationCenter } from "/notification-center.js";
import { createInviteLink, createInviteLinks } from "/invite-links.mjs";
import { createProfileSettings } from "/profile-settings.js";
import { createRoomSharing } from "/room-sharing.js";
import { mergePendingMessages, failedOutcome } from "/conversation-ui.mjs";
import { layoutBranches, branchGraphGeometry, branchDisplayName, branchFocus, branchEdgeKey } from "/branch-graph.mjs";
import { sessionColors } from "/session-colors.js";
import { createSessionColorPicker, rgbToHex } from "/session-color-picker.mjs";
import { createRoutineUI } from "/routines.js";
import { createVoiceCall } from "/voice-call.js";
import { createMessageQueue } from "/message-queue.js";
import { createModelFailoverUI } from "/model-failover.mjs";
import { createLoginRequestUI } from "/browser-logins.mjs";
import { pasteComposerImages, uploadAttachmentFiles, clearAttachmentDraft, removeAttachmentDraft } from "/composer-attachments.mjs";
import { suggestTopicSwitch } from "/topic-switch.mjs";
const inviteLinks = createInviteLinks();

let dockRects = [{x:0,y:0,w:1,h:1}];
let pendingDock = null;
const state = {
  session: null,
  rooms: [],
  forks: [],
  bots: [],
  selectedRoom: null,
  roomData: null,
  selectedBots: [],
  pollTimer: null,
  pollBusy: false,
  activityBusy: false,
  sending: false,
  pendingSend: null,
  roomRequest: 0,
  pendingAttachments: [],
  attachmentGeneration: 0,
  layout: 1,
  extra: [],
  focusPane: 0,
  models: [],
};
let desktopUI;
let pwaUI;
let setupUI;
let mailUI;
let agentPresence;
let notificationUI;
let profileUI;
let sharingUI;
let routineUI;
let voiceUI;
let messageQueueUI;
let modelFailoverUI;
let loginUI;
let loginPollBusy = false;
let loginPollEpoch = 0;
let composerSuggestions;
const topicPrompts = new Set();
const pendingMessages = new Map();
const presenceTurns = new Map();
const presenceErrors = new Set();
const presenceBusy = new Set();
const branchOperations = new Set();
const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const els = {
  auth: $("#auth-view"),
  workspace: $("#workspace-view"),
  authMessage: $("#auth-message"),
  login: $("#login-form"),
  register: $("#register-form"),
  roomList: $("#room-list"),
  empty: $("#empty-state"),
  roomView: $("#room-view"),
  roomTitle: $("#room-title"),
  mobileRoomTitle: $("#mobile-room-title"),
  roomDescription: $("#room-description"),
  roomKicker: $("#room-kicker"),
  messages: $("#message-list"),
  memberList: $("#member-list"),
  memberCount: $("#member-count"),
  memberPanel: $("#member-panel"),
  modelWarning: $("#model-warning"),
  demoBadge: $("#demo-badge"),
  usage: $("#usage-label"),
  sendingStatus: $("#sending-status"),
  toast: $("#toast"),
};
const api = async (path, options = {}, retry = 0) => {
  const isFormData = options.body instanceof FormData;
  const headers = {
    Accept: "application/json",
    ...(options.body && !isFormData ? { "Content-Type": "application/json" } : {}),
    ...(state.session?.csrfToken
      ? { "X-CSRF-Token": state.session.csrfToken }
      : {}),
    ...(options.headers || {}),
  };
  let response;
  try {
    response = await fetch(path, {
      ...options,
      headers,
      credentials: "same-origin",
    });
  } catch (error) {
    if (retry < 1 && options.retryable) return api(path, options, retry + 1);
    throw error;
  }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || "요청을 처리하지 못했습니다.");
    error.status = response.status;
    error.code = payload.code;
    throw error;
  }
  return payload;
};
const setBusy = (button, busy, label) => {
  if (!button) return;
  button.disabled = busy;
  if (busy) {
    button.dataset.previousLabel = button.textContent;
    button.textContent = label;
  } else if (button.dataset.previousLabel) {
    button.textContent = button.dataset.previousLabel;
    delete button.dataset.previousLabel;
  }
};
const formDataObject = (form) =>
  Object.fromEntries(new FormData(form).entries());
const showMessage = (target, message, type = "error") => {
  target.textContent = message || "";
  target.className = `form-message ${type}`;
};
const toast = (message) => {
  els.toast.textContent = message;
  els.toast.classList.add("is-visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(
    () => els.toast.classList.remove("is-visible"),
    2800,
  );
};
const initials = (name) => (name || "?").trim().slice(0, 1).toUpperCase();
function renderUserAvatar(avatar, user, name) {
  const label=user.avatarLabel || initials(name || user.displayName || user.username);
  const key=JSON.stringify([label,user.avatarColor,user.avatarUrl]);
  if(avatar.dataset.profileKey===key)return;
  avatar.dataset.profileKey=key;
  avatar.replaceChildren();
  avatar.style.backgroundColor=user.avatarColor || "";
  avatar.classList.toggle("avatar-text",[...new Intl.Segmenter("ko",{granularity:"grapheme"}).segment(label)].length>1);
  if(typeof user.avatarUrl==="string" && /^\/api\/avatars\/[a-zA-Z0-9/-]+$/.test(user.avatarUrl)) {
    const photo=document.createElement("img");photo.src=user.avatarUrl;photo.alt="";photo.decoding="async";
    photo.addEventListener("error",()=>{if(avatar.dataset.profileKey===key)avatar.textContent=label;},{once:true});
    avatar.append(photo);
  } else avatar.textContent=label;
}
function messageProfile(message) {
  return message.authorId===state.session?.user?.id ? state.session.user : message;
}
function renderAccountTools() {
  if (!$("#delete-all-conversations")) {
    const button=document.createElement("button");button.id="delete-all-conversations";button.type="button";button.className="profile-menu-item";button.textContent="내 대화 전체 삭제";
    button.onclick=()=>{closeProfileMenu();void openDeleteAllConversations();};
    $("#restore-conversations").after(button);
  }
  const admin=state.session?.user?.role==="admin";
  $$("[data-admin-tool]",$("#profile-menu")).forEach(button=>button.classList.toggle("is-hidden",!admin));
  $("#open-dashboard").classList.toggle("is-hidden",!state.rooms.some(room=>room.id===MONITOR_ROOM&&!room.archived));
}
function openRoutines() {
  const pane=state.focusPane>0?state.extra[state.focusPane-1]:null;
  const id=pane?.roomId||state.selectedRoom,room=state.rooms.find(item=>item.id===id);
  if(!room||id===MONITOR_ROOM||room.archived){toast("루틴을 실행할 대화를 먼저 선택해 주세요.");return;}
  void routineUI?.open(room,{model:pane?.model??$("#model-select").value,effort:pane?.effort??$("#effort-select").value});
}
function closeProfileMenu() {
  const menu=$("#profile-menu");
  if(menu.open)menu.close();
  $("#profile-customize").setAttribute("aria-expanded","false");
}
function toggleProfileMenu() {
  const menu=$("#profile-menu"),trigger=$("#profile-customize");
  if(menu.open){closeProfileMenu();return;}
  renderAccountTools();
  const rect=trigger.getBoundingClientRect(),bottom=Math.max(12,innerHeight-rect.top+8);
  menu.style.bottom=bottom+"px";
  menu.style.maxHeight=Math.max(160,innerHeight-bottom-12)+"px";
  menu.show();
  menu.style.left=Math.max(12,Math.min(rect.left,innerWidth-menu.offsetWidth-12))+"px";
  trigger.setAttribute("aria-expanded","true");
  $("#edit-profile-button").focus({preventScroll:true});
}

function icon(name) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "icon");
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", "#i-" + name);
  svg.append(use);
  return svg;
}
const formatDate = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};
function switchAuth(tab) {
  const login = tab === "login";
  $$(".tab-button").forEach((button) => {
    const active = button.dataset.authTab === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
  });
  els.login.classList.toggle("is-hidden", !login);
  els.register.classList.toggle("is-hidden", login);
  showMessage(els.authMessage, "");
  (login ? $("#login-username") : $("#register-display")).focus();
}
async function loadSession() {
  const startup = $("#startup-view");
  $("#startup-retry").classList.add("is-hidden");
  $("#startup-status").textContent = "내 공간을 불러오고 있어요";
  try {
    state.session = await api("/api/session", { signal: AbortSignal.timeout(15000) });
    applyBrand(state.session.brand);
    if (pwaUI?.setAppOrigin(state.session.brand?.appOrigin)) return;
    if (state.session.user) void enterWorkspace().catch(() => toast("대화 목록을 불러오지 못했습니다. 새로고침해주세요."));
    else showAuth();
    startup.classList.add("is-ready");
    setTimeout(() => startup.classList.add("is-hidden"), 300);
  } catch {
    $("#startup-status").textContent = "연결이 잠시 늦어지고 있어요. 다시 시도해주세요.";
    $("#startup-retry").classList.remove("is-hidden");
  }
}
$("#startup-retry").addEventListener("click", loadSession);
function showAuth() {
  disposeTranscript(els.messages);
  $$(".extra-pane .message-list").forEach(disposeTranscript);
  closeComposerPicker();
  voiceUI?.reset();
  messageQueueUI?.reset();
  composerSuggestions?.reset();
  messageQueueUI?.render($("#composer-form"), null);
  agentPresence?.reset(); presenceErrors.clear(); presenceTurns.clear(); presenceBusy.clear(); pendingMessages.clear(); notificationUI?.reset();
  profileUI?.close(); sharingUI?.close();
  setupUI?.reset();
  mailUI?.reset();
  routineUI?.reset();topicPrompts.clear();document.querySelector(".topic-choice-dialog")?.close();
  closeContextPopover();
  resetSidebarState();
  modelChanges.clear();
  modelFailoverUI?.reset();
  loginPollEpoch++; loginPollBusy=false; loginUI?.reset();
  cancelActiveRecording();
  pwaUI?.setSession(null);
  els.auth.classList.remove("is-hidden");
  els.workspace.classList.add("is-hidden");
  stopPolling();
  state.selectedRoom = null;
  state.roomData = null;
  state.rooms = [];
  state.forks = [];
  branchOperations.clear();
  state.bots = [];
  state.selectedBots = [];
  state.pendingSend = null;
  state.sending = false;
  $("#message-input").disabled=false;$("#send-button").disabled=false;
  state.layout = 1;
  state.extra.forEach(pane => clearAttachmentDraft(pane));
  state.extra = [];
  state.focusPane = 0;
  state.models = [];
  dockRects = [{x:0,y:0,w:1,h:1}];
  applyDockLayout();
  pendingDock = null;
  const paneGrid = $("#pane-grid");
  if (paneGrid) {
    paneGrid.dataset.panes = "1";
    $$(".extra-pane", paneGrid).forEach((pane) => { disposeTranscript(pane.querySelector(".message-list")); pane.remove(); });
  }
  $("#room-view").style.gridColumn = "";
  $("#room-view").classList.remove("is-focus");
  $$(".split-picker button").forEach((button) => {
    button.classList.remove("is-on");
    button.setAttribute("aria-pressed", "false");
  });
  clearPendingAttachments();
  desktopUI?.reset();
  state.roomRequest += 1;
  state.pollBusy = false;
  els.messages.replaceChildren();
  els.memberList.replaceChildren();
  els.roomList.replaceChildren();
  $("#message-input").value = "";
  els.memberPanel.classList.remove("is-open");
  closeSidebar();
  $$("dialog[open]").forEach((dialog) => dialog.close());
  $("#invite-token").textContent = "";
  const pendingSite = inviteLinks.get("site");
  $("#register-token").hidden = Boolean(pendingSite); $("#register-token-label").hidden = Boolean(pendingSite);
  if (pendingSite) { $("#register-token").value = pendingSite; switchAuth("register"); }
  else { switchAuth("login"); if (inviteLinks.get("room")) showMessage(els.authMessage, "대화 초대를 받았습니다. 로그인하면 참여할 수 있습니다.", "info"); }
}
async function enterWorkspace() {
  voiceUI?.syncSession();
  applyBrand(state.session.brand);
  els.auth.classList.add("is-hidden");
  els.workspace.classList.remove("is-hidden");
  const user = state.session.user;
  $("#profile-name").textContent = user.displayName || user.username;
  $("#profile-role").textContent =
    user.role === "admin" ? "사이트 관리자" : "멤버";
  renderUserAvatar($("#profile-avatar"),user);
  $("#site-invite-button").classList.toggle("is-hidden", user.role !== "admin");
  renderModelConnection();
  notificationUI?.setSession(state.session);
  agentPresence?.set("idle", true);
  pwaUI?.setSession(state.session);
  closeComposerPicker();
  resetSidebarState(user.id);
  const workspaceEpoch=sidebarEpoch;
  await Promise.all([loadSidebar(),loadRooms()]);
  if(state.session?.user?.id!==user.id||sidebarEpoch!==workspaceEpoch)return;
  if (!openPendingRoomInvite()) setupUI?.maybePrompt();
  try {
    const catalog = await api("/api/models");
    if(state.session?.user?.id!==user.id||sidebarEpoch!==workspaceEpoch)return;
    applyModels(catalog.models);
    if (!catalog.models.length) toast(!state.session.model?.configured ? "AI 연결을 설정해 주세요." : catalog.failures.length ? "모델 목록을 가져오지 못했습니다. 기본 모델로 연결됩니다." : "선택 가능한 API 모델이 없습니다. 기본 모델로 연결됩니다.");
  } catch (error) { toast(error.message || "모델 목록을 불러오지 못했습니다."); }
}
function renderModelConnection() {
  const model = state.session?.model || {};
  els.demoBadge.classList.toggle("is-hidden", !model.demo);
  els.modelWarning.classList.toggle("is-hidden", Boolean(model.configured) || Boolean(model.selectable));
}
async function refreshSetupState(data, { connectionChanged }) {
  const userId=state.session?.user?.id, workspaceEpoch=sidebarEpoch;
  if(!userId||state.session.user.role!=="admin")return;
  state.session.setupRequired=data.setupRequired===true;
  if(data.profile?.displayName) {state.session.brand={...state.session.brand,name:data.profile.displayName};applyBrand(state.session.brand);}
  if(!connectionChanged)return;
  try {
    const [session,catalog]=await Promise.all([api("/api/session"),api("/api/models")]);
    if(state.session?.user?.id!==userId||session.user?.id!==userId||workspaceEpoch!==sidebarEpoch)return;
    state.session=session;applyBrand(session.brand);renderModelConnection();applyModels(catalog.models || []);
    await loadRooms();
  } catch { if(state.session?.user?.id===userId&&workspaceEpoch===sidebarEpoch)toast("연결 설정은 저장했습니다. 모델 목록은 새로고침 후 확인해주세요."); }
}
async function loadRooms() {
  const userId=state.session?.user?.id,epoch=sidebarEpoch;if(!userId)return;
  try {
    const data = await api("/api/rooms");
    if(userId!==state.session?.user?.id||epoch!==sidebarEpoch)return;
    state.rooms = data.rooms || [];
    state.forks = data.forks || [];
    state.bots = data.bots || [];
    state.selectedBots = state.bots.length ? [state.bots[0].id] : [];
    els.usage.textContent = "";
    els.usage.title = data.usage ? `앱의 하루 호출 사용량 ${data.usage.used} / ${data.usage.limit}회 · 공급자 잔여량과 별개` : "";
    renderRooms();
    updateModelAvailability();
    const activeRooms = state.rooms.filter(room => !room.archived && room.id !== MONITOR_ROOM);
    if (!state.rooms.some(room => room.id === state.selectedRoom && !room.archived)) {
      if (!activeRooms.length) { showEmpty(); return; }
      let last;
      try { last = sessionStorage.getItem("community-room:" + userId); } catch {}
      const requested = new URLSearchParams(window.location.search).get("room");
      await selectRoom(activeRooms.find(room => room.id === requested)?.id || activeRooms.find(room => room.id === last)?.id || activeRooms[0].id);
    }
    voiceUI?.handleLink();
  } catch (error) {
    if(userId===state.session?.user?.id&&epoch===sidebarEpoch)toast(error.message);
  }
}
let showDeletedRooms=false;
let sidebarBranchFocus=null;
let sessionSearch="";
let sidebarState={userId:null,groups:[],roomOrder:[],width:280,loaded:false};
let sidebarConfirmed={groups:[],roomOrder:[],width:280};
let sidebarEpoch=0,sidebarRevision=0,sidebarWriteQueue=Promise.resolve();
let sidebarPreviewWidth=null,sidebarWidthTimer=null;
function sidebarWidthBounds(viewport=innerWidth) {
  return {min:200,max:Math.max(200,Math.min(420,viewport-360))};
}
function boundedSidebarWidth(value,viewport=innerWidth) {
  const {min,max}=sidebarWidthBounds(viewport);return Math.max(min,Math.min(max,Math.round(Number(value)||280)));
}
function applySidebarWidth() {
  const width=boundedSidebarWidth(sidebarPreviewWidth??sidebarState.width),handle=$("#sidebar-resizer");
  els.workspace.style.setProperty("--sidebar-width",width+"px");
  handle.setAttribute("aria-valuenow",String(width));handle.setAttribute("aria-valuetext",width+"픽셀");handle.setAttribute("aria-valuemax",String(sidebarWidthBounds().max));
  handle.setAttribute("aria-disabled",String(!sidebarState.loaded));
}
function resetSidebarState(userId=null) {
  sidebarEpoch+=1;sidebarRevision=0;showDeletedRooms=false;sidebarBranchFocus=null;sessionSearch="";
  $("#session-search").value="";$("#sidebar-search-wrap").hidden=true;$("#sidebar-search-toggle").setAttribute("aria-expanded","false");
  clearTimeout(sidebarWidthTimer);sidebarWidthTimer=null;sidebarPreviewWidth=null;
  sidebarState={userId,groups:[],roomOrder:[],width:280,loaded:false};sidebarConfirmed={groups:[],roomOrder:[],width:280};
  els.workspace.classList.remove("sidebar-resizing","sidebar-collapsed");applySidebarWidth();
  $("#create-sidebar-group").disabled=true;
}
function sidebarConfig(value) {
  return {roomOrder:Array.isArray(value?.roomOrder)?[...value.roomOrder]:[],groups:Array.isArray(value?.groups)?value.groups.map(group=>({id:group.id,name:group.name,collapsed:!!group.collapsed})):[],width:Math.max(200,Math.min(420,Number(value?.width)||280))};
}
async function loadSidebar() {
  const userId=state.session?.user?.id,epoch=sidebarEpoch;if(!userId)return;
  try {
    const config=sidebarConfig(await api("/api/sidebar",{retryable:true}));
    if(epoch!==sidebarEpoch||state.session?.user?.id!==userId)return;
    sidebarConfirmed=config;sidebarState={...config,userId,loaded:true};applySidebarWidth();renderRooms();
  }catch(error){if(epoch===sidebarEpoch){toast("대화 그룹 설정을 불러오지 못했습니다. 새로고침해 다시 시도해주세요.");}}
}
function saveSidebar(next) {
  const userId=state.session?.user?.id,epoch=sidebarEpoch;if(!userId||!sidebarState.loaded)return Promise.resolve(false);
  const config=sidebarConfig(next),revision=++sidebarRevision;
  sidebarState={...config,userId,loaded:true};applySidebarWidth();renderRooms();
  const current=()=>epoch===sidebarEpoch&&state.session?.user?.id===userId;
  const pending=sidebarWriteQueue.then(async()=>{
    if(!current())return false;
    try {
      const saved=sidebarConfig(await api("/api/sidebar",{method:"PUT",body:JSON.stringify(config)}));
      if(!current())return false;
      sidebarConfirmed=saved;
      if(revision===sidebarRevision){sidebarState={...saved,userId,loaded:true};applySidebarWidth();renderRooms();}
      return true;
    }catch(error){
      if(current()){
        if(revision===sidebarRevision){sidebarState={...sidebarConfirmed,userId,loaded:true};applySidebarWidth();renderRooms();}
        toast(error.message||"대화 목록 설정을 저장하지 못했습니다.");
      }
      return false;
    }
  });
  sidebarWriteQueue=pending.catch(()=>false);return pending;
}
function commitSidebarWidth() {
  clearTimeout(sidebarWidthTimer);sidebarWidthTimer=null;
  if(sidebarPreviewWidth==null)return;
  const width=boundedSidebarWidth(sidebarPreviewWidth);sidebarPreviewWidth=null;
  if(sidebarState.loaded&&width!==sidebarState.width)void saveSidebar({...sidebarState,width});
  else applySidebarWidth();
}
function setupSidebarResize() {
  const handle=$("#sidebar-resizer");let drag=null;
  handle.addEventListener("pointerdown",event=>{
    if(event.button!==0||!sidebarState.loaded||matchMedia("(max-width:720px)").matches)return;
    event.preventDefault();event.stopPropagation();clearTimeout(sidebarWidthTimer);
    drag={pointerId:event.pointerId,startX:event.clientX,width:boundedSidebarWidth(sidebarPreviewWidth??sidebarState.width),epoch:sidebarEpoch};
    handle.setPointerCapture(event.pointerId);handle.focus();els.workspace.classList.add("sidebar-resizing");
  });
  handle.addEventListener("pointermove",event=>{
    if(!drag||event.pointerId!==drag.pointerId)return;
    if(drag.epoch!==sidebarEpoch){drag=null;return;}
    sidebarPreviewWidth=boundedSidebarWidth(drag.width+event.clientX-drag.startX);applySidebarWidth();
  });
  const finish=event=>{
    if(!drag||event.pointerId!==drag.pointerId)return;
    const same=drag.epoch===sidebarEpoch;drag=null;els.workspace.classList.remove("sidebar-resizing");
    if(handle.hasPointerCapture(event.pointerId))handle.releasePointerCapture(event.pointerId);
    if(same)commitSidebarWidth();
  };
  handle.addEventListener("pointerup",finish);handle.addEventListener("lostpointercapture",finish);
  handle.addEventListener("pointercancel",event=>{
    if(!drag||event.pointerId!==drag.pointerId)return;drag=null;sidebarPreviewWidth=null;els.workspace.classList.remove("sidebar-resizing");applySidebarWidth();
  });
  handle.addEventListener("keydown",event=>{
    if(!sidebarState.loaded||!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
    event.preventDefault();const {min,max}=sidebarWidthBounds(),step=event.shiftKey?40:10;
    sidebarPreviewWidth=boundedSidebarWidth(event.key==="Home"?min:event.key==="End"?max:(sidebarPreviewWidth??sidebarState.width)+(event.key==="ArrowRight"?step:-step));applySidebarWidth();
    clearTimeout(sidebarWidthTimer);sidebarWidthTimer=setTimeout(commitSidebarWidth,250);
  });
  window.addEventListener("resize",applySidebarWidth);applySidebarWidth();
}
function sidebarDialog(title) {
  const dialog=document.createElement("dialog");dialog.className="sidebar-dialog";dialog.setAttribute("aria-label",title);
  const heading=document.createElement("h2");heading.textContent=title;dialog.append(heading);
  dialog.addEventListener("close",()=>dialog.remove(),{once:true});document.body.append(dialog);return dialog;
}
function openSidebarGroupEditor(group=null) {
  if(!sidebarState.loaded)return;
  const epoch=sidebarEpoch,dialog=sidebarDialog(group?"그룹 이름 변경":"새 대화 그룹"),form=document.createElement("form");
  const label=document.createElement("label");label.textContent="그룹 이름";
  const input=document.createElement("input");input.name="name";input.maxLength=40;input.required=true;input.autocomplete="off";input.value=group?.name||"";label.append(input);
  const message=document.createElement("p");message.className="form-message";message.setAttribute("role","alert");
  const actions=document.createElement("div");actions.className="sidebar-dialog-actions";
  const cancel=document.createElement("button");cancel.type="button";cancel.textContent="취소";cancel.onclick=()=>dialog.close();
  const submit=document.createElement("button");submit.type="submit";submit.textContent=group?"저장":"만들기";actions.append(cancel,submit);form.append(label,message,actions);dialog.append(form);
  form.onsubmit=async event=>{
    event.preventDefault();if(submit.disabled||epoch!==sidebarEpoch)return;
    const name=input.value.trim();if(!name){message.textContent="그룹 이름을 입력해주세요.";return;}
    if(group&&!sidebarState.groups.some(item=>item.id===group.id)){dialog.close();return;}
    if(!group&&sidebarState.groups.length>=20){message.textContent="그룹은 최대 20개까지 만들 수 있습니다.";return;}
    setBusy(submit,true,"저장 중…");
    const groups=group?sidebarState.groups.map(item=>item.id===group.id?{...item,name}:item):[...sidebarState.groups,{id:crypto.randomUUID(),name,collapsed:false}];
    const saved=await saveSidebar({...sidebarState,groups});
    if(saved&&epoch===sidebarEpoch)dialog.close();else setBusy(submit,false);
  };
  dialog.showModal();input.focus();input.select();
}
function openSidebarGroupMenu(group) {
  const epoch=sidebarEpoch,dialog=sidebarDialog(group.name),rename=document.createElement("button"),remove=document.createElement("button"),cancel=document.createElement("button");
  rename.type=remove.type=cancel.type="button";rename.textContent="이름 변경";remove.textContent="그룹 삭제";cancel.textContent="닫기";
  rename.onclick=()=>{dialog.close();openSidebarGroupEditor(group);};cancel.onclick=()=>dialog.close();
  const note=document.createElement("p");note.className="sidebar-dialog-note";note.textContent="그룹을 삭제해도 대화는 유지되며 ‘그룹 없음’으로 이동합니다.";
  remove.onclick=async()=>{
    remove.disabled=true;
    const saved=await saveSidebar({...sidebarState,groups:sidebarState.groups.filter(item=>item.id!==group.id)});
    if(saved&&epoch===sidebarEpoch){for(const room of state.rooms)if(room.groupId===group.id)room.groupId=null;renderRooms();dialog.close();}
    else remove.disabled=false;
  };
  dialog.append(rename,remove,note,cancel);dialog.showModal();
}
function openRoomGroupPicker(room) {
  if(!sidebarState.loaded)return;
  const dialog=sidebarDialog("대화 그룹으로 이동"),epoch=sidebarEpoch;
  for(const group of [{id:null,name:"그룹 없음"},...sidebarState.groups]) {
    const button=document.createElement("button");button.type="button";button.className="sidebar-group-option";
    const selected=(room.groupId||null)===group.id;button.textContent=group.name+(selected?" ✓":"");button.setAttribute("aria-pressed",String(selected));
    button.onclick=async()=>{
      if(epoch!==sidebarEpoch)return;if(selected){dialog.close();return;}
      $$("button",dialog).forEach(item=>item.disabled=true);
      if(await updateRoomListPreference(room,{groupId:group.id}))dialog.close();
      else $$("button",dialog).forEach(item=>item.disabled=false);
    };dialog.append(button);
  }
  const close=document.createElement("button");close.type="button";close.textContent="취소";close.onclick=()=>dialog.close();dialog.append(close);dialog.showModal();
}
async function updateRoomListPreference(room, changes) {
  const userId=state.session?.user?.id,epoch=sidebarEpoch;
  try {
    const prefs=await api("/api/rooms/"+room.id+"/preferences",{method:"POST",body:JSON.stringify({pinned:!!room.pinned,archived:!!room.archived,groupId:room.groupId||null,...changes})});
    if(userId!==state.session?.user?.id||epoch!==sidebarEpoch)return false;
    const current=state.rooms.find(item=>item.id===room.id);if(!current)return false;Object.assign(current,prefs);
    if(prefs.archived && state.selectedRoom===room.id) {
      const next=state.extra.map(pane=>state.rooms.find(item=>item.id===pane.roomId&&!item.archived)).find(Boolean)||state.rooms.find(r=>!r.archived);
      if(next) await selectRoom(next.id); else showEmpty();
      if(userId!==state.session?.user?.id||epoch!==sidebarEpoch)return false;
    }
    if(prefs.archived) {
      desktopUI?.closeRoom(room.id);
      state.extra.filter(pane => pane.roomId === room.id).forEach(pane => clearAttachmentDraft(pane));
      state.extra=state.extra.filter(p=>p.roomId!==room.id);
      const count=state.extra.length+1;
      state.layout=count;state.focusPane=0;$("#pane-grid").dataset.panes=String(count);
      dockRects=Array.from({length:count},(_,index)=>({x:index/count,y:0,w:1/count,h:1}));
      $("#room-view").classList.toggle("is-focus",count>1);
      renderExtraPanes();
    }
    renderRooms();return true;
  } catch(error) {if(userId===state.session?.user?.id&&epoch===sidebarEpoch)toast(error.message);return false;}
}
function sidebarRoomButton(room) {
  const button=document.createElement("button");button.dataset.dockRoom=room.id;button.draggable=false;button.type="button";
  const open=sidebarOpenRoomIds().has(room.id), focused=open&&currentBranchId()===room.id;
  button.className=`room-item${open?" is-active is-open":""}${focused?" is-selected":""}`;button.dataset.roomId=room.id;
  if(focused)button.setAttribute("aria-current","page");
  const roomIcon=document.createElement("span");roomIcon.className="room-icon";roomIcon.append(icon("chat"));
  const copy=document.createElement("span");copy.className="room-item-copy";
  const name=document.createElement("strong");name.textContent=(room.pinned?"· ":"")+room.name;
  const meta=document.createElement("small");meta.textContent=`${room.memberCount||0}명 · ${room.description||"공동 대화"}`;
  copy.append(name,meta);button.append(roomIcon,copy);button.addEventListener("click",()=>{if(state.focusPane>0)assignExtra(state.focusPane-1,room.id);else selectRoom(room.id);closeSidebar();});return button;
}
function confirmRemoveConversation(room) {
  if (room.archived) return void updateRoomListPreference(room, {archived:false});
  const userId = state.session?.user?.id, epoch = sidebarEpoch;
  const dialog = document.createElement("dialog"); dialog.className = "quick-model-picker session-delete-dialog";
  dialog.setAttribute("aria-label", "대화 삭제");
  const title = contextElement("h2", "대화를 삭제할까요?");
  const text = contextElement("p", "내 목록에서 삭제합니다. 계정 메뉴의 ‘대화 복원’에서 되돌릴 수 있으며 다른 참여자의 대화는 유지됩니다.");
  const cancel = contextElement("button", "취소"), confirm = contextElement("button", "삭제", "session-delete-confirm");
  cancel.type = confirm.type = "button";
  cancel.onclick = () => dialog.close();
  confirm.onclick = async () => {
    if (state.session?.user?.id !== userId || sidebarEpoch !== epoch) { dialog.close(); return; }
    confirm.disabled = true;
    if (await updateRoomListPreference(room, {archived:true})) dialog.close();
    else confirm.disabled = false;
  };
  const buttons = contextElement("div", undefined, "session-delete-actions"); buttons.append(cancel, confirm);
  dialog.append(title, text, buttons); dialog.onclose = () => dialog.remove(); document.body.append(dialog); dialog.showModal(); cancel.focus();
}
async function openDeleteAllConversations() {
  const userId=state.session?.user?.id,epoch=sidebarEpoch;
  try {
    const preview=await api("/api/conversations/delete-preview");
    if(userId!==state.session?.user?.id||epoch!==sidebarEpoch)return;
    if(!preview.count){toast("삭제할 대화가 없습니다.");return;}
    const dialog=document.createElement("dialog");dialog.className="quick-model-picker session-delete-dialog";dialog.setAttribute("aria-label","내 대화 전체 삭제");
    const title=contextElement("h2","내 대화를 전부 삭제할까요?");
    const detail=contextElement("p",`보관된 대화를 포함해 내가 만든 대화 ${preview.count}개, 메시지 ${preview.messages}개, 첨부 ${preview.attachments}개를 영구 삭제합니다. 복원할 수 없습니다.${preview.shared ? ` 공동 대화 ${preview.shared}개는 다른 참여자에게서도 삭제됩니다.` : ""}`);
    const note=contextElement("p","계정·봇 설정·메일함과 다른 사람이 만든 대화는 유지됩니다.");
    const cancel=contextElement("button","취소"),confirm=contextElement("button","전체 영구 삭제","session-delete-confirm");cancel.type=confirm.type="button";
    cancel.onclick=()=>dialog.close();
    confirm.onclick=async()=>{
      if(userId!==state.session?.user?.id||epoch!==sidebarEpoch){dialog.close();return;}
      confirm.disabled=true;
      try {
        const result=await api("/api/conversations/delete-all",{method:"POST",body:JSON.stringify({fingerprint:preview.fingerprint})});
        if(userId!==state.session?.user?.id||epoch!==sidebarEpoch){dialog.close();return;}
        state.rooms=state.rooms.filter(room=>!result.roomIds.includes(room.id));state.forks=state.forks.filter(link=>!result.roomIds.includes(link.id));
        showDeletedRooms=false;showEmpty();dialog.close();
        toast(`${result.deleted}개 대화를 영구 삭제했습니다.${result.pendingFiles||result.pendingCleanup ? " 일부 연결·파일 정리는 다시 확인해야 합니다." : ""}`);
      }catch(error){detail.textContent=error.message;confirm.disabled=false;}
    };
    const actions=contextElement("div",undefined,"session-delete-actions");actions.append(cancel,confirm);dialog.append(title,detail,note,actions);dialog.onclose=()=>dialog.remove();document.body.append(dialog);dialog.showModal();cancel.focus();
  }catch(error){toast(error.message);}
}
function bindSessionTitle(element,getRoomId) {
  element.classList.add("session-title");element.setAttribute("role","button");element.tabIndex=0;
  element.title="클릭하여 제목 변경";
  const open=()=>openSessionRename(getRoomId());
  element.addEventListener("click",open);
  element.addEventListener("keydown",event=>{if(["Enter"," "].includes(event.key)){event.preventDefault();open();}});
}
function openSessionRename(roomId) {
  const room=state.rooms.find(item=>item.id===roomId);if(!room||room.id===MONITOR_ROOM)return;
  if(room.role!=="owner"){toast("대화 소유자만 제목을 변경할 수 있어요.");return;}
  const userId=state.session?.user?.id,epoch=sidebarEpoch,dialog=sidebarDialog("대화 제목 변경");dialog.classList.add("session-edit-dialog");
  paintSession(dialog,sessionColors(state.rooms,state.forks).get(roomId));
  const form=contextElement("form"),label=contextElement("label","제목"),input=contextElement("input"),message=contextElement("p",undefined,"form-message"),actions=contextElement("div",undefined,"session-edit-actions");
  input.type="text";input.required=true;input.maxLength=80;input.value=room.name;input.autocomplete="off";label.append(input);message.setAttribute("role","alert");
  const cancel=contextElement("button","취소"),save=contextElement("button","저장");cancel.type="button";save.type="submit";cancel.onclick=()=>dialog.close();actions.append(cancel,save);form.append(label,message,actions);dialog.append(form);
  form.onsubmit=async event=>{
    event.preventDefault();if(save.disabled||state.session?.user?.id!==userId||sidebarEpoch!==epoch)return;
    const name=input.value.trim();if(!name){message.textContent="제목을 입력해주세요.";input.focus();return;}
    setBusy(save,true,"저장 중…");
    try {
      const result=await api(`/api/rooms/${encodeURIComponent(roomId)}`,{method:"PATCH",body:JSON.stringify({name})});
      if(state.session?.user?.id!==userId||sidebarEpoch!==epoch)return;
      const current=state.rooms.find(item=>item.id===roomId);if(current)Object.assign(current,result.room);
      if(state.selectedRoom===roomId){els.roomTitle.textContent=result.room.name;if(state.roomData?.room)state.roomData.room.name=result.room.name;}
      state.extra.forEach((pane,index)=>{if(pane.roomId===roomId){if(pane.data?.room)pane.data.room.name=result.room.name;const title=$("h2",$$(".extra-pane")[index]);if(title)title.textContent=result.room.name;}});
      renderRooms();dialog.close();
    }catch(error){if(dialog.isConnected)message.textContent=error.message;}finally{setBusy(save,false);}
  };
  dialog.showModal();input.focus();input.select();
}
function openSessionColor(roomId) {
  const room=state.rooms.find(item=>item.id===roomId);if(!room||room.id===MONITOR_ROOM)return;
  const userId=state.session?.user?.id,epoch=sidebarEpoch,dialog=sidebarDialog("대화 색상");dialog.classList.add("session-edit-dialog");
  let choice=room.color||null;
  const automatic=sessionColors(state.rooms.map(item=>item.id===roomId?{...item,color:null}:item),state.forks).get(roomId);
  const message=contextElement("p",undefined,"form-message"),actions=contextElement("div",undefined,"session-edit-actions");
  message.setAttribute("role","alert");
  const preview=()=>paintSession(dialog,sessionColors(state.rooms.map(item=>item.id===roomId?{...item,color:choice}:item),state.forks).get(roomId));
  const picker=createSessionColorPicker({value:choice,automaticColor:rgbToHex(automatic?.tint.split(",").map(Number)),onChange:color=>{choice=color;preview();}});
  const cancel=contextElement("button","취소"),save=contextElement("button","저장");cancel.type=save.type="button";cancel.onclick=()=>dialog.close();save.onclick=async()=>{
    if(save.disabled||state.session?.user?.id!==userId||sidebarEpoch!==epoch||!picker.reportValidity())return;
    save.disabled=true;
    if(await updateRoomListPreference(room,{color:choice})){if(dialog.isConnected)dialog.close();}else{save.disabled=false;message.textContent="색상을 저장하지 못했습니다. 다시 시도해주세요.";}
  };actions.append(cancel,save);dialog.append(picker.element,message,actions);preview();dialog.showModal();
}
function openSessionActions(roomId, trigger) {
  const room = state.rooms.find(item => item.id === roomId);
  if (!room || room.id === MONITOR_ROOM) return;
  openComposerPicker(trigger, "대화 메뉴", [
    ...(room.role==="owner"?[{label:"제목 변경",select:()=>openSessionRename(room.id)}]:[]),
    {label:"색상 변경",detail:"내 화면의 대화 색상",select:()=>openSessionColor(room.id)},
    {label:room.pinned ? "고정 해제" : "상단에 고정", detail:"내 대화 목록", select:() => void updateRoomListPreference(room, {pinned:!room.pinned})},
    {label:room.archived ? "대화 복원" : "대화 삭제", danger:!room.archived, select:() => confirmRemoveConversation(room)},
  ]);
}
function syncSessionActions() {
  const room = state.rooms.find(item => item.id === state.selectedRoom), enabled = !!room && room.id !== MONITOR_ROOM;
  for (const selector of ["#room-share-button", "#room-actions-button"]) $(selector).disabled = !enabled;
  $(".topbar-actions").classList.toggle("no-conversation", !enabled);
}
function currentBranchId() {
  return state.focusPane > 0 ? state.extra[state.focusPane - 1]?.roomId : state.selectedRoom;
}
function sidebarOpenRoomIds() {
  return new Set([state.selectedRoom,...state.extra.slice(0,Math.max(0,state.layout-1)).map(pane=>pane.roomId)].filter(Boolean));
}
function branchBusy(id) {
  return pendingMessages.get(id)?.retrying || branchOperations.has(id) || modelChanges.has(id) || (state.selectedRoom === id && (state.sending || state.roomData?.busy)) || state.extra.some(pane => pane.roomId === id && (pane.sending || pane.data?.busy));
}
function updateBranchControls() {
  const id = currentBranchId(), room = state.rooms.find(item => item.id === id && !item.archived), available = room && id !== MONITOR_ROOM;
  const fork = $("#branch-fork"), merge = $("#branch-merge"), label = $("#branch-current");
  if (!fork) return;
  fork.disabled = !available || branchBusy(id);
  merge.disabled = !available || branchBusy(id) || !mergeCandidates(id).length;
  fork.setAttribute("aria-label", available ? `${room.name}에서 Fork` : "현재 가지에서 Fork");
  label.textContent = available ? room.name : "새 줄기에서 시작하세요";
}
function branchSvg(tag, attributes = {}) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}
function paintSession(element, color) {
  if (!element) return;
  const tokens={"--pane-tint":color?.tint,"--session-color":color?.color,"--session-accent":color?.accent,"--session-on-accent":color?.foreground};
  for(const [key,value] of Object.entries(tokens)) {if(value)element.style.setProperty(key,value);else element.style.removeProperty(key);}
}
function inheritSessionTheme(element,trigger) {
  const style=getComputedStyle(trigger);
  for(const token of ["--pane-tint","--session-color","--session-accent","--session-on-accent"]) {
    const value=style.getPropertyValue(token).trim();if(value)element.style.setProperty(token,value);else element.style.removeProperty(token);
  }
}
function syncSessionColors(colors = sessionColors(state.rooms, state.forks)) {
  dockPanels().forEach((panel, index) => paintSession(panel, colors.get(dockRoomAt(index))));
  paintSession($("#branch-current"), colors.get(currentBranchId()));
  paintSession($(".topbar"),colors.get(state.selectedRoom));
}
function focusSidebarBranch(roomId) {
  const changed=sidebarBranchFocus!==roomId;
  sidebarBranchFocus=roomId || null;
  const graphList=$(".branch-graph",els.roomList);if(!graphList)return;
  const graph=layoutBranches(state.rooms.filter(room=>room.id!==MONITOR_ROOM),state.forks,{order:sidebarState.roomOrder,query:sessionSearch});
  const geometry=branchGraphGeometry(graph,{focusRoomId:sidebarBranchFocus||currentBranchId(),visibleLaneCount:3});
  const paths=new Map(geometry.paths.map(path=>[branchEdgeKey(path.from,path.to),path]));
  const nodes=new Map(geometry.nodes.map(node=>[node.id,node]));
  const svg=$(".branch-lines",graphList);svg?.setAttribute("width",geometry.width);
  graphList.style.setProperty("--branch-rail",(geometry.width+4)+"px");
  for(const path of $$(".branch-path,.branch-path-hit",graphList)) {
    const item=paths.get(branchEdgeKey(path.dataset.branchFrom,path.dataset.branchTo));if(!item)continue;
    path.setAttribute("d",item.d);path.setAttribute("visibility",item.visible===false?"hidden":"visible");
    if(path.classList.contains("branch-path-hit"))path.setAttribute("tabindex",item.visible===false?"-1":"0");
  }
  const flow=branchFocus(graph,sidebarBranchFocus);
  for(const node of $$(".branch-node",graphList)) {
    const item=nodes.get(node.dataset.roomId);if(!item)continue;
    node.setAttribute("cx",item.x);node.setAttribute("visibility",item.visible===false?"hidden":"visible");
    node.classList.toggle("is-flow-focused",!!flow?.roomIds.has(item.id));node.classList.toggle("is-flow-muted",!!flow&&!flow.roomIds.has(item.id));
  }
  graphList.classList.toggle("has-branch-focus",!!flow);
  for(const row of $$(".branch-row",graphList)) {
    row.classList.toggle("is-flow-focused",!!flow?.roomIds.has(row.dataset.roomId));
    row.classList.toggle("is-flow-muted",!!flow&&!flow.roomIds.has(row.dataset.roomId));
  }
  for(const path of $$(".branch-path",graphList)) {
    const active=!!flow?.edgeKeys.has(branchEdgeKey(path.dataset.branchFrom,path.dataset.branchTo));
    path.classList.toggle("is-flow-focused",active);path.classList.toggle("is-flow-muted",!!flow&&!active);
  }
  for(const hit of $$(".branch-path-hit",graphList)) hit.setAttribute("aria-pressed",String(sidebarBranchFocus===hit.dataset.roomId));
  if(changed&&roomId)$$(".branch-row",graphList).find(row=>row.dataset.roomId===roomId)?.scrollIntoView({block:"nearest",behavior:"instant"});
}
function renderRooms() {
  const focus = els.roomList.contains(document.activeElement) ? {roomId: document.activeElement.dataset.roomId, action: document.activeElement.dataset.branchAction, from:document.activeElement.dataset.branchFrom} : null;
  renderAccountTools(); els.roomList.replaceChildren(); updateBranchControls(); syncSessionActions();
  els.roomList.onclick=event=>{if(event.target===els.roomList)focusSidebarBranch(null);};
  els.roomList.onkeydown=event=>{if(event.key==="Escape"){event.stopPropagation();focusSidebarBranch(null);}};
  const colors = sessionColors(state.rooms, state.forks);
  const openIds = sidebarOpenRoomIds(), focusedId = currentBranchId();
  const graph = layoutBranches(state.rooms.filter(room => room.id !== MONITOR_ROOM), state.forks, {order:sidebarState.roomOrder,query:sessionSearch});
  const graphList = document.createElement("div"); graphList.className = "branch-graph";
  const geometry = branchGraphGeometry(graph,{focusRoomId:sidebarBranchFocus||focusedId,visibleLaneCount:3});
  graphList.style.setProperty("--branch-rail", (geometry.width+4) + "px");
  const svg = branchSvg("svg", {class:"branch-lines is-windowed", width:geometry.width, height:geometry.height, role:"group", "aria-label":"대화 연결선"});
  const byId = new Map(graph.rows.map(row => [row.id,row]));
  for (const edge of geometry.paths) {
    svg.append(branchSvg("path", {d:edge.d, "data-branch-from":edge.from, "data-branch-to":edge.to, "aria-hidden":"true", style:`--branch-color:${colors.get(edge.to)?.color || "currentColor"}`, class:`branch-path${edge.secondary ? " is-merge" : ""}${edge.from===currentBranchId()||edge.to===currentBranchId()?" is-current":""}`}));
  }
  for (const edge of geometry.paths) {
    const hit=branchSvg("path",{d:edge.d,class:"branch-path-hit",style:`--branch-color:${colors.get(edge.to)?.color || "currentColor"}`,role:"button",tabindex:0,"data-room-id":edge.to,"data-branch-from":edge.from,"data-branch-to":edge.to,"data-branch-action":"focus-flow","aria-label":`${byId.get(edge.from)?.room.name}에서 ${byId.get(edge.to)?.room.name}로 이어지는 흐름 강조`,"aria-pressed":"false"});
    hit.onclick=event=>{event.stopPropagation();focusSidebarBranch(sidebarBranchFocus===edge.to?null:edge.to);};
    hit.onkeydown=event=>{if(event.key==="Enter"||event.key===" "){event.preventDefault();event.stopPropagation();focusSidebarBranch(sidebarBranchFocus===edge.to?null:edge.to);}};
    svg.append(hit);
  }
  for(const node of geometry.nodes)svg.append(branchSvg("circle",{cx:node.x,cy:node.y,r:1.75,class:`branch-node${node.id===focusedId?" is-current":""}`,"data-room-id":node.id,"aria-hidden":"true",style:`--branch-color:${colors.get(node.id)?.color||"currentColor"}`}));
  graphList.onclick=event=>{if(event.target===graphList||event.target===svg)focusSidebarBranch(null);};
  graphList.onkeydown=event=>{if(event.key==="Escape"){event.stopPropagation();focusSidebarBranch(null);}};
  for (const row of graph.rows) {
    const open = openIds.has(row.id), active = open && focusedId === row.id;
    const button = document.createElement("button"); button.type="button"; button.className="branch-row"; button.dataset.roomId=row.id; button.dataset.dockRoom=row.id;

    button.classList.toggle("is-open",open); button.classList.toggle("is-selected",active); button.classList.toggle("is-ancestor",!row.matched); if(active)button.setAttribute("aria-current","page");
    const copy=document.createElement("span"); copy.className="branch-row-copy";
    const name=document.createElement("strong"); name.textContent=branchDisplayName(row);
    if(row.room.pinned){const pin=icon("pin");pin.classList.add("branch-pin");pin.setAttribute("aria-label","고정됨");name.prepend(pin);}
    const meta=document.createElement("small"), parentNames=row.parents.map(id=>byId.get(id)?.room.name).filter(Boolean);
    const relation=row.operation==="merge"?"Merge":row.operation==="fork"?"Fork":"줄기";
    const branchIndex=state.forks.find(link=>link.id===row.id)?.branchIndex;
    meta.textContent=(row.operation==="merge"?"합친 대화":row.operation==="fork"?(branchIndex?`가지 ${branchIndex}`:"이어진 대화"):"")+(row.room.pinned?" · 고정":"");
    button.title = "드래그: 목록 사이에서 순서 이동 · 제목 위에서 Merge · 대화 영역에서 분할";
    button.setAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown");
    button.setAttribute("aria-label", `${row.room.name}, ${relation}${parentNames.length?", "+parentNames.join(" 및 ")+"에서 이어짐":""}${active?", 현재 가지":open?", 열린 대화":""}`);
    copy.append(name,meta); button.append(copy);
    const grip=document.createElement("span");grip.className="session-drag-handle";grip.setAttribute("aria-hidden","true");grip.title="잡고 이동";grip.innerHTML='<svg viewBox="0 0 24 24"><path d="M8 5v14m8-14v14M5 8l3-3 3 3m2 8 3 3 3-3"/></svg>';button.append(grip);
    paintSession(button, colors.get(row.id));
    button.onclick=event=>{if(event.target.closest(".session-drag-handle"))return;focusSidebarBranch(row.id);if(state.focusPane>0)assignExtra(state.focusPane-1,row.id);else void selectRoom(row.id);closeSidebar();};
    graphList.append(button);
  }
  graphList.prepend(svg); els.roomList.append(graphList);
  if (!graph.rows.length) { const empty=document.createElement("p");empty.className="search-empty";empty.textContent=sessionSearch?"검색한 세션이 없습니다.":"위의 + 버튼으로 새 세션을 시작하세요.";els.roomList.append(empty); }
  const archived = state.rooms.filter(room => room.archived && room.id !== MONITOR_ROOM && (!sessionSearch || room.name.toLocaleLowerCase().includes(sessionSearch.toLocaleLowerCase())));
  if (archived.length) {
    const section=document.createElement("section"); section.className="branch-archive-section";
    const toggle=document.createElement("button");toggle.type="button";toggle.className="branch-archive-toggle";toggle.dataset.branchAction="archive-toggle";
    toggle.textContent=(showDeletedRooms?"보관된 대화 접기":"보관된 대화 더보기")+` (${archived.length})`;
    toggle.setAttribute("aria-expanded",String(showDeletedRooms));toggle.setAttribute("aria-controls","archived-conversation-list");
    toggle.onclick=()=>{showDeletedRooms=!showDeletedRooms;renderRooms();};section.append(toggle);
    const list=document.createElement("div");list.id="archived-conversation-list";list.hidden=!showDeletedRooms;
    if(showDeletedRooms) for(const room of archived) {
      const row=document.createElement("div");row.className="branch-archive-row";
      const name=document.createElement("span");name.className="branch-archive-name";name.textContent=room.name;name.title=room.name;
      const restore=document.createElement("button");restore.type="button";restore.className="branch-restore";restore.textContent="복원";restore.dataset.roomId=room.id;restore.dataset.branchAction="restore";
      restore.setAttribute("aria-label",room.name+" 복원");restore.onclick=async()=>{restore.disabled=true;await updateRoomListPreference(room,{archived:false});if(restore.isConnected)restore.disabled=false;};
      row.append(name,restore);list.append(row);
    }
    section.append(list);els.roomList.append(section);
  }
  focusSidebarBranch(sidebarBranchFocus);
  syncSessionColors(colors);
  syncSessionActivity();
  if(focus){const target=$$(focus.action==="focus-flow"?".branch-path-hit":"button",els.roomList).find(button=>button.dataset.roomId===focus.roomId&&button.dataset.branchAction===focus.action&&button.dataset.branchFrom===focus.from);target?.focus({preventScroll:true});}
}
function openArchivedConversations() {
  showDeletedRooms=true;renderRooms();
  const toggle=$(".branch-archive-toggle",els.roomList);
  if(toggle){toggle.scrollIntoView({block:"nearest",behavior:"smooth"});toggle.focus({preventScroll:true});}
  else toast("보관된 대화가 없습니다.");
}
function touchConversation(id) {
  if(id && id!==MONITOR_ROOM) void api(`/api/rooms/${encodeURIComponent(id)}/touch`,{method:"POST",body:"{}"}).catch(()=>{});
}
function showEmpty() {
  modelFailoverUI?.reset();
  cancelActiveRecording();
  disposeTranscript(els.messages);
  closeComposerPicker();
  clearPendingAttachments();
  state.selectedRoom = null;
  loginUI?.reset();
  state.roomData = null;
  state.extra.forEach(pane => clearAttachmentDraft(pane)); state.extra = []; state.layout = 1; state.focusPane = 0;
  $$(".extra-pane").forEach(pane => { disposeTranscript(pane.querySelector(".message-list")); pane._desktop?.destroy(); pane.remove(); });
  dockRects = [{x:0,y:0,w:1,h:1}]; $("#pane-grid").dataset.panes = "1"; applyDockLayout();
  desktopUI?.setRoom(null);
  stopPolling();
  els.empty.classList.remove("is-hidden");
  els.roomView.classList.add("is-hidden");
  $("#room-invite-button").classList.add("is-hidden");
  els.mobileRoomTitle.textContent = "대화를 선택하세요";
  renderRooms();
}
async function selectRoom(id) {
  closeComposerPicker();
  if (!id) return;
  touchConversation(id);
  closeContextPopover();
  const previous = state.selectedRoom;
  if(previous!==id && !matchMedia("(prefers-reduced-motion: reduce)").matches) els.roomView.animate([{opacity:.35,transform:"translateY(7px)"},{opacity:1,transform:"translateY(0)"}],{duration:320,easing:"cubic-bezier(.2,.8,.2,1)"});
  state.extra.forEach((pane) => {
    if (pane.roomId === id) { clearAttachmentDraft(pane); pane.roomId = previous && previous !== id ? previous : null; }
  });
  state.selectedRoom = id;
  loginPollEpoch++; loginPollBusy=false; loginUI?.sync([]);
  focusSidebarBranch(id);
  $("#message-input").disabled=state.sending;
  notificationUI?.markRoomRead(id);
  clearThinking(els.sendingStatus);
  const prefs = roomPreferences(id);
  $("#model-select").dataset.chosen = prefs.model || "";
  $("#effort-select").value = prefs.effort || "";
  applyModels(state.models);
  try {
    sessionStorage.setItem("community-room:" + state.session.user.id, id);
  } catch {}
  state.roomData = null;
  messageQueueUI?.render($("#composer-form"), id);
  modelFailoverUI?.render($("#composer-form"),id,null);
  syncProgressStreams();
  cancelActiveRecording();
  clearPendingAttachments();
  desktopUI?.setRoom(id);
  disposeTranscript(els.messages);
  els.messages.replaceChildren();
  els.memberList.replaceChildren();
  els.memberCount.textContent = "0";
  renderRooms();
  els.empty.classList.add("is-hidden");
  els.roomView.classList.remove("is-hidden");
  const room = state.rooms.find((item) => item.id === id);
  if (room) {
    els.roomTitle.textContent = room.id===MONITOR_ROOM?"대시보드":room.name;
    els.mobileRoomTitle.textContent = room.name;
    els.roomDescription.textContent = room.description || "";
    const canInvite = room.id !== MONITOR_ROOM && room.role === "owner" && (room.sharing?.canInvite || room.sharing?.canCreateSharedCopy || !room.personal);
    els.roomKicker.textContent = room.personal ? "개인 비서 · 연결 서비스" : canInvite ? "방장" : "공동 대화";
    $("#room-invite-button").classList.toggle("is-hidden", !canInvite);
  }
  els.roomView.classList.toggle("is-host-dashboard", id === MONITOR_ROOM);
  if (state.layout > 1) {
    renderExtraPanes();
    refreshExtras();
  }
  await refreshRoom(true);
  startPolling();
}
function renderHostDashboard(snapshot) {
  const panel = document.createElement("section");
  panel.className = "host-dashboard";
  const element = (tag, text, className) => { const node=document.createElement(tag); node.textContent=text; if(className)node.className=className; return node; };
  panel.append(element("h2", "서버 대시보드"), element("p", "연결된 호스트 전체 사용량", "host-subtitle"));
  if (!snapshot.available || snapshot.scope !== "a1-host") {
    panel.append(element("p", "최신 서버 상태를 받지 못했습니다. 잠시 후 자동으로 다시 확인합니다.", "host-warning"));
  } else {
    const format = n => Number(n).toFixed(1);
    const cards = element("div", "", "host-cards");
    const metrics = [
      ["CPU", `${format(snapshot.cpuUsedPercent)}%`, `${snapshot.cpuCount} OCPU 전체`, snapshot.cpuUsedPercent],
      ["메모리", `${format(snapshot.memoryUsedGiB)} GiB`, `OS 사용 가능 ${format(snapshot.memoryTotalGiB)} GiB`, snapshot.memoryUsedGiB / snapshot.memoryTotalGiB * 100],
      ["전체 디스크", `${format(snapshot.diskUsedPercent)}%`, `${format(snapshot.diskUsedGiB)} / ${format(snapshot.diskTotalGiB)} GiB 사용`, snapshot.diskUsedPercent],
    ];
    for (const [label,value,detail,percent] of metrics) {
      const card=element("article", "", "host-card");
      card.append(element("h3",label),element("strong",value),element("p",detail));
      const meter=document.createElement("progress"); meter.max=100; meter.value=Math.min(100,Math.max(0,percent)); meter.setAttribute("aria-label",label+" 사용률");card.append(meter);cards.append(card);
    }
    panel.append(cards);
    const storage=element("section","","host-storage");
    storage.append(element("h3","디스크 공간"),element("p",`파일시스템 여유 ${format(snapshot.diskFreeGiB)} GiB · 미할당 ${format(snapshot.diskUnallocatedGiB)} GiB`));
    if(snapshot.diskUnallocatedGiB>1) storage.append(element("p","미할당 공간은 파티션 확장 전까지 파일 저장에 사용할 수 없습니다.","host-subtitle"));
    for (const fs of snapshot.filesystems) {
      const row=element("div","","host-filesystem");
      row.append(element("strong",fs.mount),element("span",`${format(fs.usedGiB)} / ${format(fs.totalGiB)} GiB · 여유 ${format(fs.freeGiB)} GiB`));
      if(fs.usedPercent>=85) row.append(element("span","공간 부족 주의","host-warning"));
      storage.append(row);
    }
    panel.append(storage,element("p",`최근 측정 ${new Date(snapshot.timestamp).toLocaleString('ko-KR')} · 자동 갱신`,"host-subtitle"));
  }
  disposeTranscript(els.messages);
  els.messages.replaceChildren(panel);
}
async function refreshRoom(force = false) {
  const roomId = state.selectedRoom,
    userId = state.session?.user?.id;
  if (!roomId || (state.pollBusy && !force)) return;
  const request = ++state.roomRequest;
  const modelStateAtRequest=state.roomData?.modelControl;
  state.pollBusy = true;
  try {
    if (roomId === MONITOR_ROOM) {
      const snapshot = await api("/api/admin/monitor");
      if (state.selectedRoom === roomId && request === state.roomRequest) renderHostDashboard(snapshot);
      return;
    }
    const data = await api(`/api/rooms/${encodeURIComponent(roomId)}`);
    if (
      state.selectedRoom !== roomId ||
      state.session?.user?.id !== userId ||
      request !== state.roomRequest
    )
      return;
    if(data.busy&&!data.modelControl&&state.roomData?.modelControl!==modelStateAtRequest)data.modelControl=state.roomData?.modelControl;
    data.modelControl = latestModelControl(state.roomData?.modelControl,data.modelControl);
    const unchanged = JSON.stringify(state.roomData) === JSON.stringify(data);
    state.roomData = data;
    notificationUI?.observeRoom(data, { userId });
    observeRoomOutcome(data);
    syncProgressStreams();
    if (!unchanged) {
      renderRoom(data);
    }
  } catch (error) {
    if (request !== state.roomRequest) return;
    if (error.status === 401) {
      state.session = null;
      showAuth();
    } else {
      if (error.status === 403 || error.status === 404) {
        state.roomData = null;
        syncProgressStreams();
        clearThinking(els.sendingStatus);
      }
      toast(error.message);
    }
  } finally {
    if (request === state.roomRequest) state.pollBusy = false;
  }
}
function syncSessionActivity() {
  for(const row of $$(".branch-row",els.roomList)) {
    const id=row.dataset.roomId, room=state.rooms.find(room=>room.id===id);
    const pane=state.extra.find(pane=>pane.roomId===id);
    const busy=(state.selectedRoom===id?state.sending||state.roomData?.busy:pane?.sending||pane?.data?.busy)||room?.busy;
    row.classList.toggle("is-working",!!busy);
    if(busy)row.setAttribute("aria-description","작업 진행 중");else row.removeAttribute("aria-description");
  }
}
async function refreshSidebarActivity() {
  const userId=state.session?.user?.id,epoch=sidebarEpoch;if(!userId||state.activityBusy||document.hidden)return;
  state.activityBusy=true;
  try {
    const data=await api("/api/rooms/activity");
    if(userId!==state.session?.user?.id||epoch!==sidebarEpoch)return;
    const activity=new Map(data.rooms.map(room=>[room.id,room.busy]));
    for(const room of state.rooms)room.busy=!!activity.get(room.id);
    syncSessionActivity();
  } catch { /* The next normal poll retries; unavailable status is not a chat error. */ }
  finally {state.activityBusy=false;}
}
async function refreshBrowserLogins() {
  const actor=state.session?.user,roomId=currentBranchId(),epoch=loginPollEpoch;
  if(!actor?.hostAdmin || !roomId) { loginUI?.reset(); return; }
  if(loginPollBusy)return;
  loginPollBusy=true;
  try {
    const data=await api("/api/browser-logins");
    if(epoch!==loginPollEpoch || actor.id!==state.session?.user?.id || roomId!==currentBranchId())return;
    loginUI?.sync(data.requests);
  } catch { /* A normal poll retries without putting private errors in chat. */ }
  finally { if(epoch===loginPollEpoch)loginPollBusy=false; }
}
function startPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  void refreshBrowserLogins();
  state.pollTimer = setInterval(() => {
    refreshRoom();
    refreshExtras();
    void refreshSidebarActivity();
    void refreshBrowserLogins();
  }, 3000);
}
function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
  stopProgressStreams();
}
function observeRoomOutcome(data) {
  const roomId=data?.room?.id; if(!roomId)return;
  const listed=state.rooms.find(room=>room.id===roomId);if(listed)listed.busy=!!data.busy;
  syncSessionActivity();
  const outcome=failedOutcome(data.messages);
  if(presenceTurns.has(roomId) && presenceTurns.get(roomId)!==outcome.humanId)presenceErrors.delete(roomId);
  presenceTurns.set(roomId,outcome.humanId);
  if(outcome.failed)presenceErrors.add(roomId);
  if(data.busy)presenceBusy.add(roomId);
  else if(presenceBusy.delete(roomId) && !outcome.failed &&
    data.messages?.findLast(message=>message.kind==="human" || message.kind==="bot")?.kind==="bot")agentPresence?.react("complete");
  const pending=pendingMessages.get(roomId);
  if(pending && (data.messages || []).some(message=>message.id===pending.id || (pending.clientNonceHash && message.clientNonceHash===pending.clientNonceHash)))pendingMessages.delete(roomId);
}
async function optimisticMessage(roomId, text, nonce, attachments = []) {
  const user=state.session?.user;if(!user)return;
  const message={id:"pending:"+nonce,kind:"human",authorId:user.id,author:user.displayName || user.username,text,createdAt:Date.now(),attachments,pending:"sending"};
  pendingMessages.set(roomId,message);
  paintPending(roomId, true);
  try {
    const bytes=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(user.id+":"+nonce));
    if(pendingMessages.get(roomId)===message)message.clientNonceHash=[...new Uint8Array(bytes)].map(x=>x.toString(16).padStart(2,"0")).join("");
  } catch { /* POST messageId still reconciles the outbox if digest is unavailable. */ }
  return message;
}
function renderConversation(list, messages, { pane = null, roomId = state.selectedRoom, busy = false, forceBottom = false, emptyTitle = "", emptyNote = "메시지를 보내 대화를 시작하세요." } = {}) {
  renderTranscript(list, messages, {
    roomId, busy, forceBottom,
    createMessage: (message, options) => createMessage(message, pane, roomId, options),
    updateMessage: (node, message) => {
      const avatar = node.querySelector(".avatar");
      if (message.kind === "human" && avatar) renderUserAvatar(avatar, messageProfile(message), message.author);
    },
    createThinking: () => thinkingRow(roomId),
    empty: () => {
      const node = document.createElement("div"); node.className = "message-empty";
      if (emptyTitle) { const title = document.createElement("strong"); title.textContent = emptyTitle; node.append(title); }
      const note = document.createElement("span"); note.textContent = emptyNote; node.append(note);
      return node;
    },
  });
}
function paintPending(roomId, forceBottom = false) {
  if (state.selectedRoom === roomId && state.roomData) renderRoom(state.roomData, forceBottom);
  state.extra.forEach((pane, index) => {
    if (pane.roomId !== roomId) return;
    const list = $$(".extra-pane")[index]?.querySelector(".message-list");
    if (list) renderConversation(list, mergePendingMessages(pane.data?.messages || [], pendingMessages.get(roomId)), { pane, roomId, busy: !!pane.data?.busy, forceBottom });
  });
}
function renderRoom(data, forceBottom = false) {
  if(data.room) {const room=state.rooms.find(r=>r.id===data.room.id);if(room&&room.name!==data.room.name){room.name=data.room.name;els.roomTitle.textContent=room.name;renderRooms();}}
  renderContextMeter(data.context);
  modelFailoverUI?.render($("#composer-form"),data.room.id,data.modelControl);
  messageQueueUI?.render($("#composer-form"), data.room.id, data.queue);
  renderConversation(els.messages, mergePendingMessages(data.messages || [], pendingMessages.get(data.room.id)), {
    roomId: data.room.id, busy: !!data.busy, forceBottom,
    emptyTitle: "아직 메시지가 없습니다.",
  });
  const members = data.members || [];
  els.memberCount.textContent = members.length;
  els.memberList.replaceChildren();
  members.forEach((member) => {
    const row = document.createElement("div");
    row.className = "member-row";
    const avatar = document.createElement("span");
    avatar.className = `avatar ${member.role === "owner" || member.role === "admin" ? "avatar-accent" : ""}`;
    renderUserAvatar(avatar,member);
    const copy = document.createElement("span");
    copy.className = "member-copy";
    const name = document.createElement("strong");
    name.textContent = member.displayName;
    const role = document.createElement("small");
    role.textContent =
      member.role === "owner"
        ? "방장"
        : member.role === "admin"
          ? "관리자"
          : "멤버";
    copy.append(name, role);
    row.append(avatar, copy);
    els.memberList.append(row);
  });
  els.roomView.classList.toggle("agent-working",!!data.busy);
  if (data.busy) {
    clearThinking(els.sendingStatus);
  } else if (!state.sending) {
    clearThinking(els.sendingStatus);
  }
}
// Public execution milestones only: labels come from actual server operations.
const progressStreams = new Map();
function visibleProgressRooms() {
  const visible = new Map();
  if (state.session?.user && state.selectedRoom && state.selectedRoom !== MONITOR_ROOM && state.roomData?.busy)
    visible.set(state.selectedRoom, state.roomData);
  for (const pane of state.extra) {
    if (state.session?.user && pane.roomId && pane.data?.room?.id === pane.roomId && pane.data.busy)
      visible.set(pane.roomId, pane.data);
  }
  return visible;
}
function stopProgressStreams() {
  for (const entry of progressStreams.values()) entry.source?.close();
  progressStreams.clear();
  clearThinking(els.sendingStatus);
  updateAgentPresence();
}
function addProgress(entry, event) {
  if (!event || typeof event.stage !== "string" || typeof event.label !== "string") return;
  const milestone = { stage: event.stage, label: event.label.slice(0, 240), at: event.at };
  if (entry.events.some(item => item.stage === milestone.stage && item.label === milestone.label && item.at === milestone.at)) return;
  entry.events.push(milestone);
  if (entry.roomId && milestone.stage === "error") presenceErrors.add(entry.roomId);
  entry.events.sort((a, b) => (Number(a.at) || 0) - (Number(b.at) || 0));
  entry.events = entry.events.slice(-40);
}
function refreshProgressRoom(roomId) {
  if (state.selectedRoom === roomId) void refreshRoom(true);
  state.extra.forEach((pane, index) => {
    if (pane.roomId === roomId) void refreshExtra(index);
  });
}
function syncProgressStreams() {
  const visible = visibleProgressRooms();
  for (const [roomId, entry] of progressStreams) {
    if (!visible.has(roomId)) {
      entry.source?.close();
      progressStreams.delete(roomId);
    }
  }
  for (const [roomId, data] of visible) {
    let entry = progressStreams.get(roomId);
    if (!entry) {
      entry = { roomId, events: [], source: null, retryAt: 0 };
      progressStreams.set(roomId, entry);
    }
    for (const event of Array.isArray(data.progress) ? data.progress : []) addProgress(entry, event);
    if (!entry.source && Date.now() >= entry.retryAt && typeof EventSource !== "undefined") {
      const userId = state.session?.user?.id;
      const source = new EventSource(`/api/rooms/${encodeURIComponent(roomId)}/progress`);
      entry.source = source;
      source.addEventListener("open", () => {
        if (progressStreams.get(roomId) !== entry || entry.source !== source) return;
        renderProgressRoom(roomId);
      });
      source.addEventListener("progress", event => {
        if (progressStreams.get(roomId) !== entry || entry.source !== source) return;
        try { const progress = JSON.parse(event.data); addProgress(entry, progress); notificationUI?.observeProgress(roomId, progress, { userId }); } catch { return; }
        renderProgressRoom(roomId);
      });
      source.addEventListener("model-control", event => {
        if(progressStreams.get(roomId)!==entry||entry.source!==source||state.session?.user?.id!==userId)return;
        try {renderModelControl(roomId,JSON.parse(event.data));} catch { /* Polling reconciles invalid events. */ }
      });
      source.addEventListener("done", () => {
        if (progressStreams.get(roomId) !== entry || entry.source !== source) return;
        source.close();
        entry.source = null;
        entry.retryAt = Date.now() + 3000;
        refreshProgressRoom(roomId);
      });
      source.addEventListener("error", () => {
        if (progressStreams.get(roomId) !== entry || entry.source !== source) return;
        // Recheck membership/session through the API; polling controls bounded retries.
        source.close();
        entry.source = null;
        entry.retryAt = Date.now() + 6000;
        renderProgressRoom(roomId);
        refreshProgressRoom(roomId);
      });
    }
    renderProgressRoom(roomId);
  }
  updateAgentPresence();
}
function latestModelControl(previous, incoming) {
  if (!previous || !incoming) return incoming ?? null;
  if (previous.runId === incoming.runId) return previous.sequence > incoming.sequence ? previous : incoming;
  return previous.startedAt > incoming.startedAt ? previous : incoming;
}
function renderModelControl(roomId, status) {
  if (state.selectedRoom === roomId && state.roomData?.room?.id === roomId) {
    state.roomData.modelControl=latestModelControl(state.roomData.modelControl,status);
    modelFailoverUI?.render($("#composer-form"),roomId,state.roomData.modelControl);
  }
  state.extra.forEach((pane,index)=>{
    if(pane.roomId!==roomId||pane.data?.room?.id!==roomId)return;
    pane.data.modelControl=latestModelControl(pane.data.modelControl,status);
    const form=$$(".extra-pane")[index]?.querySelector(".pane-composer");
    if(form)modelFailoverUI?.render(form,roomId,pane.data.modelControl);
  });
}
function renderProgressRoom(roomId) {
  updateAgentPresence();
  for (const target of $$("[data-progress-room]")) {
    if (target.dataset.progressRoom === roomId) renderProgressTarget(target, roomId);
  }
}
function updateAgentPresence() {
  const rooms = [{ roomId: state.selectedRoom, data: state.roomData }, ...state.extra.map(pane => ({ roomId: pane.roomId, data: pane.data?.room?.id === pane.roomId ? pane.data : null }))].filter(room => room.roomId && room.roomId !== MONITOR_ROOM);
  agentPresence?.set(resolveAgentPresence({
    sending: state.sending || state.extra.some(pane => pane.sending) || rooms.some(room=>pendingMessages.get(room.roomId)?.retrying),
    rooms: rooms.map(room => ({ busy: !!room.data?.busy, stage: (progressStreams.get(room.roomId)?.events || room.data?.progress || []).at(-1)?.stage })),
    hasError: rooms.some(room => presenceErrors.has(room.roomId)),
  }), Boolean(state.session?.user));
}
function renderProgressTarget(target, roomId) {
  const entry = progressStreams.get(roomId);
  const events = entry?.events || [];
  const label = events.at(-1)?.label || "진행 상황을 연결하는 중";
  const line = $(".think-line", target);
  if (line && line.textContent !== label) line.textContent = label;
}
function thinkParts() {
  const mark = document.createElement("span");
  mark.className = "think-mark";
  mark.setAttribute("aria-hidden", "true");
  for (let i = 0; i < 3; i += 1) mark.append(document.createElement("i"));
  const line = document.createElement("span");
  line.className = "think-line";
  const caret = document.createElement("span");
  caret.className = "think-caret";
  caret.setAttribute("aria-hidden", "true");
  return [mark, line, caret];
}
function showThinking(target, fixed, roomId = state.selectedRoom) {
  target.replaceChildren();
  target.classList.add("is-visible");
  const [mark, line, caret] = thinkParts();
  target.append(mark, line, caret);
  if (fixed) {
    delete target.dataset.progressRoom;
    line.textContent = fixed;
  } else {
    target.dataset.progressRoom = roomId;
    renderProgressTarget(target, roomId);
  }
}
function clearThinking(target) {
  target.replaceChildren();
  target.classList.remove("is-visible");
  delete target.dataset.progressRoom;
}
function thinkingRow(roomId = state.selectedRoom) {
  const article = document.createElement("article");
  article.className = "message message-bot message-thinking";
  article.setAttribute("aria-label", "에이전트 진행 상황");
  const body = document.createElement("div");
  body.className = "message-body";
  const bubble = document.createElement("div");
  bubble.className = "think-bubble";
  bubble.dataset.progressRoom = roomId;
  bubble.append(...thinkParts());
  renderProgressTarget(bubble, roomId);
  body.append(bubble);
  article.append(body);
  return article;
}
const animatedMessages = new Set();
function createMessage(message, pane = null, roomId = state.selectedRoom, { animate = true } = {}) {
  const article = document.createElement("article");
  if(message.id)article.dataset.messageId=message.id;
  if(message.pending)article.dataset.pending=message.pending;
  const own =
    message.kind === "human" && message.authorId === state.session?.user?.id;
  article.className = `message message-${message.kind}${own ? " message-own" : ""}`;
  if(animate && message.id && Date.now()-message.createdAt<15000 && !animatedMessages.has(message.id)){article.classList.add("message-enter");animatedMessages.add(message.id);if(animatedMessages.size>500)animatedMessages.delete(animatedMessages.values().next().value);}
  article.addEventListener("animationend", event => { if (event.target === article) article.classList.remove("message-enter"); });
  const avatar = document.createElement("div");
  avatar.className = `avatar ${message.kind === "bot" ? "avatar-bot" : ""}`;
  if (message.kind !== "bot") renderUserAvatar(avatar,messageProfile(message),message.author);
  const body = document.createElement("div");
  body.className = "message-body";
  const meta = document.createElement("div");
  meta.className = "message-meta";
  const author = document.createElement("strong");
  author.textContent =
    message.author || (message.kind === "system" ? "안내" : "알 수 없음");
  const time = document.createElement("time");
  time.textContent = new Intl.DateTimeFormat("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(message.createdAt));
  time.dateTime = new Date(message.createdAt).toISOString();
  time.title = formatDate(message.createdAt);
  meta.append(author, time);
  if (message.text) {
    const text = message.kind === "bot" ? renderMessageText(message.text) : document.createElement("p");
    if(message.kind !== "bot")text.textContent = message.text;
    body.append(text);
  }
  if (Array.isArray(message.attachments)) {
    const attachments = document.createElement("div");
    attachments.className = "message-attachments";
    message.attachments.forEach((attachment) => {
      if (!attachment || !attachment.url) return;
      if (attachment.kind === "image") {
        const image = document.createElement("img");
        image.src = attachment.url;
        image.alt = attachment.name || "첨부 이미지";
        image.loading = "lazy";
        image.decoding = "async";
        if (attachment.width > 0 && attachment.height > 0) {
          image.width = attachment.width; image.height = attachment.height;
          image.style.width = `min(${Math.min(220, attachment.width, 220 * attachment.width / attachment.height)}px, 55vw)`;
          image.style.height = "auto";
          image.style.objectFit = "contain";
        }
        image.addEventListener("click", () => {
          $("#image-dialog-image").src = attachment.url;
          $("#image-dialog-image").alt = attachment.name || "첨부 이미지";
          openDialog($("#image-dialog"));
        });
        attachments.append(image);
      } else if (attachment.kind === "audio") {
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.preload = "metadata";
        audio.src = attachment.url;
        audio.setAttribute("aria-label", attachment.name || "첨부 음성");
        attachments.append(audio);
      }
    });
    if (attachments.childElementCount) body.append(attachments);
  }
  if (message.kind !== "bot") article.append(avatar);
  if (!message.pending && roomId !== MONITOR_ROOM && message.id) {
    const actions = document.createElement("div"); actions.className = "message-actions";
    const copy = document.createElement("button"); copy.type = "button"; copy.append(icon("copy")); copy.title = "메시지 복사"; copy.setAttribute("aria-label", copy.title);
    copy.onclick = () => navigator.clipboard.writeText(message.text || "").then(() => toast("복사했습니다.")).catch(() => toast("복사하지 못했습니다."));
    const fork = document.createElement("button"); fork.type = "button"; fork.append(icon("fork")); fork.title = "여기서 포크 · 이 메시지까지를 줄기로 새 가지를 만듭니다"; fork.setAttribute("aria-label", "여기서 포크");
    fork.onclick = () => sessionAction("fork", pane, fork, message.id, roomId);
    actions.append(copy, fork); body.append(actions);
  }
  if (message.pending === "failed") {
    const failure = document.createElement("div"); failure.className = "message-send-error";
    const note = document.createElement("span"); note.textContent = message.readOnly ? "원본이 읽기 전용으로 바뀌어 보내지 않았어요. 내용을 복사해 새 가지에서 이어가세요." : "전송을 확인하지 못했어요.";
    const retry = document.createElement("button"); retry.type = "button"; retry.textContent = "다시 보내기";
    retry.dataset.retryRoomId = roomId; retry.disabled = !!message.readOnly || roomReadOnly(roomId);
    retry.onclick = () => retryPendingMessage(message);
    const discard = document.createElement("button"); discard.type = "button"; discard.textContent = "삭제";
    discard.setAttribute("aria-label", "보내지 못한 메시지 삭제");
    discard.onclick = () => discardPendingMessage(message, roomId);
    failure.append(note, retry, discard); body.append(failure);
  }
  article.append(body);
  return article;
}
async function retryPendingMessage(message) {
  const request = message.retry;
  if (!request || message.pending !== "failed" || message.retrying || message.readOnly || roomReadOnly(request.roomId) ||
      state.session?.user?.id !== request.userId || pendingMessages.get(request.roomId) !== message) return;
  const { roomId, userId, payload } = request;
  const retrySession = state.session;
  const sameSession = () => state.session?.user?.id === retrySession?.user?.id && state.session?.csrfToken === retrySession?.csrfToken;
  const current = () => sameSession() && pendingMessages.get(roomId) === message;
  message.retrying = true; message.pending = "sending";
  presenceErrors.delete(roomId);
  paintPending(roomId); updateModelAvailability(); agentPresence?.react("send");
  let accepted = false;
  try {
    const result = await api(`/api/rooms/${encodeURIComponent(roomId)}/messages`, { method: "POST", body: payload, retryable: true });
    accepted = true;
    if (!current()) return;
    const nonce = JSON.parse(payload).clientNonce;
    if (state.pendingSend?.nonce === nonce) state.pendingSend = null;
    for (const pane of state.extra) if (pane.pendingSend?.nonce === nonce) pane.pendingSend = null;
    if (result.messageId) message.id = result.messageId;
    if (result.queued) pendingMessages.delete(roomId);
    if (Array.isArray(result.models)) applyModels(result.models);
    if (state.selectedRoom === roomId) await refreshRoom(true);
    await Promise.all(state.extra.map((pane, index) => pane.roomId === roomId ? refreshExtra(index) : null));
    await loadRooms();
  } catch (error) {
    if (!current()) return;
    if (accepted) { toast("메시지는 접수됐습니다. 대화를 다시 불러오고 있어요."); return; }
    message.pending = "failed";
    if (error.code === "ROOM_READ_ONLY") { message.readOnly = true; markRoomReadOnly(roomId); }
    else presenceErrors.add(roomId);
    toast(error.message);
  } finally {
    message.retrying = false;
    if (sameSession() && (current() || accepted)) { paintPending(roomId); updateModelAvailability(); }
  }
}
function discardPendingMessage(message, roomId) {
  if (message.retrying || message.pending !== "failed" || pendingMessages.get(roomId) !== message) return;
  pendingMessages.delete(roomId); paintPending(roomId);
}
function roomReadOnly(roomId) {
  if (!roomId) return false;
  return !!(state.rooms?.find(room => room.id === roomId)?.readOnly ||
    (state.roomData?.room?.id === roomId && state.roomData.room.readOnly) ||
    state.extra?.some(pane => pane.roomId === roomId && pane.data?.room?.id === roomId && pane.data.room.readOnly));
}
function markRoomReadOnly(roomId) {
  const rooms = [state.rooms?.find(room => room.id === roomId), state.roomData?.room,
    ...state.extra.map(pane => pane.data?.room)];
  for (const room of rooms) if (room?.id === roomId) { room.readOnly = true; room.readOnlyReason = "forked"; }
}
function recoverReadOnlySend(error, {roomId, pane = null, input, text, attachmentGeneration, pending}) {
  if (error.code !== "ROOM_READ_ONLY") return false;
  markRoomReadOnly(roomId);
  const owner = pane || state;
  owner.pendingSend = null;
  if (pending) { pending.pending = "failed"; pending.readOnly = true; }
  // Only restore into the exact draft that sent this request. A late response
  // must not overwrite another room's draft or discard its attachments.
  if (contextOwnerCurrent(roomId, state.session?.user?.id, pane) && owner.attachmentGeneration === attachmentGeneration && !input.value) {
    input.value = text;
    if (pane) pane.draft = text;
    if (pendingMessages.get(roomId) === pending) pendingMessages.delete(roomId);
  }
  paintPending(roomId); toast(error.message);
  return true;
}
function clearPendingAttachments(pane = null) {
  clearAttachmentDraft(pane || state);
  renderPendingAttachments(pane);
}
function cancelActiveRecording() { composerRecorder?.cancel(); }
function renderPendingAttachments(pane = null) {
  const owner = pane || state;
  const section = pane ? $$(".extra-pane")[state.extra.indexOf(pane)] : null;
  const list = pane ? section && $(".attachment-list", section) : $("#attachment-list");
  if (!list) return;
  list.replaceChildren();
  (owner.pendingAttachments || []).forEach((item) => {
    const card = document.createElement("div");
    card.className = `attachment-card${item.error ? " is-error" : ""}`;
    if (item.kind === "image" && item.previewUrl) {
      const image = document.createElement("img");
      image.src = item.previewUrl;
      image.alt = item.name;
      card.append(image);
    } else if (item.kind === "audio" && item.previewUrl && !item.error) {
      const audio = document.createElement("audio");
      audio.controls = true;
      audio.src = item.previewUrl;
      card.append(audio);
    }
    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = item.error || (item.uploading ? `${item.name} · 업로드 중…` : item.name);
    card.append(name);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.setAttribute("aria-label", `${item.name} 첨부 제거`);
    remove.disabled = !!owner.sending;
    remove.append(icon("close"));
    remove.addEventListener("click", () => {
      if (owner.sending) return;
      removeAttachmentDraft(owner, item);
      renderPendingAttachments(pane);
    });
    card.append(remove);
    list.append(card);
  });
}
async function uploadAttachments(files, pane = null, signal = null) {
  if (composerBlocked(pane)) return;
  const owner = pane || state;
  const roomId = pane ? pane.roomId : state.selectedRoom;
  const userId = state.session?.user?.id;
  return uploadAttachmentFiles({
    files, owner, roomId, signal,
    isCurrent: () => !!userId && state.session?.user?.id === userId &&
      (pane ? state.extra.includes(pane) && pane.roomId === roomId : state.selectedRoom === roomId),
    changed: () => renderPendingAttachments(pane),
    notify: toast,
    upload: (file, name, signal) => {
      const form = new FormData();
      form.append("file", file, name);
      return api(`/api/rooms/${encodeURIComponent(roomId)}/attachments`, { method: "POST", body: form, signal });
    },
  });
}
function pasteAttachments(event, pane = null) {
  pasteComposerImages(event, { enabled: !composerBlocked(pane), upload: files => uploadAttachments(files, pane) });
}
let composerRecorder;
function recordingCurrent(context) {
  const owner=context.pane||state;
  return contextOwnerCurrent(context.roomId,context.userId,context.pane) &&
    context.csrfToken===state.session?.csrfToken && owner.attachmentGeneration===context.attachmentGeneration && !roomReadOnly(context.roomId);
}
function recordingBlocksSend(pane=null) {
  if(composerRecorder?.context?.pane!==pane||composerRecorder.status==="idle")return false;
  toast("녹음을 마치거나 취소한 뒤 보내주세요.");return true;
}
function syncRecordingButtons() {
  if (composerRecorder?.status !== "idle" && composerRecorder?.context && roomReadOnly(composerRecorder.context.roomId)) composerRecorder.cancel();
  for(const button of $$(".record-button")) {
    const pane=button._pane||null, active=composerRecorder?.context?.pane===pane && composerRecorder.status!=="idle";
    const status=active?composerRecorder.status:"idle";
    button.classList.toggle("is-recording",status==="recording");
    button.disabled=status==="requesting"||status==="stopping"||status==="uploading"||(!active&&!!composerBlocked(pane));
    const label=status==="recording"?"음성 녹음 중지":status==="requesting"?"마이크 권한 확인 중":status==="stopping"||status==="uploading"?"녹음 첨부 중":"음성 녹음 시작";
    button.setAttribute("aria-label",label);button.title=label;
    const cancel=$(".record-cancel-button",button.closest("form"));if(cancel)cancel.hidden=!active;
  }
}
function toggleRecording(pane=null) {
  if(voiceUI?.roomId){toast("통화가 끝난 뒤 녹음을 첨부할 수 있어요.");return;}
  if(!composerRecorder)composerRecorder=createComposerRecorder({
    isCurrent:recordingCurrent,upload:(files,context,{signal})=>uploadAttachments(files,context.pane,signal),onState:syncRecordingButtons,notify:toast,
  });
  if(composerRecorder.status!=="idle") {
    if(composerRecorder.context.pane===pane)void composerRecorder.stop();
    else toast("다른 입력창의 녹음을 먼저 마쳐주세요.");
    return;
  }
  if(composerBlocked(pane))return;
  const owner=pane||state;
  void composerRecorder.start({pane,roomId:pane?pane.roomId:state.selectedRoom,userId:state.session?.user?.id,csrfToken:state.session?.csrfToken,attachmentGeneration:owner.attachmentGeneration});
}
function topicChoiceDialog() {
  return new Promise(resolve=>{
    const dialog=sidebarDialog("다른 일을 시작하시나요?");dialog.classList.add("topic-choice-dialog");
    const note=document.createElement("p");note.textContent="이전 내용을 이어서 가지치기할까요, 아예 새 대화로 시작할까요?";
    const choices=document.createElement("div");choices.className="topic-choice-buttons";
    let answer="cancel";
    for(const [value,title,description] of [["fork","이전 내용 이어서","지금까지의 내용을 가지고 새 가지에서 시작해요."],["new","새로 시작","이전 내용 없이 빈 대화에서 시작해요."],["stay","여기서 계속","현재 대화에 그대로 보내요."]]) {
      const button=document.createElement("button");button.type="button";
      const label=document.createElement("strong"),detail=document.createElement("span");label.textContent=title;detail.textContent=description;button.append(label,detail);
      button.onclick=()=>{answer=value;dialog.close();};choices.append(button);
    }
    const cancel=document.createElement("button");cancel.type="button";cancel.textContent="취소";cancel.onclick=()=>dialog.close();
    dialog.append(note,choices,cancel);dialog.addEventListener("close",()=>resolve(answer),{once:true});dialog.showModal();choices.firstChild.focus();
  });
}
// A conservative local suggestion keeps ordinary sends instant and never changes a room by itself.
async function offerTopicChoice(pane,draft) {
  const {roomId,data}=roomContextOwner(pane),userId=state.session?.user?.id;
  if(data?.busy || !data || data.room?.pendingTitle || roomId===MONITOR_ROOM || !suggestTopicSwitch({history:data.messages,draft}).suggest)return false;
  topicPrompts.add(roomId);
  const model=pane?.model??$("#model-select").value,effort=pane?.effort??$("#effort-select").value;
  const current=()=>contextOwnerCurrent(roomId,userId,pane);
  const sourceInput=pane?$("textarea",$$(".extra-pane")[state.extra.indexOf(pane)]):$("#message-input");
  let locked=false,lockedRoomId=roomId;
  try {
    const choice=await topicChoiceDialog();
    if(!current()||choice==="cancel")return true;
    if(choice==="stay")return false;
    if(roomContextOwner(pane).busy){toast("답변이 끝난 뒤 다시 보내 주세요.");return true;}
    sourceInput.disabled=true;locked=true;
    const result=await api(choice==="fork"?`/api/rooms/${encodeURIComponent(roomId)}/fork`:"/api/rooms",{method:"POST",body:JSON.stringify(choice==="fork"?{branching:true}:{})});
    if(!current())return true;
    if(result.pausedRoutineCount)toast("원본은 읽기 전용으로 남기고 루틴을 일시 중지했습니다.");
    saveRoomPreferences(result.room.id,{model,effort});
    await loadRooms();if(!current())return true;
    if(pane){
      const index=state.extra.indexOf(pane);assignExtra(index,result.room.id);pane.model=model;pane.effort=effort;pane.draft=draft;
      const form=$(".pane-composer",$$(".extra-pane")[index]);$("textarea",form).value=draft;
      await submitPane({preventDefault(){},currentTarget:form},index,true);
    }else{
      lockedRoomId=result.room.id;
      await selectRoom(result.room.id);if(!contextOwnerCurrent(result.room.id,userId))return true;
      $("#message-input").value=draft;await submitMessage({preventDefault(){}},true);
    }
    return true;
  }catch(error){if(current())toast(error.message);return true;}
  finally{topicPrompts.delete(roomId);if(locked&&sourceInput.isConnected&&contextOwnerCurrent(lockedRoomId,userId,pane))sourceInput.disabled=!!composerBlocked(pane);}
}
async function submitMessage(event, skipTopic = false) {
  event.preventDefault();
  if (composerBlocked() || recordingBlocksSend()) return;
  const sendSession = state.session;
  const sendCurrent = () => state.session?.user?.id === sendSession?.user?.id && state.session?.csrfToken === sendSession?.csrfToken;
  const input = $("#message-input"),
    text = input.value.trim();
  const attachments = state.pendingAttachments.filter((item) => item.attachment && !item.error);
  const attachmentGeneration = state.attachmentGeneration;
  const roomId = state.selectedRoom,
    botIds = state.selectedBots.slice(0, 1);
  if (pendingMessages.get(roomId)?.pending === "failed") { toast("보내지 못한 메시지를 다시 보내거나 삭제한 뒤 전송해 주세요."); return; }
  if (state.pendingAttachments.some((item) => item.uploading)) {
    toast("첨부 파일 업로드가 끝날 때까지 기다려주세요.");
    return;
  }
  if (state.pendingAttachments.some(item => item.error)) { toast("업로드하지 못한 첨부 파일을 제거한 뒤 다시 첨부해 주세요."); return; }
  if (!text && !attachments.length) return;
  if(topicPrompts.has(roomId))return;
  if(!skipTopic && !attachments.length && await offerTopicChoice(null,text))return;
  if(!sendCurrent() || state.selectedRoom!==roomId || composerBlocked())return;
  const attachmentIds = attachments.map((item) => item.attachment.id);
  const model = $("#model-select").value, effort = $("#effort-select").value;
  const signature = JSON.stringify({ roomId, text, botIds, attachmentIds, model, effort });
  if (state.pendingSend?.signature !== signature)
    state.pendingSend = { signature, nonce: crypto.randomUUID() };
  const payload = JSON.stringify({
    text,
    botIds,
    attachmentIds,
    clientNonce: state.pendingSend.nonce,
    model,
    effort,
    queueIfBusy: true,
  });
  const sendUserId=state.session?.user?.id;
  presenceErrors.delete(roomId);
  state.sending = true;
  updateModelAvailability();
  agentPresence?.react("send");
  $("#send-button").disabled = true;
  input.disabled = true;
  input.value=""; input.style.height="";
  const pending = state.roomData?.busy ? null : await optimisticMessage(roomId,text,state.pendingSend.nonce,attachments.map(item=>item.attachment));
  if (pending) pending.retry = Object.freeze({ roomId, userId: sendUserId, payload });
  let accepted=false;
  try {
    if (!sendCurrent()) return;
    const result = await api(`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: "POST",
      body: payload,
      retryable: true,
    });
    accepted=true;
    if(!sendCurrent())return;
    if(result.queued && pendingMessages.get(roomId)===pending)pendingMessages.delete(roomId);
    if(result.messageId && pending)pending.id=result.messageId;
    if(result.queued)paintPending(roomId);
    if (Array.isArray(result.models)) applyModels(result.models);
    state.pendingSend = null;
    if(state.selectedRoom===roomId && state.attachmentGeneration===attachmentGeneration)clearPendingAttachments();
    await refreshRoom(true);
    await loadRooms();
  } catch (error) {
    if(!sendCurrent())return;
    if(accepted){toast("메시지는 접수됐습니다. 대화를 다시 불러오고 있어요.");return;}
    if (recoverReadOnlySend(error, {roomId, input, text, attachmentGeneration, pending})) return;
    presenceErrors.add(roomId);
    if (pending) {
      pending.pending = "failed";
      state.pendingSend = null;
      if (state.selectedRoom === roomId && state.attachmentGeneration === attachmentGeneration) clearPendingAttachments();
    } else if (state.selectedRoom === roomId && !input.value) input.value = text;
    paintPending(roomId);toast(error.message);
  } finally {
    if(!sendCurrent())return;
    state.sending = false;
    $("#send-button").disabled = false;
    input.disabled = false;
    if (!state.roomData?.busy) clearThinking(els.sendingStatus);
    if(state.selectedRoom===roomId && !roomReadOnly(roomId))input.focus();
    updateModelAvailability();
  }
}
async function authSubmit(event, endpoint, buttonLabel) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  const message = els.authMessage;
  showMessage(message, "");
  setBusy(button, true, "확인 중…");
  try {
    state.session = await api(endpoint, {
      method: "POST",
      body: JSON.stringify(formDataObject(form)),
    });
    if (endpoint === "/api/register") inviteLinks.clear("site");
    form.reset();
    await enterWorkspace();
  } catch (error) {
    showMessage(message, error.message);
  } finally {
    setBusy(button, false, buttonLabel);
  }
}
function openDialog(dialog) {
  if (!dialog.open) dialog.showModal();
  const first = dialog.querySelector(
    "input:not([hidden]), textarea:not([hidden]), button:not(.modal-close)",
  );
  setTimeout(() => first?.focus(), 0);
}
function closeDialog(dialog) {
  if (dialog?.open) dialog.close();
}
let creatingSession=false;
async function startNewSession() {
  if(creatingSession)return;creatingSession=true;
  const userId=state.session?.user?.id,epoch=sidebarEpoch,current=()=>state.session?.user?.id===userId&&sidebarEpoch===epoch;
  try {const data=await api("/api/rooms",{method:"POST",body:JSON.stringify({})});if(!current())return;await loadRooms();if(!current())return;state.focusPane=0;await selectRoom(data.room.id);if(!current())return;closeSidebar();$("#message-input").focus();}
  catch(error){if(current())toast(error.message);}finally{creatingSession=false;}
}
async function resetConversations(button, dialog = null) {
  const userId=state.session?.user?.id,epoch=sidebarEpoch;if(!userId||button.disabled)return;
  if(state.rooms.some(room=>branchBusy(room.id))){toast("진행 중인 작업이 끝난 뒤 목록을 비워 주세요.");return;}
  setBusy(button,true,"비우는 중…");
  try {
    const data=await api("/api/sessions/reset",{method:"POST",body:"{}"});
    if(state.session?.user?.id!==userId||sidebarEpoch!==epoch)return;
    dialog?.close();stopProgressStreams();if(state.layout>1)setLayout(state.layout);
    dockRects=[{x:0,y:0,w:1,h:1}];applyDockLayout();showDeletedRooms=false;$("#message-input").value="";state.pendingSend=null;pendingMessages.clear();clearPendingAttachments();
    await loadRooms();if(state.session?.user?.id!==userId||sidebarEpoch!==epoch)return;await selectRoom(data.room.id);
    toast(`${data.archived||0}개 가지를 보관하고 새 줄기를 시작했습니다.`);
  } catch(error){if(state.session?.user?.id===userId&&sidebarEpoch===epoch)toast(error.message);}
  finally{if(button.isConnected)setBusy(button,false);}
}
async function openCapabilityHub() {
  let dialog=$("#capability-hub");
  if(!dialog){dialog=document.createElement("dialog");dialog.id="capability-hub";dialog.className="capability-hub";document.body.append(dialog);}
  dialog.replaceChildren();
  const title=document.createElement("h2");title.textContent="통합 관리";
  const close=document.createElement("button");close.textContent="닫기";close.onclick=()=>dialog.close();dialog.append(title,close);
  const sessions=document.createElement("section"), sessionTitle=document.createElement("h3"), sessionNote=document.createElement("p"), reset=document.createElement("button");
  sessionTitle.textContent="대화 세션";
  sessionNote.textContent="내 대화 목록을 비우고 새 세션을 시작합니다. 기존 기록은 ‘삭제한 대화’에서 복원할 수 있습니다.";
  reset.textContent="대화 목록 초기화";
  reset.onclick=()=>void resetConversations(reset,dialog);
  sessions.append(sessionTitle,sessionNote,reset);dialog.append(sessions);dialog.showModal();
  try {
    const data=await api("/api/admin/capabilities");
    for(const [name,items] of [["API",[...new Set(data.providers.map(p=>p.name))]],["Vault",data.services.map(s=>`${s.name} · ${s.configured?"키 등록됨":"미등록"}`)],["MCP",["연결된 MCP 서버 없음"]],["스킬",["실행 연결된 스킬 없음"]]]) {
      const section=document.createElement("section"),h=document.createElement("h3");h.textContent=name;section.append(h);
      for(const text of items){const row=document.createElement("p");row.textContent=text;section.append(row);}dialog.append(section);
    }
    const note=document.createElement("p");note.textContent=data.note;dialog.append(note);
  }catch(error){const note=document.createElement("p");note.textContent=error.message;dialog.append(note);}
}
const modelChanges = new Map();
function roomContextOwner(pane = null) {
  const roomId=pane?pane.roomId:state.selectedRoom,data=pane?pane.data:state.roomData;
  const working=!!(data?.busy||(pane?pane.sending:state.sending)||pendingMessages.get(roomId)?.retrying);
  const role=data?.room?.role || state.rooms?.find(room=>room.id===roomId)?.role;
  const readOnly = roomReadOnly(roomId);
  return {roomId,data,working,readOnly,busy:working||modelChanges.has(roomId)||branchOperations.has(roomId),canManage:role==="owner"&&!readOnly};
}
function contextOwnerCurrent(roomId, userId, pane = null) {
  return state.session?.user?.id === userId && (pane ? state.extra.includes(pane) && pane.roomId === roomId : state.selectedRoom === roomId);
}
async function refreshContextOwner(pane) {
  if (pane) await refreshExtra(state.extra.indexOf(pane));
  else await refreshRoom(true);
}
function mergeCandidates(roomId) {
  return state.rooms.filter(room => room.id !== roomId && room.id !== MONITOR_ROOM && !room.archived);
}
function branchDestination(pane = null, explicit = false) {
  const target = explicit && state.focusPane > 0 ? state.extra[state.focusPane-1] : pane;
  const selection = state.selectedRoom, focused=state.focusPane, targetId=target?.roomId, userId=state.session?.user?.id, epoch=sidebarEpoch;
  return {pane:target,userId,valid:()=>state.session?.user?.id===userId&&sidebarEpoch===epoch,current:()=>state.session?.user?.id===userId&&sidebarEpoch===epoch&&state.selectedRoom===selection&&state.focusPane===focused&&(!target||(state.extra.includes(target)&&target.roomId===targetId))};
}
async function openBranchResult(data, destination) {
  await loadRooms(); if(!destination.current())return;
  showDeletedRooms=false;
  if(destination.pane)assignExtra(state.extra.indexOf(destination.pane),data.room.id);else await selectRoom(data.room.id);
  renderRooms();closeSidebar();
  const message=data.contextTruncated?"맥락이 길어 일부만 이어받았습니다. 원본 가지에서 전체 기록을 볼 수 있어요.":data.createdRooms?.length>1?"원본은 읽기 전용으로 남기고 하위 대화 2개를 만들었습니다.":"새 가지를 만들었습니다. 원본은 그대로 남습니다.";
  toast(message+(data.pausedRoutineCount?" 원본의 루틴은 일시 중지했습니다.":""));
}
function mergeBranch(roomId, sourceId = null) {
  const room=state.rooms.find(item=>item.id===roomId&&!item.archived), branches=mergeCandidates(roomId);
  if(!room)return;
  if(roomId===MONITOR_ROOM){toast("대시보드는 합칠 수 없습니다.");return;}
  if(sourceId && !branches.some(branch=>branch.id===sourceId)){toast("합칠 대화를 다시 선택해 주세요.");return;}
  if(sourceId && branchBusy(sourceId)){toast("진행 중인 작업이 끝난 뒤 합쳐 주세요.");return;}
  if(branchBusy(roomId)){toast("진행 중인 작업이 끝난 뒤 합쳐 주세요.");return;}
  if(!branches.length){toast("함께 합칠 다른 대화가 없습니다.");return;}
  const destination=branchDestination(null,true),dialog=sidebarDialog("대화 합치기 · Merge"),form=document.createElement("form");dialog.classList.add("branch-merge-dialog");
  const note=document.createElement("p");note.className="sidebar-dialog-note";note.textContent="두 대화의 내용을 함께 이어갈 새 세션을 만듭니다. 원래 대화 두 개는 그대로 남습니다.";
  const label=document.createElement("label");label.textContent="함께 이어갈 가지";
  const select=document.createElement("select");select.required=true;
  for(const branch of branches){const option=document.createElement("option");option.value=branch.id;option.textContent=branch.name+" · "+branch.id.slice(0,8);option.disabled=branchBusy(branch.id);select.append(option);}
  const first=branches.find(branch=>branch.id===sourceId&&!branchBusy(branch.id))||branches.find(branch=>!branchBusy(branch.id));select.value=first?.id||"";label.append(select);
  const preview=document.createElement("p");preview.className="branch-merge-preview";
  const error=document.createElement("p");error.className="form-message";error.setAttribute("role","status");
  const actions=document.createElement("div");actions.className="sidebar-dialog-actions";
  const cancel=document.createElement("button");cancel.type="button";cancel.textContent="취소";cancel.onclick=()=>dialog.close();
  const submit=document.createElement("button");submit.type="submit";submit.textContent="합쳐서 새 세션 만들기";submit.disabled=!first;
  const update=()=>{preview.textContent=room.name+" + "+(branches.find(branch=>branch.id===select.value)?.name||"가지 선택")+" → 새 가지";};select.onchange=update;update();
  actions.append(cancel,submit);form.append(note,label,preview,error,actions);dialog.append(form);
  form.onsubmit=async event=>{
    event.preventDefault();const sourceId=select.value;
    if(submit.disabled||!destination.valid()||!mergeCandidates(roomId).some(branch=>branch.id===sourceId))return;
    if(branchBusy(roomId)||branchBusy(sourceId)){error.textContent="진행 중인 작업이 끝난 뒤 합쳐 주세요.";return;}
    branchOperations.add(roomId);branchOperations.add(sourceId);select.disabled=true;submit.disabled=true;updateModelAvailability();
    try{const data=await api(`/api/rooms/${encodeURIComponent(roomId)}/merge`,{method:"POST",body:JSON.stringify({sourceId})});if(!destination.valid())return;const follow=dialog.open;dialog.close();if(follow)await openBranchResult(data,destination);else await loadRooms();}
    catch(e){if(destination.valid()&&dialog.open)error.textContent=e.message;}
    finally{if(destination.valid()){branchOperations.delete(roomId);branchOperations.delete(sourceId);select.disabled=false;submit.disabled=false;updateModelAvailability();}}
  };
  dialog.showModal();if(sourceId)submit.focus();else select.focus();
}
async function sessionAction(action, pane = null, button = null, throughMessageId = null, expectedRoomId = null, explicitRoomId = null) {
  const owner=roomContextOwner(pane),roomId=explicitRoomId||owner.roomId,destination=branchDestination(pane,!!explicitRoomId);
  if(!roomId||roomId===MONITOR_ROOM||branchBusy(roomId)||(expectedRoomId&&expectedRoomId!==roomId)||!state.rooms.some(room=>room.id===roomId&&!room.archived))return;
  if(action!=="fork" && roomReadOnly(roomId))return;
  if(action==="compact"&&!owner.canManage)return;
  if(button)button.disabled=true;branchOperations.add(roomId);updateModelAvailability();
  try {
    const data=await api(`/api/rooms/${encodeURIComponent(roomId)}/${action}`,{method:"POST",body:JSON.stringify({...(throughMessageId?{throughMessageId}:{}),...(action==="fork"?{branching:true}:{})})});
    if(!destination.valid())return;
    if(action==="fork")await openBranchResult(data,destination);
    else if(destination.current()){await refreshContextOwner(pane);toast("기록은 보존하고 대화 맥락을 압축했습니다.");}
  }catch(error){if(destination.valid())toast(error.message);}
  finally{if(destination.valid()){branchOperations.delete(roomId);if(button?.isConnected)button.disabled=branchBusy(roomId);updateModelAvailability();}}
}
function contextNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value.toLocaleString("ko-KR") : "확인 불가";
}
function contextPercent(context) {
  return Math.min(100,Math.max(0,Math.round((context?.usedChars||0)/(context?.budgetChars||8000)*100)));
}
function contextElement(tag, text, className) {
  const element=document.createElement(tag);if(text!==undefined)element.textContent=text;if(className)element.className=className;return element;
}
function renderContextMeter(context, form = $("#composer-form"), pane = null) {
  if(!form)return;
  const toolbar=$(".model-controls",form);
  if(!toolbar)return;
  let bar=$(".context-controls",form);
  if(!bar) {
    bar=contextElement("div",undefined,"context-controls");
    const trigger=contextElement("button",undefined,"context-trigger");trigger.type="button";trigger.setAttribute("aria-label","컨텍스트 및 API 사용량");trigger.setAttribute("aria-haspopup","dialog");trigger.setAttribute("aria-expanded","false");
    const ring=contextElement("span",undefined,"context-ring"),label=contextElement("span",undefined,"context-label");ring.setAttribute("aria-hidden","true");label.setAttribute("aria-hidden","true");trigger.append(ring,label);trigger.onclick=()=>openContextPopover(trigger,pane);
    bar.append(trigger);toolbar.append(bar);
    if(!pane){bar.id="context-controls";trigger.id="context-usage-button";ring.id="context-ring";label.id="context-label";}
  }
  const percent=contextPercent(context), owner=roomContextOwner(pane);
  $(".context-ring",bar).style.setProperty("--context",percent+"%");
  $(".context-label",bar).textContent=percent+"%";
  bar.removeAttribute("title");
  $(".context-trigger",bar).disabled=!owner.roomId;
  if(contextPopover?.roomId===owner.roomId){renderPopoverContext(contextPopover.contextSection,context);contextPopover.compact.disabled=owner.busy||!owner.canManage||!(context?.usedChars>=500);}
  updateModelAvailability();
}
let contextPopover = null;
function closeContextPopover() {
  const open=contextPopover;if(!open)return;contextPopover=null;
  open.cancelled=true;open.abort.abort();open.trigger.setAttribute("aria-expanded","false");
  window.removeEventListener("resize",open.position);window.removeEventListener("scroll",open.position,true);
  try {if(open.native)open.element.hidePopover();else if(open.element.open)open.element.close();} catch {}
  open.element.remove();
}
function renderPopoverContext(section, context) {
  section.replaceChildren();
  const heading=contextElement("h3","대화에 담는 맥락"),amount=contextElement("strong",`${contextPercent(context)}%`,"context-popover-percent");
  const top=contextElement("div",undefined,"context-section-heading");top.append(heading,amount);
  const meter=document.createElement("progress");meter.max=100;meter.value=contextPercent(context);meter.setAttribute("aria-label","앱 대화 맥락 추정 사용률");
  const scale=contextElement("div",undefined,"context-scale");
  const budget=Math.round((context?.budgetChars||8000)/2);
  for(const fraction of [0,.25,.5,.75,1])scale.append(contextElement("span",contextNumber(Math.round(budget*fraction))));
  const tokens=contextElement("p",`약 ${contextNumber(context?.estimatedTokens)} / ${contextNumber(Math.round((context?.budgetChars||8000)/2))} 토큰 · 추정`,"context-muted");
  const breakdown=contextElement("div",undefined,"context-breakdown");
  for(const [label,value] of [["최근 대화",context?.messageTokens],["압축 요약",context?.summaryTokens]]) {
    const row=contextElement("div");row.append(contextElement("span",label),contextElement("span",`${contextNumber(value)} 토큰`));breakdown.append(row);
  }
  section.append(top,meter,scale,tokens,breakdown,contextElement("p","다음 답변에 전달할 대화의 추정량입니다. 모델의 전체 한도나 API 잔여량은 아닙니다.","context-note"));
}
function usageTime(value) {
  const date=new Date(value);return value!=null&&!Number.isNaN(date.getTime())?date.toLocaleString("ko-KR",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"}):"시각 확인 불가";
}
function renderUsageSection(section, usage) {
  section.replaceChildren(contextElement("h3","이 가지의 API 사용량"));
  const counts=contextElement("div",undefined,"context-usage-counts");
  for(const [label,value] of [["입력 토큰",usage.inputTokens],["출력 토큰",usage.outputTokens],["API 응답",usage.requests]]) {
    const item=contextElement("div");item.append(contextElement("strong",contextNumber(value)),contextElement("span",label));counts.append(item);
  }
  section.append(counts);
  if(usage.last) section.append(contextElement("p",`최근 ${usage.last.provider || "공급자 미제공"} · ${usage.last.model || "모델 미제공"}`,"context-note"));
  else section.append(contextElement("p","이 가지에서 아직 API 응답을 기록하지 않았습니다.","context-note"));
  const providers=(Array.isArray(usage.providers)?[...usage.providers]:[]).sort((a,b)=>new Date(b.at)-new Date(a.at));
  if(providers.length) {
    const quota=contextElement("section",undefined,"context-quota");quota.append(contextElement("h3","공급자 한도"));
    const selector=contextElement("select",undefined,"context-provider-select");selector.setAttribute("aria-label","공급자와 API 키 선택");
    providers.forEach((provider,index)=>{
      const slot=Number.isInteger(provider.keySlot)?provider.keySlot+1:"확인 불가";
      selector.append(new Option(`${provider.provider || "공급자"} · 키 ${slot}`,String(index)));
    });
    const values=contextElement("div");
    function showProvider() {
      const provider=providers[Number(selector.value)||0],name=String(provider.provider).toLowerCase(),groq=name==="groq";
      values.replaceChildren(contextElement("p",`${usageTime(provider.at)} 기준${groq?" · 조직 공유":name==="gemini"?" · 프로젝트 공유":""}`,"context-note"));
      for(const [key,label] of [["requests","요청"],["tokens","토큰"]]) {
        const limit=provider.limits?.[key],row=contextElement("div",undefined,"context-quota-row");
        const value=limit?`${contextNumber(limit.remaining)} / ${contextNumber(limit.limit)} 남음`:"공급자 미제공";
        row.append(contextElement("span",label+(groq?(key==="requests"?" / 일":" / 분"):"")),contextElement("span",value));values.append(row);
        if(limit?.reset!=null)values.append(contextElement("p",`갱신: ${String(limit.reset).slice(0,100)}`,"context-note"));
      }
      if(["requests","tokens"].some(key=>provider.limits?.[key]?.remaining==null||provider.limits?.[key]?.limit==null)) {
        const consoles={
          groq:["Groq 한도 확인","https://console.groq.com/settings/limits"],
          gemini:["AI Studio 한도 확인","https://aistudio.google.com/rate-limit"],
          huggingface:["Hugging Face 사용량 확인","https://huggingface.co/settings/inference-providers/overview"],
          nvidia:["NVIDIA API 콘솔 열기","https://build.nvidia.com/"],
        };
        const note=contextElement("p","API 응답에 없는 한도는 연결한 계정의 콘솔에서 확인해 주세요.","context-note");
        if(consoles[name]) {
          const [label,url]=consoles[name],link=contextElement("a",label);
          link.href=url;link.target="_blank";link.rel="noopener noreferrer";
          note.append(document.createElement("br"),link);
        }
        values.append(note);
      }
      contextPopover?.position();
    }
    selector.onchange=showProvider;showProvider();quota.append(selector,values);section.append(quota);
  }
  const scope=contextElement("details",undefined,"context-scope-note");scope.append(contextElement("summary","집계 기준"));
  scope.append(contextElement("p","기록 시작 이후 이 가지에서 받은 응답만 집계합니다. Fork 이전 사용량은 복사하지 않습니다.","context-note"));
  scope.append(contextElement("p","공급자 한도는 마지막 응답 시점의 값이며, 전체 계정 사용량·청구액·남은 크레딧은 포함하지 않습니다.","context-note"));
  scope.addEventListener("toggle",()=>contextPopover?.position());section.append(scope);
}
async function openContextPopover(trigger,pane) {
  if(contextPopover?.trigger===trigger){closeContextPopover();return;}
  closeContextPopover();closeComposerPicker();
  const {roomId,data}=roomContextOwner(pane),userId=state.session?.user?.id;if(!roomId)return;
  const native=typeof HTMLElement.prototype.showPopover==="function";
  const element=contextElement(native?"div":"dialog",undefined,"context-popover");element.setAttribute("role","dialog");element.setAttribute("aria-label","컨텍스트 및 API 사용량");if(native)element.setAttribute("popover","auto");
  const header=contextElement("header"),title=contextElement("h2","컨텍스트 및 API 사용량"),close=contextElement("button","×","context-popover-close");close.type="button";close.setAttribute("aria-label","사용량 닫기");close.onclick=closeContextPopover;header.append(title,close);
  const contextSection=contextElement("section"),usageSection=contextElement("section",undefined,"context-api-section");renderPopoverContext(contextSection,data?.context);usageSection.append(contextElement("p","API 기록을 확인하는 중…","context-muted"));
  const compact=contextElement("button","Compact · 대화 맥락 압축","context-compact-button"); compact.type="button";
  const owner=roomContextOwner(pane);compact.disabled=owner.busy||!owner.canManage||!(data?.context?.usedChars>=500);
  compact.title=owner.canManage ? "기록을 보존하고 다음 요청에 담을 맥락을 줄입니다" : "대화 소유자만 압축할 수 있습니다";
  compact.onclick=()=>sessionAction("compact",pane,compact);
  inheritSessionTheme(element,trigger);
  element.append(header,contextSection,compact,usageSection);document.body.append(element);
  const open={element,trigger,roomId,pane,userId,native,contextSection,compact,cancelled:false,abort:new AbortController()};
  open.position=()=>{
    if(!trigger.isConnected){closeContextPopover();return;}
    const rect=trigger.getBoundingClientRect(),width=element.offsetWidth,height=element.offsetHeight;
    element.style.left=Math.max(12,Math.min(innerWidth-width-12,rect.right-width))+"px";
    element.style.top=Math.max(12,Math.min(innerHeight-height-12,rect.top-height-10))+"px";
  };
  contextPopover=open;trigger.setAttribute("aria-expanded","true");
  if(native){element.addEventListener("toggle",event=>{if(event.newState==="closed"&&contextPopover===open)closeContextPopover();});element.showPopover();}
  else {element.addEventListener("close",()=>{if(contextPopover===open)closeContextPopover();});element.showModal();element.addEventListener("click",event=>{if(event.target===element){const r=element.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)closeContextPopover();}});}
  open.position();window.addEventListener("resize",open.position);window.addEventListener("scroll",open.position,true);
  try {
    const usage=await api(`/api/rooms/${encodeURIComponent(roomId)}/usage`,{signal:open.abort.signal});
    if(open.cancelled||contextPopover!==open||!contextOwnerCurrent(roomId,userId,pane))return;
    renderUsageSection(usageSection,usage);open.position();
  }catch(error){if(!open.cancelled){usageSection.replaceChildren(contextElement("p","API 기록을 불러오지 못했습니다. 다시 열어 확인해주세요.","context-note"));open.position();}}
}
async function createRoom(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  showMessage($("#room-form-message"), "");
  setBusy(button, true, "만드는 중…");
  try {
    const data = await api("/api/rooms", {
      method: "POST",
      body: JSON.stringify({
        name: $("#room-name").value.trim(),
        description: $("#room-description-input").value.trim(),
      }),
    });
    closeDialog($("#room-dialog"));
    await loadRooms();
    await selectRoom(data.room.id);
    toast("대화를 만들었습니다.");
  } catch (error) {
    showMessage($("#room-form-message"), error.message);
  } finally {
    setBusy(button, false, "만들기");
  }
}
async function joinRoom(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const button = $('button[type="submit"]', form);
  showMessage($("#join-form-message"), "");
  setBusy(button, true, "참여 중…");
  try {
    const data = await api("/api/rooms/join", {
      method: "POST",
      body: JSON.stringify({ token: $("#join-token").value.trim() }),
    });
    inviteLinks.clear("room");
    closeDialog($("#join-dialog"));
    await loadRooms();
    await selectRoom(data.room.id);
    toast("대화에 참여했습니다.");
  } catch (error) {
    showMessage($("#join-form-message"), error.message);
  } finally {
    setBusy(button, false, "참여하기");
  }
}
async function makeInvite(path, title) {
  const userId = state.session?.user?.id, epoch = sidebarEpoch;
  try {
    const data = await api(path, { method: "POST", body: "{}" });
    if(state.session?.user?.id !== userId || sidebarEpoch !== epoch)return;
    $("#invite-token").textContent = createInviteLink(title, data.token);
    $("#invite-expires").textContent = data.expiresAt
      ? `만료: ${formatDate(data.expiresAt)}`
      : "";
    $(".invite-modal h2").textContent =
      title === "site" ? "가입 초대 링크" : "대화 초대 링크";
    $(".invite-modal .eyebrow").textContent =
      title === "site" ? "SITE INVITATION" : "ROOM INVITATION";
    $("#invite-dialog").dataset.title = title;
    openDialog($("#invite-dialog"));
  } catch (error) {
    if(state.session?.user?.id === userId && sidebarEpoch === epoch)toast(error.message);
  }
}
function closeSidebar() {
  closeProfileMenu();
  $("#sidebar").classList.remove("is-open");
  $("#sidebar-scrim").classList.remove("is-visible");
}
function roomPreferences(id) {
  try { return JSON.parse(localStorage.getItem("community-model:" + state.session.user.id + ":" + id) || "{}"); } catch { return {}; }
}
function saveRoomPreferences(id, prefs) {
  if (!id) return;
  try { localStorage.setItem("community-model:" + state.session.user.id + ":" + id, JSON.stringify(prefs)); } catch {}
}
function composerBlocked(pane = null) {
  const {roomId,readOnly} = roomContextOwner(pane);
  return readOnly || !roomId || roomId === MONITOR_ROOM || (pane ? pane.sending : state.sending) || pendingMessages.get(roomId)?.retrying || modelChanges.has(roomId) || branchOperations.has(roomId);
}
function syncReadOnlyComposer(form, pane, owner) {
  form.classList.toggle("is-readonly", owner.readOnly);
  let notice = $(".composer-readonly", form);
  if (!owner.readOnly) { notice?.remove(); return; }
  if (!notice) {
    notice = contextElement("div", undefined, "composer-readonly"); notice.setAttribute("role", "status");
    notice.append(contextElement("span", "가지치기한 원본입니다. 새 가지에서 대화를 이어가세요."));
    const fork = contextElement("button", "가지치기", "composer-readonly-fork"); fork.type = "button";
    fork.onclick = () => sessionAction("fork", pane, fork);
    notice.append(fork); form.prepend(notice);
  }
  $("button", notice).disabled = owner.busy;
}
function updateModelAvailability() {
  syncRecordingButtons();
  updateBranchControls();
  syncSessionActivity();
  updateAgentPresence();
  for (const button of $$("[data-retry-room-id]")) button.disabled = roomReadOnly(button.dataset.retryRoomId);
  for (const button of $$(".voice-call-button")) {
    const pane = button._pane || null, roomId = pane ? pane.roomId : state.selectedRoom;
    const room = state.rooms?.find(item => item.id === roomId);
    button.disabled = !room || room.archived || roomId === MONITOR_ROOM || roomReadOnly(roomId);
  }
  for(const select of $$(".model-select")) {
    const pane=select._pane||null,owner=roomContextOwner(pane);
    const disabled=!owner.roomId||owner.busy||owner.readOnly;
    select.disabled=disabled;
    if(select._triggerButton)select._triggerButton.disabled=disabled;
    const effort=$(".effort-select",select.closest("form"));if(effort){effort.disabled=disabled;if(effort._triggerButton)effort._triggerButton.disabled=disabled;}
    const form=select.closest("form");
    if(form) {
      syncReadOnlyComposer(form,pane,owner);
      const send=$('button[type="submit"]',form);
      const blocked=composerBlocked(pane), queued=!!owner.data?.busy;
      if(send){send.disabled=blocked;send.setAttribute("aria-label",queued?"대기열에 추가":"메시지 보내기");send.title=queued?"대기열에 추가 · 현재 답변이 끝나면 순서대로 보냅니다":"메시지 보내기";}
      for (const attach of $$(".attach-button, #attach-button, input[type=file]", form)) attach.disabled = !!blocked;
      const input=$("textarea",form);
      if(input){
        input.readOnly=!!owner.readOnly;
        input.disabled=!!blocked && !owner.readOnly;
        composerSuggestions?.sync({input,roomId:owner.roomId,data:owner.data,model:select.value,effort:effort?.value || "",queued,
          blocked:blocked || pendingMessages.has(owner.roomId) || Boolean(composerRecorder && composerRecorder.status!=="idle"),
          hasAttachments:Boolean((pane || state).pendingAttachments?.length)});
        if (owner.readOnly) input.placeholder = "읽기 전용";
      }
      const actions=$$(".context-action",form);
      if(actions[0])actions[0].disabled=owner.busy;
      if(actions[1])actions[1].disabled=owner.busy||!owner.canManage||!(owner.data?.context?.usedChars>=500);
    }
  }
}
function confirmModelChange(label,canReset) {
  return new Promise(resolve=>{
    const dialog=contextElement("dialog",undefined,"model-change-dialog");dialog.setAttribute("aria-labelledby","model-change-title");
    const title=contextElement("h2","모델을 변경할까요?");title.id="model-change-title";
    const next=contextElement("p",label,"model-change-name");
    const note=contextElement("p","기록은 그대로 남습니다. 맥락을 초기화하면 이전 대화와 압축 요약을 다음 요청에 보내지 않습니다.","context-note");
    const actions=contextElement("div",undefined,"model-change-actions");
    let choice=null;
    for(const [value,text] of [["keep","맥락 유지하고 변경"],["reset","맥락 초기화 후 변경"],[null,"취소"]]) {
      const button=contextElement("button",text);button.type="button";button.disabled=value==="reset"&&!canReset;
      button.onclick=()=>{choice=value;dialog.close();};actions.append(button);
    }
    dialog.append(title,next,note);
    if(!canReset)dialog.append(contextElement("p","맥락 초기화는 세션 소유자만 할 수 있습니다.","context-note"));
    dialog.append(actions);dialog.addEventListener("close",()=>{dialog.remove();resolve(choice);},{once:true});
    document.body.append(dialog);dialog.showModal();
  });
}
async function requestModelChange(select, value) {
  const pane=select._pane||null,{roomId,busy,readOnly}=roomContextOwner(pane),userId=state.session?.user?.id;
  const previous=select.dataset.chosen ?? select.value;
  select.value=previous;
  if(!roomId||!select.isConnected||busy||readOnly||value===previous)return;
  const operation=Symbol("model-change");modelChanges.set(roomId,operation);select._changingModel=operation;updateModelAvailability();
  const stillCurrent=()=>select.isConnected&&contextOwnerCurrent(roomId,userId,pane);
  try {
    const model=state.models.find(item=>item.value===value);
    const choice=await confirmModelChange(value?(model?modelLabel(model):value):"자동 선택 · 추천",roomContextOwner(pane).canManage);
    if(!choice||!stillCurrent()||roomReadOnly(roomId))return;
    if(roomContextOwner(pane).working){toast("답변이 끝난 뒤 모델을 변경해주세요.");return;}
    if(choice==="reset") {
      if(!roomContextOwner(pane).canManage)return;
      await api(`/api/rooms/${encodeURIComponent(roomId)}/context-reset`,{method:"POST",body:"{}"});
      if(!stillCurrent())return;
    }
    // Commit only after confirmation and, when requested, a successful server reset.
    select.dataset.chosen=value;
    if(pane)pane.model=value;
    const effort=pane?pane.effort||"":$("#effort-select").value;
    saveRoomPreferences(roomId,{model:value,effort});
    applyModels(state.models);
    if(choice==="reset")await refreshContextOwner(pane);
  } catch(error) {if(stillCurrent())toast(error.message);}
  finally {
    if(modelChanges.get(roomId)===operation)modelChanges.delete(roomId);
    if(select._changingModel===operation)select._changingModel=false;
    if(stillCurrent())select.value=select.dataset.chosen ?? previous;
    updateModelAvailability();
  }
}
function applyModels(models) {
  if (Array.isArray(models)) state.models = models;
  const recommended = recommendedModels(state.models);
  for (const select of $$(".model-select")) {
    const chosen = select.dataset.chosen ?? select.value;
    select.replaceChildren(new Option("자동 선택 · 추천", ""));
    const visible=[...recommended];
    const current=state.models.find(model=>model.value===chosen);
    if(current&&!visible.includes(current))visible.push(current);
    for(const model of visible)select.append(new Option(modelLabel(model)+(model===current&&!recommended.includes(model)?" · 선택됨":""),model.value));
    select.value=visible.some(model=>model.value===chosen)?chosen:"";
    select.dataset.chosen=select.value;
    if(!select._triggerButton){
      const trigger=document.createElement("button");trigger.type="button";trigger.className="model-trigger";trigger.setAttribute("aria-label","모델 선택");trigger.setAttribute("aria-haspopup","menu");trigger.setAttribute("aria-expanded","false");
      trigger.onclick=()=>openRecommendedModels(select,trigger);select.after(trigger);select._triggerButton=trigger;select.classList.add("custom-model-select");
    }
    setPickerTrigger(select._triggerButton,select.value?(select.selectedOptions[0]?.textContent||"모델"):"자동 선택");
    select._triggerButton.prepend(createModelIcon(current || {value:"",id:""}));
    select.title="추천 모델 · 자동 선택은 연결 상태에 따라 순환합니다";
  }
  decorateEffortPickers();
  updateModelAvailability();
}
function setPickerTrigger(button,label,shortLabel=label) {
  const text=contextElement("span",label),chevron=document.createElementNS("http://www.w3.org/2000/svg","svg");
  chevron.setAttribute("viewBox","0 0 16 16");chevron.setAttribute("aria-hidden","true");chevron.innerHTML='<path d="m4 6 4 4 4-4"/>';
  button.replaceChildren(text,chevron);
  button.dataset.shortLabel=shortLabel;
}
let composerPicker=null;
function closeComposerPicker(restoreFocus=false) {
  const open=composerPicker;if(!open)return;composerPicker=null;
  open.trigger.setAttribute("aria-expanded","false");
  window.removeEventListener("resize",open.reposition);document.removeEventListener("pointerdown",open.outside,true);
  window.removeEventListener("scroll",open.scroll,true);open.element.remove();
  if(restoreFocus&&open.trigger.isConnected&&!$("dialog[open]"))open.trigger.focus();
}
function openComposerPicker(trigger,title,options,{after}={}) {
  if(composerPicker?.trigger===trigger){closeComposerPicker(true);return;}
  closeComposerPicker();closeContextPopover();
  const element=contextElement("div",undefined,"composer-picker");element.setAttribute("role","menu");element.setAttribute("aria-label",title);element.setAttribute("popover","auto");
  inheritSessionTheme(element,trigger);
  element.append(contextElement("div",title,"picker-heading"));
  for(const option of options) {
    const button=contextElement("button",undefined,"picker-option"+(option.danger?" is-danger":""));button.type="button";button.setAttribute("role",typeof option.selected==="boolean"?"menuitemradio":"menuitem");if(typeof option.selected==="boolean")button.setAttribute("aria-checked",String(option.selected));
    const copy=contextElement("span",undefined,"picker-option-copy");copy.append(contextElement("span",option.label,"picker-option-label"));
    if(option.detail)copy.append(contextElement("span",option.detail,"picker-option-detail"));
    if(option.model)button.append(createModelIcon(option.model));
    button.append(copy,contextElement("span",option.selected?"✓":"","picker-check"));
    button.onclick=()=>{closeComposerPicker(true);option.select();};element.append(button);
  }
  if(after){const button=contextElement("button",after.label,"picker-option picker-all");button.type="button";button.setAttribute("role","menuitem");button.onclick=()=>{closeComposerPicker();after.select();};element.append(button);}
  const reposition=()=>{
    if(!trigger.isConnected){closeComposerPicker();return;}
    const rect=trigger.getBoundingClientRect(),width=element.offsetWidth,height=element.offsetHeight;
    element.style.left=Math.max(10,Math.min(rect.right-width,innerWidth-width-10))+"px";
    const above=rect.top-height-9; element.style.top=Math.max(10,above>=10?above:Math.min(rect.bottom+9,innerHeight-height-10))+"px";
  };
  const outside=event=>{if(!element.contains(event.target)&&!trigger.contains(event.target))closeComposerPicker();};
  const scroll=event=>{if(!element.contains(event.target))reposition();};
  composerPicker={element,trigger,reposition,outside,scroll};trigger.setAttribute("aria-expanded","true");
  document.body.append(element);if(typeof element.showPopover==="function")element.showPopover();reposition();
  element.addEventListener("toggle",event=>{if(event.newState==="closed"&&composerPicker?.element===element)closeComposerPicker();});
  element.addEventListener("keydown",event=>{
    const buttons=$$("button",element),index=buttons.indexOf(document.activeElement);
    if(event.key==="Escape"){event.preventDefault();event.stopPropagation();closeComposerPicker(true);}
    else if(["ArrowDown","ArrowUp","Home","End"].includes(event.key)) {
      event.preventDefault();const next=event.key==="Home"?0:event.key==="End"?buttons.length-1:(index+(event.key==="ArrowDown"?1:-1)+buttons.length)%buttons.length;buttons[next]?.focus();
    }else if(event.key==="Tab")closeComposerPicker(true);
  });
  document.addEventListener("pointerdown",outside,true);window.addEventListener("resize",reposition);window.addEventListener("scroll",scroll,true);
  ($('[aria-checked="true"]',element)||$("button",element))?.focus({preventScroll:true});
}
function openRecommendedModels(select,trigger){
  if(select.disabled)return;
  const entries=[{value:"",id:"",name:"자동 선택"},...recommendedModels(state.models)];
  const current=state.models.find(m=>m.value===select.value);if(current&&!entries.some(m=>m.value===current.value))entries.push(current);
  openComposerPicker(trigger,"모델",entries.map(model=>({model,label:model.value?modelLabel(model):"자동 선택",detail:model.value?modelDetail(model):"연결된 공급자를 순환하며 선택 · 실패하면 자동 전환",selected:select.value===model.value,select:()=>void requestModelChange(select,model.value)})),{after:{label:"전체 모델 검색",select:()=>openModelBrowser(select,trigger)}});
}
function decorateEffortPickers() {
  for(const select of $$(".effort-select")) {
    if(!select._triggerButton) {
      const trigger=contextElement("button",undefined,"effort-trigger");trigger.type="button";trigger.setAttribute("aria-label","생각의 깊이 선택");trigger.setAttribute("aria-haspopup","menu");trigger.setAttribute("aria-expanded","false");
      select.after(trigger);select._triggerButton=trigger;select.classList.add("custom-effort-select");
      trigger.onclick=()=>{
        if(select.disabled)return;
        const detail={"":"모델의 기본 설정","low":"빠르게 답하기","medium":"균형 있게 살펴보기","high":"더 깊게 검토하기","xhigh":"복잡한 문제를 충분히 검토하기"};
        openComposerPicker(trigger,"생각의 깊이",[...select.options].map(option=>({label:option.textContent,detail:detail[option.value],selected:option.value===select.value,select:()=>{if(select.disabled||!select.isConnected)return;select.value=option.value;select.dispatchEvent(new Event("change",{bubbles:true}));decorateEffortPickers();}})));
      };
    }
    const effortLabel=select.selectedOptions[0]?.textContent||"기본";
    setPickerTrigger(select._triggerButton,"생각: "+effortLabel,effortLabel);
  }
}

let modelBrowser;
function openModelBrowser(select,trigger,{onChoose}={}) {
  if(select.disabled&&!onChoose)return;
  if(!modelBrowser){
    modelBrowser=document.createElement("dialog");modelBrowser.className="model-browser";modelBrowser.setAttribute("aria-labelledby","model-browser-title");
    modelBrowser.innerHTML='<header><div><span class="picker-eyebrow">MODEL LIBRARY</span><h2 id="model-browser-title">어떤 모델과 대화할까요?</h2></div><button type="button" class="model-browser-close" aria-label="모델 선택 닫기">×</button></header><input class="model-search" type="search" placeholder="모델 또는 공급자 검색" aria-label="모델 또는 공급자 검색"><p class="model-count" role="status"></p><div class="model-results"></div><button class="model-load-more" type="button">더 불러오기</button>';
    document.body.append(modelBrowser);
    $(".model-browser-close",modelBrowser).onclick=()=>modelBrowser.close();
    modelBrowser.addEventListener("click",event=>{if(event.target===modelBrowser){const r=modelBrowser.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)modelBrowser.close();}});
  }
  inheritSessionTheme(modelBrowser,trigger);
  const search=$(".model-search",modelBrowser), results=$(".model-results",modelBrowser), load=$(".model-load-more",modelBrowser);
  let count=60;
  const recommended=new Set(recommendedModels(state.models).map(m=>m.value));
  function render(){
    const matching=filterModels(state.models,search.value);
    results.replaceChildren();
    $(".model-count",modelBrowser).textContent=matching.length?`${matching.length}개 모델 · ${Math.min(count,matching.length)}개 표시`:"일치하는 모델이 없어요. 다른 이름이나 공급자로 검색해 보세요.";
    for(const model of matching.slice(0,count)){
      const button=document.createElement("button");button.type="button";button.className="model-card";button.setAttribute("aria-pressed",String(select.value===model.value));
      const name=document.createElement("strong"),detail=document.createElement("span"),badge=document.createElement("small");
      name.textContent=modelLabel(model);detail.textContent=modelDetail(model);badge.textContent=select.value===model.value?"선택됨":recommended.has(model.value)?"추천":model.id;
      const copy=contextElement("span",undefined,"model-card-copy");copy.append(name,detail,badge);
      button.append(createModelIcon(model),copy);button.title=model.id;
      button.onclick=()=>{modelBrowser.close();if(onChoose)void onChoose(model.value);else void requestModelChange(select,model.value);};results.append(button);
    }
    load.hidden=count>=matching.length;
  }
  search.value="";search.oninput=()=>{count=60;render();};load.onclick=()=>{count+=60;render();};modelBrowser.onclose=()=>{if(trigger.isConnected&&!$("dialog[open]"))trigger.focus();};
  render();modelBrowser.showModal();search.focus();
}
function setLayout(count) {
  if (!state.selectedRoom || count < 2 || count > 8) return;
  state.extra.forEach(pane => clearAttachmentDraft(pane));
  if (state.layout === count) {
    state.layout = 1;
    state.extra = [];
    composerRecorder?.cancelIfStale();
    state.focusPane = 0;
    $("#pane-grid").dataset.panes = "1";
    $("#pane-grid").classList.remove("docked");
    $("#room-view").style.gridColumn = "";
    $("#room-view").classList.remove("is-focus");
    $$(".extra-pane").forEach((pane) => { disposeTranscript(pane.querySelector(".message-list")); pane.remove(); });
    dockRects = [{x:0,y:0,w:1,h:1}]; applyDockLayout();
    $$(".split-picker button").forEach((button) => {
      button.classList.remove("is-on");
      button.setAttribute("aria-pressed", "false");
    });
    renderRooms();
    syncProgressStreams();
    return;
  }
  state.layout = count;
  state.focusPane = 0;
  const ids = [state.selectedRoom];
  for (const room of state.rooms) {
    if (ids.length >= count) break;
    if (!ids.includes(room.id)) ids.push(room.id);
  }
  state.extra = ids.slice(1).map((roomId) => ({ roomId, data: null, busy: false, request: 0, model: "", effort: "" }));
  while (state.extra.length < count - 1) state.extra.push({ roomId: null, data: null, busy: false, request: 0, model: "", effort: "" });
  $("#pane-grid").dataset.panes = String(count);
  $$(".split-picker button").forEach((button) => {
    const on = Number(button.dataset.split) === count;
    button.classList.toggle("is-on", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  });
  $("#room-view").classList.add("is-focus");
  renderExtraPanes();
  renderRooms();
  refreshExtras();
}
function renderExtraPanes() {
  if(contextPopover?.pane)closeContextPopover();
  closeComposerPicker();
  composerRecorder?.cancelIfStale();
  syncProgressStreams();
  const grid = $("#pane-grid");
  const spans = { 5: [2, 2, 2, 3, 3], 7: [3, 3, 3, 3, 4, 4, 4] }[state.layout];
  $$(".extra-pane", grid).forEach((pane) => {disposeTranscript(pane.querySelector(".message-list"));pane._desktop?.destroy();pane.remove();});
  $("#room-view").style.gridColumn = spans ? "span " + spans[0] : "";
  state.extra.forEach((pane, index) => {
    Object.assign(pane, roomPreferences(pane.roomId));
    const room = state.rooms.find((item) => item.id === pane.roomId);
    const section = document.createElement("section");
    section.className = "room-view extra-pane" + (state.focusPane === index + 1 ? " is-focus" : "");
    section.dataset.paneIndex = String(index + 1);
    if (spans) section.style.gridColumn = "span " + spans[index + 1];
    const focusBranchPane = () => {
      if(state.focusPane===index+1)return;
      state.focusPane = index + 1;
      loginPollEpoch++; loginPollBusy=false; loginUI?.sync([]); void refreshBrowserLogins();
      $("#room-view").classList.remove("is-focus");
      $$(".extra-pane").forEach((item, itemIndex) => item.classList.toggle("is-focus", itemIndex + 1 === state.focusPane));
      renderRooms();
    };
    section.addEventListener("mousedown",focusBranchPane);section.addEventListener("focusin",focusBranchPane);
    const header = document.createElement("header");
    header.className = "pane-bar";
    const title = document.createElement("h2");
    title.textContent = room?.name || "대화 선택";
    bindSessionTitle(title,()=>pane.roomId);
    header.append(title);
    const desktopButton = document.createElement("button");
    desktopButton.type = "button";
    desktopButton.className = "icon-button desktop-button";
    desktopButton.setAttribute("aria-label","작업 공간 열기");desktopButton.title="작업 공간";
    desktopButton.innerHTML='<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M3 4h18v13H3zM8 21h8m-4-4v4"/></svg>';
    desktopButton.disabled = !pane.roomId;
    desktopButton.addEventListener("click", () => desktopUI?.openRoom(pane.roomId));
    header.append(desktopButton);
    const callButton = document.createElement("button");
    callButton.type = "button"; callButton.className = "voice-call-button"; callButton.append(icon("phone"));
    callButton.setAttribute("aria-label", "이 대화에 전화하기"); callButton.title = "이 대화에 전화하기";
    callButton._pane = pane;
    callButton.disabled = !room || room.archived || room.id === MONITOR_ROOM || roomReadOnly(pane.roomId);
    callButton.onclick = () => { if (!roomReadOnly(pane.roomId)) voiceUI?.open(state.rooms.find(item=>item.id===pane.roomId)); }; header.append(callButton);
    const shareButton = contextElement("button", undefined, "icon-button room-share-button"); shareButton.type = "button"; shareButton.append(icon("share"));
    shareButton.setAttribute("aria-label", "대화 공유 및 다운로드"); shareButton.title = "공유"; shareButton.disabled = !room || room.id === MONITOR_ROOM;
    shareButton.onclick = () => sharingUI?.open(state.rooms.find(item => item.id === pane.roomId)); header.append(shareButton);
    const menuButton = contextElement("button", undefined, "icon-button room-actions-button"); menuButton.type = "button"; menuButton.append(icon("more"));
    menuButton.setAttribute("aria-label", "대화 메뉴"); menuButton.title = "고정·삭제"; menuButton.setAttribute("aria-haspopup", "menu"); menuButton.setAttribute("aria-expanded", "false"); menuButton.disabled = !room || room.id === MONITOR_ROOM;
    menuButton.onclick = () => openSessionActions(pane.roomId, menuButton); header.append(menuButton);

    const list = document.createElement("div");
    list.className = "message-list";
    section.classList.toggle("agent-working", !!pane.data?.busy);
    const form = document.createElement("form");
    form.className = "composer pane-composer";
    form.addEventListener("submit", (event) => submitPane(event, index));
    const controls = document.createElement("div");
    controls.className = "model-controls";
    controls.append(modelSelect(pane), effortSelect(pane));
    const tools=document.createElement("div");tools.className="composer-tools";
    const footer=document.createElement("div");footer.className="composer-footer";footer.setAttribute("role","group");footer.setAttribute("aria-label","메시지 도구");
    const row = document.createElement("div");
    row.className = "composer-row";
    const input = document.createElement("textarea");
    input.rows = 1;
    input.value=pane.draft || "";
    input.addEventListener("input",()=>{pane.draft=input.value;agentPresence?.react("typing");});
    input.addEventListener("paste", event => pasteAttachments(event, pane));
    input.maxLength = 4000;
    input.placeholder = "무엇을 함께 해볼까요?";
    input.setAttribute("aria-label", (room?.name || "대화") + " 메시지");
    input.addEventListener("keydown", (event) => {
      if (event.isComposing || event.keyCode === 229) return;
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        form.requestSubmit();
      }
    });
    const send = document.createElement("button");
    send.type = "submit";
    send.className = "send-button";
    send.setAttribute("aria-label", "메시지 보내기");
    send.append(icon("arrow"));
    const attach = document.createElement("button");
    attach.type = "button"; attach.className = "bot-picker-button attach-button";
    attach.setAttribute("aria-label", "사진 또는 음성 첨부"); attach.title = "사진 또는 음성 첨부 · 이미지 붙여넣기도 가능해요";
    attach.append(icon("attach"));
    const fileInput = document.createElement("input");
    fileInput.type = "file"; fileInput.className = "sr-only"; fileInput.accept = "image/png,image/jpeg,image/webp,image/gif,audio/*"; fileInput.multiple = true;
    attach.onclick = () => { if (!composerBlocked(pane)) fileInput.click(); };
    fileInput.onchange = () => { void uploadAttachments(fileInput.files, pane); fileInput.value = ""; };
    const mic=contextElement("button",undefined,"bot-picker-button record-button"),cancel=contextElement("button","취소","record-cancel-button");
    mic.type=cancel.type="button";mic._pane=pane;mic.append(icon("mic"));mic.setAttribute("aria-label","음성 녹음 시작");mic.title="음성 녹음";mic.onclick=()=>toggleRecording(pane);cancel.hidden=true;cancel.onclick=cancelActiveRecording;
    row.append(input);
    footer.append(attach,fileInput,mic,cancel,controls,send);
    const attachmentList = document.createElement("div");
    attachmentList.className = "attachment-list"; attachmentList.setAttribute("aria-live", "polite");
    form.append(tools, row, attachmentList, footer);
    renderContextMeter(pane.data?.context,form,pane);
    messageQueueUI?.render(form, pane.roomId, pane.data?.queue);
    section.append(header, list, form);
    grid.append(section);
    modelFailoverUI?.render(form,pane.roomId,pane.data?.modelControl);
    renderConversation(list, mergePendingMessages(pane.data?.messages || [], pendingMessages.get(pane.roomId)), {
      pane, roomId: pane.roomId, busy: !!pane.data?.busy && pane.data.room?.id === pane.roomId,
      emptyNote: pane.roomId ? "메시지를 불러오는 중…" : "이 칸을 누른 뒤 왼쪽 대화를 고르세요.",
    });
    renderPendingAttachments(pane);

  });
  applyModels(state.models);
  syncRecordingButtons();
  applyDockLayout();
}
function modelSelect(pane) {
  const label = document.createElement("label");
  label.append(contextElement("span","모델","sr-only"));
  const select = document.createElement("select");
  select.className = "model-select";
  select.setAttribute("aria-label", "모델");
  select.dataset.chosen = pane.model || "";
  select._pane=pane;
  select.addEventListener("change", () => { void requestModelChange(select,select.value); });
  label.append(select);
  return label;
}
function effortSelect(pane) {
  const label = document.createElement("label");
  label.append(contextElement("span","effort","sr-only"));
  const select = document.createElement("select");
  select.className = "effort-select";
  select.setAttribute("aria-label", "effort");
  for (const [value, text] of [["", "기본"], ["low", "낮음"], ["medium", "보통"], ["high", "높음"], ["xhigh", "최대"]]) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = text;
    select.append(option);
  }
  select.value = pane.effort || "";
  select._pane=pane;
  select.addEventListener("change", () => { pane.effort = select.value; saveRoomPreferences(pane.roomId, {model:pane.model || "", effort:pane.effort}); });
  label.append(select);
  return label;
}
async function submitPane(event, index, skipTopic = false) {
  event.preventDefault();
  const pane = state.extra[index];
  if (!pane || composerBlocked(pane) || recordingBlocksSend(pane)) return;
  const sendSession = state.session;
  const sendCurrent = () => state.session?.user?.id === sendSession?.user?.id && state.session?.csrfToken === sendSession?.csrfToken;
  const form = event.currentTarget;
  const input = $("textarea", form);
  const text = input.value.trim();
  if (pendingMessages.get(pane.roomId)?.pending === "failed") { toast("보내지 못한 메시지를 다시 보내거나 삭제한 뒤 전송해 주세요."); return; }
  const attachments = (pane.pendingAttachments || []).filter(item => item.attachment && !item.error);
  if ((pane.pendingAttachments || []).some(item => item.uploading)) { toast("첨부 파일 업로드가 끝날 때까지 기다려주세요."); return; }
  if ((pane.pendingAttachments || []).some(item => item.error)) { toast("업로드하지 못한 첨부 파일을 제거한 뒤 다시 첨부해 주세요."); return; }
  if (!text && !attachments.length) return;
  const attachmentGeneration = pane.attachmentGeneration;
  const roomId=pane.roomId,userId=state.session?.user?.id;
  if(topicPrompts.has(roomId))return;
  if(!skipTopic && !attachments.length && await offerTopicChoice(pane,text))return;
  if(!sendCurrent() || !contextOwnerCurrent(roomId,userId,pane)||composerBlocked(pane))return;
  const attachmentIds = attachments.map(item => item.attachment.id);
  const model = $(".model-select", form).value, effort = $(".effort-select", form).value, botIds = state.selectedBots.slice(0, 1);
  const signature=JSON.stringify({roomId,text,attachmentIds,model,effort,botIds});
  if(pane.pendingSend?.signature!==signature)pane.pendingSend={signature,nonce:crypto.randomUUID()};
  const nonce=pane.pendingSend.nonce;
  const payload=JSON.stringify({text,botIds,attachmentIds,clientNonce:nonce,model,effort,queueIfBusy:true});
  presenceErrors.delete(roomId);
  pane.sending = true;
  updateModelAvailability();
  agentPresence?.react("send");
  input.value=""; pane.draft="";input.disabled=true;
  const pending=pane.data?.busy ? null : await optimisticMessage(roomId,text,nonce,attachments.map(item => item.attachment));
  if (pending) pending.retry = Object.freeze({ roomId, userId, payload });
  let accepted=false;
  try {
    if (!sendCurrent()) return;
    const result = await api(`/api/rooms/${encodeURIComponent(roomId)}/messages`, {
      method: "POST",
      body: payload,
      retryable: true,
    });
    accepted=true;
    if(!sendCurrent())return;
    if(result.queued && pendingMessages.get(roomId)===pending)pendingMessages.delete(roomId);
    if(result.messageId&&pending)pending.id=result.messageId;
    if(result.queued)paintPending(roomId);
    pane.pendingSend=null;
    if (Array.isArray(result.models)) applyModels(result.models);
    if(contextOwnerCurrent(roomId,userId,pane) && pane.attachmentGeneration===attachmentGeneration)clearPendingAttachments(pane);
    if(contextOwnerCurrent(roomId,userId,pane))await refreshExtra(state.extra.indexOf(pane));
    await loadRooms();
  } catch (error) {
    if(!sendCurrent())return;
    if(accepted){toast("메시지는 접수됐습니다. 대화를 다시 불러오고 있어요.");return;}
    if (recoverReadOnlySend(error, {roomId, pane, input, text, attachmentGeneration, pending})) return;
    presenceErrors.add(roomId);
    if (pending) {
      pending.pending = "failed";
      pane.pendingSend = null;
      if (contextOwnerCurrent(roomId, userId, pane) && pane.attachmentGeneration === attachmentGeneration) clearPendingAttachments(pane);
    } else if (pane.roomId === roomId) { input.value = text; pane.draft = text; }
    paintPending(roomId);toast(error.message);
  } finally {
    if(!sendCurrent())return;
    input.disabled=false;
    pane.sending = false;
    updateModelAvailability();
  }
}
async function refreshExtra(index) {
  const pane = state.extra[index];
  if (!pane?.roomId || pane.busy) return;
  const request = ++pane.request;
  const modelStateAtRequest=pane.data?.modelControl;
  const roomId = pane.roomId, userId = state.session?.user?.id;
  pane.busy = true;
  try {
    const data = await api(`/api/rooms/${encodeURIComponent(roomId)}`);
    if (state.session?.user?.id !== userId || state.extra[index] !== pane || pane.roomId !== roomId || pane.request !== request) return;
    if(data.busy&&!data.modelControl&&pane.data?.modelControl!==modelStateAtRequest)data.modelControl=pane.data?.modelControl;
    data.modelControl=latestModelControl(pane.data?.modelControl,data.modelControl);
    const unchanged = JSON.stringify(pane.data) === JSON.stringify(data);
    pane.data = data;
    notificationUI?.observeRoom(data, { userId });
    observeRoomOutcome(data);
    syncProgressStreams();
    if (unchanged) return;
    const section = $$(".extra-pane")[index];
    if (!section) return;
    renderContextMeter(data.context,$(".pane-composer",section),pane);
    modelFailoverUI?.render($(".pane-composer",section),roomId,data.modelControl);
    messageQueueUI?.render($(".pane-composer",section), roomId, data.queue);
    const list = $(".message-list", section);
    renderConversation(list, mergePendingMessages(data.messages || [], pendingMessages.get(roomId)), { pane, roomId, busy: !!data.busy });
    section.classList.toggle("agent-working", !!data.busy);
    $("h2", section).textContent = data.room?.name || "대화";
    const listed=state.rooms.find(room=>room.id===roomId);
    if(listed&&data.room?.name&&listed.name!==data.room.name){listed.name=data.room.name;renderRooms();}
  } catch (error) {
    if (pane.request !== request) return;
    if (error.status === 401) { state.session = null; showAuth(); }
    else {
      if (error.status === 403 || error.status === 404) { pane.data = null; syncProgressStreams(); }
      toast(error.message);
    }
  } finally {
    if (pane.request === request) pane.busy = false;
  }
}
function refreshExtras() {
  state.extra.forEach((_, index) => { void refreshExtra(index); });
}
function assignExtra(index, roomId) {
  const pane = state.extra[index];
  if (!pane || roomId === state.selectedRoom || pane.roomId === roomId) return;
  state.extra.forEach((item, itemIndex) => {
    if (itemIndex !== index && item.roomId === roomId) { clearAttachmentDraft(item); item.roomId = pane.roomId; }
  });
  clearAttachmentDraft(pane);
  pane.roomId = roomId;
  focusSidebarBranch(roomId);
  touchConversation(roomId);
  pane.data = null;
  pane.busy = false;
  renderExtraPanes();
  renderRooms();
  void refreshExtra(index);
}
function bind() {
  setupSidebarResize();
  bindSessionTitle(els.roomTitle,()=>state.selectedRoom);
  document.body.append($("#profile-menu"));
  $("#create-sidebar-group").addEventListener("click",()=>openSidebarGroupEditor());
  $("#sidebar-search-toggle").addEventListener("click",()=>{
    const wrap=$("#sidebar-search-wrap");wrap.hidden=!wrap.hidden;$("#sidebar-search-toggle").setAttribute("aria-expanded",String(!wrap.hidden));
    if(!wrap.hidden)$("#session-search").focus();else{sessionSearch="";$("#session-search").value="";renderRooms();}
  });
  $("#session-search").addEventListener("input",event=>{sessionSearch=event.target.value;renderRooms();});
  $("#session-search").addEventListener("keydown",event=>{if(event.key==="Escape"){event.stopPropagation();$("#sidebar-search-toggle").click();$("#sidebar-search-toggle").focus();}});
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      els.memberPanel.classList.remove("is-open");
      closeSidebar();
    }
  });
  $$("[data-auth-tab]").forEach((button) =>
    button.addEventListener("click", () => switchAuth(button.dataset.authTab)),
  );
  els.login.addEventListener("submit", (event) =>
    authSubmit(event, "/api/login", "로그인"),
  );
  els.register.addEventListener("submit", (event) =>
    authSubmit(event, "/api/register", "계정 만들기"),
  );
  $("#logout-button").addEventListener("click", async () => {
    try {
      voiceUI?.reset();
      await pwaUI?.clearSession({ keepSession: true });
      await api("/api/logout", { method: "POST", body: "{}" });
      await pwaUI?.clearSession();
      state.session = null;
      showAuth();
    } catch (error) {
      toast(error.message);
    }
  });
  ["#create-room-button", "#empty-create-button", "#sidebar-new-session"].forEach((selector) =>
    $(selector).addEventListener("click", startNewSession),
  );
  $("#room-form").addEventListener("submit", createRoom);
  $("#join-form").addEventListener("submit", joinRoom);
  $("#composer-form").addEventListener("submit", submitMessage);
  $("#model-select").addEventListener("change",()=>{void requestModelChange($("#model-select"),$("#model-select").value);});
  $("#effort-select").addEventListener("change",()=>{
    saveRoomPreferences(state.selectedRoom,{model:$("#model-select").dataset.chosen || "",effort:$("#effort-select").value});
  });
  $("#room-view").addEventListener("focusin", () => {
    if(state.focusPane===0)return;state.focusPane=0;desktopUI?.setRoom(state.selectedRoom);
    loginPollEpoch++; loginPollBusy=false; loginUI?.sync([]); void refreshBrowserLogins();
    $("#room-view").classList.add("is-focus");$$(".extra-pane").forEach(pane=>pane.classList.remove("is-focus"));renderRooms();
  });
  $("#room-view").addEventListener("mousedown", () => {
    if (state.layout < 2) return;
    if(state.focusPane!==0) {state.focusPane=0; loginPollEpoch++; loginPollBusy=false; loginUI?.sync([]); void refreshBrowserLogins();}
    desktopUI?.setRoom(state.selectedRoom);
    $("#room-view").classList.add("is-focus");
    $$(".extra-pane").forEach((pane) => pane.classList.remove("is-focus"));
    renderRooms();
  });
  $$(".split-picker button").forEach((button) => {
    button.addEventListener("click", () => setLayout(Number(button.dataset.split)));
  });
  $("#attach-button").addEventListener("click", () => { if (!composerBlocked()) $("#attachment-input").click(); });
  $("#attachment-input").addEventListener("change", (event) => {
    uploadAttachments(event.target.files);
    event.target.value = "";
  });
  $("#record-button").addEventListener("click", () => toggleRecording());
  $("#voice-call-button").addEventListener("click", () => { const id=state.selectedRoom; if (!roomReadOnly(id)) voiceUI?.open(state.rooms.find(room => room.id === id)); });
  $("#record-cancel-button").addEventListener("click", cancelActiveRecording);
  $("#message-input").addEventListener("paste", event => pasteAttachments(event));
  $("#message-input").addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      $("#composer-form").requestSubmit();
    }
  });
  $("#message-input").addEventListener("input", (event) => {
    agentPresence?.react("typing");
    event.target.style.height = "auto";
    event.target.style.height = `${Math.min(event.target.scrollHeight, 140)}px`;
  });
  $("#members-toggle").addEventListener("click", () =>
    els.memberPanel.classList.toggle("is-open"),
  );
  $("#member-close").addEventListener("click", () =>
    els.memberPanel.classList.remove("is-open"),
  );
  $("#room-invite-button").addEventListener("click", () => sharingUI?.open(state.roomData?.room || state.rooms.find(room=>room.id===state.selectedRoom)));
  $("#room-share-button").addEventListener("click", () => sharingUI?.open(state.rooms.find(room=>room.id===state.selectedRoom)));
  $("#room-actions-button").addEventListener("click", event => openSessionActions(state.selectedRoom, event.currentTarget));
  $("#profile-customize").addEventListener("click", toggleProfileMenu);
  $("#profile-menu").addEventListener("close",()=>$("#profile-customize").setAttribute("aria-expanded","false"));
  document.addEventListener("pointerdown",event=>{
    if(!event.target.closest("#profile-menu, #profile-customize"))closeProfileMenu();
  });
  $("#profile-menu").addEventListener("click",event=>{
    if(event.target.closest("button:not(:disabled)")){closeProfileMenu();$("#profile-customize").focus({preventScroll:true});}
  },true);
  $("#profile-menu").addEventListener("keydown",event=>{
    if(event.key!=="Escape")return;
    event.preventDefault();event.stopPropagation();closeProfileMenu();$("#profile-customize").focus();
  });
  window.addEventListener("resize",closeProfileMenu);
  $("#edit-profile-button").addEventListener("click",()=>profileUI?.open());
  $("#notification-settings-button").addEventListener("click",()=>{closeSidebar();notificationUI?.openSettings();});
  $("#restore-conversations").addEventListener("click",openArchivedConversations);
  $("#open-routines").addEventListener("click",openRoutines);
  $("#open-bot-setup").addEventListener("click",()=>void setupUI?.open());
  $("#open-mail").addEventListener("click",()=>void mailUI?.open());
  $("#open-capability-hub").addEventListener("click",openCapabilityHub);
  $("#open-dashboard").addEventListener("click",()=>{closeSidebar();void selectRoom(MONITOR_ROOM);});
  $("#site-invite-button").addEventListener("click", () =>
    makeInvite("/api/admin/invites", "site"),
  );
  $("#copy-invite").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText($("#invite-token").textContent);
      toast("초대 링크를 복사했습니다.");
    } catch {
      toast("복사하지 못했습니다. 링크를 직접 선택해주세요.");
    }
  });
  $("#mobile-menu").addEventListener("click", () => {
    if (matchMedia("(max-width: 720px)").matches) {
      const open = $("#sidebar").classList.toggle("is-open");
      $("#sidebar-scrim").classList.toggle("is-visible", open);
      $("#mobile-menu").setAttribute("aria-expanded", String(open));
    } else {
      const hidden = els.workspace.classList.toggle("sidebar-collapsed");
      $("#mobile-menu").setAttribute("aria-expanded", String(!hidden));
    }
  });
  setupDock();
  $("#mobile-close").addEventListener("click", closeSidebar);
  $("#sidebar-scrim").addEventListener("click", closeSidebar);
  $$(".modal-close, .modal-cancel").forEach((button) =>
    button.addEventListener("click", () =>
      closeDialog(button.closest("dialog")),
    ),
  );
  $("#image-dialog-close").addEventListener("click", () => closeDialog($("#image-dialog")));
  $$("dialog").forEach((dialog) =>
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) closeDialog(dialog);
    }),
  );
}
function openPendingRoomInvite() {
  const token = inviteLinks.get("room");
  if (!state.session?.user || !token) return false;
  $("#join-token").value = token; $("#join-token").hidden = true; $("#join-token-label").hidden = true;
  $("#join-invite-note").classList.remove("is-hidden"); openDialog($("#join-dialog")); return true;
}
window.addEventListener("hashchange", () => {
  if (!inviteLinks.capture()) return;
  if (state.session?.user) openPendingRoomInvite(); else showAuth();
});
bind();
agentPresence = createAgentPresence({ mount: $("#agent-presence") });
composerSuggestions = createComposerSuggestions({api,getSession:()=>state.session});
notificationUI = createNotificationCenter({ mount: $("#notification-center"), api,
  getViewingRoomIds: () => !document.hidden && document.hasFocus() && !els.workspace.classList.contains("is-hidden")
    ? [state.selectedRoom, ...state.extra.map(pane => pane.roomId)].filter(Boolean) : [],
  openRoom: async id => { await loadRooms(); await selectRoom(id); }, toast });
pwaUI = createPwaController({ api, getSession: () => state.session, toast });
desktopUI = createDesktopUI({ api, getRoomId: () => state.selectedRoom, getRoomName: id => state.rooms.find(room=>room.id===id)?.name || "대화", toast,
  mobileChat:{
    load:async (roomId,{signal}={})=>{
      const data=await api(`/api/rooms/${encodeURIComponent(roomId)}`,{signal});
      return {messages:data.messages,readOnly:!!data.room?.readOnly,busy:!!data.busy};
    },
    send:async (roomId,text)=>{
      const prefs=roomPreferences(roomId),pane=state.extra.find(item=>item.roomId===roomId),selected=roomId===state.selectedRoom;
      const result=await api(`/api/rooms/${encodeURIComponent(roomId)}/messages`,{method:"POST",retryable:true,body:JSON.stringify({
        text,clientNonce:crypto.randomUUID(),queueIfBusy:true,
        model:selected?$("#model-select").value:pane?.model||prefs.model||"",effort:selected?$("#effort-select").value:pane?.effort||prefs.effort||"",
        botIds:[state.selectedBots[0]||state.bots[0]?.id].filter(Boolean)
      })});
      agentPresence?.react("send");
      if(result.models)applyModels(result.models);
      if(selected)void refreshRoom(true);refreshExtras();void loadRooms();
      return result;
    }
  }
});
profileUI = createProfileSettings({api,getSession:()=>state.session,toast,onSaved: user=>{
  state.session.user=user;$("#profile-name").textContent=user.displayName;renderUserAvatar($("#profile-avatar"),user);
  if(state.roomData)renderRoom(state.roomData);refreshExtras();
}});
routineUI = createRoutineUI({api,getSession:()=>state.session,getRoom:()=>state.rooms.find(room=>room.id===currentBranchId()),toast,onChanged:async()=>{await refreshRoom(true);await loadRooms();refreshExtras();}});
messageQueueUI = createMessageQueue({api, getSession:()=>state.session, toast, onRefresh:async roomId=>{
  const tasks=[];
  if(state.selectedRoom===roomId)tasks.push(refreshRoom(true));
  state.extra.forEach((pane,index)=>{if(pane.roomId===roomId)tasks.push(refreshExtra(index));});
  await Promise.all(tasks);
}});
const loginPendingButton = $("#browser-login-pending");
loginUI = createLoginRequestUI({api,toast,
  getContext:()=>({userId:state.session?.user?.id,roomId:currentBranchId(),isOwner:state.session?.user?.hostAdmin===true}),
  onPendingChange:({count,request})=>{
    const button=loginPendingButton;
    if(!button)return;
    const pane=state.focusPane>0?$$(".extra-pane")[state.focusPane-1]:$("#room-view");
    pane?.querySelector("form.composer,form.pane-composer")?.before(button);
    button.hidden=!count;
    button.textContent=request ? `Vault에서 로그인 · ${new URL(request.origin).hostname}` : "Vault에서 로그인";
    button.onclick=()=>loginUI.open(request?.id);
  },
  onResolved:()=>{void refreshBrowserLogins();},
});
modelFailoverUI = createModelFailoverUI({api,getSession:()=>state.session,toast,
  onRefresh:async roomId=>{
    const tasks=[];
    if(state.selectedRoom===roomId)tasks.push(refreshRoom(true));
    state.extra.forEach((pane,index)=>{if(pane.roomId===roomId)tasks.push(refreshExtra(index));});
    await Promise.all(tasks);
  },
  onSelectModel:({roomId,select:choose})=>{
    const index=state.extra.findIndex(pane=>pane.roomId===roomId);
    const form=state.selectedRoom===roomId?$("#composer-form"):index>=0?$$(".extra-pane")[index]?.querySelector(".pane-composer"):null;
    const model=form?.querySelector(".model-select"),trigger=form?.querySelector(".model-failover-select");
    if(!model||!trigger)return;
    // The in-flight request keeps its messages and completed tools. This choice
    // only replaces its next model call; regular composer preferences stay intact.
    openModelBrowser(model,trigger,{onChoose:choose});
  }
});
voiceUI = createVoiceCall({api,getSession:()=>state.session,getRoom:id=>state.rooms.find(room=>room.id===id),toast,
  beforeStart:cancelActiveRecording,
  getSelection:id=>{
    const prefs=roomPreferences(id),pane=state.extra.find(item=>item.roomId===id);
    return {model:id===state.selectedRoom?$("#model-select").value:pane?.model||prefs.model||"",effort:id===state.selectedRoom?$("#effort-select").value:pane?.effort||prefs.effort||"",botIds:[state.selectedBots[0]||state.bots[0]?.id].filter(Boolean)};
  },
  onMessages:id=>{if(state.selectedRoom===id)void refreshRoom(true);refreshExtras();}
});
sharingUI = createRoomSharing({api,getSession:()=>state.session,toast,onRoomCreated:async room=>{await loadRooms();await selectRoom(room.id);},onInvite:room=>makeInvite(`/api/rooms/${encodeURIComponent(room.id)}/invites`,"room")});
const workspaceButton = $(".topbar-actions .desktop-button");
if (workspaceButton) {
  const monitor = document.createElementNS("http://www.w3.org/2000/svg", "svg"); monitor.setAttribute("class", "icon"); monitor.setAttribute("viewBox", "0 0 24 24"); monitor.setAttribute("aria-hidden", "true");
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", "M4 4h16v12H4zM12 16v4m-4 0h8"); monitor.append(path); workspaceButton.replaceChildren(monitor);
  workspaceButton.setAttribute("aria-label", "작업 공간 열기 또는 닫기"); workspaceButton.title = "작업 공간";
  workspaceButton.parentElement.insertBefore(workspaceButton, $("#voice-call-button"));
}
setupUI = createBotSetupUI({ api, getSession: () => state.session, onSaved: refreshSetupState, toast });
mailUI = createMailUI({ api, getSession: () => state.session, toast, openRoom: async id => {await loadRooms();await selectRoom(id);} });
loadSession();


// Docking changes only the arrangement; room identity and permissions stay unchanged.
function dockPanels() { return [$("#room-view"), ...$$(".extra-pane")]; }
function applyDockLayout() {
  const grid = $("#pane-grid");
  const split = dockRects.length > 1;
  grid.classList.toggle("docked", split);
  const topbar = $(".topbar"), main = $(".main-panel"), primary = $("#room-view");
  main.classList.toggle("is-split", split);
  // Keep the existing controls and handlers, but make them the first pane's header.
  if (split && topbar.parentElement !== primary) primary.prepend(topbar);
  else if (!split && topbar.parentElement !== main) main.insertBefore(topbar, grid);
  topbar.classList.toggle("pane-bar", split);
  const actions = $(".topbar-actions");
  const toolsHost = topbar;
  if (actions && actions.parentElement !== toolsHost) toolsHost.append(actions);
  dockPanels().forEach((panel, index) => {
    panel.dataset.dockIndex = index;
    let close=panel.querySelector(":scope > .pane-close");
    if(dockRects.length>1) {
      if(!close){close=document.createElement("button");close.className="pane-close";close.type="button";close.textContent="×";panel.append(close);}
      close.setAttribute("aria-label",(dockRoomAt(index)?state.rooms.find(r=>r.id===dockRoomAt(index))?.name || "대화":"빈")+" 분할 닫기");
      close.onclick=()=>closeDockPane(index);
    } else close?.remove();
    const rect = dockRects[index];
    if (rect && dockRects.length > 1) Object.assign(panel.style, {left:rect.x*100+"%", top:rect.y*100+"%", width:rect.w*100+"%", height:rect.h*100+"%", gridColumn:""});
    else for (const key of ["left","top","width","height"]) panel.style[key] = "";
    const handle = index || split ? panel.querySelector(".pane-bar") : $(".header-identity");
    if (handle) { handle.draggable = false; handle.dataset.dockIndex = index; handle.title = "드래그해서 이동 · 우클릭으로 분할"; }
  });
  syncSessionColors();
}
async function closeDockPane(index) {
  if(dockRects.length<2)return;
  if(index===0 ? $("#message-input").value.trim() : state.extra[index-1]?.draft?.trim()) {toast("작성 중인 메시지를 보내거나 비운 뒤 창을 닫아주세요.");return;}
  if ((index === 0 ? state.pendingAttachments.length || state.extra[0]?.pendingAttachments?.length : state.extra[index-1]?.pendingAttachments?.length)) {
    toast("첨부 파일을 보내거나 제거한 뒤 창을 닫아주세요."); return;
  }
  let promote;
  if(index===0){promote=state.extra.shift();if(promote)clearAttachmentDraft(promote);} else {clearAttachmentDraft(state.extra[index-1]);state.extra.splice(index-1,1);}
  const count=state.extra.length+1;
  dockRects=Array.from({length:count},(_,i)=>({x:i/count,y:0,w:1/count,h:1}));
  state.layout=count;state.focusPane=0;$("#pane-grid").dataset.panes=String(count);
  if(promote?.roomId) await selectRoom(promote.roomId);
  renderExtraPanes();renderRooms();applyDockLayout();
}
function dockRoomAt(index) { return index === 0 ? state.selectedRoom : state.extra[index-1]?.roomId; }
function dockZone(panel, event) {
  const r=panel.getBoundingClientRect(), x=(event.clientX-r.left)/r.width, y=(event.clientY-r.top)/r.height;
  const distances=[x,1-x,y,1-y], side=["left","right","top","bottom"][distances.indexOf(Math.min(...distances))];
  return Math.min(...distances) > .3 && pendingDock?.index !== undefined ? "center" : side;
}
function placeDock(index, side) {
  if (!pendingDock || !state.selectedRoom) return;
  const source = pendingDock; pendingDock = null;
  if (source.index !== undefined) {
    if (source.index === index) return;
    // Move existing panes without restarting their sessions.
    [dockRects[source.index],dockRects[index]]=[dockRects[index],dockRects[source.index]];
    applyDockLayout(); return;
  }
  if (dockRects.length >= 8) { toast("분할 화면은 최대 8개입니다."); return; }
  const r = dockRects[index], next={...r};
  if (side === "left" || side === "right") {
    next.w=r.w/2; r.w/=2;
    if (side === "left") r.x+=r.w; else next.x+=r.w;
  } else {
    next.h=r.h/2; r.h/=2;
    if (side === "top") r.y+=r.h; else next.y+=r.h;
  }
  dockRects.push(next);
  state.extra.push({roomId:source.roomId, data:null,busy:false,request:0,...roomPreferences(source.roomId)});
  state.layout=dockRects.length;
  $("#pane-grid").dataset.panes=String(state.layout);
  renderExtraPanes(); renderRooms(); refreshExtras(); applyDockLayout();
}
async function moveSession(roomId, targetId, after = false) {
  if (!sidebarState.loaded || roomId === targetId) return;
  const order = layoutBranches(state.rooms.filter(room => room.id !== MONITOR_ROOM), state.forks, {order:sidebarState.roomOrder}).rows.map(row => row.id);
  if (!order.includes(roomId) || !order.includes(targetId)) return;
  const next = order.filter(id => id !== roomId), index = next.indexOf(targetId) + (after ? 1 : 0);
  next.splice(index, 0, roomId);
  if (next.every((id, i) => id === order[i])) return;
  const userId = state.session?.user?.id, epoch = sidebarEpoch;
  if (await saveSidebar({...sidebarState, roomOrder:next}) && state.session?.user?.id === userId && sidebarEpoch === epoch) toast("대화 순서를 저장했습니다.");
}
function setupDock() {
  const grid=$("#pane-grid"), preview=document.createElement("div"), menu=document.createElement("div"), hint=document.createElement("div");
  preview.className="dock-preview"; preview.hidden=true; document.body.append(preview);
  hint.className="session-drag-hint";hint.hidden=true;hint.setAttribute("role","status");hint.setAttribute("aria-live","polite");document.body.append(hint);
  menu.className="dock-menu"; menu.hidden=true; menu.setAttribute("role","menu"); document.body.append(menu);
  let pointerDock = null, suppressClick = false, scrollFrame = null;
  const sourceRoom = () => pendingDock?.roomId || (pendingDock?.index !== undefined ? dockRoomAt(pendingDock.index) : null);
  const hide=()=>{preview.hidden=true;hint.hidden=true;menu.hidden=true;};
  function dropAt(event) {
    const hit=document.elementFromPoint(event.clientX,event.clientY), sourceId=sourceRoom();
    if(!hit || !sourceId)return null;
    const row=hit.closest(".branch-row[data-dock-room]");
    if(row){
      const targetId=row.dataset.dockRoom;if(targetId===sourceId)return null;
      const rect=row.getBoundingClientRect(), fraction=(event.clientY-rect.top)/rect.height;
      if(fraction<.25||fraction>.75)return {kind:"order",row,targetId,after:fraction>.75};
      return {kind:"merge",row,targetId};
    }
    if(hit.closest("#room-list")){
      const rows=$$(".branch-row[data-dock-room]",els.roomList);if(!rows.length)return null;
      const first=rows[0],last=rows[rows.length-1],before=event.clientY<first.getBoundingClientRect().top;
      const target=before?first:last;if(target.dataset.dockRoom===sourceId)return null;
      return {kind:"order",row:target,targetId:target.dataset.dockRoom,after:!before};
    }
    const panel=hit.closest("#pane-grid > .room-view");if(!panel)return null;
    const index=Number(panel.dataset.dockIndex),targetId=dockRoomAt(index);
    if(hit.closest(".pane-bar")&&targetId&&targetId!==sourceId)return {kind:"merge",row:panel.querySelector(".pane-bar"),targetId};
    if(pendingDock?.index===index)return null;
    return {kind:"dock",panel,index,side:dockZone(panel,event)};
  }
  function previewDrop(drop,event) {
    if(!drop){preview.hidden=true;hint.textContent="목록 사이: 순서 이동 · 제목 위: Merge · 대화 안: 분할";hint.hidden=false;return;}
    let rect,label,kind=drop.kind;
    if(kind==="order"){
      rect=drop.row.getBoundingClientRect();rect={left:rect.left,top:(drop.after?rect.bottom:rect.top)-2,width:rect.width,height:4};
      label="이 위치로 이동";
    }else if(kind==="merge"){
      rect=drop.row.getBoundingClientRect();label="Merge · "+(state.rooms.find(room=>room.id===drop.targetId)?.name||"대화")+"와 합치기";
      if([sourceRoom(),drop.targetId].some(id=>id===MONITOR_ROOM||!state.rooms.some(room=>room.id===id&&!room.archived))){kind="blocked";label="이 항목은 합칠 수 없어요";}
      else if(branchBusy(sourceRoom())||branchBusy(drop.targetId)){kind="blocked";label="작업이 끝난 뒤 합칠 수 있어요";}
    }else{
      const r=drop.panel.getBoundingClientRect();rect={left:r.left,top:r.top,width:r.width,height:r.height};
      if(pendingDock?.index===undefined){
        if(drop.side==="left"||drop.side==="right"){rect.width/=2;if(drop.side==="right")rect.left+=rect.width;}
        else{rect.height/=2;if(drop.side==="bottom")rect.top+=rect.height;}
        label="여기에 분할";
      }else label="창 위치 바꾸기";
    }
    preview.dataset.dropKind=kind;preview.textContent=kind==="order"?"":label;
    Object.assign(preview.style,{left:rect.left+"px",top:rect.top+"px",width:rect.width+"px",height:rect.height+"px"});preview.hidden=false;
    hint.textContent=label;hint.hidden=false;
    Object.assign(hint.style,{left:Math.max(8,Math.min(event.clientX+14,innerWidth-280))+"px",top:Math.max(8,Math.min(event.clientY+18,innerHeight-64))+"px"});
  }
  function completeDrop(drop) {
    const roomId=sourceRoom();if(!drop||!roomId)return;
    if(drop.kind==="order")void moveSession(roomId,drop.targetId,drop.after);
    else if(drop.kind==="merge"){
      if(branchBusy(roomId)||branchBusy(drop.targetId)){toast("진행 중인 작업이 끝난 뒤 합쳐 주세요.");return;}
      mergeBranch(drop.targetId,roomId);
    }else{placeDock(drop.index,drop.side);closeSidebar();}
  }
  function stopPointer() {
    if(scrollFrame!==null)cancelAnimationFrame(scrollFrame);scrollFrame=null;
    const drag=pointerDock;pointerDock=null;pendingDock=null;hide();
    document.body.classList.remove("session-dragging");
    if(drag&&document.body.hasPointerCapture(drag.id))document.body.releasePointerCapture(drag.id);
  }
  function scrollList() {
    if(!pointerDock?.active)return;
    if(pointerDock.epoch!==sidebarEpoch){stopPointer();return;}
    const {lastX:x,lastY:y}=pointerDock,r=els.roomList.getBoundingClientRect();
    if(x>=r.left&&x<=r.right&&y>=r.top&&y<=r.bottom){
      const delta=y<r.top+32?-9:y>r.bottom-32?9:0;
      if(delta){els.roomList.scrollTop+=delta;previewDrop(dropAt({clientX:x,clientY:y}),{clientX:x,clientY:y});}
    }
    scrollFrame=requestAnimationFrame(scrollList);
  }
  document.addEventListener("pointerdown", event => {
    if(pointerDock?.active)stopPointer();
    if (event.button!==0 || pendingDock?.placing || event.target.closest("select,input,textarea")) return;
    const room=event.target.closest("[data-dock-room]"),handle=event.target.closest(".pane-bar[data-dock-index],.header-identity[data-dock-index]");
    if(!room&&(!handle||event.target.closest("button")))return;
    // Touching a row scrolls the list. Only the explicit handle starts a touch drag.
    if(event.pointerType==="touch"&&room&&!event.target.closest(".session-drag-handle"))return;
    if(event.pointerType==="touch"&&handle&&!room)return;
    pointerDock={id:event.pointerId,epoch:sidebarEpoch,x:event.clientX,y:event.clientY,lastX:event.clientX,lastY:event.clientY,source:room?{roomId:room.dataset.dockRoom}:{index:Number(handle.dataset.dockIndex)}};
  });
  document.addEventListener("pointermove", event => {
    if(!pointerDock||event.pointerId!==pointerDock.id)return;
    if(event.pointerType!=="touch"&&event.buttons===0){stopPointer();return;}
    if(pointerDock.epoch!==sidebarEpoch){stopPointer();return;}
    pointerDock.lastX=event.clientX;pointerDock.lastY=event.clientY;
    if(!pointerDock.active&&Math.hypot(event.clientX-pointerDock.x,event.clientY-pointerDock.y)<7)return;
    if(!pointerDock.active){pointerDock.active=true;document.body.setPointerCapture(event.pointerId);document.body.classList.add("session-dragging");scrollFrame=requestAnimationFrame(scrollList);}
    pendingDock=pointerDock.source;event.preventDefault();previewDrop(dropAt(event),event);
  },{passive:false});
  document.addEventListener("pointerup", event => {
    if(!pointerDock||event.pointerId!==pointerDock.id)return;
    if(pointerDock.active&&pointerDock.epoch===sidebarEpoch){completeDrop(dropAt(event));suppressClick=true;setTimeout(()=>{suppressClick=false;},0);}
    stopPointer();
  });
  document.addEventListener("click",event=>{if(suppressClick){event.preventDefault();event.stopImmediatePropagation();}},true);
  document.addEventListener("pointercancel",stopPointer);
  els.roomList.addEventListener("scroll",()=>{if(pointerDock&&!pointerDock.active)stopPointer();},{passive:true});
  document.body.addEventListener("lostpointercapture",event=>{if(event.target===document.body&&pointerDock?.id===event.pointerId)stopPointer();});
  window.addEventListener("blur",stopPointer);
  document.addEventListener("dragstart",event=>{if(event.target.closest("[data-dock-room],.pane-bar[data-dock-index]"))event.preventDefault();});
  grid.addEventListener("pointermove",event=>{if(pendingDock?.placing)previewDrop(dropAt(event),event);});
  grid.addEventListener("click",event=>{if(pendingDock?.placing){event.preventDefault();event.stopImmediatePropagation();completeDrop(dropAt(event));pendingDock=null;hide();}},true);
  els.roomList.addEventListener("keydown",event=>{
    if(!event.altKey||!["ArrowUp","ArrowDown"].includes(event.key))return;
    const row=event.target.closest(".branch-row");if(!row)return;
    const rows=$$(".branch-row",els.roomList),index=rows.indexOf(row),target=rows[index+(event.key==="ArrowUp"?-1:1)];
    event.preventDefault();if(target)void moveSession(row.dataset.roomId,target.dataset.roomId,event.key==="ArrowDown");
  });
  const begin=roomId=>{pendingDock={roomId,placing:true};menu.hidden=true;toast("놓을 위치를 가리킨 뒤 클릭하세요. 제목 위는 Merge, 대화 안은 분할입니다.");};
  document.addEventListener("contextmenu",event=>{
    const room=event.target.closest("[data-dock-room]"), panel=event.target.closest("[data-dock-index]");
    if(!room&&!panel)return;if(event.target.closest("textarea,input"))return;
    event.preventDefault();menu.replaceChildren();
    const action=document.createElement("button");action.type="button";action.setAttribute("role","menuitem");action.textContent="Split view로 열기";
    action.onclick=()=>begin(room?.dataset.dockRoom || dockRoomAt(Number(panel.dataset.dockIndex)));menu.append(action);
    const targetRoom=state.rooms.find(r=>r.id===(room?.dataset.dockRoom || dockRoomAt(Number(panel.dataset.dockIndex))));
    if(targetRoom) {
      paintSession(menu,sessionColors(state.rooms,state.forks).get(targetRoom.id));
      const addAction=(label,handler)=>{const b=document.createElement("button");b.type="button";b.setAttribute("role","menuitem");b.textContent=label;b.onclick=()=>{menu.hidden=true;handler();};menu.append(b);};
      if(targetRoom.id!==MONITOR_ROOM){
        if(targetRoom.role==="owner")addAction("제목 변경",()=>openSessionRename(targetRoom.id));
        addAction("색상 변경",()=>openSessionColor(targetRoom.id));
      }
      if(targetRoom.id!==MONITOR_ROOM&&!targetRoom.archived){
        addAction("여기서 Fork",()=>void sessionAction("fork",null,null,null,null,targetRoom.id));
        addAction("다른 가지와 Merge",()=>mergeBranch(targetRoom.id));
      }
      if(sidebarState.loaded&&sidebarState.groups.length&&targetRoom.id!==MONITOR_ROOM)addAction("그룹으로 이동",()=>openRoomGroupPicker(targetRoom));
      addAction(targetRoom.pinned?"고정 해제":"상단에 고정",()=>updateRoomListPreference(targetRoom,{pinned:!targetRoom.pinned}));
      addAction(targetRoom.archived?"대화 복원":"대화 삭제",()=>confirmRemoveConversation(targetRoom));
    }
    const reset=document.createElement("button");reset.type="button";reset.setAttribute("role","menuitem");reset.textContent="분할 닫기";reset.onclick=()=>{state.layout=2;setLayout(2);dockRects=[{x:0,y:0,w:1,h:1}];applyDockLayout();hide();};menu.append(reset);
    menu.hidden=false;Object.assign(menu.style,{left:Math.max(8,Math.min(event.clientX,innerWidth-menu.offsetWidth-8))+"px",top:Math.max(8,Math.min(event.clientY,innerHeight-menu.offsetHeight-8))+"px"});action.focus();
  });
  document.addEventListener("pointerdown",event=>{if(!menu.contains(event.target))menu.hidden=true;});
  document.addEventListener("keydown",event=>{if(event.key==="Escape")stopPointer();});
  applyDockLayout();
}
