import test from 'node:test';
import assert from 'node:assert/strict';
import {createContinuation,beginTool,finishTool,snapshotContinuation,continuationPrompt} from '../message-continuation.mjs';

test('steering keeps the original request and every accepted addition, without duplicating the newest instruction', () => {
  const initial = createContinuation({requestText:'서버를 확인하고 보고서를 만들어 줘'});
  const first = snapshotContinuation(initial, '보고서는 한국어로 작성해 줘');
  const resumed = createContinuation({requestText:'보고서는 한국어로 작성해 줘',continuation:first});
  const second = snapshotContinuation(resumed, '디스크도 확인해 줘');
  assert.deepEqual(second.requests, ['서버를 확인하고 보고서를 만들어 줘','보고서는 한국어로 작성해 줘','디스크도 확인해 줘']);
  const prompt = continuationPrompt(second);
  assert.match(prompt, /아직 끝나지 않은 목표를 유지/);
  assert.equal(prompt.split('한국어로 작성해 줘').length, 2);
  assert.match(prompt,/최신 사용자 지시/);
  assert.deepEqual(initial.requests, ['서버를 확인하고 보고서를 만들어 줘']);
});

test('completed tools are observed checkpoints; interrupted or failed side effects remain explicitly uncertain', () => {
  const state=createContinuation({requestText:'프로그램을 설치해 줘'});
  const completed=beginTool(state,'host_exec',{command:'install example'});
  finishTool(state,completed,{exitCode:0,stdout:'Installed example'});
  finishTool(state,completed,'duplicate callback');
  const pending=beginTool(state,'browser_click',{selector:'Submit'});
  const before=snapshotContinuation(state,'설치 결과도 정리해 줘');
  assert.deepEqual(before.checkpoints.map(item=>item.status),['completed','uncertain']);
  assert.match(before.checkpoints[0].result,/Installed example/);
  finishTool(state,pending,null,new DOMException('aborted','AbortError'));
  const after=snapshotContinuation(state,'설치 결과도 정리해 줘');
  assert.equal(after.checkpoints.length,2);
  assert.equal(after.checkpoints[1].status,'uncertain');
  assert.match(continuationPrompt(after),/중복 실행하지 마세요/);
  assert.match(continuationPrompt(after),/현재 상태를 조회한 뒤/);
  assert.equal(JSON.stringify(after).includes('pending'),false);
});

test('handoffs are immutable serializable copies and do not capture arbitrary reasoning fields', () => {
  const state=createContinuation({requestText:'원래 요청'});
  state.reasoning='internal text must not transfer';
  const tool=beginTool(state,'read',{path:'report'});
  const snapshot=snapshotContinuation(state,'추가');
  finishTool(state,tool,'latest result');
  const copy=JSON.parse(JSON.stringify(snapshot));
  assert.equal(copy.checkpoints[0].status,'uncertain');
  assert.equal(JSON.stringify(copy).includes(state.reasoning),false);
  assert.equal(createContinuation({continuation:copy}).checkpoints[0].status,'uncertain');
});

test('bounded tool records explicitly mark omissions; full user instructions are rejected instead of silently truncated', () => {
  const state=createContinuation({requestText:'원래 요청'});
  for(let i=0;i<30;i++) { const id=beginTool(state,'host_exec',{command:'x'.repeat(10000)});finishTool(state,id,'start'+('z'.repeat(10000))+'end'); }
  const snapshot=snapshotContinuation(state,'추가');
  assert.ok(snapshot.omittedCheckpoints>0);
  assert.ok(JSON.stringify(snapshot.checkpoints).length<=12000);
  assert.match(snapshot.checkpoints.at(-1).result,/일부 기록 생략/);
  assert.ok(snapshot.checkpoints.at(-1).result.endsWith('end'));
  assert.match(continuationPrompt(snapshot),/다시 실행하기 전에 상태를 확인/);
  assert.throws(()=>snapshotContinuation(createContinuation({requestText:'x'.repeat(16000)}),'y'),{status:409});
  const ordinaryLongRequest=createContinuation({requestText:'x'.repeat(20000)});
  assert.equal(ordinaryLongRequest.requests[0].length,20000);
  assert.throws(()=>snapshotContinuation(ordinaryLongRequest,'추가'),{status:409});
  assert.throws(()=>createContinuation({continuation:{version:1,requests:Array(17).fill('x')}}),{status:409});
});

test('mobile workspace target survives serializable and repeated steering without altering requests', () => {
  const initial = createContinuation({requestText:'설정 열어줘',workspaceContext:'mobile'});
  const handoff = JSON.parse(JSON.stringify(snapshotContinuation(initial,'밝기도 내려줘')));
  const resumed = createContinuation({requestText:'밝기도 내려줘',continuation:handoff});
  const next = snapshotContinuation(resumed,'소리도 줄여줘');
  assert.equal(next.workspaceContext,'mobile');
  assert.deepEqual(next.requests,['설정 열어줘','밝기도 내려줘','소리도 줄여줘']);
  assert.equal(createContinuation({requestText:'일반 대화'}).workspaceContext,'');
  assert.equal(createContinuation({workspaceContext:'untrusted text',continuation:{...handoff,workspaceContext:'untrusted text'}}).workspaceContext,'');
  assert.equal(createContinuation({workspaceContext:'mobile',continuation:snapshotContinuation(createContinuation({requestText:'첫 요청'}))}).workspaceContext,'mobile');
});
