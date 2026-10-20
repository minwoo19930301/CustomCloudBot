import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveLoginIntent } from '../login-intent.mjs';

const none = { requested: false, currentPage: false, continuation: false };
const rows = (...texts) => texts.map(text => ({ text }));
const original = '브라우저로 naver.com 들어가서 로그인 좀 해줘';

test('direct login requests bind explicit HTTPS or bare public website targets', () => {
  for (const text of [original, 'https://naver.com/ 에 로그인해 줘', 'please log in to naver.com']) {
    assert.deepEqual(resolveLoginIntent({ text }), { requested: true, currentPage: false, continuation: false, targetUrl: 'https://naver.com/' });
  }
  assert.deepEqual(resolveLoginIntent({ text: 'https://github.com/login?return_to=%2Fsettings 에 로그인해줘' }),
    { requested: true, currentPage: false, continuation: false, targetUrl: 'https://github.com/login?return_to=%2Fsettings' });
  assert.deepEqual(resolveLoginIntent({ text: '네이버에 로그인해줘' }), { requested: true, currentPage: false, continuation: false },
    'an unrecognized service name must not imply the current browser site');
});

test('a stated login goal plus an explicit Vault action is a request, not a help question', () => {
  for (const text of [
    'https://github.com/login 에 로그인하려고 하니까 해당 사이트로 이동하고 Vault 창을 열어 줘',
    'github.com/login 에 로그인하려고 하니까 Vault 계정 선택 창을 띄워주세요',
    'I want to log in to https://github.com/login; open the Vault chooser',
  ]) {
    assert.deepEqual(resolveLoginIntent({ text }),
      { requested: true, currentPage: false, continuation: false, targetUrl: 'https://github.com/login' }, text);
  }
  for (const text of [
    '로그인하려고 하는데 Vault 창을 여는 방법을 알려줘',
    '로그인할 때 Vault 창을 열어주는 기능을 설명해줘',
    '로그인 기능의 "Vault 창을 열어줘"라는 문장을 번역해줘',
    'Explain how to open the Vault chooser to log in',
    'Vault 창을 열어줘라는 말의 의미를 설명해줘',
  ]) assert.deepEqual(resolveLoginIntent({ text, previous: rows(original) }), none, text);
});

test('the actual owner follow-up chain inherits the original naver target', () => {
  const second = '너가 로그인해줘 내가 아이디비번 줄게';
  assert.deepEqual(resolveLoginIntent({ text: second, previous: rows(original) }),
    { requested: true, currentPage: false, continuation: true, targetUrl: 'https://naver.com/' });
  for (const text of ['아니 직접 해줘 내가 알려줄테니', '아니 직접 해줘', '그럼 진행해줘']) {
    assert.deepEqual(resolveLoginIntent({ text, previous: rows(second, original) }),
      { requested: true, currentPage: false, continuation: true, targetUrl: 'https://naver.com/' }, text);
  }
  assert.deepEqual(resolveLoginIntent({ text: '아니 직접 해줘 내가 알려줄테니' }), none);
});

test('a new current target wins and a current-page reference does not reuse an older site', () => {
  assert.deepEqual(resolveLoginIntent({ text: '이제 github.com에 로그인해줘', previous: rows(original) }),
    { requested: true, currentPage: false, continuation: false, targetUrl: 'https://github.com/' });
  for (const text of ['여기 로그인해줘', '이 브라우저에서 로그인해 줘', '현재 페이지에 로그인해주세요', 'please sign in here']) {
    assert.deepEqual(resolveLoginIntent({ text, previous: rows(original) }), { requested: true, currentPage: true, continuation: false }, text);
  }
  assert.deepEqual(resolveLoginIntent({ text: '로그인해줘' }), { requested: true, currentPage: true, continuation: false });
});

