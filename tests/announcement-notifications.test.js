const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const register = require('../announcement-notifications');

test('announcement notifications exclude hidden posts and keep per-user read state', async (t) => {
  const posts = [{ id: '1', title: 'Meeting', published: true }, { id: '2', title: 'Hidden', published: false }];
  const reads = new Set();
  const query = async (sql, params = []) => {
    if (sql.startsWith('CREATE')) return {};
    if (sql.startsWith('INSERT')) {
      assert.match(sql, /WHERE id = \$1 AND is_published = true/);
      assert.match(sql, /ON CONFLICT \(user_id, announcement_id\)/);
      const post = posts.find((item) => item.id === params[0] && item.published);
      if (!post) return { rowCount: 0 };
      reads.add(`${params[1]}:${post.id}`);
      return { rowCount: 1 };
    }
    assert.match(sql, /r.user_id = \$1/);
    assert.match(sql, /a.is_published = true/);
    const items = posts.filter((post) => post.published).map((post) => ({ id: post.id, title: post.title, readAt: reads.has(`${params[0]}:${post.id}`) ? '2026-11-12T00:00:00Z' : null }));
    if (sql.startsWith('SELECT COUNT')) return { rows: [{ unread: items.filter((item) => !item.readAt).length }] };
    assert.match(sql, /LIMIT 20/);
    return { rows: items };
  };
  const app = express();
  app.use((req, _res, next) => { req.session = req.headers['x-role'] ? { user: { id: Number(req.headers['x-user'] || 7), role: req.headers['x-role'] } } : {}; next(); });
  const allow = (...roles) => (req, res, next) => !req.session.user ? res.sendStatus(401) : roles.includes(req.session.user.role) ? next() : res.sendStatus(403);
  register(app, { query }, allow);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = (route, role, method = 'GET', user = 7) => fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers: role ? { 'x-role': role, 'x-user': String(user) } : {} });
  assert.equal((await request('/api/announcement-notifications')).status, 401);
  assert.equal((await request('/api/announcement-notifications', 'admin')).status, 403);
  const response = await request('/api/announcement-notifications', 'captain');
  assert.match(response.headers.get('cache-control'), /no-store/);
  const inbox = await response.json();
  assert.equal(inbox.unread, 1);
  assert.deepEqual(inbox.announcements.map((row) => row.id), ['1']);
  assert.equal((await request('/api/announcement-notifications/1/read', 'captain', 'PATCH')).status, 200);
  assert.equal((await request('/api/announcement-notifications/1/read', 'captain', 'PATCH')).status, 200);
  assert.equal(reads.size, 1);
  assert.equal((await (await request('/api/announcement-notifications', 'captain')).json()).unread, 0);
  assert.equal((await (await request('/api/announcement-notifications', 'tanod', 'GET', 8)).json()).unread, 1);
  assert.equal((await request('/api/announcement-notifications/2/read', 'tanod', 'PATCH')).status, 404);
  assert.equal((await request('/api/announcement-notifications/999/read', 'tanod', 'PATCH')).status, 404);
  assert.equal((await request('/api/announcement-notifications/bad/read', 'tanod', 'PATCH')).status, 400);
  posts[0].published = false;
  assert.equal((await (await request('/api/announcement-notifications', 'tanod', 'GET', 8)).json()).unread, 0);
});
