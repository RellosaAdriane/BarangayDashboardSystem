const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const bcrypt = require('bcryptjs');
const register = require('../account-passwords');

test('admin password reset protects target roles, hashes passwords, revokes sessions and audits atomically', async (t) => {
  const oldHash = await bcrypt.hash('old-password', 4);
  const users = [
    { id: '1', role: 'admin', approval: 'approved', hash: oldHash },
    { id: '2', role: 'tanod', approval: 'approved', hash: oldHash },
    { id: '3', role: 'captain', approval: 'approved', hash: oldHash },
    { id: '4', role: 'tanod', approval: 'pending', hash: oldHash }
  ];
  let sessions = [{ sid: 'admin', userId: '1' }, { sid: 'tanod-one', userId: '2' }, { sid: 'tanod-two', userId: '2' }, { sid: 'captain', userId: '3' }];
  const audits = [];
  let snapshot;
  let failAudit = false;
  let released = 0;
  const query = async (sql, params = []) => {
    if (sql === 'BEGIN') { snapshot = { hashes: users.map((user) => user.hash), sessions: [...sessions] }; return {}; }
    if (sql === 'COMMIT') return {};
    if (sql === 'ROLLBACK') { users.forEach((user, index) => { user.hash = snapshot.hashes[index]; }); sessions = snapshot.sessions; return {}; }
    if (sql.startsWith('UPDATE users')) {
      assert.match(sql, /role IN \('tanod', 'captain'\) AND approval_status = 'approved'/);
      const user = users.find((user) => user.id === params[1] && ['tanod', 'captain'].includes(user.role) && user.approval === 'approved');
      if (!user) return { rows: [] };
      user.hash = params[0];
      return { rows: [{ id: user.id, role: user.role }] };
    }
    if (sql.startsWith('DELETE FROM private.user_sessions')) {
      assert.match(sql, /sess->'user'->>'id' = \$1/);
      sessions = sessions.filter((session) => session.userId !== params[0]);
      return {};
    }
    if (sql.startsWith('INSERT INTO audit_logs')) {
      if (failAudit) throw new Error('Audit failed');
      audits.push(params);
      return {};
    }
    throw new Error(`Unexpected query: ${sql}`);
  };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = req.headers['x-role'] ? { user: { id: 1, role: req.headers['x-role'] } } : {}; next(); });
  const allow = (...roles) => (req, res, next) => !req.session.user ? res.sendStatus(401) : roles.includes(req.session.user.role) ? next() : res.sendStatus(403);
  register(app, { connect: async () => ({ query, release() { released++; } }) }, allow);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = (id, role, body = { newPassword: 'new-password', confirmPassword: 'new-password' }) => fetch(`http://127.0.0.1:${server.address().port}/api/users/${id}/reset-password`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(role ? { 'x-role': role } : {}) }, body: JSON.stringify(body)
  });
  await t.test('only admin can reset passwords', async () => {
    assert.equal((await request(2)).status, 401);
    assert.equal((await request(2, 'tanod')).status, 403);
    assert.equal((await request(2, 'captain')).status, 403);
    assert.equal(users[1].hash, oldHash);
    assert.equal(released, 0);
  });
  await t.test('invalid IDs and mismatched or out-of-range passwords are rejected', async () => {
    for (const body of [{}, { newPassword: 'short', confirmPassword: 'short' }, { newPassword: 'x'.repeat(17), confirmPassword: 'x'.repeat(17) }, { newPassword: 'new-password', confirmPassword: 'different' }]) {
      assert.equal((await request(2, 'admin', body)).status, 400);
    }
    assert.equal((await request('bad', 'admin')).status, 400);
    assert.equal(released, 0);
  });
  await t.test('reset changes only the target Tanod password and sessions without exposing credentials', async () => {
    const response = await request(2, 'admin');
    assert.equal(response.status, 200);
    assert.match(response.headers.get('cache-control'), /no-store/);
    const result = await response.json();
    assert.equal(result.ok, true);
    assert.equal(JSON.stringify(result).includes('new-password'), false);
    assert.notEqual(users[1].hash, 'new-password');
    assert.equal(await bcrypt.compare('new-password', users[1].hash), true);
    assert.equal(await bcrypt.compare('old-password', users[1].hash), false);
    assert.deepEqual(sessions.map((session) => session.sid), ['admin', 'captain']);
    assert.equal(users[0].hash, oldHash);
    assert.equal(users[2].hash, oldHash);
    assert.equal(audits[0][1], 'password_reset');
    assert.equal(audits[0][3], '2');
    assert.deepEqual(JSON.parse(audits[0][4]), { role: 'tanod' });
    assert.equal(JSON.stringify(audits).includes('new-password'), false);
  });
  await t.test('admin accounts, pending accounts and unknown targets cannot be reset here', async () => {
    for (const id of ['1', '4', '999']) assert.equal((await request(id, 'admin')).status, 404);
    assert.equal(users[0].hash, oldHash);
    assert.equal(users[3].hash, oldHash);
    assert.ok(sessions.some((session) => session.sid === 'admin'));
  });
  await t.test('failed audit rolls back the password and session revocation; Captain reset then succeeds', async () => {
    failAudit = true;
    assert.equal((await request(3, 'admin')).status, 500);
    assert.equal(users[2].hash, oldHash);
    assert.ok(sessions.some((session) => session.sid === 'captain'));
    failAudit = false;
    assert.equal((await request(3, 'admin')).status, 200);
    assert.equal(await bcrypt.compare('new-password', users[2].hash), true);
    assert.deepEqual(sessions.map((session) => session.sid), ['admin']);
    assert.equal(audits.length, 2);
  });
});
