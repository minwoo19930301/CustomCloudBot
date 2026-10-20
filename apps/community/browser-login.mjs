import { randomUUID } from 'node:crypto';
import { loginOrigin } from './login-requests.mjs';

const fail = (code = 'LOGIN_TARGET_CHANGED') => Object.assign(new Error(
  code === 'LOGIN_FORM_UNSUPPORTED' ? '자동 입력할 로그인 화면을 확인할 수 없습니다. 브라우저에서 로그인 화면을 열어주세요.' :
    '로그인 화면이 바뀌었습니다. 현재 화면에서 다시 로그인 요청을 해주세요.'
), { status: 409, code });
async function bounded(operation, signal) {
  let timer, abort;
  try {
    signal?.throwIfAborted();
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise((_, reject) => {
        abort = () => reject(fail());
        signal?.addEventListener('abort', abort, { once: true });
        timer = setTimeout(abort, 5000); timer.unref?.();
      }),
    ]);
  } finally { clearTimeout(timer); if (abort) signal?.removeEventListener('abort', abort); }
}

// Runs in the page. Its returned JSHandle retains the exact DOM nodes privately;
// the page receives no global marker, selector, credential or model-facing ref.
function captureForm() {
  const visible = element => {
    const style = getComputedStyle(element), box = element.getBoundingClientRect();
    return element.isConnected && !element.disabled && !element.readOnly &&
      style.display !== 'none' && style.visibility !== 'hidden' && box.width > 0 && box.height > 0;
  };
  const autocomplete = element => (element.getAttribute('autocomplete') || '').toLowerCase().split(/\s+/);
  const identity = element => [element.type, element.name, element.id, element.getAttribute('autocomplete')].join('\n');
  const usernameField = element => {
    if (!['text', 'email', 'tel'].includes(element.type)) return false;
    const hint = [element.name, element.id].join(' ').toLowerCase();
    if (/(?:otp|captcha|verification|search|query|phone|mobile)/.test(hint)) return false;
    return element.type === 'email' || autocomplete(element).some(value => ['username', 'email'].includes(value)) ||
      /(?:user(?:name|id)?|e.?mail|identifier|login|account)/.test(hint) || element.name === 'id' || element.id === 'id';
  };
  const inspect = () => {
    const inputs = Array.from(document.querySelectorAll('input')).filter(visible);
    const passwords = inputs.filter(element => element.type === 'password');
    if (passwords.length > 1) throw new Error('Unsupported login form');
    let password = passwords[0] || null;
    const candidates = inputs.filter(usernameField).filter(element => !password || element.form === password.form);
    if (candidates.length > 1 || !password && candidates.length !== 1) throw new Error('Ambiguous login form');
    const username = candidates[0] || null, form = (password || username).form;
    const scoped = inputs.filter(element => element.form === form);
    if (scoped.some(element => ['text', 'email', 'tel', 'url', 'search', 'number', 'password'].includes(element.type) && element !== username && element !== password))
      throw new Error('Unknown login input');
    if (password && (autocomplete(password).includes('new-password') || /(?:new|confirm|repeat)/i.test(password.name + ' ' + password.id)))
      throw new Error('Signup is not login');
    const buttons = Array.from((form || document).querySelectorAll('button,input[type=submit]'));
    const submits = buttons.filter(element => element.type === 'submit');
    const signup = /(?:sign[\s_-]*up|create[\s_-]*(?:an?[\s_-]*)?account|register|회원\s*가입|가입하기)/i;
    if (submits.some(element => signup.test(element.innerText || element.value || '')) || signup.test(form?.getAttribute('action') || ''))
      throw new Error('Signup is not login');
    if (!password && !autocomplete(username).includes('username') &&
        !/(?:login|sign[\s_-]*in|authenticate)/i.test((form?.getAttribute('action') || '') + ' ' + location.pathname) &&
        !submits.some(element => /(?:log[\s_-]*in|sign[\s_-]*in|continue|next|로그인|계속|다음)/i.test(element.innerText || element.value || '')))
      throw new Error('Not a login form');
    const actions = [form?.getAttribute('action'), ...buttons.map(element => element.getAttribute('formaction'))].filter(Boolean);
    if (actions.some(action => new URL(action, location.href).origin !== location.origin))
      throw new Error('Cross-origin form');
    return { username, password, form };
  };
  const initial = inspect(), href = location.href, origin = location.origin;
  const signatures = [initial.username && identity(initial.username), initial.password && identity(initial.password)];
  return {
    ...initial, href, origin,
    validate() {
      if (location.href !== href || location.origin !== origin) throw new Error('Changed page');
      const current = inspect();
      if (current.username !== initial.username || current.password !== initial.password || current.form !== initial.form ||
          (initial.username && identity(initial.username)) !== signatures[0] ||
          (initial.password && identity(initial.password)) !== signatures[1]) throw new Error('Changed login fields');
    },
  };
}

