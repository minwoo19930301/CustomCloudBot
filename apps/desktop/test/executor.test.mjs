import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { execFileSync } from 'node:child_process';
import { createExecutor } from '../executor.mjs';

const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const nodeCommand = (source) => `${shellQuote(process.execPath)} -e ${shellQuote(source)}`;
const unix = process.platform !== 'win32';

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ccb-executor-test-'));
  const root = path.join(directory, 'allowed');
  const outside = path.join(directory, 'outside');
  await fs.mkdir(root);
  await fs.mkdir(outside);
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const policy = { enabled: true, roots: [root], capabilities: { files: true, terminal: true, browser: true } };
  const opened = [];
  const executor = createExecutor({ getPolicy: () => policy, openExternal: async (url) => opened.push(url), ...options });
  return { root: await fs.realpath(root), outside: await fs.realpath(outside), policy, opened, execute: executor.execute };
}

test('status describes granted access without opening or listing the selected folders', async () => {
  const executor = createExecutor({
    getPolicy: () => ({ enabled: false, roots: ['/nonexistent/selected-folder'], capabilities: { files: true, terminal: false } }),
    describeMachine: () => ({ hostname: 'test-desktop', platform: 'test-os', secret: 'must-not-leak' }),
  });
  const result = await executor.execute('computer_status', {});
  assert.equal(result.enabled, false);
  assert.equal(result.hostname, 'test-desktop');
  assert.equal(result.platform, 'test-os');
  assert.equal(result.commandAuthority, 'current_os_user');
  assert.equal(JSON.stringify(result).includes('must-not-leak'), false);
  assert.equal(result.roots[0].label, 'selected-folder');
});

test('disabled desktop and individual capabilities are enforced on each invocation', async (t) => {
  const f = await fixture(t);
  f.policy.enabled = false;
  await assert.rejects(f.execute('computer_list_files', { path: f.root }), { code: 'desktop_disabled' });
  f.policy.enabled = true;
  f.policy.capabilities.files = false;
  await assert.rejects(f.execute('computer_write_file', { path: path.join(f.root, 'denied.txt'), content: 'x' }), { code: 'capability_disabled' });
  f.policy.capabilities.terminal = false;
  await assert.rejects(f.execute('computer_exec', { command: 'echo denied' }), { code: 'capability_disabled' });
  f.policy.capabilities.browser = false;
  await assert.rejects(f.execute('computer_open_url', { url: 'https://example.com' }), { code: 'capability_disabled' });
  assert.deepEqual(f.opened, []);
});

test('rejects unknown tools, unexpected arguments, malformed values and relative paths', async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.execute('computer_delete_file', {}), { code: 'unknown_tool' });
  await assert.rejects(f.execute('__proto__', {}), { code: 'unknown_tool' });
  await assert.rejects(f.execute('computer_status', { secret: true }), { code: 'invalid_arguments' });
  await assert.rejects(f.execute('computer_status', []), { code: 'invalid_arguments' });
  await assert.rejects(f.execute('computer_status', Object.create({ inherited: 1 })), { code: 'invalid_arguments' });
  await assert.rejects(f.execute('computer_read_file', {}), { code: 'invalid_arguments' });
  await assert.rejects(f.execute('computer_read_file', { path: 'relative.txt' }), { code: 'invalid_path' });
  await assert.rejects(f.execute('computer_read_file', { path: `${f.root}\0x` }), { code: 'invalid_arguments' });
  await assert.rejects(f.execute('computer_exec', { command: 'x'.repeat(8193) }), { code: 'invalid_arguments' });
  await assert.rejects(f.execute('computer_exec', { command: 'echo x', timeout: 5 }), { code: 'invalid_arguments' });
});

test('writes and reads bounded UTF-8 files atomically without leaving temporary files', async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.root, 'hello.txt');
  const content = '데스크탑 연결 확인\nHello';
  assert.equal((await f.execute('computer_write_file', { path: filename, content })).bytesWritten, Buffer.byteLength(content));
  assert.equal((await f.execute('computer_read_file', { path: filename })).content, content);
  await f.execute('computer_write_file', { path: filename, content: '' });
  assert.equal(await fs.readFile(filename, 'utf8'), '');
  assert.deepEqual(await fs.readdir(f.root), ['hello.txt']);
});

