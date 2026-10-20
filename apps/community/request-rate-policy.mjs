const DEFAULT_RATE = Object.freeze({bucket: 'api', max: 180});
const POLL_RATE = Object.freeze({bucket: 'api-read', max: 600});
const ROOM_DETAIL = /^\/api\/rooms\/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const POLL_PATHS = new Set([
  '/api/rooms/activity',
  '/api/notifications',
  '/api/notifications/settings',
  '/api/sidebar',
  '/api/browser-logins',
]);
// These routes already apply their own authenticated workspace/mobile limits.
// Preserve the server's existing exemption, including subroutes and methods.
const WORKSPACE_OR_MOBILE = /^\/api\/rooms\/[a-f0-9-]{36}\/(?:workspace|mobile)(?:\/|$)/;

/** Called only after authentication and CSRF checks, with URL.pathname.
 * Polls share one per-user budget, not an unbounded bucket per room or URL. */
export function authenticatedApiRatePolicy(pathname, method) {
  if (WORKSPACE_OR_MOBILE.test(pathname)) return null;
  if (method === 'GET' && (POLL_PATHS.has(pathname) || ROOM_DETAIL.test(pathname))) return POLL_RATE;
  return DEFAULT_RATE;
}
