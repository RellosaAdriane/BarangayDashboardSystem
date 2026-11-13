const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const root = path.resolve(__dirname, '..');

test('bundled runtime schemas match the SQL source files', () => {
  const schemas = require('../database/runtime-schemas');
  for (const [key, file] of Object.entries({ cameraAlerts: 'camera_alerts.sql', reportNotifications: 'report_notifications.sql', enrolledFaces: 'enrolled_faces.sql', announcementReads: 'announcement_reads.sql' })) {
    assert.equal(schemas[key], fs.readFileSync(path.join(root, 'database', file), 'utf8').replace(/\r\n/g, '\n'), file);
  }
});

test('alerts, notifications and face enrollment work from a server bundle with no SQL files', async (t) => {
  const prefix = path.join(__dirname, '.schema-bundle-');
  const bundle = fs.mkdtempSync(prefix);
  t.after(() => {
    const target = path.resolve(bundle);
    if (!target.startsWith(prefix)) throw new Error('Unexpected fixture directory');
    fs.rmSync(target, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(bundle, 'database'));
  fs.copyFileSync(path.join(root, 'database/runtime-schemas.js'), path.join(bundle, 'database/runtime-schemas.js'));
  for (const file of ['camera-alerts.js', 'face-management.js', 'announcement-notifications.js']) fs.copyFileSync(path.join(root, file), path.join(bundle, file));
  assert.equal(fs.existsSync(path.join(bundle, 'database/camera_alerts.sql')), false);
  const app = express();
  const pool = { query: async (sql) => sql.includes('AS unread') ? { rows: [{ unread: 0 }] } : { rows: [] } };
  app.use((req, _res, next) => { req.session = { user: { id: 1, role: req.headers['x-role'] || 'admin' } }; next(); });
  const auth = (_req, _res, next) => next();
  const allow = (...roles) => (req, res, next) => roles.includes(req.session.user.role) ? next() : res.sendStatus(403);
  require(path.join(bundle, 'camera-alerts.js'))(app, pool, auth, allow);
  require(path.join(bundle, 'face-management.js'))(app, pool, auth, allow);
  require(path.join(bundle, 'announcement-notifications.js'))(app, pool, allow);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  for (const [route, role] of [['/api/alerts', 'admin'], ['/api/report-notifications', 'captain'], ['/api/faces', 'admin'], ['/api/announcement-notifications', 'tanod']]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${route}`, { headers: { 'x-role': role } });
    assert.equal(response.status, 200, route);
  }
});
