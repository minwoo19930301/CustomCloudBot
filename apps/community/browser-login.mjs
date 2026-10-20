import { randomUUID } from 'node:crypto';
import { loginOrigin } from './login-requests.mjs';

const messages = {
  LOGIN_TARGET_CHANGED:'로그인 화면이 바뀌었습니다. 현재 화면에서 다시 로그인 요청을 해주세요.',
  LOGIN_FORM_UNSUPPORTED:'자동 입력할 로그인 화면을 확인할 수 없습니다. 브라우저에서 로그인 화면을 열어주세요.',
  LOGIN_URL_INVALID:'로그인할 사이트의 HTTPS 주소를 확인해주세요.',
  LOGIN_TARGET_MISMATCH:'요청한 사이트와 현재 브라우저 주소가 다릅니다. 로그인할 사이트를 확인해주세요.',
  LOGIN_LINK_UNSUPPORTED:'로그인 링크를 하나로 확인하지 못했습니다. 브라우저에서 로그인 화면을 연 뒤 다시 요청해주세요.',
  LOGIN_NAVIGATION_FAILED:'로그인 화면으로 이동하지 못했습니다. 브라우저에서 사이트를 확인해주세요.',
};
const fail = (code = 'LOGIN_TARGET_CHANGED') => Object.assign(new Error(messages[code]), { status:code === 'LOGIN_URL_INVALID' ? 400 : 409, code });
const hostName = value => new URL(value).hostname.toLowerCase().replace(/^www\./, '');
const sameSite = (value, rootHost) => {
  try {
    const url = new URL(value), host = hostName(value);
    return url.protocol === 'https:' && !url.username && !url.password && (host === rootHost || host.endsWith('.' + rootHost));
  } catch { return false; }
};
function requestedUrl(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048 || /[\s\\\x00-\x1f\x7f]/.test(value.trim())) throw fail('LOGIN_URL_INVALID');
  try {
    const url = new URL(value.includes('://') ? value.trim() : 'https://' + value.trim());
    loginOrigin(url.origin);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw fail('LOGIN_URL_INVALID');
    return url.href;
  } catch { throw fail('LOGIN_URL_INVALID'); }
}
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

// Read only actual visible anchors. Never use buttons, form submits, page text
// instructions, an LLM-generated URL, or a guessed /login route.
function captureLoginLink(rootHost) {
  const text = /^(?:[a-z0-9가-힣._-]{1,30}\s*)?(?:로그인|log\s*in|sign\s*in)(?:\s*(?:하기|하세요))?$/i;
  const candidates = Array.from(document.querySelectorAll('a[href]')).slice(0, 1000).filter(node => {
    const style = getComputedStyle(node), box = node.getBoundingClientRect();
    if (!node.isConnected || style.display === 'none' || style.visibility === 'hidden' || box.width <= 0 || box.height <= 0 ||
        node.hasAttribute('download') || !['', '_self'].includes((node.getAttribute('target') || '').toLowerCase())) return false;
    if (!text.test((node.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 120))) return false;
    try {
      const url = new URL(node.getAttribute('href'), location.href), host = url.hostname.toLowerCase().replace(/^www\./, '');
      return url.protocol === 'https:' && !url.username && !url.password && url.href !== location.href &&
        (host === rootHost || host.endsWith('.' + rootHost)) && /(?:login|log[-_]in|signin|sign[-_]in|authenticate|\/auth(?:\/|$))/i.test(url.pathname);
    } catch { return false; }
  });
  if (candidates.length !== 1) throw new Error('No unique same-site login anchor');
  return candidates[0];
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
  async function capture(roomId, page, signal) {
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
      signal?.throwIfAborted();
      throw fail('LOGIN_FORM_UNSUPPORTED');
    }
  }
  return {
    captureLoginTarget(roomId, { signal } = {}) {
      return enqueue(roomId, async () => {
        signal?.throwIfAborted();
        await prune();
        const { page } = await pageFor(roomId);
        return capture(roomId, page, signal);
      });
    },
    prepareLoginTarget(roomId, options = {}) {
      return enqueue(roomId, async () => {
        if (!options || typeof options !== 'object' || Object.keys(options).some(key => !['url', 'expectedOrigin', 'signal'].includes(key))) throw fail('LOGIN_URL_INVALID');
        const { url, expectedOrigin, signal } = options;
        signal?.throwIfAborted(); await prune();
        let expected;
        try { if (expectedOrigin !== undefined) expected = loginOrigin(expectedOrigin); }
        catch { throw fail('LOGIN_URL_INVALID'); }
        const destination = url === undefined ? null : requestedUrl(url), rootHost = destination && hostName(destination);
        if (destination) await assertSafeUrl(destination);
        signal?.throwIfAborted();
        const { page, session } = await pageFor(roomId);
        const verifySite = () => {
          signal?.throwIfAborted();
          if ((expected && new URL(page.url()).origin !== expected) || (destination && !sameSite(page.url(), rootHost))) throw fail('LOGIN_TARGET_MISMATCH');
        };
        // A continuation without a new URL is bound to the exact authorized
        // origin. It never searches the web or silently switches sites.
        if (!destination) {
          verifySite();
          try { return await capture(roomId, page, signal); }
          catch (error) {
            signal?.throwIfAborted();
            if (error.code === 'LOGIN_INPUT_INVALID') throw fail('LOGIN_FORM_UNSUPPORTED');
            throw error;
          }
        }
        const tryCapture = async () => {
          try { verifySite(); return await capture(roomId, page, signal); }
          catch (error) {
            signal?.throwIfAborted();
            if (error.code !== 'LOGIN_FORM_UNSUPPORTED') throw error;
            return null;
          }
        };
        if (sameSite(page.url(), rootHost) && (!expected || new URL(page.url()).origin === expected)) {
          const current = await tryCapture();
          if (current) return current;
        }
        try {
          await invalidate(session); signal?.throwIfAborted();
          await page.goto(destination, {waitUntil:'domcontentloaded', timeout:10000});
        } catch {
          signal?.throwIfAborted(); throw fail('LOGIN_NAVIGATION_FAILED');
        }
        verifySite();
        const direct = await tryCapture();
        if (direct) return direct;
        const before = page.url();
        let link;
        try {
          const pendingLink = page.evaluateHandle(captureLoginLink, rootHost);
          try { link = await bounded(() => pendingLink, signal); }
          catch (error) { void pendingLink.then(late => late.dispose()).catch(() => {}); throw error; }
          const href = await bounded(() => link.evaluate(node => node.href), signal);
          if (!sameSite(href, rootHost) || page.url() !== before) throw fail('LOGIN_TARGET_MISMATCH');
          await assertSafeUrl(href);
          verifySite();
          const valid = await bounded(() => link.evaluate((node, expected) => node.isConnected && node.tagName === 'A' && node.href === expected, href), signal);
          if (!valid || page.url() !== before) throw fail('LOGIN_TARGET_CHANGED');
          await invalidate(session); signal?.throwIfAborted();
          // Arm navigation before clicking the anchor. Do not click a submit or
          // continue button; the separate private fill flow remains user-driven.
          const navigation = page.waitForURL(url => url.href !== before, {waitUntil:'domcontentloaded', timeout:10000});
          navigation.catch(() => {});
          await link.asElement().click({timeout:5000});
          await navigation;
        } catch (error) {
          signal?.throwIfAborted();
          if (error.code === 'LOGIN_TARGET_MISMATCH') throw error;
          throw fail('LOGIN_LINK_UNSUPPORTED');
        } finally { await link?.dispose().catch(() => {}); }
        verifySite();
        return capture(roomId, page, signal);
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
