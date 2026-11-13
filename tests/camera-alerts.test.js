const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const registerAlerts = require('../camera-alerts');

test('snapshot alerts enforce authentication, review roles, deduplication and one review', async (t) => {
  const records = [];
  const notifications = [];
  let transaction;
  let failDelivery = false;
  let failActionAudit = false;
  let released = 0;
  const query = async (sql, params = []) => {
    if (sql.startsWith('CREATE') || sql === 'COMMIT' || sql.includes('pg_advisory')) return {};
    if (sql === 'BEGIN') { transaction = { records: records.map((row) => ({ ...row })), notifications: notifications.map((row) => ({ ...row })) }; return {}; }
    if (sql === 'ROLLBACK') { records.splice(0, records.length, ...transaction.records); notifications.splice(0, notifications.length, ...transaction.notifications); return {}; }
    if (sql.startsWith('INSERT INTO report_notifications')) {
      assert.match(sql, /role IN \('tanod', 'captain'\) AND is_active = true AND approval_status = 'approved'/);
      assert.match(sql, /ON CONFLICT \(alert_id, user_id\) DO NOTHING/);
      if (failDelivery) throw new Error('Notification insert failed');
      for (const userId of [7, 8]) notifications.push({ notificationId: String(notifications.length + 1), id: params[0], userId, readAt: null });
      return { rowCount: 2 };
    }
    if (sql.startsWith('SELECT COUNT(*) AS unread FROM report_notifications')) {
      assert.match(sql, /a.actioned_at IS NULL/);
      return { rows: [{ unread: notifications.filter((row) => row.userId === params[0] && !row.readAt && !records.find((record) => record.id === row.id)?.actionedAt).length }] };
    }
    if (sql.includes('FROM report_notifications n JOIN')) {
      assert.match(sql, /a.actioned_at IS NULL/);
      return { rows: notifications.filter((row) => row.userId === params[0] && !records.find((record) => record.id === row.id)?.actionedAt).map((row) => ({ ...row, cameraName: 'CAM 01' })) };
    }
    if (sql.startsWith('INSERT INTO audit_logs')) {
      if (failActionAudit) throw new Error('Action audit failed');
      assert.equal(params[1], 'actioned');
      return {};
    }
    if (sql.startsWith('UPDATE camera_alerts SET actioned_by')) {
      const row = records.find((row) => row.id === params[2] && row.status === 'report' && !row.actionedAt);
      if (!row) return { rowCount: 0 };
      row.actionedAt = new Date().toISOString(); row.actionedBy = `User ${params[0]}`; row.actionNote = params[1];
      return { rowCount: 1 };
    }
    if (sql.startsWith('UPDATE report_notifications')) {
      const row = notifications.find((row) => row.notificationId === params[0] && row.userId === params[1]);
      if (!row) return { rowCount: 0 };
      row.readAt ||= new Date().toISOString();
      return { rowCount: 1 };
    }
    if (sql.startsWith('SELECT id FROM cameras')) return { rowCount: params[0] === 1 ? 1 : 0 };
    if (sql.includes("INTERVAL '60 seconds'")) return { rowCount: records.length, rows: records };
    if (sql.startsWith('INSERT INTO camera_alerts')) { records.push({ id: '1', status: 'pending', snapshot: params[3] }); return { rows: records }; }
    if (sql.startsWith('UPDATE')) {
      const record = records.find((row) => row.id === params[3] && row.status === 'pending');
      if (!record) return { rowCount: 0 };
      record.status = params[0]; record.reviewedBy = params[2]; return { rowCount: 1 };
    }
    if (sql.startsWith('SELECT snapshot')) return { rows: records.filter((row) => row.id === params[0] && (!sql.includes("status = 'report'") || row.status === 'report' && !row.actionedAt)) };
    if (sql.includes("WHERE a.id = $1 AND a.status = 'report'")) return { rows: records.filter((row) => row.id === params[0] && row.status === 'report' && (!sql.includes('AND a.actioned_at IS NULL') || !row.actionedAt)).map(({ snapshot, ...row }) => row) };
    if (sql.includes('WHERE a.status = ANY($1::text[])')) {
      assert.match(sql, /ORDER BY a.detected_at DESC, a.id DESC LIMIT 21 OFFSET \$2/);
      return { rows: records.filter((row) => params[0].includes(row.status)
        && (!sql.includes('AND a.actioned_at IS NULL') || !row.actionedAt)
        && (!sql.includes('a.actioned_at IS NOT NULL') || row.status !== 'report' || row.actionedAt))
        .slice(params[1], params[1] + 21).map(({ snapshot, ...row }) => row) };
    }
    return { rows: records.map(({ snapshot, ...row }) => row) };
  };
  const pool = { query, connect: async () => ({ query, release() { released++; } }) };
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { req.session = req.headers['x-test-role'] ? { user: { role: req.headers['x-test-role'], id: Number(req.headers['x-test-user'] || 7) } } : {}; next(); });
  const auth = (req, res, next) => req.session.user ? next() : res.sendStatus(401);
  const allow = (...roles) => (req, res, next) => !req.session.user ? res.sendStatus(401) : roles.includes(req.session.user.role) ? next() : res.sendStatus(403);
  registerAlerts(app, pool, auth, allow);
  const server = await new Promise((resolve) => { const server = app.listen(0, '127.0.0.1', () => resolve(server)); });
  t.after(() => { server.closeAllConnections(); server.close(); });
  const request = (path, role, method = 'GET', body, userId = 7) => fetch(`http://127.0.0.1:${server.address().port}${path}`, {
    method, headers: { ...(role ? { 'x-test-role': role, 'x-test-user': String(userId) } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined
  });
  const snapshot = `data:image/jpeg;base64,${Buffer.from([255, 216, 255, 217]).toString('base64')}`;
  await t.test('anonymous users cannot read alerts or snapshots', async () => {
    assert.equal((await request('/api/alerts')).status, 401);
    assert.equal((await request('/api/alerts?view=archived')).status, 401);
    assert.equal((await request('/api/alerts/1/snapshot')).status, 401);
  });
  await t.test('invalid snapshot and unavailable camera are rejected', async () => {
    assert.equal((await request('/api/alerts', 'tanod', 'POST', { cameraId: 1, faceCount: 1, snapshot: 'bad' })).status, 400);
    assert.equal((await request('/api/alerts', 'tanod', 'POST', { cameraId: 2, faceCount: 1, snapshot })).status, 404);
  });
  await t.test('capture saves snapshot, suppresses duplicates and releases clients', async () => {
    const capture = { cameraId: 1, faceCount: 1, snapshot };
    assert.equal((await request('/api/alerts', 'tanod', 'POST', capture)).status, 201);
    assert.equal((await (await request('/api/alerts', 'tanod', 'POST', capture)).json()).duplicate, true);
    assert.equal(records.length, 1);
    assert.equal(released, 3);
    const image = await request('/api/alerts/1/snapshot', 'captain');
    assert.equal(image.headers.get('content-type'), 'image/jpeg');
    assert.equal((await image.arrayBuffer()).byteLength, 4);
  });
  await t.test('only captain or admin may review; approval does not register an identity', async () => {
    assert.equal((await request('/api/alerts/1/review', 'tanod', 'PATCH', { status: 'approved' })).status, 403);
    assert.equal((await request('/api/alerts/1/review', 'captain', 'PATCH', { status: 'invalid' })).status, 400);
    assert.equal((await request('/api/alerts/1/review', 'captain', 'PATCH', { status: 'approved', note: 'Reviewed' })).status, 200);
    assert.equal(records[0].status, 'approved');
    assert.equal(records[0].reviewedBy, 7);
    assert.equal((await request('/api/alerts/1/review', 'admin', 'PATCH', { status: 'dismissed' })).status, 409);
  });
  await t.test('approved and dismissed snapshots automatically leave Pending and remain readable in Archive', async () => {
    records.push({ id: '2', status: 'pending', snapshot: Buffer.from([255, 216, 255, 217]) });
    assert.deepEqual((await (await request('/api/alerts', 'captain')).json()).map((row) => row.id), ['2']);
    assert.equal((await request('/api/alerts/2/review', 'admin', 'PATCH', { status: 'dismissed' })).status, 200);
    assert.deepEqual(await (await request('/api/alerts', 'captain')).json(), []);
    const archive = await (await request('/api/alerts?view=archived', 'admin')).json();
    assert.deepEqual(archive.map((row) => row.status), ['approved', 'dismissed']);
    assert.ok(archive.every((row) => row.reviewedBy === 7));
    assert.ok(archive.every((row) => !Object.hasOwn(row, 'snapshot')));
    assert.equal((await request('/api/alerts/2/snapshot', 'admin')).headers.get('content-type'), 'image/jpeg');
  });
  await t.test('pending and archive pages do not mix and pages retain older snapshots', async () => {
    for (let id = 3; id <= 47; id++) records.push({ id: String(id), status: 'pending', snapshot: Buffer.from([255, 216, 255, 217]) });
    const first = await (await request('/api/alerts?view=pending&offset=0', 'admin')).json();
    const second = await (await request('/api/alerts?view=pending&offset=20', 'admin')).json();
    const last = await (await request('/api/alerts?view=pending&offset=40', 'admin')).json();
    assert.equal(first.length, 21); // Extra row tells the browser another page exists.
    assert.equal(second.length, 21);
    assert.equal(last.length, 5);
    assert.equal(new Set([...first.slice(0, 20), ...second.slice(0, 20), ...last].map((row) => row.id)).size, 45);
    assert.ok([...first, ...second, ...last].every((row) => row.status === 'pending'));
    assert.equal((await (await request('/api/alerts?view=archived', 'admin')).json()).length, 2);
  });
  await t.test('invalid archive views and offsets are rejected', async () => {
    for (const query of ['view=all', 'offset=-1', 'offset=1.5', 'offset=abc', 'offset=9007199254740992']) {
      assert.equal((await request(`/api/alerts?${query}`, 'admin')).status, 400, query);
    }
  });
  await t.test('Captain cannot access Archive but can still access Pending and Reports', async () => {
    assert.equal((await request('/api/alerts?view=archived', 'captain')).status, 403);
    assert.equal((await request('/api/alerts?view=pending', 'captain')).status, 200);
    assert.equal((await request('/api/alerts?view=reports', 'captain')).status, 200);
    assert.equal((await request('/api/alerts?view=archived', 'admin')).status, 200);
  });
  await t.test('recognized, unrecognized and report reviews archive snapshots and Reports filters only reports', async () => {
    for (const [index, status] of ['recognized', 'unrecognized', 'report'].entries()) {
      const id = String(100 + index);
      records.push({ id, status: 'pending', snapshot: Buffer.from([255, 216, 255, 217]) });
      assert.equal((await request(`/api/alerts/${id}/review`, 'tanod', 'PATCH', { status })).status, 403);
      assert.equal((await request(`/api/alerts/${id}/review`, 'admin', 'PATCH', { status, note: 'Checked' })).status, 200);
      assert.equal((await request(`/api/alerts/${id}/review`, 'captain', 'PATCH', { status })).status, 409);
    }
    const archive = await (await request('/api/alerts?view=archived', 'admin')).json();
    assert.deepEqual(archive.map((row) => row.status), ['approved', 'dismissed', 'recognized', 'unrecognized']);
    const reports = await (await request('/api/alerts?view=reports', 'captain')).json();
    assert.deepEqual(reports.map((row) => row.id), ['102']);
    const tanodReports = await (await request('/api/alerts', 'tanod')).json();
    assert.deepEqual(tanodReports.map((row) => row.id), ['102']);
    assert.equal((await request('/api/alerts?view=pending', 'tanod')).status, 403);
    assert.equal((await request('/api/alerts?view=archived', 'tanod')).status, 403);
    assert.equal((await request('/api/alerts/102/snapshot', 'tanod')).status, 200);
    assert.equal((await request('/api/alerts/3/snapshot', 'tanod')).status, 404);
    assert.equal((await request('/api/alerts/1/snapshot', 'tanod')).status, 404);
    assert.equal(notifications.length, 2);
    assert.ok(notifications.every((row) => row.id === '102'));
  });
  await t.test('report review and recipient notifications commit together; failed delivery can be retried', async () => {
    records.push({ id: '1000', status: 'pending', snapshot: Buffer.from([255, 216, 255, 217]) });
    failDelivery = true;
    assert.equal((await request('/api/alerts/1000/review', 'admin', 'PATCH', { status: 'report' })).status, 503);
    assert.equal(records.find((row) => row.id === '1000').status, 'pending');
    assert.equal(notifications.length, 2);
    failDelivery = false;
    const result = await request('/api/alerts/1000/review', 'captain', 'PATCH', { status: 'report' });
    assert.equal(result.status, 200);
    assert.equal((await result.json()).notified, 2);
    assert.equal((await request('/api/alerts/1000/review', 'admin', 'PATCH', { status: 'report' })).status, 409);
    assert.equal(notifications.length, 4);
  });
  await t.test('notification inbox and read acknowledgement are private to the recipient', async () => {
    assert.equal((await request('/api/report-notifications')).status, 401);
    assert.equal((await request('/api/report-notifications', 'admin')).status, 403);
    const tanod = await request('/api/report-notifications', 'tanod');
    assert.match(tanod.headers.get('cache-control'), /no-store/);
    const inbox = await tanod.json();
    assert.equal(inbox.unread, 2);
    assert.ok(inbox.notifications.every((row) => row.userId === 7));
    const id = inbox.notifications[0].notificationId;
    assert.equal((await request(`/api/report-notifications/${id}/read`, 'captain', 'PATCH', undefined, 8)).status, 404);
    assert.equal((await request(`/api/report-notifications/${id}/read`, 'tanod', 'PATCH')).status, 200);
    assert.equal((await request(`/api/report-notifications/${id}/read`, 'tanod', 'PATCH')).status, 200);
    assert.equal((await (await request('/api/report-notifications', 'tanod')).json()).unread, 1);
    assert.equal((await (await request('/api/report-notifications', 'captain', 'GET', undefined, 8)).json()).unread, 2);
  });
  await t.test('report action starts pending and records the Tanod actor, action notes and timestamp once', async () => {
    const before = await (await request('/api/alerts/102/report', 'captain')).json();
    assert.equal(before.actionedAt, undefined);
    assert.equal((await request('/api/alerts/102/action', null, 'PATCH', { note: 'Checked location' })).status, 401);
    assert.equal((await request('/api/alerts/102/action', 'tanod', 'PATCH', { note: '  ' })).status, 400);
    assert.equal((await request('/api/alerts/102/action', 'tanod', 'PATCH', { note: 'x'.repeat(1001) })).status, 400);
    const result = await request('/api/alerts/102/action', 'tanod', 'PATCH', { note: '  Checked location; situation resolved.  ' });
    assert.equal(result.status, 200);
    const { alert } = await result.json();
    assert.equal(alert.actionedBy, 'User 7');
    assert.ok(alert.actionedAt);
    assert.equal(alert.actionNote, 'Checked location; situation resolved.');
    assert.equal((await request('/api/alerts/102/action', 'captain', 'PATCH', { note: 'Overwrite' })).status, 409);
    assert.equal((await request('/api/alerts/100/action', 'admin', 'PATCH', { note: 'Not a report' })).status, 409);
    const inbox = await (await request('/api/report-notifications', 'captain', 'GET', undefined, 8)).json();
    assert.equal(inbox.notifications.some((row) => row.id === '102'), false);
    assert.equal(inbox.unread, 1);
    assert.equal((await (await request('/api/alerts?view=reports', 'captain')).json()).some((row) => row.id === '102'), false);
    const archived = await (await request('/api/alerts?view=archived', 'admin')).json();
    assert.ok(archived.find((row) => row.id === '102').actionedAt);
    assert.equal(archived.some((row) => row.id === '1000'), false);
  });
  await t.test('failed action audit rolls back; Captain can retry and Admin can also record an action', async () => {
    failActionAudit = true;
    assert.equal((await request('/api/alerts/1000/action', 'captain', 'PATCH', { note: 'Responded' }, 8)).status, 503);
    assert.equal(records.find((row) => row.id === '1000').actionedAt, undefined);
    failActionAudit = false;
    assert.equal((await request('/api/alerts/1000/action', 'captain', 'PATCH', { note: 'Responded' }, 8)).status, 200);
    records.push({ id: '2000', status: 'report' });
    assert.equal((await request('/api/alerts/2000/action', 'admin', 'PATCH', { note: 'Follow-up completed' })).status, 200);
    assert.equal((await request('/api/alerts/3/report', 'captain')).status, 404);
    assert.equal((await request('/api/alerts/invalid/action', 'tanod', 'PATCH', { note: 'Test' })).status, 400);
  });
  await t.test('all actioned reports automatically appear only in Archive and leave the active inbox', async () => {
    assert.deepEqual(await (await request('/api/alerts?view=reports', 'captain')).json(), []);
    const archived = await (await request('/api/alerts?view=archived', 'admin')).json();
    for (const id of ['102', '1000', '2000']) assert.ok(archived.find((row) => row.id === id)?.actionedAt);
    const inbox = await (await request('/api/report-notifications', 'captain', 'GET', undefined, 8)).json();
    assert.equal(inbox.unread, 0);
    assert.deepEqual(inbox.notifications, []);
    assert.equal((await request('/api/alerts?view=archived', 'captain')).status, 403);
    assert.equal((await request('/api/alerts/102/report', 'tanod')).status, 404);
    assert.equal((await request('/api/alerts/102/snapshot', 'tanod')).status, 404);
    assert.deepEqual(await (await request('/api/alerts', 'tanod')).json(), []);
  });
});
