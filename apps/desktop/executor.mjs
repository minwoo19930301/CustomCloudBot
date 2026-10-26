import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';

const MAX_FILE_BYTES = 256 * 1024;
const MAX_OUTPUT_BYTES = 32 * 1024;
const MAX_LIST_ENTRIES = 200;
const MAX_COMMAND_MS = 60_000;
const sensitiveDirectories = new Set([
  '.ssh', '.aws', '.oci', '.gnupg', '.azure', '.kube', '.password-store',
  'keychains', '.keychain', '.credentials',
]);
const sensitiveFiles = new Set([
  '.netrc', '_netrc', '.npmrc', '.pypirc', '.git-credentials',
  'credentials', 'credentials.json', '.credentials.json', 'auth.json',
  'tokens.json', 'token.json', 'access_tokens.db', 'credentials.db',
  'login data', 'login data for account', 'cookies', 'cookies.sqlite',
  'logins.json', 'key4.db', 'key3.db', 'web data',
]);

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

function validateArgs(args, allowed, required = []) {
  if (!args || typeof args !== 'object' || Array.isArray(args)
      || ![Object.prototype, null].includes(Object.getPrototypeOf(args))) {
    throw failure('invalid_arguments', 'Tool arguments must be an object.');
  }
  if (Object.keys(args).some((key) => !allowed.includes(key))
      || required.some((key) => !Object.hasOwn(args, key))) {
    throw failure('invalid_arguments', 'Missing or unsupported tool arguments.');
  }
}

function textArg(value, name, maximum = 4096) {
  if (typeof value !== 'string' || !value || value.length > maximum || value.includes('\0')) {
    throw failure('invalid_arguments', `${name} must be a nonempty string of at most ${maximum} characters.`);
  }
  return value;
}

function absolutePath(value) {
  textArg(value, 'path');
  if (!path.isAbsolute(value)) throw failure('invalid_path', 'Choose an absolute path inside an allowed folder.');
  return path.resolve(value);
}

function isWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function isSensitive(candidate) {
  const normalized = candidate.replaceAll('\\', '/').toLowerCase();
  const parts = normalized.split('/').filter(Boolean);
  return parts.some((part) => sensitiveDirectories.has(part) || sensitiveFiles.has(part)
    || part.startsWith('.env') || /^id_(rsa|dsa|ecdsa|ed25519)(\.|$)/.test(part)
    || /\.(pem|p12|pfx|keychain|keychain-db)$/.test(part))
    || /\/(?:\.config\/)?(?:google-chrome|chromium|brave-browser|gcloud)(?:\/|$)/.test(normalized)
    || /\/library\/(?:keychains|safari)(?:\/|$)/.test(normalized)
    || /\/(?:google\/chrome|microsoft\/edge|bravesoftware|mozilla\/firefox|\.mozilla\/firefox)(?:\/|$)/.test(normalized);
}

function assertUnprotected(candidate, protectedPaths) {
  if (protectedPaths.some((protectedPath) => isWithin(protectedPath, candidate))) {
    throw failure('protected_path', 'The desktop app and its private settings cannot be accessed through file tools.');
  }
}

async function canonicalProtectedPaths(paths) {
  const result = new Set(paths);
  for (const selected of paths) {
    let ancestor = selected;
    const suffix = [];
    // A protected config path may not exist yet. Resolve its nearest existing
    // parent so system aliases cannot make a future file writable through /var.
    while (true) {
      try {
        result.add(path.join(await fs.realpath(ancestor), ...suffix));
        break;
      } catch (error) {
        if (!['ENOENT', 'ENOTDIR'].includes(error.code) || path.dirname(ancestor) === ancestor) throw error;
        suffix.unshift(path.basename(ancestor));
        ancestor = path.dirname(ancestor);
      }
    }
  }
  return [...result];
}

function assertAllowed(candidate, roots, protectedPaths = []) {
  assertUnprotected(candidate, protectedPaths);
  if (isSensitive(candidate)) throw failure('sensitive_path', 'Credential and browser profile locations are unavailable to file tools.');
  if (!roots.some((root) => isWithin(root, candidate))) {
    throw failure('path_outside_roots', 'This path is outside the folders allowed in the desktop app.');
  }
}

