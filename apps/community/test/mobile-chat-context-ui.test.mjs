import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

// Exercise the real app-to-workspace adapter without booting the entire app DOM.
const source=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const start=source.indexOf('desktopUI = createDesktopUI({');
const end=source.indexOf('\nprofileUI = ',start);
assert.ok(start>=0 && end>start);
const adapterSource=source.slice(start,end);

test('mobile chat keeps its own room target and tags the unchanged message even while another room is selected',async()=>{
  const calls=[];
  const context={
    api:async(path,options)=>{calls.push({path,body:JSON.parse(options.body)});return {accepted:true};},
    state:{selectedRoom:'foreground-room',rooms:[],extra:[{roomId:'mobile-room',model:'chosen-model',effort:'high'}],selectedBots:['bot-analyst'],bots:[]},
    roomPreferences:()=>({}),createDesktopUI:options=>options,toast:()=>{},crypto:{randomUUID:()=>'test-nonce'},
    agentPresence:null,applyModels:()=>{},refreshRoom:()=>{},refreshExtras:()=>{},loadRooms:async()=>{},
  };
  runInNewContext(adapterSource,context);
  await context.desktopUI.mobileChat.send('mobile-room','설정 열어줘');
  assert.equal(calls.length,1);
  assert.equal(calls[0].path,'/api/rooms/mobile-room/messages');
  assert.equal(calls[0].body.workspaceContext,'mobile');
  assert.equal(calls[0].body.text,'설정 열어줘');
  assert.equal(calls[0].body.model,'chosen-model');
  assert.equal(calls[0].body.effort,'high');
  assert.equal(calls[0].body.queueIfBusy,true);
});
