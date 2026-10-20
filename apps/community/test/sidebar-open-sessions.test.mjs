import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {layoutBranches, branchGraphGeometry, branchDisplayName, branchFocus, branchEdgeKey} from '../public/branch-graph.mjs';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
function functionSource(start, end) {
  const from = source.indexOf(start), to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `Application function range ${start}`);
  return source.slice(from, to);
}

class Element {
  constructor(tag) {
    this.tagName = tag; this.children = []; this.dataset = {}; this.attributes = new Map(); this.className = '';
    this.scrollCalls = [];
    this.style = {setProperty() {}, removeProperty() {}};
    this.classList = {
      contains: name => this.className.split(/\s+/).includes(name),
      toggle: (name, on = !this.classList.contains(name)) => {
        this.className = [...this.className.split(/\s+/).filter(value => value && value !== name), ...(on ? [name] : [])].join(' ');
        return on;
      },
      add: (...names) => names.forEach(name => this.classList.toggle(name, true)),
      remove: (...names) => names.forEach(name => this.classList.toggle(name, false)),
    };
  }
  append(...nodes) { nodes.forEach(node => { node.parent = this; this.children.push(node); }); }
  prepend(...nodes) { nodes.forEach(node => { node.parent = this; }); this.children.unshift(...nodes); }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(key, value) {
    this.attributes.set(key, String(value));
    if (key === 'class') this.className = String(value);
    if (key.startsWith('data-')) this.dataset[key.slice(5).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = String(value);
  }
  getAttribute(key) { return this.attributes.get(key) ?? null; }
  removeAttribute(key) { this.attributes.delete(key); }
  contains(node) { return this === node || this.children.some(child => child.contains(node)); }
  addEventListener() {}
  querySelector() { return null; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); }
  scrollIntoView(options) {
    const request = {...options}; this.scrollCalls.push(request);
    for (let node = this; node; node = node.parent) {
      if (node.scrollLog) { node.scrollLog.push({roomId:this.dataset.roomId, options:request}); break; }
    }
  }
}
function descendants(node) { return node.children.flatMap(child => [child, ...descendants(child)]); }

