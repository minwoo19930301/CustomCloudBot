import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const part = (start, end) => source.slice(source.indexOf(start), source.indexOf(end, source.indexOf(start)));

function setup() {
  class Element {
    constructor(tag, text, className) { this.tagName=tag;this.textContent=text;this.className=className||'';this.children=[];this.attributes={};this.dataset={};this.value='작성 중인 초안';this.disabled=false;this.classes=new Set();this.classList={toggle:(name,on)=>on?this.classes.add(name):this.classes.delete(name)}; }
    append(...items) {for(const item of items){item.parent=this;this.children.push(item);}}
    prepend(item) {item.parent=this;this.children.unshift(item);}
    remove() {this.parent.children=this.parent.children.filter(item=>item!==this);}
    setAttribute(name,value){this.attributes[name]=value;}
    closest(){return this.form;}
    query(selector){return this.children.find(item=>selector==='button'?item.tagName==='button':item.className===selector.slice(1))||null;}
  }
  const forms = [0,1].map(() => {
    const form = new Element('form'); form.nodes={};
    for(const name of ['.model-select','.effort-select','textarea','button[type="submit"]','.attach-button']){
      const node=new Element(name);node.form=form;form.nodes[name]=node;
      if(name.includes('select'))node._triggerButton=new Element('button');
    }
    return form;
  });
  const state={session:{user:{id:'owner'}},rooms:[{id:'main',role:'owner',readOnly:true},{id:'child',role:'owner',readOnly:false}],selectedRoom:'main',roomData:{room:{id:'main',role:'owner',readOnly:false}},sending:false,extra:[{roomId:'child',data:{room:{id:'child',role:'owner',readOnly:false}},draft:'분할 초안'}]};
  forms[1].nodes['.model-select']._pane=state.extra[0];
  const phones=[new Element('button'),new Element('button')];phones[1]._pane=state.extra[0];
  const forks=[];
  const runtime={state,MONITOR_ROOM:'monitor',pendingMessages:new Map(),modelChanges:new Map(),branchOperations:new Set(),composerRecorder:null,
    $:(selector,root)=>root?.nodes?.[selector] || root?.query(selector),
    $$:(selector,root)=>selector==='.model-select'?forms.map(form=>form.nodes[selector]):selector==='.voice-call-button'?phones:selector==='.attach-button, #attach-button, input[type=file]'?[root.nodes['.attach-button']]:[],
    contextElement:(...args)=>new Element(...args),currentBranchId:()=>state.selectedRoom,
    syncRecordingButtons(){},updateBranchControls(){},syncSessionActivity(){},updateAgentPresence(){},composerSuggestions:{sync({input}){input.placeholder='추천 문장';}},
    sessionAction:(...args)=>forks.push(args),
  };
  vm.runInNewContext(part('function roomReadOnly(', 'function clearPendingAttachments(')+
    part('function roomContextOwner(', 'function contextOwnerCurrent(')+
    part('function composerBlocked(', 'function confirmModelChange(')+
    '\nthis.update=updateModelAvailability;this.owner=roomContextOwner;this.blocked=composerBlocked;',runtime);
  return {state,forms,phones,forks,update:runtime.update,owner:runtime.owner,blocked:runtime.blocked};
}

test('main and split composers use the newest readonly flag without locking their writable sibling', () => {
  const app=setup();app.update();
  const [main,split]=app.forms;
  assert.equal(main.nodes.textarea.readOnly,true);
  assert.equal(main.nodes.textarea.disabled,false,'a preserved draft remains selectable for copying');
  assert.equal(main.nodes.textarea.value,'작성 중인 초안');
  assert.equal(main.nodes['button[type="submit"]'].disabled,true);
  assert.equal(main.nodes['.attach-button'].disabled,true);
  assert.equal(main.nodes['.model-select']._triggerButton.disabled,true);
  assert.equal(main.nodes['.effort-select']._triggerButton.disabled,true);
  assert.equal(app.owner().canManage,false,'compact/reset must be unavailable');
  assert.equal(app.blocked(),true);
  assert.equal(app.phones[0].disabled,true);
  assert.equal(app.phones[1].disabled,false);
  assert.equal(split.nodes.textarea.readOnly,false);
  assert.equal(split.nodes['button[type="submit"]'].disabled,false);
  const notice=main.query('.composer-readonly');assert.match(notice.children[0].textContent,/새 가지/);
  const fork=notice.query('button');assert.equal(fork.disabled,false);fork.onclick();
  assert.equal(app.forks[0][0],'fork');assert.equal(app.forks[0][1],null);
  app.state.rooms[1].readOnly=true;app.update();
  assert.equal(split.nodes.textarea.readOnly,true);
  assert.equal(split.nodes['button[type="submit"]'].disabled,true);
  const splitFork=split.query('.composer-readonly').query('button');assert.equal(splitFork.disabled,false);splitFork.onclick();
  assert.equal(app.forks[1][1],app.state.extra[0]);
});

test('a stale list refresh cannot unlock a frozen source, while selecting a writable child removes the notice', () => {
  const app=setup();app.state.rooms[0].readOnly=false;app.state.roomData.room.readOnly=true;app.update();
  assert.equal(app.forms[0].nodes.textarea.readOnly,true);
  app.state.selectedRoom='child';app.state.roomData=app.state.extra[0].data;app.update();
  assert.equal(app.forms[0].nodes.textarea.readOnly,false);
  assert.equal(app.forms[0].nodes['button[type="submit"]'].disabled,false);
  assert.equal(app.forms[0].query('.composer-readonly'),null);
  assert.equal(app.forms[0].nodes.textarea.placeholder,'추천 문장');
});
