import test from 'node:test';
import assert from 'node:assert/strict';
import {mergePendingMessages, failedOutcome} from '../public/conversation-ui.mjs';

const human = (id = 'turn') => ({id, kind: 'human', text: '요청'});
const reply = text => ({id: 'reply', kind: 'bot', text});

test('optimistic messages remain until exact server message or own nonce reconciliation', () => {
  const pending = {id: 'pending:nonce', kind: 'human', text: '같은 문장', clientNonceHash: 'a'.repeat(64)};
  const sameText = [{id: 'other-user-message', kind: 'human', text: '같은 문장'}];
  assert.deepEqual(mergePendingMessages(sameText, pending), [...sameText, pending]);
  assert.equal(sameText.length, 1);
  const accepted = [{id: 'server-id', clientNonceHash: pending.clientNonceHash}];
  assert.equal(mergePendingMessages(accepted, pending), accepted);
  assert.equal(mergePendingMessages(accepted, {...pending, id: 'server-id', clientNonceHash: undefined}), accepted);
  assert.equal(mergePendingMessages(sameText, null), sameText);
  assert.equal(mergePendingMessages([{}], {text: 'unsaved'}).length, 2);
});

test('failed outcomes recognize actual refusal and server errors, including empty model output', () => {
  for (const text of [
    '현재 네이버 메일에 접근할 권한이 없습니다. 다시 연결해 주세요.',
    '죄송합니다. 이 환경에서는 파일을 읽을 수 없습니다.',
    '요청하신 작업은 완료하지 못했습니다.',
    '이 기능은 지원하지 않습니다.',
    'I cannot access your mailbox.',
    "I'm sorry. I am unable to execute this request.",
  ]) assert.equal(failedOutcome([human(), reply(text)]).failed, true, text);
  for (const text of ['봇이 답변을 완료하지 못했습니다. 모델 연결이나 사용량 제한을 확인해 주세요.', '모델이 답변을 반환하지 않았습니다. 다시 시도하거나 다른 모델을 선택해 주세요.']) {
    assert.equal(failedOutcome([human(), {id: 'system-error', kind: 'system', text}]).failed, true, text);
  }
});

test('quoted errors, explanations, successful fixes, and previous turns do not count as failures', () => {
  for (const text of [
    '“접근할 권한이 없습니다” 오류를 해결했습니다.',
    '> 현재 접근할 수 없습니다.\n위 오류는 예시입니다.',
    '```\n할 수 없습니다\n```',
    '현재 접근할 수 없을 때 발생하는 오류를 설명할게요.',
    '로그인을 해제하면 메일에 접근할 수 없습니다.',
    '접근할 수 없습니다라는 오류는 해결했습니다.',
    '로그인 문제를 수정했습니다. 이제 메일을 읽을 수 있습니다.',
    "I'm sorry for the delay. The task is complete.",
    '죄송합니다. 작업은 완료했습니다.',
  ]) assert.equal(failedOutcome([human(), reply(text)]).failed, false, text);
  const result = failedOutcome([human('old'), reply('할 수 없습니다.'), human('new')]);
  assert.deepEqual(result, {humanId: 'new', failed: false, messageId: null});
});


test('unavailable OCR capability is a persistent failed outcome without classifying quoted or resolved notices', () => {
  const refusal = '죄송하지만, 현재 이 방에서는 사진의 OCR을 읽는 기능이 제공되지 않습니다.';
  assert.deepEqual(failedOutcome([human(), reply(refusal)]), {humanId: 'turn', failed: true, messageId: 'reply'});
  for (const text of [
    '현재 OCR 기능이 제공되어 있지 않습니다.',
    '이 환경에서는 OCR 기능이 지원되지 않아요.',
  ]) assert.equal(failedOutcome([human(), reply(text)]).failed, true, text);
  for (const text of [
    '“OCR 기능이 제공되지 않습니다” 안내는 해결했습니다.',
    '현재 표시되는 \"OCR 기능이 제공되지 않습니다\" 문구의 의미를 설명할게요.',
    'OCR 설정을 해제하면 기능이 제공되지 않습니다.',
    'OCR 기능이 제공되지 않습니다라는 오류는 수정했습니다.',
    'OCR 설정을 복구했습니다. 기능이 정상 제공됩니다.',
  ]) assert.equal(failedOutcome([human(), reply(text)]).failed, false, text);
  assert.deepEqual(failedOutcome([human('prior'), reply(refusal), human('next')]), {humanId: 'next', failed: false, messageId: null});
});

