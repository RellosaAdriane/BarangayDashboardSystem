// Optional PostgreSQL integration: node tests/device-recordings.database.cjs <path-to-@electric-sql/pglite>
const assert = require('node:assert/strict');
const express = require('express');
const { PGlite } = require(process.argv[2] || '@electric-sql/pglite');
const schema = require('../database/runtime-schemas').deviceRecordings;
const fixture = require('./helpers/avi-fixture');
const register = require('../device-recordings');

(async () => {
  const db = new PGlite(); let server;
  try {
    await db.exec(`CREATE TABLE cameras (id bigint PRIMARY KEY, name text, is_enabled boolean DEFAULT true, is_archived boolean DEFAULT false);
      INSERT INTO cameras (id,name) VALUES (1,'Test camera');`);
    await db.exec(schema); await db.exec(schema);
    // A legacy recording must survive migration and keep its provider.
    await db.query("INSERT INTO camera_recordings(camera_id,file_name,started_at,ended_at,duration_seconds,file_size_bytes,storage_path) VALUES(1,'legacy.mp4','2026-01-01','2026-01-01 00:01',60,100,'legacy/path')");
    await db.exec(schema);
    assert.equal((await db.query("SELECT storage_provider FROM camera_recordings WHERE file_name='legacy.mp4'")).rows[0].storage_provider, 'supabase');
    const pool = { query: (sql, args) => sql.startsWith('CREATE') ? db.exec(sql).then(() => ({ rows: [] })) : db.query(sql, args) };
    const bytes = fixture(300);
    let uploaded = false;
    const storage = {
      head: async () => { if (!uploaded) { const e = new Error(); e.name = 'NotFound'; throw e; } return { ContentLength: bytes.length, ContentType: 'video/x-msvideo' }; },
      header: async () => bytes.subarray(0, 224), uploadUrl: async () => 'https://r2.invalid/upload', videoUrl: async () => 'https://r2.invalid/read'
    };
    const app = express(); app.use(express.json());
    app.use((req, _res, next) => { req.session = { user: { role: 'admin' } }; next(); });
    register(app, pool, (_req, _res, next) => next(), () => (_req, _res, next) => next(), storage);
    server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
    const request = async (route, body, token) => {
      const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body || {}) });
      const data = await response.json(); assert.ok(response.ok, JSON.stringify(data)); return data;
    };
    const { token } = await request('/api/cameras/1/device-token');
    const data = { recordingId: 'b'.repeat(32), startedAt: '2026-01-01T00:00:00Z', endedAt: '2026-01-01T00:01:00Z', fileSize: bytes.length };
    await request('/api/device/recordings/upload-url', data, token);
    uploaded = true;
    const complete = await request('/api/device/recordings/complete', data, token);
    assert.equal((await request('/api/device/recordings/complete', data, token)).id, complete.id);
    assert.equal((await request('/api/device/recordings/upload-url', data, token)).complete, true);
    const rows = await db.query("SELECT storage_provider,device_recording_id,started_at FROM camera_recordings WHERE storage_provider='r2'");
    assert.equal(rows.rows.length, 1); assert.equal(rows.rows[0].device_recording_id, data.recordingId);
    const filtered = await db.query(`SELECT to_char(started_at,'YYYY-MM-DD"T"HH24:MI:SS') || 'Z' AS stamp FROM camera_recordings r
      WHERE storage_provider='r2' AND (r.ended_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila') >= $1`, ['2026-01-01 08:00:00']);
    assert.equal(filtered.rows[0].stamp, data.startedAt);
    console.log('PASS: actual PostgreSQL migration replay, legacy rows, camera tokens, signed upload flow, idempotent completion and Philippine-time filtering.');
  } finally { if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); } await db.close(); }
})().catch((error) => { console.error(error); process.exitCode = 1; });