test('replacing an existing script preserves its ordinary file permissions', { skip: !unix }, async (t) => {
  const f = await fixture(t);
  const script = path.join(f.root, 'run.sh');
  await fs.writeFile(script, '#!/bin/sh\nexit 0\n', { mode: 0o750 });
  await f.execute('computer_write_file', { path: script, content: '#!/bin/sh\necho updated\n' });
  assert.equal((await fs.stat(script)).mode & 0o777, 0o750);
});

test('file size limits use bytes, including multibyte strings', async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.root, 'large.txt');
  await assert.rejects(f.execute('computer_write_file', { path: filename, content: '한'.repeat(90_000) }), { code: 'file_too_large' });
  await fs.writeFile(filename, Buffer.alloc(256 * 1024 + 1));
  await assert.rejects(f.execute('computer_read_file', { path: filename }), { code: 'file_too_large' });
  await f.execute('computer_write_file', { path: filename, content: 'x'.repeat(256 * 1024) });
  assert.equal((await f.execute('computer_read_file', { path: filename })).bytes, 256 * 1024);
});

test('binary text, directories and special targets are not treated as regular files', async (t) => {
  const f = await fixture(t);
  const binary = path.join(f.root, 'bytes.bin');
  await fs.writeFile(binary, Buffer.from([0xff, 0xfe]));
  await assert.rejects(f.execute('computer_read_file', { path: binary }), { code: 'unsupported_encoding' });
  await assert.rejects(f.execute('computer_read_file', { path: f.root }), { code: 'not_regular_file' });
  await assert.rejects(f.execute('computer_write_file', { path: f.root, content: 'x' }), { code: 'path_outside_roots' });
  const subdirectory = path.join(f.root, 'subdirectory');
  await fs.mkdir(subdirectory);
  await assert.rejects(f.execute('computer_write_file', { path: subdirectory, content: 'x' }), { code: 'not_regular_file' });
});

test('reading a named pipe rejects without waiting for a writer', { skip: !unix, timeout: 2000 }, async (t) => {
  const f = await fixture(t);
  const pipe = path.join(f.root, 'named-pipe');
  execFileSync('mkfifo', [pipe]);
  await assert.rejects(f.execute('computer_read_file', { path: pipe }), { code: 'not_regular_file' });
  assert.deepEqual((await f.execute('computer_list_files', { path: f.root })).entries, []);
});

test('blocks traversal, sibling prefix collisions and symlink escapes for reads and writes', { skip: !unix }, async (t) => {
  const f = await fixture(t);
  const privateFile = path.join(f.outside, 'private.txt');
  await fs.writeFile(privateFile, 'outside data');
  const escape = path.join(f.root, 'escape');
  const fileLink = path.join(f.root, 'file-link');
  await fs.symlink(f.outside, escape);
  await fs.symlink(privateFile, fileLink);
  for (const candidate of [path.join(f.root, '..', 'outside', 'private.txt'), path.join(escape, 'private.txt'), fileLink]) {
    await assert.rejects(f.execute('computer_read_file', { path: candidate }), { code: 'path_outside_roots' });
  }
  await assert.rejects(f.execute('computer_write_file', { path: path.join(escape, 'new.txt'), content: 'denied' }), { code: 'path_outside_roots' });
  await assert.rejects(f.execute('computer_write_file', { path: fileLink, content: 'denied' }), { code: 'not_regular_file' });
  const sibling = `${f.root}-other`;
  await fs.mkdir(sibling);
  await assert.rejects(f.execute('computer_list_files', { path: sibling }), { code: 'path_outside_roots' });
  assert.equal(await fs.readFile(privateFile, 'utf8'), 'outside data');
  assert.deepEqual((await f.execute('computer_list_files', { path: f.root })).entries, []);
});