test('polite refusals and unsuccessful replies are actual failed outcomes', () => {
  for (const text of [
    '죄송합니다만, 해당 요청은 도와드릴 수 없습니다.',
    '**죄송합니다만, 해당 요청은 도와드릴 수 없습니다.**',
    '## 안내\n죄송합니다만, 해당 요청은 도와드릴 수 없습니다.',
    '죄송해요. 해당 작업을 도와드릴 수는 없어요.',
    '아쉽지만 도움을 드릴 수 없습니다.',
    '이 요청은 도와드리기 어렵습니다. 다른 방법을 안내해 드릴게요.',
    '해당 작업은 도와드리지 못합니다.',
    '현재 요청에는 답변해 드릴 수 없습니다.',
    '해당 요청에 응할 수 없습니다.',
    '작업을 수행할 수 없습니다.',
    '요청 처리에 실패했습니다. 다시 시도해 주세요.',
    '오류가 발생했습니다. 작업을 마치지 못했습니다.',
    "I'm sorry, but I can't help with that request.",
    "Sorry, I can't assist with that.",
    'Unfortunately, I am unable to process this request.',
    'Your request cannot be completed.',
  ]) assert.deepEqual(failedOutcome([human(), reply(text)]), {humanId:'turn', failed:true, messageId:'reply'}, text);
});

test('quoted or historical refusals and successful replies with caveats are not current failures', () => {
  for (const text of [
    '“죄송합니다만, 해당 요청은 도와드릴 수 없습니다.”는 이전 답변입니다.',
    '> 죄송합니다만, 해당 요청은 도와드릴 수 없습니다.\n이전 응답을 인용했습니다.',
    '```text\n죄송합니다만, 해당 요청은 도와드릴 수 없습니다.\n```',
    '## 안내\n> 죄송합니다만, 해당 요청은 도와드릴 수 없습니다.\n이전 응답입니다.',
    '## 안내\n```text\n죄송합니다만, 해당 요청은 도와드릴 수 없습니다.\n```',
    '이전의 "도와드릴 수 없습니다." 문구를 수정했습니다.',
    "이전의 '도와드릴 수 없습니다.' 문구를 수정했습니다.",
    '이전 답변에서 도와드릴 수 없습니다라고 안내했던 것은 오류였습니다.',
    '이전에는 도와드릴 수 없다고 했지만 지금은 작업을 이어갑니다.',
    '도와드릴 수 없습니다라는 문구의 의미를 설명할게요.',
    '권한을 해제하면 요청을 도와드릴 수 없습니다.',
    '설치는 완료했습니다. 계정 로그인을 직접 도와드릴 수는 없습니다.',
    '요청하신 설정을 수정했습니다. 사진 속 인물의 신원은 확인할 수 없습니다.',
    '네, 해당 작업을 도와드릴 수 있습니다.',
    "I've completed the setup. I cannot access your account password.",
    'The previous answer said "I cannot help with that request."',
  ]) assert.equal(failedOutcome([human(), reply(text)]).failed, false, text);
  const messages = [human('earlier'), reply('죄송합니다만, 해당 요청은 도와드릴 수 없습니다.'), human('current'), reply('확인을 마쳤습니다.')];
  assert.deepEqual(failedOutcome(messages), {humanId:'current', failed:false, messageId:null});
});