function fillForm(target, { username, password, origin, href, deadline }) {
  const verify = () => {
    if (Date.now() > deadline || location.href !== href || location.origin !== origin) throw new Error('Changed page');
    target.validate();
    if (Date.now() > deadline) throw new Error('Login entry expired');
  };
  const set = (element, value) => {
    verify();
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    if (!setter) throw new Error('Input unavailable');
    setter.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  };
  verify();
  if (target.username) set(target.username, username);
  // The username event may synchronously replace the password field or navigate.
  // Revalidate the captured nodes before sending a password to the page.
  if (target.password) set(target.password, password);
  return { status: 'filled', nextStep: target.password ? 'submit' : 'continue' };
}

/** Private methods only: these are not part of BROWSER_TOOL_DEFINITIONS. */
export function createBrowserLogin({ enqueue, pageFor, assertSafeUrl, redact, invalidate, now = Date.now, ttlMs = 600_000 }) {
  const targets = new Map();
  const dispose = target => target.handle.dispose().catch(() => {});
  async function prune() {
    for (const [id, target] of targets) if (target.expiresAt <= now()) {
      targets.delete(id); await dispose(target);
    }
  }
  return {
    captureLoginTarget(roomId, { signal } = {}) {
      return enqueue(roomId, async () => {
        signal?.throwIfAborted();
        await prune();
        const { page } = await pageFor(roomId);
        const href = page.url(), origin = loginOrigin(new URL(href).origin);
        await assertSafeUrl(href);
        signal?.throwIfAborted();
        let handle;
        try {
          const pendingHandle = page.evaluateHandle(captureForm);
          try { handle = await bounded(() => pendingHandle, signal); }
          catch (error) { void pendingHandle.then(late => late.dispose()).catch(() => {}); throw error; }
          const checked = await bounded(() => handle.evaluate(target => ({ href: target.href, origin: target.origin })), signal);
          if (checked.href !== href || checked.origin !== origin || page.url() !== href) throw fail();
          if (targets.size >= 64) {
            const [oldId, oldTarget] = targets.entries().next().value;
            targets.delete(oldId); await dispose(oldTarget);
          }
          const tabRef = randomUUID(), expiresAt = now() + ttlMs;
          targets.set(tabRef, { roomId, page, href, origin, handle, expiresAt });
          return { origin, tabRef, siteLabel: new URL(origin).hostname, expiresAt };
        } catch {
          await handle?.dispose().catch(() => {});
          throw fail('LOGIN_FORM_UNSUPPORTED');
        }
      });
    },
    fillLogin({ roomId, origin, tabRef, username, password, signal, authorize }) {
      return enqueue(roomId, async () => {
        await prune(); signal?.throwIfAborted();
        const target = targets.get(tabRef);
        if (!target || target.roomId !== roomId || target.origin !== origin) throw fail();
        targets.delete(tabRef);
        try {
          if (typeof authorize !== 'function') throw fail();
          await authorize(); signal?.throwIfAborted();
          const { page, session } = await pageFor(roomId);
          if (page !== target.page || page.isClosed() || page.url() !== target.href || target.expiresAt <= now()) throw fail();
          await assertSafeUrl(target.href);
          await authorize(); signal?.throwIfAborted();
          if (page.url() !== target.href || target.expiresAt <= now()) throw fail();
          if (typeof username !== 'string' || username.length > 320 || typeof password !== 'string' || !password || password.length > 4096)
            throw fail('LOGIN_FORM_UNSUPPORTED');
          redact(session, [username, password]);
          await invalidate(session);
          await authorize(); signal?.throwIfAborted();
          if (page.url() !== target.href || target.expiresAt <= now()) throw fail();
          const result = await bounded(() => target.handle.evaluate(fillForm, { username, password, origin, href: target.href, deadline: Date.now() + 5000 }), signal);
          return { status: 'filled', nextStep: result?.nextStep === 'continue' ? 'continue' : 'submit' };
        } catch (error) {
          if ([401, 403].includes(error?.status))
            throw Object.assign(fail(), { status: error.status });
          throw fail();
        } finally { await dispose(target); }
      });
    },
    async close() {
      await Promise.all([...targets.values()].map(dispose)); targets.clear();
    },
  };
}
