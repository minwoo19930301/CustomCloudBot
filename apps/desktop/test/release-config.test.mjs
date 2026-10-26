import test from 'node:test';
import assert from 'node:assert/strict';
import { initialDesktopSettings, releaseMetadata } from '../release-config.mjs';

function reader(files) {
  return async file => {
    if (!Object.hasOwn(files, file)) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    return files[file];
  };
}

test('build origin accepts only a public HTTPS service origin without credentials or paths', () => {
  assert.deepEqual(releaseMetadata(undefined), { version: 1, appOrigin: '' });
  assert.deepEqual(releaseMetadata(' https://bot.example.com/ '), { version: 1, appOrigin: 'https://bot.example.com' });
  for (const input of ['http://bot.example.com', 'https://user:secret@bot.example.com', 'https://bot.example.com/login', 'https://bot.example.com/?token=secret', 'https://bot.example.com/#login']) assert.throws(() => releaseMetadata(input));
});

test('fresh install uses its release origin without accepting permissions from the release', async () => {
  const readFile = reader({ release: JSON.stringify({ version: 1, appOrigin: 'https://bot.example.com', roots: ['/'], capabilities: { files: true, terminal: true, browser: true }, token: 'untrusted' }) });
  assert.deepEqual(await initialDesktopSettings('settings', 'release', readFile), {
    origin: 'https://bot.example.com', roots: [], capabilities: { files: false, terminal: false, browser: false }
  });
});

test('existing settings take precedence even if a later release changes its service origin', async () => {
  const saved = { origin: 'https://my-bot.example.com', name: 'My Mac', roots: ['/chosen'], capabilities: { files: true } };
  const readFile = reader({ settings: JSON.stringify(saved), release: JSON.stringify(releaseMetadata('https://other.example.com')) });
  assert.deepEqual(await initialDesktopSettings('settings', 'release', readFile), saved);
});

test('corrupt or inaccessible user settings do not silently fall back to another service', async () => {
  const readFile = reader({ settings: '{invalid', release: JSON.stringify(releaseMetadata('https://other.example.com')) });
  await assert.rejects(initialDesktopSettings('settings', 'release', readFile), SyntaxError);
  await assert.rejects(initialDesktopSettings('settings', 'release', async () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); }), { code: 'EACCES' });
});

test('generic builds have no configured service and invalid release origins fail closed', async () => {
  assert.equal(await initialDesktopSettings('settings', 'release', reader({})), null);
  assert.equal(await initialDesktopSettings('settings', 'release', reader({ release: JSON.stringify(releaseMetadata()) })), null);
  await assert.rejects(initialDesktopSettings('settings', 'release', reader({ release: '{"version":1,"appOrigin":"file:///tmp/index.html"}' })));
  await assert.rejects(initialDesktopSettings('settings', 'release', reader({ release: '{"version":2,"appOrigin":"https://bot.example.com"}' })), /unsupported_release_metadata/);
});
