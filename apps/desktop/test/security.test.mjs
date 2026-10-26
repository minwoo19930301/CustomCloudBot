import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { normalizeAppUrl, isTrustedSender, isSameOriginUrl, externalHttpsUrl, capabilityList, consentDetails, validJob, isStaleResultError } from '../security.mjs';

test('service address requires one HTTPS origin, without credentials or a path', () => {
  assert.equal(normalizeAppUrl(' https://bot.example.com/ '), 'https://bot.example.com');
  for (const value of ['http://bot.example.com', 'https://user:password@bot.example.com', 'https://bot.example.com/admin', 'https://bot.example.com/?token=x', 'https://bot.example.com/#x', 'file:///tmp/index.html']) assert.throws(() => normalizeAppUrl(value));
});

test('privileged IPC is limited to the exact local main frame and web contents', () => {
  const localPath = '/app/ui/index.html';
  const frame = { url: pathToFileURL(localPath).href };
  const contents = { mainFrame: frame };
  assert.equal(isTrustedSender({ sender: contents, senderFrame: frame }, contents, localPath), true);
  assert.equal(isTrustedSender({ sender: {}, senderFrame: frame }, contents, localPath), false);
  assert.equal(isTrustedSender({ sender: contents, senderFrame: { ...frame } }, contents, localPath), false);
  frame.url = 'https://bot.example.com';
  assert.equal(isTrustedSender({ sender: contents, senderFrame: frame }, contents, localPath), false);
});

test('remote navigation cannot use privileged or lookalike origins', () => {
  assert.equal(isSameOriginUrl('https://bot.example.com/chat', 'https://bot.example.com'), true);
  for (const url of ['https://bot.example.com.evil.test', 'https://evil.test/?https://bot.example.com', 'file:///tmp/index.html', 'javascript:alert(1)', 'https://bot.example.com:8443']) assert.equal(isSameOriginUrl(url, 'https://bot.example.com'), false);
  for (const url of ['file:///tmp/x', 'javascript:alert(1)', 'custom:open', 'https://a:b@bot.example.com']) assert.equal(externalHttpsUrl(url), null);
});

test('capabilities default off and terminal consent distinguishes broad account access', () => {
  assert.deepEqual(capabilityList({ files: true, terminal: false, browser: 'true' }), ['fs']);
  const text = consentDetails({ name: 'My Mac', origin: 'https://bot.example.com', roots: ['/tmp/demo'], capabilities: { files: true, terminal: true } });
  assert.match(text, /선택 폴더 밖/);
  assert.match(text, /sudo/);
  assert.match(text, /\/tmp\/demo/);
});

test('only bounded wire job shapes can reach the local executor', () => {
  const job = { id: '1a05d2b1-cf8b-4a7b-88e6-6151b943fe01', tool: 'computer_exec', args: { command: 'pwd' }, expiresAt: Date.now() + 3000 };
  assert.equal(validJob(job), true);
  for (const change of [{ id: '../../x' }, { tool: 'shell.openExternal' }, { args: [] }, { expiresAt: 'tomorrow' }]) assert.equal(validJob({ ...job, ...change }), false);
  assert.equal(isStaleResultError({ status: 409 }), true);
  assert.equal(isStaleResultError({ code: 'HTTP_404' }), true);
  assert.equal(isStaleResultError({ status: 500 }), false);
});
