import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { desktopDownloads } from '../desktop-downloads.mjs';
import { startCommunity } from '../server.mjs';

const release = { platform: 'macos', arch: 'arm64', version: '0.1.0', url: 'https://downloads.example/app.zip', notarized: false };
const configuration = entries => ({ COMMUNITY_DESKTOP_DOWNLOADS: JSON.stringify(entries) });

test('unconfigured forks do not advertise downloads; malformed or unsafe release URLs are omitted', () => {
  for (const env of [{}, { COMMUNITY_DESKTOP_DOWNLOADS: 'invalid' }, configuration({}),
    ...['http://downloads.example/app.zip', 'javascript:alert(1)', 'https://secret:token@downloads.example/app.zip', 'https://downloads.example/app.zip#fragment'].map(url => configuration([{ ...release, url }]))])
    assert.deepEqual(desktopDownloads(env), []);
  assert.deepEqual(desktopDownloads(configuration([{ ...release, platform: 'windows' }, { ...release, version: '<script>' }])), []);
});

test('only explicit public metadata is returned, with notarization false unless explicitly true', () => {
  const result = desktopDownloads(configuration([{ ...release, notarized: 'true', signingSecret: 'private', label: '<script>' }]));
  assert.deepEqual(result, [{ ...release, label: 'Mac · Apple Silicon' }]);
});

test('download catalog works before login without exposing private settings or relaxing origin checks', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ccb-downloads-'));
  const app = await startCommunity({ dataDir, port: 0, env: { ...configuration([release]), COMMUNITY_BOOTSTRAP_TOKEN: 'private-fixture' } });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const response = await fetch(app.url + '/api/desktop/downloads');
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { downloads: [{ ...release, label: 'Mac · Apple Silicon' }] });
  assert.equal((await fetch(app.url + '/api/desktop/downloads', { headers: { origin: 'https://other.example' } })).status, 403);
  assert.equal((await fetch(app.url + '/api/desktop/downloads', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
});


test('only an administrator with CSRF can publish a validated download; empty list removes it', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ccb-download-admin-'));
  const app = await startCommunity({ dataDir, port: 0, env: { COMMUNITY_BOOTSTRAP_TOKEN: 'download-fixture' } });
  t.after(async () => { await app.close(); await rm(dataDir, { recursive: true, force: true }); });
  const call = async (path, body, headers = {}) => fetch(app.url + path, { method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const endpoint = '/api/admin/setup/desktop-downloads';
  const payload = { downloads: [release] };
  assert.equal((await call(endpoint, payload)).status, 401);
  const registration = await call('/api/register', { username: 'release_owner', displayName: 'Owner', password: 'fixture-download-passphrase', inviteToken: 'download-fixture' });
  assert.equal(registration.status, 201);
  const session = await registration.json();
  const cookie = registration.headers.get('set-cookie').split(';')[0];
  const headers = { cookie, 'x-csrf-token': session.csrfToken };
  assert.equal((await call(endpoint, payload, { cookie })).status, 403);
  assert.equal((await call(endpoint, { downloads: [{ ...release, url: 'http://unsafe.example/app.zip' }] }, headers)).status, 400);
  const published = await call(endpoint, payload, headers);
  assert.equal(published.status, 200);
  assert.equal((await published.json()).desktopDownloads[0].url, release.url);
  assert.equal((await (await call('/api/desktop/downloads')).json()).downloads[0].url, release.url);
  assert.equal(JSON.parse(app.db.prepare("SELECT value FROM settings WHERE key='desktop-downloads'").get().value)[0].url, release.url);
  app.db.prepare("UPDATE users SET role='member' WHERE id=?").run(session.user.id);
  assert.equal((await call(endpoint, { downloads: [] }, headers)).status, 403);
  app.db.prepare("UPDATE users SET role='admin' WHERE id=?").run(session.user.id);
  assert.equal((await call(endpoint, { downloads: [] }, headers)).status, 200);
  assert.deepEqual((await (await call('/api/desktop/downloads')).json()).downloads, []);
});