function fixture({open = ['a', 'b'], focus = 0} = {}) {
  const roomList = new Element('nav'), main = new Element('section'), grid = new Element('main');
  roomList.scrollLog = [];
  grid.append(main);
  const state = {
    selectedRoom: open[0], extra: open.slice(1).map(roomId => ({roomId})), layout: open.length, focusPane: focus,
    rooms: ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'closed'].map((id, i) => ({id, name: `Room ${id}`, createdAt: i + 1})),
    forks: [], pendingAttachments: [],
  };
  const nodes = {'#room-view': main, '#pane-grid': grid, '#message-input': {value: ''}};
  const find = (selector, parent = grid) => descendants(parent).filter(node => selector.split(',').some(part => {
    const item = part.trim();
    return item === 'button' ? node.tagName === 'button' : item === '[data-activity-room]' ? !!node.dataset.activityRoom :
      item.startsWith('.') && node.classList.contains(item.slice(1));
  }));
  const runtime = {
    state, els: {roomList}, document: {activeElement: null, createElement: tag => new Element(tag), createElementNS: (_, tag) => new Element(tag)},
    MONITOR_ROOM: 'monitor', showDeletedRooms: false, sidebarState: {roomOrder: []}, sessionSearch: '',
    layoutBranches, branchGraphGeometry, branchDisplayName, branchFocus, branchEdgeKey, sidebarBranchFocus:null, sessionColors: () => new Map(),
    renderAccountTools() {}, updateBranchControls() {}, syncSessionActions() {}, syncSessionColors() {},
    $: (selector,parent) => parent?find(selector,parent)[0]:nodes[selector], $$: find, icon: () => new Element('svg'),
    closeBotPickers() {}, closeSidebar() {}, clearAttachmentDraft() {}, disposeTranscript() {}, applyDockLayout() {}, syncProgressStreams() {},
    refreshExtras() {}, refreshExtra() {}, touchConversation() {}, roomPreferences: () => ({}), composerRecorder: null, toast() {},
    renderExtraPanes() {
      find('.extra-pane').forEach(node => node.remove());
      state.extra.forEach(() => { const node = new Element('section'); node.className = 'extra-pane'; grid.append(node); });
    },
    async selectRoom(id) { state.selectedRoom = id; runtime.renderRooms(); },
    dockRects: open.map((_, index) => ({x: index / open.length, y: 0, w: 1 / open.length, h: 1})),
  };
  vm.runInNewContext([
    functionSource('function currentBranchId(', 'function branchBusy('),
    functionSource('function branchSvg(', 'function inheritSessionTheme('),
    functionSource('function focusSidebarBranch(', 'function openArchivedConversations('),
    functionSource('function sidebarRoomButton(', 'function confirmRemoveConversation('),
    functionSource('function syncSessionActivity(', 'async function refreshSidebarActivity('),
    functionSource('function setLayout(', 'function renderExtraPanes('),
    functionSource('function assignExtra(', 'function bind('),
    functionSource('async function closeDockPane(', 'function dockRoomAt('),
  ].join('\n'), runtime);
  runtime.renderExtraPanes(); runtime.renderRooms();
  return {
    state, runtime, rows: () => find('.branch-row', roomList),
    row: id => find('.branch-row', roomList).find(node => node.dataset.roomId === id),
    dots: () => descendants(roomList).filter(node => node.tagName === 'circle'),
    all: () => descendants(roomList), scrolled: () => roomList.scrollLog,
  };
}
function assertSelection(app, open, focused) {
  assert.deepEqual(app.rows().filter(row => row.classList.contains('is-open')).map(row => row.dataset.roomId).sort(), [...open].sort());
  assert.deepEqual(app.rows().filter(row => row.classList.contains('is-selected')).map(row => row.dataset.roomId), focused ? [focused] : []);
  assert.deepEqual(app.rows().filter(row => row.getAttribute('aria-current') === 'page').map(row => row.dataset.roomId), focused ? [focused] : []);
  assert.equal(app.dots().length, app.rows().length, 'only recorded graph endpoints receive a junction marker');
  for (const node of app.dots()) {
    assert.ok(node.classList.contains('branch-node'));
    assert.ok(Number(node.getAttribute('r')) > 0 && Number(node.getAttribute('r')) <= 2, 'junctions stay smaller than status badges');
    assert.equal(node.getAttribute('aria-hidden'), 'true');
    assert.equal(node.getAttribute('role'), null);
    assert.equal(node.getAttribute('tabindex'), null);
    assert.equal(node.onclick, undefined, 'junctions do not add separate controls');
  }
  const visible = app.dots().filter(node => node.getAttribute('visibility') !== 'hidden');
  assert.ok(new Set(visible.map(node => node.getAttribute('cx'))).size <= 3, 'at most three vertical lanes are visible');
}

test('all eight visible sessions remain highlighted as focus moves, without marking closed sessions', () => {
  const open = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], app = fixture({open});
  for (let focus = 0; focus < open.length; focus++) {
    app.state.focusPane = focus; app.runtime.renderRooms();
    assertSelection(app, open, open[focus]);
  }
  assert.match(app.row('a').getAttribute('aria-label'), /열린 대화/);
  assert.match(app.row('h').getAttribute('aria-label'), /현재 가지/);
});

test('empty panes and leftover state outside the active layout do not become open or current sessions', () => {
  const app = fixture({open: ['a', null, 'b'], focus: 1});
  assertSelection(app, ['a', 'b'], null);
  app.state.layout = 1; app.state.focusPane = 0; app.runtime.renderRooms();
  assertSelection(app, ['a'], 'a');
  app.state.selectedRoom = null; app.runtime.renderRooms();
  assertSelection(app, [], null);
});

test('replacing a split session clears its old highlight, while swapping two open sessions retains both', () => {
  const app = fixture({open: ['a', 'b', 'c'], focus: 1});
  app.runtime.assignExtra(0, 'd');
  assertSelection(app, ['a', 'd', 'c'], 'd');
  app.runtime.assignExtra(0, 'c');
  assertSelection(app, ['a', 'c', 'd'], 'c');
});