test('allows in-root symlink reads but does not overwrite link targets', { skip: !unix }, async (t) => {
  const f = await fixture(t);
  const filename = path.join(f.root, 'real.txt');
  const link = path.join(f.root, 'alias.txt');
  await fs.writeFile(filename, 'real content');
  await fs.symlink(filename, link);
  assert.equal((await f.execute('computer_read_file', { path: link })).content, 'real content');
  await assert.rejects(f.execute('computer_write_file', { path: link, content: 'replacement' }), { code: 'not_regular_file' });
  assert.equal(await fs.readFile(filename, 'utf8'), 'real content');
});

test('user-selected folder aliases work without admitting targets outside their canonical roots', { skip: !unix }, async (t) => {
  const f = await fixture(t);
  const alias = path.join(path.dirname(f.root), 'selected-alias');
  await fs.symlink(f.root, alias);
  f.policy.roots = [alias];
  const file = path.join(alias, 'through-alias.txt');
  const written = await f.execute('computer_write_file', { path: file, content: 'alias works' });
  assert.equal(written.path, path.join(f.root, 'through-alias.txt'));
  assert.equal((await f.execute('computer_read_file', { path: file })).content, 'alias works');
  assert.equal((await f.execute('computer_list_files', { path: alias })).entries[0].name, 'through-alias.txt');
  assert.equal((await f.execute('computer_exec', { command: 'pwd', cwd: alias })).stdout.trim(), f.root);
  await fs.symlink(f.outside, path.join(f.root, 'escape'));
  await assert.rejects(f.execute('computer_write_file', { path: path.join(alias, 'escape', 'denied.txt'), content: 'no' }), { code: 'path_outside_roots' });
});

test('credential locations are denied even inside explicitly granted roots', async (t) => {
  const f = await fixture(t);
  const filenames = ['.env', '.env.production', '.npmrc', 'credentials.json', 'auth.json', 'Login Data', 'key4.db', 'private.pem'];
  for (const name of filenames) {
    const filename = path.join(f.root, name);
    await fs.writeFile(filename, 'test fixture, no real credential');
    await assert.rejects(f.execute('computer_read_file', { path: filename }), { code: 'sensitive_path' });
    await assert.rejects(f.execute('computer_write_file', { path: filename, content: 'denied' }), { code: 'sensitive_path' });
  }
  for (const name of ['.ssh', '.aws', '.oci', '.gnupg', 'Keychains']) {
    const folder = path.join(f.root, name);
    await fs.mkdir(folder);
    await assert.rejects(f.execute('computer_list_files', { path: folder }), { code: 'sensitive_path' });
  }
  assert.deepEqual((await f.execute('computer_list_files', { path: f.root })).entries, []);
});

test('credential symlinks cannot disguise an otherwise blocked filename', { skip: !unix }, async (t) => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.root, '.env.local'), 'fixture');
  const link = path.join(f.root, 'innocent.txt');
  await fs.symlink(path.join(f.root, '.env.local'), link);
  await assert.rejects(f.execute('computer_read_file', { path: link }), { code: 'sensitive_path' });
  assert.deepEqual((await f.execute('computer_list_files', { path: f.root })).entries, []);
});

