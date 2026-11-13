const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const express = require('express');
const register = require('../device-recordings');
const fixture = require('./helpers/avi-fixture');

test('device recordings bind camera identity, verify R2 objects, retry idempotently, and protect playback', async (t) => {
  let tokenHash, pending, completed, object, source, signed = 0;
  const bytes = fixture(300);
  const pool = { query: async (sql, args = []) => {
    if (sql.startsWith('CREATE')) return { rows: [] };
    if (sql.startsWith('SELECT id FROM cameras')) return { rows: args[0] === '1' ? [{ id: '1' }] : [] };
    if (sql.includes('INSERT INTO camera_device_tokens')) { tokenHash = args[1]; return { rows: [] }; }
    if (sql.includes('DELETE FROM camera_device_tokens')) { tokenHash = null; return { rows: [] }; }
    if (sql.includes('SELECT t.token_hash')) return { rows: tokenHash && args[0] === '1' ? [{ token_hash: tokenHash }] : [] };
    if (sql.includes('SELECT id FROM camera_recordings')) return { rows: completed ? [{ id: '9' }] : [] };
    if (sql.includes('INSERT INTO device_recording_uploads')) { pending ||= { camera_id: args[0], recording_id: args[1], storage_path: args[2], file_name: args[3], started_at: args[4], ended_at: args[5], file_size_bytes: args[6] }; return { rows: [pending] }; }
    if (sql.includes('SELECT * FROM device_recording_uploads')) return { rows: pending ? [pending] : [] };
    if (sql.includes('INSERT INTO camera_recordings')) { assert.equal(args[0], '1'); assert.equal(args[7], pending.recording_id); completed = true; source = { storage_provider: 'r2', storage_path: args[6], file_name: args[1], file_size_bytes: args[5] }; return { rows: [{ id: '9' }] }; }
    if (sql.includes('SELECT r.*')) return { rows: source ? [source] : [] };
    throw new Error(`Unexpected test SQL: ${sql}`);
  } };
  const storage = {
    head: async () => { if (!object) { const error = new Error('Missing'); error.name = 'NotFound'; throw error; } return object; },
    header: async () => bytes.subarray(0, 224),
    uploadUrl: async (_key, size) => { assert.equal(size, bytes.length); signed++; return 'https://r2.invalid/signed-put'; },
    videoUrl: async (key) => { assert.equal(key, pending.storage_path); return 'https://r2.invalid/signed-get'; }
  };
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { req.session = { user: req.headers['x-role'] ? { role: req.headers['x-role'] } : null }; next(); });
  const auth = (req, res, next) => req.session.user ? next() : res.sendStatus(401);
  const allow = (...roles) => (req, res, next) => !req.session.user ? res.sendStatus(401) : roles.includes(req.session.user.role) ? next() : res.sendStatus(403);
  register(app, pool, auth, allow, storage);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = (route, method = 'GET', body, headers = {}) => fetch(`http://127.0.0.1:${server.address().port}${route}`, { method, headers: { 'Content-Type': 'application/json', ...headers }, body: body && JSON.stringify(body) });
  assert.equal((await request('/api/cameras/1/device-token', 'POST')).status, 401);
  assert.equal((await request('/api/cameras/1/device-token', 'POST', null, { 'x-role': 'tanod' })).status, 403);
  const created = await request('/api/cameras/1/device-token', 'POST', null, { 'x-role': 'admin' });
  const { token } = await created.json(); assert.match(created.headers.get('cache-control'), /no-store/);
  assert.notEqual(tokenHash, token); assert.equal(tokenHash, crypto.createHash('sha256').update(token).digest('hex'));
  const device = { Authorization: `Bearer ${token}` };
  const body = { cameraId: 999, recordingId: 'a'.repeat(32), startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z', fileSize: bytes.length };
  const upload = '/api/device/recordings/upload-url', complete = '/api/device/recordings/complete';
  assert.equal((await request(upload, 'POST', body)).status, 401);
  assert.equal((await request(upload, 'POST', body, { Authorization: `Bearer ${token.replace('bwcam_1_', 'bwcam_2_')}` })).status, 401);
  for (const changes of [{ fileSize: 100 }, { fileSize: 65 * 1048576 }, { endedAt: '2026-01-01T01:00:00Z' }, { recordingId: '../evil' }, { recordingId: ['a'.repeat(32)] }, { startedAt: '2026-01-01T00:00:00' }]) {
    assert.equal((await request(upload, 'POST', { ...body, ...changes }, device)).status, 400);
  }
  const prepared = await request(upload, 'POST', body, device); assert.equal(prepared.status, 200);
  assert.equal((await prepared.json()).uploadUrl, 'https://r2.invalid/signed-put'); assert.equal(pending.camera_id, '1');
  assert.equal((await request(upload, 'POST', { ...body, fileSize: bytes.length + 1 }, device)).status, 409);
  assert.equal((await request(complete, 'POST', body, device)).status, 409);
  object = { ContentLength: bytes.length - 1, ContentType: 'video/x-msvideo' };
  assert.equal((await request(complete, 'POST', body, device)).status, 409);
  object.ContentLength = bytes.length;
  assert.equal((await (await request(upload, 'POST', body, device)).json()).uploaded, true); assert.equal(signed, 1);
  assert.equal((await request(complete, 'POST', body, device)).status, 201);
  assert.equal((await request(complete, 'POST', body, device)).status, 200);
  assert.equal((await (await request(upload, 'POST', body, device)).json()).complete, true);
  assert.equal((await request('/api/recordings/9/source')).status, 401);
  const playback = await request('/api/recordings/9/source', 'GET', null, { 'x-role': 'tanod' });
  assert.equal((await playback.json()).format, 'mjpeg-avi'); assert.match(playback.headers.get('cache-control'), /no-store/);
  source = { id: '10', storage_provider: 'supabase' };
  assert.deepEqual(await (await request('/api/recordings/10/source', 'GET', null, { 'x-role': 'captain' })).json(), { format: 'video', url: '/api/recordings/10/video' });
  source = null; assert.equal((await request('/api/recordings/9/source', 'GET', null, { 'x-role': 'admin' })).status, 404);
  await request('/api/cameras/1/device-token', 'DELETE', null, { 'x-role': 'admin' });
  assert.equal((await request(upload, 'POST', body, device)).status, 401);
});

test('R2 signer requires configuration and signs immutable, size-bound upload requests', async () => {
  const create = require('../r2-storage');
  assert.throws(() => create({}).uploadUrl('test', 10), /Configure R2/);
  const r2 = create({ R2_ACCOUNT_ID: 'example', R2_ACCESS_KEY_ID: 'example-key', R2_SECRET_ACCESS_KEY: 'example-secret', R2_BUCKET: 'recordings' });
  const url = new URL(await r2.uploadUrl('recordings/1/test.avi', 1024));
  assert.equal(url.hostname, 'example.r2.cloudflarestorage.com');
  assert.match(url.searchParams.get('X-Amz-SignedHeaders'), /content-length/);
  assert.match(url.searchParams.get('X-Amz-SignedHeaders'), /content-type/);
  assert.match(url.searchParams.get('X-Amz-SignedHeaders'), /if-none-match/);
});