test('closing extra panes, promoting an extra to main, and collapsing layout immediately update sidebar highlights', async () => {
  const app = fixture({open: ['a', 'b', 'c'], focus: 2});
  await app.runtime.closeDockPane(2);
  assertSelection(app, ['a', 'b'], 'a');
  await app.runtime.closeDockPane(0);
  assertSelection(app, ['b'], 'b');
  app.runtime.setLayout(3);
  assertSelection(app, ['b', 'a', 'c'], 'b');
  app.runtime.setLayout(3);
  assertSelection(app, ['b'], 'b');
});

test('open highlights coexist with working glow, drag handles, and search ancestor styling', () => {
  const app = fixture({open: ['a', 'b'], focus: 1});
  app.state.rooms.find(room => room.id === 'a').busy = true;
  app.state.forks = [{id: 'b', parent: 'a'}]; app.runtime.sessionSearch = 'Room b'; app.runtime.renderRooms();
  assertSelection(app, ['a', 'b'], 'b');
  assert.ok(app.row('a').classList.contains('is-working'));
  assert.ok(app.row('a').classList.contains('is-ancestor'));
  assert.equal(app.row('a').getAttribute('aria-description'), '작업 진행 중');
  assert.equal(app.row('a').dataset.dockRoom, 'a');
  assert.ok(descendants(app.row('a')).some(node => node.classList.contains('session-drag-handle')));
  assert.equal(typeof app.row('a').onclick, 'function');
});

test('the alternate room button shares open/focused semantics with the branch graph', () => {
  const app = fixture({open: ['a', 'b'], focus: 1});
  for (const id of ['a', 'b', 'closed']) {
    const button = app.runtime.sidebarRoomButton(app.state.rooms.find(room => room.id === id));
    assert.equal(button.classList.contains('is-open'), id !== 'closed');
    assert.equal(button.classList.contains('is-active'), id !== 'closed');
    assert.equal(button.classList.contains('is-selected'), id === 'b');
    assert.equal(button.getAttribute('aria-current'), id === 'b' ? 'page' : null);
  }
});

test('archived conversations expand below the active tree and restore without replacing open sessions', async () => {
  const app = fixture();
  app.state.rooms.push({id:'old',name:'이전 아이디어',archived:true,createdAt:0});
  app.runtime.updateRoomListPreference = async (room,changes) => {Object.assign(room,changes);app.runtime.renderRooms();return true;};
  const all = () => descendants(app.runtime.els.roomList);
  const toggle = () => all().find(node => node.dataset.branchAction === 'archive-toggle');
  app.runtime.renderRooms();
  assert.equal(toggle().getAttribute('aria-expanded'),'false');
  assert.equal(all().filter(node => node.dataset.branchAction === 'restore').length,0);
  assertSelection(app,['a','b'],'a');
  toggle().onclick();
  assert.equal(toggle().getAttribute('aria-expanded'),'true');
  assertSelection(app,['a','b'],'a');
  assert.equal(app.row('old'),undefined);
  const restore=all().find(node => node.dataset.branchAction === 'restore');
  await restore.onclick();
  assert.ok(app.row('old'));
  assert.equal(toggle(),undefined);
  assertSelection(app,['a','b'],'a');
});


test('session and line selection focus their own flow while siblings stay selectable', () => {
  const app=fixture();app.state.forks=[{id:'b',parent:'a'},{id:'c',parent:'a'},{id:'d',parent:'b'}];app.runtime.renderRooms();
  app.runtime.focusSidebarBranch('b');
  const focused=()=>app.rows().filter(row=>row.classList.contains('is-flow-focused')).map(row=>row.dataset.roomId).sort();
  assert.deepEqual(focused(),['a','b','d']);
  assert.ok(app.row('c').classList.contains('is-flow-muted'));
  const hit=descendants(app.runtime.els.roomList).find(node=>node.classList.contains('branch-path-hit')&&node.dataset.roomId==='c');
  hit.onclick({stopPropagation(){}});
  assert.deepEqual(focused(),['a','c']);
  assert.equal(hit.getAttribute('aria-pressed'),'true');
  const graph=descendants(app.runtime.els.roomList).find(node=>node.classList.contains('branch-graph'));
  graph.onkeydown({key:'Escape',stopPropagation(){}});
  assert.equal(app.rows().some(row=>row.classList.contains('is-flow-muted')),false);
  hit.onkeydown({key:'Enter',preventDefault(){},stopPropagation(){}});
  assert.deepEqual(focused(),['a','c']);
  app.runtime.els.roomList.onclick({target:app.runtime.els.roomList});
  assert.equal(app.rows().some(row=>row.classList.contains('is-flow-muted')),false);
});