test('app code and private settings stay protected when their parent folder is granted', { skip: !unix }, async (t) => {
  const f = await fixture(t);
  const userData = path.join(f.root, 'Application Support', 'Desktop');
  const resources = path.join(f.root, 'Desktop.app', 'Contents', 'Resources');
  const appPath = path.join(resources, 'app');
  await fs.mkdir(userData, { recursive: true });
  await fs.mkdir(appPath, { recursive: true });
  const config = path.join(userData, 'config.json');
  const source = path.join(appPath, 'main.mjs');
  await fs.writeFile(config, '{"origin":"https://trusted.example"}');
  await fs.writeFile(source, '// original app source');
  const protectedPaths = [userData, appPath, resources];
  const executor = createExecutor({ getPolicy: () => f.policy, protectedPaths });
  protectedPaths.length = 0;
  for (const folder of [userData, appPath, resources]) {
    await assert.rejects(executor.execute('computer_list_files', { path: folder }), { code: 'protected_path' });
    await assert.rejects(executor.execute('computer_write_file', { path: path.join(folder, 'injected.js'), content: 'forbidden' }), { code: 'protected_path' });
  }
  for (const filename of [config, source]) {
    await assert.rejects(executor.execute('computer_read_file', { path: filename }), { code: 'protected_path' });
    await assert.rejects(executor.execute('computer_write_file', { path: filename, content: 'forbidden' }), { code: 'protected_path' });
  }
  const alias = path.join(f.root, 'ordinary-folder');
  const fileAlias = path.join(f.root, 'ordinary-file.txt');
  await fs.symlink(userData, alias);
  await fs.symlink(config, fileAlias);
  await assert.rejects(executor.execute('computer_list_files', { path: alias }), { code: 'protected_path' });
  await assert.rejects(executor.execute('computer_read_file', { path: path.join(alias, 'config.json') }), { code: 'protected_path' });
  await assert.rejects(executor.execute('computer_write_file', { path: path.join(alias, 'config.json'), content: 'forbidden' }), { code: 'protected_path' });
  await assert.rejects(executor.execute('computer_read_file', { path: fileAlias }), { code: 'protected_path' });
  await assert.rejects(executor.execute('computer_write_file', { path: fileAlias, content: 'forbidden' }), { code: 'not_regular_file' });
  const listing = await executor.execute('computer_list_files', { path: f.root });
  assert.ok(!listing.entries.some((entry) => entry.name.startsWith('ordinary-')));
  assert.deepEqual((await executor.execute('computer_list_files', { path: path.dirname(userData) })).entries, []);
  await executor.execute('computer_write_file', { path: path.join(f.root, 'normal.txt'), content: 'allowed' });
  assert.equal(await fs.readFile(config, 'utf8'), '{"origin":"https://trusted.example"}');
  assert.equal(await fs.readFile(source, 'utf8'), '// original app source');
});

test('protected paths resolve aliases and cover configuration files before they exist', { skip: !unix }, async (t) => {
  const f = await fixture(t);
  const alias = path.join(path.dirname(f.root), 'root-alias');
  await fs.symlink(f.root, alias);
  const future = path.join(f.root, 'future-config.json');
  const executor = createExecutor({ getPolicy: () => f.policy, protectedPaths: [path.join(alias, 'future-config.json')] });
  await assert.rejects(executor.execute('computer_write_file', { path: future, content: 'forbidden' }), { code: 'protected_path' });
  await fs.writeFile(future, 'private');
  await assert.rejects(executor.execute('computer_read_file', { path: future }), { code: 'protected_path' });
  assert.deepEqual((await executor.execute('computer_list_files', { path: f.root })).entries, []);
  assert.throws(() => createExecutor({ getPolicy: () => f.policy, protectedPaths: ['relative'] }), /absolute filesystem/);
});

test('directory listings are capped at 200 entries', async (t) => {
  const f = await fixture(t);
  await Promise.all(Array.from({ length: 205 }, (_, i) => fs.writeFile(path.join(f.root, `file-${i}.txt`), '')));
  const result = await f.execute('computer_list_files', { path: f.root });
  assert.equal(result.entries.length, 200);
  assert.equal(result.truncated, true);
  assert.ok(result.entries.every((entry) => entry.type === 'file'));
});

test('browser opening accepts only HTTP(S), without embedded credentials', async (t) => {
  const f = await fixture(t);
  await f.execute('computer_open_url', { url: 'https://example.com/path?q=test' });
  assert.deepEqual(f.opened, ['https://example.com/path?q=test']);
  for (const url of ['file:///tmp/test', 'javascript:alert(1)', 'mailto:test@example.com', 'https://user:pass@example.com', 'not a url']) {
    await assert.rejects(f.execute('computer_open_url', { url }), { code: 'invalid_url' });
  }
  assert.equal(f.opened.length, 1);
});

test('commands use an allowed cwd and retain exit code and separated output', { skip: !unix }, async (t) => {
  const f = await fixture(t);
  const source = "process.stdout.write(process.cwd()); process.stderr.write('failure detail'); process.exitCode=7;";
  const result = await f.execute('computer_exec', { command: nodeCommand(source), cwd: f.root });
  assert.equal(result.stdout, f.root);
  assert.equal(result.stderr, 'failure detail');
  assert.equal(result.exitCode, 7);
  assert.equal(result.timedOut, false);
  assert.equal(result.aborted, false);
  await assert.rejects(f.execute('computer_exec', { command: 'echo denied', cwd: f.outside }), { code: 'path_outside_roots' });
});

