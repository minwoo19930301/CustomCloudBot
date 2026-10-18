import test from 'node:test';
import assert from 'node:assert/strict';
import {createNextPromptCache, normalizeNextPrompt} from '../next-prompt.mjs';

const deferred = () => {let resolve; const promise = new Promise(done => {resolve = done;}); return {promise, resolve};};

test('suggestions are plain single-line bounded user drafts, never malformed envelopes or demo text', () => {
  assert.equal(normalizeNextPrompt('SendMessage: ' + JSON.stringify({content: '  "다음 단계도 알려줘"  '})), '다음 단계도 알려줘');
  assert.equal(normalizeNextPrompt('첫 단계\n다음 단계\t검토'), '첫 단계 다음 단계 검토');
  assert.equal([...normalizeNextPrompt('🌈'.repeat(110))].length, 100);
  for (const value of [null, {}, 'SendMessage: {', 'SendMessage: {"content":2}', '```rm -rf```', '[데모] 예시']) assert.equal(normalizeNextPrompt(value), '');
});

test('a revision deduplicates concurrent inference and caches provider failure', async () => {
  const cache = createNextPromptCache(), gate = deferred();
  let calls = 0;
  const first = cache.get('room:revision', async () => {calls++; await gate.promise; return '비교표도 만들어줘';});
  const second = cache.get('room:revision', () => {throw new Error('duplicate');});
  assert.equal(first, second);
  gate.resolve();
  assert.equal(await second, '비교표도 만들어줘'); assert.equal(calls, 1);
  assert.equal(await cache.get('room:revision', () => 'changed model'), '비교표도 만들어줘');
  assert.equal(await cache.get('failed', () => {calls++; throw new Error('unavailable');}), '');
  assert.equal(await cache.get('failed', () => 'retry'), ''); assert.equal(calls, 2);
});

test('background inference has a bounded concurrency and cache size', async () => {
  const cache = createNextPromptCache({maxEntries: 2, maxConcurrent: 1}), gate = deferred();
  const first = cache.get('a', () => gate.promise);
  assert.equal(await cache.get('b', () => {throw new Error('must not run');}), '');
  gate.resolve('a'); await first;
  assert.equal(await cache.get('b', () => 'b'), 'b');
  assert.equal(await cache.get('c', () => 'c'), 'c');
  assert.equal(await cache.get('b', () => 'duplicate'), 'b');
  assert.equal(await cache.get('a', () => 'evicted'), 'evicted');
});
