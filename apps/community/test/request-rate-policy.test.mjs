import test from 'node:test';
import assert from 'node:assert/strict';
import {authenticatedApiRatePolicy} from '../request-rate-policy.mjs';

const room = 'e1111111-2222-4333-8444-555555555555';
const reads = [`/api/rooms/${room}`, '/api/rooms/activity', '/api/notifications', '/api/notifications/settings', '/api/sidebar'];

test('only the explicit polling GET routes share the bounded read allowance', () => {
  for (const pathname of reads) assert.deepEqual(authenticatedApiRatePolicy(pathname, 'GET'), {bucket: 'api-read', max: 600}, pathname);
  assert.deepEqual(authenticatedApiRatePolicy('/api/rooms/f1111111-2222-4333-8444-555555555555', 'GET'), {bucket: 'api-read', max: 600});
  assert.deepEqual(authenticatedApiRatePolicy(new URL('https://example.test/api/notifications?after=123').pathname, 'GET'), {bucket: 'api-read', max: 600}, 'query cursors do not create new buckets');
});

test('mutations, expensive GETs, and non-matching paths retain the original default limit', () => {
  for (const pathname of reads) {
    for (const method of ['POST', 'PATCH', 'PUT', 'DELETE', 'HEAD', 'get', undefined]) {
      assert.deepEqual(authenticatedApiRatePolicy(pathname, method), {bucket: 'api', max: 180}, `${method} ${pathname}`);
    }
  }
  for (const pathname of ['/api/rooms', '/api/admin/monitor', '/api/admin/setup', '/api/models', '/api/conversations/delete-preview',
    `/api/rooms/${room}/progress`, `/api/rooms/${room}/export`, `/api/rooms/${room}/attachments`, `/api/rooms/${room}/usage`,
    `/api/rooms/${room}/messages`, `/api/rooms/${room}/`, '/api/rooms/not-a-room', '/api/rooms/' + '-'.repeat(36),
    '/api/notifications/read', '/api/sidebar/extra', '/api/notifications/settings/extra', '/api/notifications?after=123']) {
    assert.deepEqual(authenticatedApiRatePolicy(pathname, 'GET'), {bucket: 'api', max: 180}, pathname);
  }
});

test('workspace and mobile keep their existing route-specific budgets without widening their prefixes', () => {
  for (const method of ['GET', 'POST', 'DELETE']) {
    for (const suffix of ['workspace', 'workspace/files', 'workspace/media/status', 'mobile', 'mobile/control']) {
      assert.equal(authenticatedApiRatePolicy(`/api/rooms/${room}/${suffix}`, method), null);
    }
  }
  for (const pathname of [`/api/rooms/${room}/workspaces`, `/api/rooms/${room}/workspace-backup`, `/api/rooms/${room}/mobile-admin`, '/api/mobile', '/api/workspace']) {
    assert.deepEqual(authenticatedApiRatePolicy(pathname, 'GET'), {bucket: 'api', max: 180});
  }
});