test('commands do not inherit cloud tokens, SSH sockets, shell startup variables or NODE_OPTIONS', { skip: !unix }, async (t) => {
  const f = await fixture(t);
  const keys = ['AWS_SECRET_ACCESS_KEY', 'OPENAI_API_KEY', 'SSH_AUTH_SOCK', 'BASH_ENV', 'ENV', 'ZDOTDIR', 'NODE_OPTIONS', 'LD_PRELOAD', 'DYLD_INSERT_LIBRARIES'];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  for (const key of keys) process.env[key] = 'executor-test-not-a-real-secret';
  const result = await f.execute('computer_exec', { command: nodeCommand(`console.log(JSON.stringify(${JSON.stringify(keys)}.filter(key => process.env[key])))`) });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), []);
});

test('combined command output is bounded to 32 KiB', { skip: !unix }, async (t) => {
  const f = await fixture(t);
  const result = await f.execute('computer_exec', { command: nodeCommand("process.stdout.write('한'.repeat(30000)); process.stderr.write('x'.repeat(30000));") });
  assert.equal(result.exitCode, 0);
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr) <= 32768);
  assert.equal(result.stdout.includes('\ufffd'), false);
});

test('timeouts terminate the command and its spawned descendants', { skip: !unix, timeout: 8000 }, async (t) => {
  // Leave enough startup time for both Node processes while the full workspace
  // suite is running in parallel, before testing forced timeout termination.
  const f = await fixture(t, { commandTimeoutMs: 3000 });
  const marker = path.join(f.root, 'heartbeat.txt');
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); setInterval(() => require('node:fs').appendFileSync(${JSON.stringify(marker)}, '.'), 30);`;
  const source = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'ignore'}); setInterval(() => {}, 1000);`;
  const result = await f.execute('computer_exec', { command: nodeCommand(source) });
  assert.equal(result.timedOut, true);
  const stopped = await fs.readFile(marker, 'utf8');
  await delay(400);
  assert.equal(await fs.readFile(marker, 'utf8'), stopped);
});

test('AbortSignal cancels running commands and prevents already-aborted writes', { skip: !unix }, async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const execution = f.execute('computer_exec', { command: nodeCommand('setInterval(() => {}, 1000)') }, { signal: controller.signal });
  setTimeout(() => controller.abort(), 150);
  const result = await execution;
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  await assert.rejects(f.execute('computer_write_file', { path: path.join(f.root, 'cancelled.txt'), content: 'no' }, { signal: controller.signal }), { code: 'aborted' });
  await assert.rejects(fs.access(path.join(f.root, 'cancelled.txt')));
});

test('cancelling a running command terminates its descendant process group', { skip: !unix, timeout: 5000 }, async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  const marker = path.join(f.root, 'cancel-heartbeat.txt');
  const descendant = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ready'); setInterval(() => require('node:fs').appendFileSync(${JSON.stringify(marker)}, '.'), 30);`;
  const source = `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}], {stdio:'ignore'}); setInterval(() => {}, 1000);`;
  const execution = f.execute('computer_exec', { command: nodeCommand(source) }, { signal: controller.signal });
  t.after(() => controller.abort());
  let started = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await fs.stat(marker).then(() => true, () => false)) { started = true; break; }
    await delay(20);
  }
  controller.abort();
  const result = await execution;
  assert.equal(started, true, 'Descendant should start before cancellation');
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  const stopped = await fs.readFile(marker, 'utf8');
  await delay(400);
  assert.equal(await fs.readFile(marker, 'utf8'), stopped);
});

test('a background child cannot keep running after its shell exits', { skip: !unix }, async (t) => {
  const f = await fixture(t, { commandTimeoutMs: 2000 });
  const result = await f.execute('computer_exec', { command: 'sleep 20 & echo returned' });
  assert.equal(result.stdout.trim(), 'returned');
  assert.equal(result.timedOut, false);
});