async function resolveExisting(value, roots, protectedPaths = []) {
  const requested = absolutePath(value);
  assertUnprotected(requested, protectedPaths);
  // A user-selected path can have a system alias (macOS /var -> /private/var).
  // Containment is checked after realpath; sensitive lexical paths stay denied.
  if (isSensitive(requested)) throw failure('sensitive_path', 'Credential and browser profile locations are unavailable to file tools.');
  const canonical = await fs.realpath(requested);
  assertAllowed(canonical, roots, protectedPaths);
  return canonical;
}

async function policyRoots(policy) {
  if (!Array.isArray(policy.roots)) return [];
  const roots = [];
  for (const selected of policy.roots.slice(0, 64)) {
    if (typeof selected !== 'string' || !path.isAbsolute(selected) || isSensitive(selected)) continue;
    try {
      const canonical = await fs.realpath(selected);
      if (!isSensitive(canonical) && (await fs.stat(canonical)).isDirectory()) roots.push(canonical);
    } catch { /* A disconnected drive does not grant access to another location. */ }
  }
  return [...new Set(roots)];
}

function cleanEnvironment() {
  const env = {};
  for (const key of ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'SystemRoot', 'WINDIR', 'USERPROFILE', 'COMSPEC', 'PATHEXT']) {
    if (typeof process.env[key] === 'string') env[key] = process.env[key];
  }
  // No cloud credentials, agent tokens, NODE_OPTIONS, shell startup variables,
  // dynamic loader overrides, or inherited SSH agent sockets reach commands.
  env.PATH ||= process.platform === 'win32' ? `${env.SystemRoot || 'C:\\Windows'}\\System32` : '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
  return env;
}

function shellCommand(command) {
  if (process.platform === 'win32') return [process.env.COMSPEC || 'cmd.exe', ['/d', '/s', '/c', command]];
  const selected = process.env.SHELL;
  const shell = selected && path.isAbsolute(selected) && /^(?:zsh|bash|sh|dash|fish)$/.test(path.basename(selected))
    ? selected : process.platform === 'darwin' ? '/bin/zsh' : '/bin/sh';
  switch (path.basename(shell)) {
    case 'zsh': return [shell, ['-f', '-c', command]];
    case 'bash': return [shell, ['--noprofile', '--norc', '-c', command]];
    case 'fish': return [shell, ['--no-config', '-c', command]];
    default: return [shell, ['-c', command]];
  }
}

function runCommand(command, cwd, signal, timeoutMs) {
  if (signal?.aborted) throw failure('aborted', 'The command was cancelled.');
  return new Promise((resolve, reject) => {
    const [shell, argv] = shellCommand(command);
    const child = spawn(shell, argv, { cwd, env: cleanEnvironment(), detached: process.platform !== 'win32', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [], stderr = [];
    let bytes = 0, truncated = false, timedOut = false, aborted = false, finished = false;
    let killTimer, fallbackTimer;
    const collect = (chunks) => (chunk) => {
      const available = MAX_OUTPUT_BYTES - bytes;
      if (chunk.length > available) truncated = true;
      if (available > 0) {
        const retained = chunk.subarray(0, available);
        chunks.push(retained);
        bytes += retained.length;
      }
    };
    child.stdout.on('data', collect(stdout));
    child.stderr.on('data', collect(stderr));
    const killGroup = (kind) => {
      if (!child.pid) return;
      if (process.platform === 'win32') {
        // Windows does not have POSIX process groups. taskkill /T includes descendants.
        const killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { env: cleanEnvironment(), windowsHide: true, stdio: 'ignore' });
        killer.on('error', () => { try { child.kill(); } catch {} });
        killer.unref();
      } else {
        try { process.kill(-child.pid, kind); } catch (error) { if (error.code !== 'ESRCH') { try { child.kill(kind); } catch {} } }
      }
    };
    const stop = () => {
      killGroup('SIGTERM');
      killTimer ||= setTimeout(() => killGroup('SIGKILL'), 250);
      killTimer.unref();
    };
    const decode = (chunks) => new TextDecoder('utf-8').decode(Buffer.concat(chunks), { stream: true });
    const finish = (exitCode, exitSignal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(fallbackTimer);
      signal?.removeEventListener('abort', onAbort);
      resolve({ stdout: decode(stdout), stderr: decode(stderr), exitCode, signal: exitSignal, timedOut, aborted, truncated });
    };
    const terminate = () => {
      stop();
      fallbackTimer ||= setTimeout(() => {
        killGroup('SIGKILL');
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null, 'SIGKILL');
      }, 1500);
      fallbackTimer.unref();
    };
    const onAbort = () => { aborted = true; terminate(); };
    const timer = setTimeout(() => { timedOut = true; terminate(); }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    // A shell may exit while a background child keeps its output pipes open.
    // This executor owns the whole command group, including those descendants.
    child.once('exit', () => stop());
    child.once('close', finish);
    child.once('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      clearTimeout(fallbackTimer);
      signal?.removeEventListener('abort', onAbort);
      reject(failure('command_failed', error.message));
    });
    if (signal?.aborted) onAbort();
  });
}

