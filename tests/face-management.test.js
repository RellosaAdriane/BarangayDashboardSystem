const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const registerFaces = require('../face-management');

test('face enrollment protects photos and mutations, validates uploads and removes enrollment data', async (t) => {
  let people = [];
  let snapshot;
  let released = 0;
  let failAudit = false;
  const audits = [];
  const query = async (sql, params = []) => {
    if (sql.startsWith('CREATE')) return {};
    if (sql === 'BEGIN') { snapshot = [...people]; return {}; }
    if (sql === 'COMMIT') return {};
    if (sql === 'ROLLBACK') { people = snapshot; return {}; }
    if (sql.startsWith('INSERT INTO audit_logs')) {
      if (failAudit) throw new Error('Audit unavailable');
      audits.push(params);
      return {};
    }
    if (sql.startsWith('INSERT INTO enrolled_faces')) {
      const person = { id: String(people.length + 1), fullName: params[0], descriptor: params[1], photo: params[2], photo_type: params[3], enrolledAt: new Date().toISOString() };
      people.push(person);
      return { rows: [{ id: person.id, fullName: person.fullName, enrolledAt: person.enrolledAt }] };
    }
    if (sql.startsWith('DELETE')) {
      const person = people.find((row) => row.id === params[0]);
      people = people.filter((row) => row.id !== params[0]);
      return { rows: person ? [person] : [] };
    }
    if (sql.startsWith('SELECT photo')) return { rows: people.filter((row) => row.id === params[0]) };
    if (sql.includes('descriptor FROM')) return { rows: people.map(({ id, fullName, descriptor }) => ({ id, fullName, descriptor })) };
    return { rows: people.map(({ id, fullName, enrolledAt }) => ({ id, fullName, enrolledAt })) };
  };
  const app = express();
  app.use((req, _res, next) => { req.session = req.headers['x-role'] ? { user: { id: 7, role: req.headers['x-role'] } } : {}; next(); });
  const auth = (req, res, next) => req.session.user ? next() : res.sendStatus(401);
  const allow = (...roles) => (req, res, next) => !req.session.user ? res.sendStatus(401) : roles.includes(req.session.user.role) ? next() : res.sendStatus(403);
  registerFaces(app, { query, connect: async () => ({ query, release() { released++; } }) }, auth, allow);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = (path, role, method = 'GET', body) => fetch(`http://127.0.0.1:${server.address().port}${path}`, { method, headers: role ? { 'x-role': role } : {}, body });
  const enrollment = (descriptor = Array(128).fill(0.1), image = Buffer.from([255, 216, 255, 217]), name = 'Authorized Person') => {
    const form = new FormData();
    form.append('fullName', name);
    form.append('descriptor', JSON.stringify(descriptor));
    form.append('picture', new Blob([image], { type: 'image/jpeg' }), 'person.jpg');
    return form;
  };

  await t.test('anonymous users and non-admin mutations are rejected', async () => {
    for (const route of ['/api/faces', '/api/faces/descriptors', '/api/faces/1/photo']) assert.equal((await request(route)).status, 401);
    for (const role of ['tanod', 'captain']) {
      assert.equal((await request('/api/faces', role)).status, 403);
      assert.equal((await request('/api/faces/1/photo', role)).status, 403);
      assert.equal((await request('/api/faces', role, 'POST', enrollment())).status, 403);
      assert.equal((await request('/api/faces/1', role, 'DELETE')).status, 403);
    }
  });
  await t.test('invalid descriptors, empty names, forged photos and oversize files are rejected', async () => {
    for (const descriptor of [[], Array(127).fill(0.1), Array(128).fill(0), Array(128).fill('0.1'), Array(128).fill(99)]) {
      assert.equal((await request('/api/faces', 'admin', 'POST', enrollment(descriptor))).status, 400);
    }
    assert.equal((await request('/api/faces', 'admin', 'POST', enrollment(Array(128).fill(0.1), undefined, '  '))).status, 400);
    assert.equal((await request('/api/faces', 'admin', 'POST', enrollment(Array(128).fill(0.1), Buffer.from('not-a-photo')))).status, 400);
    assert.equal((await request('/api/faces', 'admin', 'POST', enrollment(Array(128).fill(0.1), Buffer.alloc(4194305)))).status, 413);
    assert.equal(people.length, 0);
  });
  await t.test('admin can enroll; photos are authenticated and descriptors are not part of the list', async () => {
    const result = await request('/api/faces', 'admin', 'POST', enrollment());
    assert.equal(result.status, 201);
    assert.equal((await result.json()).fullName, 'Authorized Person');
    const listResponse = await request('/api/faces', 'admin');
    assert.match(listResponse.headers.get('cache-control'), /no-store/);
    const list = await listResponse.json();
    assert.equal(list.length, 1);
    assert.equal(Object.hasOwn(list[0], 'descriptor'), false);
    const descriptors = await (await request('/api/faces/descriptors', 'tanod')).json();
    assert.equal(descriptors[0].descriptor.length, 128);
    assert.equal(Object.hasOwn(descriptors[0], 'photo'), false);
    const photo = await request('/api/faces/1/photo', 'admin');
    assert.equal(photo.headers.get('content-type'), 'image/jpeg');
    assert.match(photo.headers.get('cache-control'), /no-store/);
    assert.equal((await photo.arrayBuffer()).byteLength, 4);
    assert.equal(audits[0][1], 'created');
    assert.equal(audits[0][2], 'enrolled_face');
  });
  await t.test('failed audit rolls back enrollment and releases the database connection', async () => {
    failAudit = true;
    assert.equal((await request('/api/faces', 'admin', 'POST', enrollment())).status, 503);
    assert.equal(people.length, 1);
    assert.equal(released, 2);
    failAudit = false;
  });
  await t.test('removal deletes photo and descriptor and writes an audit event', async () => {
    assert.equal((await request('/api/faces/1', 'admin', 'DELETE')).status, 200);
    assert.equal((await request('/api/faces/1/photo', 'admin')).status, 404);
    assert.deepEqual(await (await request('/api/faces/descriptors', 'tanod')).json(), []);
    assert.equal(audits[1][1], 'deleted');
    assert.equal((await request('/api/faces/1', 'admin', 'DELETE')).status, 404);
    assert.equal((await request('/api/faces/invalid', 'admin', 'DELETE')).status, 400);
  });
});