test('a follow-up without a known target never automatically captures the current page', () => {
  for (const previous of [rows('로그인해줘'), rows('여기 로그인해줘'), rows('네이버에 로그인해줘')]) {
    assert.deepEqual(resolveLoginIntent({ text: '아니 직접 해줘 내가 알려줄테니', previous }),
      { requested: true, currentPage: false, continuation: true });
  }
  assert.deepEqual(resolveLoginIntent({ text: '너가 로그인해줘 내가 아이디비번 줄게', previous: rows('여기 로그인해줘') }),
    { requested: true, currentPage: false, continuation: true });
  assert.deepEqual(resolveLoginIntent({ text: '구글에 로그인해줘', previous: rows(original) }),
    { requested: true, currentPage: false, continuation: false }, 'a newly named service must not inherit an older service URL');
  assert.deepEqual(resolveLoginIntent({ text: '구글로그인해줘', previous: rows(original) }),
    { requested: true, currentPage: false, continuation: false });
});

test('unrelated topics, explanations and negations stop inherited login intent', () => {
  for (const text of [
    '내일 날씨 알려줘', '현재 페이지 내용을 요약해줘', '로그인이 뭔지 설명해줘', '로그인 방법을 알려줘',
    '로그인 하는 법 알려줘', '로그인 말고 내용을 요약해줘', '로그인하지 마', '취소', '그만해',
    'How do I log in?', 'Explain how to log in', "Don't log in", 'Cancel that',
    '"로그인해줘"라는 문장을 번역해줘', 'Can you explain "log in"?',
    '"로그인해줘"', '`로그인해줘`', '```text\n로그인해줘\n```',
  ]) {
    assert.deepEqual(resolveLoginIntent({ text, previous: rows(original) }), none, text);
    assert.deepEqual(resolveLoginIntent({ text: '아니 직접 해줘', previous: rows(text, original) }), none, text);
  }
  assert.deepEqual(resolveLoginIntent({ text: '응', previous: rows(original) }), none, 'bare acknowledgement is not a login action');
  assert.deepEqual(resolveLoginIntent({ text: '직접 설명해줘', previous: rows(original) }), none);
});

test('unsafe, ambiguous and unsupported current destinations never fall back to older public targets', () => {
  for (const destination of [
    'http://naver.com/login', 'https://user:password@naver.com/', 'https://127.0.0.1/', 'https://[::1]/',
    'https://0x7f000001/', 'https://localhost/', 'https://machine.local/', 'https://service.internal/',
    'https://naver.com./', 'ftp://naver.com/', 'file:///etc/passwd', '127.0.0.1', 'localhost',
    'naver.com github.com', 'https://naver.com\\@evil.example.com/',
  ]) {
    assert.deepEqual(resolveLoginIntent({ text: `${destination} 에 로그인해줘`, previous: rows(original) }), none, destination);
  }
  assert.deepEqual(resolveLoginIntent({ text: 'https://naver.com/ 와 naver.com 에 로그인해줘' }),
    { requested: true, currentPage: false, continuation: false, targetUrl: 'https://naver.com/' }, 'repeating the same canonical destination is unambiguous');
});

test('email addresses and ordinary acknowledgements never become website targets', () => {
  assert.deepEqual(resolveLoginIntent({ text: '내 계정은 owner@example.com 이야', previous: rows(original) }), none);
  assert.deepEqual(resolveLoginIntent({ text: 'owner@example.com 계정으로 로그인해줘', previous: rows(original) }),
    { requested: true, currentPage: false, continuation: false });
});

test('history is bounded to six human rows and the original login request cannot be refreshed indefinitely', () => {
  const text = '아니 직접 해줘', followups = Array.from({ length: 5 }, () => '그럼 진행해줘');
  assert.deepEqual(resolveLoginIntent({ text, previous: rows(...followups, original) }),
    { requested: true, currentPage: false, continuation: true, targetUrl: 'https://naver.com/' });
  assert.deepEqual(resolveLoginIntent({ text, previous: rows(...followups, '직접 해줘', original) }), none);
  const now = 2_000_000;
  assert.deepEqual(resolveLoginIntent({ text, now, previous: [
    { text: '직접 해줘', created_at: now - 1000 }, { text: original, created_at: now - 600_001 },
  ] }), none);
  assert.deepEqual(resolveLoginIntent({ text, now, previous: [{ text: original, created_at: now + 1 }] }), none);
  assert.deepEqual(resolveLoginIntent({ text, previous: null }), none);
});