/** Local commands run as the signed-in OS user; folder roots are NOT a shell sandbox. */
export function createExecutor({ getPolicy, openExternal, describeMachine, commandTimeoutMs = MAX_COMMAND_MS, protectedPaths = [] } = {}) {
  if (typeof getPolicy !== 'function') throw new TypeError('getPolicy is required.');
  if (!Array.isArray(protectedPaths) || protectedPaths.some((value) => typeof value !== 'string' || !path.isAbsolute(value) || value.includes('\0'))) {
    throw new TypeError('protectedPaths must be absolute filesystem paths.');
  }
  // The caller's config/policy cannot weaken this process-owned protection list.
  const protectedLocations = Object.freeze([...new Set(protectedPaths.map((value) => path.resolve(value)))]);
  if (!Number.isInteger(commandTimeoutMs) || commandTimeoutMs < 20 || commandTimeoutMs > MAX_COMMAND_MS) {
    throw new TypeError('commandTimeoutMs must be between 20 and 60000.');
  }

  return {
    async execute(tool, args = {}, { signal } = {}) {
      const schemas = {
        computer_status: [[], []], computer_list_files: [['path'], ['path']],
        computer_read_file: [['path'], ['path']], computer_write_file: [['path', 'content'], ['path', 'content']],
        computer_exec: [['command', 'cwd'], ['command']], computer_open_url: [['url'], ['url']],
      };
      if (!Object.hasOwn(schemas, tool)) throw failure('unknown_tool', 'Unknown desktop tool.');
      validateArgs(args, ...schemas[tool]);
      const policy = await getPolicy() || {};
      const capabilities = Object.fromEntries(['files', 'terminal', 'browser'].map((key) => [key, policy.capabilities?.[key] === true]));
      if (tool === 'computer_status') {
        const machine = typeof describeMachine === 'function' ? await describeMachine() || {} : {};
        return {
          enabled: policy.enabled === true,
          hostname: String(machine.hostname || os.hostname()).slice(0, 256),
          platform: String(machine.platform || process.platform).slice(0, 80),
          arch: String(machine.arch || process.arch).slice(0, 80),
          capabilities,
          roots: (Array.isArray(policy.roots) ? policy.roots : []).filter((root) => typeof root === 'string' && path.isAbsolute(root) && !isSensitive(root)).slice(0, 64).map((root) => ({ path: root, label: path.basename(root) || root })),
          commandAuthority: 'current_os_user',
        };
      }
      if (policy.enabled !== true) throw failure('desktop_disabled', 'Computer access is disabled in the desktop app.');
      const capability = tool === 'computer_exec' ? 'terminal' : tool === 'computer_open_url' ? 'browser' : 'files';
      if (!capabilities[capability]) throw failure('capability_disabled', `${capability} access is disabled in the desktop app.`);
      if (signal?.aborted) throw failure('aborted', 'The operation was cancelled.');

      if (tool === 'computer_open_url') {
        textArg(args.url, 'url', 8192);
        let url;
        try { url = new URL(args.url); } catch { throw failure('invalid_url', 'Enter an http or https URL.'); }
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw failure('invalid_url', 'Only http and https URLs without embedded credentials may be opened.');
        if (typeof openExternal !== 'function') throw failure('browser_unavailable', 'The local browser is unavailable.');
        await openExternal(url.href);
        return { opened: true, url: url.href };
      }

      const roots = await policyRoots(policy);
      if (!roots.length) throw failure('no_allowed_roots', 'Choose an allowed folder in the desktop app first.');
      if (tool === 'computer_exec') {
        const command = textArg(args.command, 'command', 8192);
        const cwd = await resolveExisting(args.cwd === undefined ? roots[0] : args.cwd, roots);
        if (!(await fs.stat(cwd)).isDirectory()) throw failure('not_directory', 'The command working directory must be a folder.');
        return runCommand(command, cwd, signal, commandTimeoutMs);
      }

      const protectedPaths = await canonicalProtectedPaths(protectedLocations);

      if (tool === 'computer_write_file') {
        const requested = absolutePath(args.path);
        assertUnprotected(requested, protectedPaths);
        if (isSensitive(requested)) throw failure('sensitive_path', 'Credential and browser profile locations are unavailable to file tools.');
        if (typeof args.content !== 'string') throw failure('invalid_arguments', 'content must be a string.');
        const content = Buffer.from(args.content, 'utf8');
        if (content.length > MAX_FILE_BYTES) throw failure('file_too_large', 'File content must be at most 256 KiB.');
        const parent = await resolveExisting(path.dirname(requested), roots, protectedPaths);
        const target = path.join(parent, path.basename(requested));
        assertAllowed(target, roots, protectedPaths);
        let original;
        try { original = await fs.lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
        if (original && !original.isFile()) throw failure('not_regular_file', 'Writes require a regular file, not a link or special device.');
        const temporary = path.join(parent, `.ccb-write-${randomUUID()}.tmp`);
        let handle;
        try {
          handle = await fs.open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
          // Editing an existing script must not silently strip its executable bit.
          if (original) await handle.chmod(original.mode & 0o777);
          await handle.writeFile(content);
          await handle.sync();
          await handle.close();
          handle = undefined;
          // Recheck the canonical parent before committing the atomic replacement.
          if (await resolveExisting(parent, roots, protectedPaths) !== parent) throw failure('path_changed', 'The destination folder changed during the write.');
          let current;
          try { current = await fs.lstat(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
          if (current && !current.isFile()) throw failure('not_regular_file', 'The destination is no longer a regular file.');
          if (signal?.aborted) throw failure('aborted', 'The write was cancelled.');
          await fs.rename(temporary, target);
          return { path: target, bytesWritten: content.length };
        } finally {
          await handle?.close().catch(() => {});
          await fs.unlink(temporary).catch(() => {});
        }
      }

      const canonical = await resolveExisting(args.path, roots, protectedPaths);
      if (tool === 'computer_read_file') {
        // Inspect special files without blocking on a FIFO before fstat can reject it.
        const handle = await fs.open(canonical, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
        try {
          const stat = await handle.stat();
          if (!stat.isFile()) throw failure('not_regular_file', 'Only regular files can be read.');
          if (stat.size > MAX_FILE_BYTES) throw failure('file_too_large', 'Files must be at most 256 KiB.');
          const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
          let size = 0;
          while (size < buffer.length) {
            if (signal?.aborted) throw failure('aborted', 'The read was cancelled.');
            const { bytesRead } = await handle.read(buffer, size, buffer.length - size, size);
            if (!bytesRead) break;
            size += bytesRead;
          }
          if (size > MAX_FILE_BYTES) throw failure('file_too_large', 'Files must be at most 256 KiB.');
          if (await resolveExisting(args.path, roots, protectedPaths) !== canonical) throw failure('path_changed', 'The file path changed during the read.');
          let content;
          try { content = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, size)); }
          catch { throw failure('unsupported_encoding', 'This file is not UTF-8 text.'); }
          return { path: canonical, content, bytes: size };
        } finally { await handle.close(); }
      }

      const entries = [];
      let inspected = 0, truncated = false;
      for await (const entry of await fs.opendir(canonical)) {
        if (signal?.aborted) throw failure('aborted', 'The listing was cancelled.');
        if (entries.length >= MAX_LIST_ENTRIES || inspected++ >= 1000) { truncated = true; break; }
        const candidate = path.join(canonical, entry.name);
        try {
          assertAllowed(candidate, roots, protectedPaths);
          const resolved = await resolveExisting(candidate, roots, protectedPaths);
          const stat = await fs.stat(resolved);
          if (!stat.isFile() && !stat.isDirectory()) continue;
          entries.push({ name: entry.name, type: stat.isDirectory() ? 'directory' : 'file', symlink: entry.isSymbolicLink() });
        } catch { /* Hide disallowed, dangling, or concurrently removed entries. */ }
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      return { path: canonical, entries, truncated };
    },
  };
}