test('selecting a distant conversation pans three graph lanes and scrolls its row without removing other sessions', () => {
  const app=fixture({open:['a']});
  app.state.forks=['b','c','d','e','f','g','h'].map((id,index)=>({id,parent:['a','b','c','d','e','f','g'][index]}));
  app.runtime.renderRooms();
  const visibleIds=()=>app.dots().filter(node=>node.getAttribute('visibility')==='visible').map(node=>node.dataset.roomId);
  const rowIds=app.rows().map(row=>row.dataset.roomId);
  assert.deepEqual(visibleIds(),['a','b','c','closed']);
  const firstPath=()=>app.all().find(node=>node.classList.contains('branch-path-hit')&&node.dataset.branchFrom==='a');
  assert.equal(firstPath().getAttribute('visibility'),'visible');
  assert.equal(firstPath().getAttribute('tabindex'),'0');

  app.row('g').onclick({target:{closest:()=>null}});
  assertSelection(app,['g'],'g');
  assert.deepEqual(app.rows().map(row=>row.dataset.roomId),rowIds,'panning never hides conversation titles');
  assert.deepEqual(visibleIds(),['f','g','h']);
  const selected=app.dots().find(node=>node.dataset.roomId==='g');
  assert.equal(selected.getAttribute('cx'),'22','selected deep generation is centered, without squeezing the lanes');
  const svg=app.all().find(node=>node.classList.contains('branch-lines'));
  assert.ok(svg.classList.contains('is-windowed'));
  assert.equal(svg.getAttribute('width'),'40');
  assert.deepEqual(app.scrolled(),[{roomId:'g',options:{block:'nearest',behavior:'instant'}}]);
  assert.equal(firstPath().getAttribute('visibility'),'hidden');
  assert.equal(firstPath().getAttribute('tabindex'),'-1','an offscreen connector is not a hidden keyboard stop');

  app.runtime.renderRooms();app.runtime.focusSidebarBranch('g');
  assert.deepEqual(visibleIds(),['f','g','h']);
  assert.equal(app.scrolled().length,1,'polling and unchanged focus must not move the user’s sidebar scroll');
  app.row('b').onclick({target:{closest:()=>null}});
  assertSelection(app,['b'],'b');
  assert.deepEqual(visibleIds(),['a','b','c','closed']);
  assert.equal(firstPath().getAttribute('tabindex'),'0');
  assert.deepEqual(app.scrolled().map(item=>item.roomId),['g','b']);
});

test('connector focus pans the same viewport without changing the open conversation, and Escape restores its lanes', () => {
  const app=fixture({open:['a']});
  app.state.forks=['b','c','d','e','f','g','h'].map((id,index)=>({id,parent:['a','b','c','d','e','f','g'][index]}));
  app.runtime.renderRooms();
  app.runtime.focusSidebarBranch('f');
  const hit=app.all().find(node=>node.classList.contains('branch-path-hit')&&node.dataset.roomId==='g');
  assert.equal(hit.getAttribute('visibility'),'visible');
  hit.onclick({stopPropagation(){}});
  assert.equal(app.state.selectedRoom,'a');
  assert.equal(app.runtime.sidebarBranchFocus,'g');
  assert.equal(app.dots().find(node=>node.dataset.roomId==='g').getAttribute('cx'),'22');
  assert.equal(hit.getAttribute('aria-pressed'),'true');
  assert.deepEqual(app.scrolled().map(item=>item.roomId),['f','g']);
  const graph=app.all().find(node=>node.classList.contains('branch-graph'));
  graph.onkeydown({key:'Escape',stopPropagation(){}});
  assert.equal(app.state.selectedRoom,'a');
  assert.equal(app.runtime.sidebarBranchFocus,null);
  assert.equal(app.dots().find(node=>node.dataset.roomId==='a').getAttribute('visibility'),'visible');
  assert.equal(app.dots().find(node=>node.dataset.roomId==='g').getAttribute('visibility'),'hidden');
  assert.equal(app.scrolled().length,2,'clearing a trace does not force another vertical scroll');
});
