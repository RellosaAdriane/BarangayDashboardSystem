const schemas = require('./database/runtime-schemas');

module.exports = function registerCameraAlerts(app, pool, requireAuth, allow) {
  let schemaReady;
  const ensureSchema = () => {
    schemaReady ||= pool.query(schemas.cameraAlerts + '\n' + schemas.reportNotifications)
      .catch((error) => { schemaReady = null; throw error; });
    return schemaReady;
  };
  const handle = (fn) => async (req, res) => {
    try { await ensureSchema(); await fn(req, res); }
    catch (error) { console.error('Camera alert:', error.message); if (!res.headersSent) res.status(503).json({ error: 'Unable to save or load camera alerts. Please try again.' }); }
  };
  const validId = (id) => /^[1-9]\d{0,15}$/.test(String(id));
  const reportDetails = `SELECT a.id, a.camera_id AS "cameraId", c.name AS "cameraName", c.location,
    a.detected_at AS "detectedAt", a.face_count AS "faceCount", a.status,
    a.reviewed_at AS "reviewedAt", a.review_note AS "reviewNote", u.full_name AS "reviewedBy",
    a.actioned_at AS "actionedAt", a.action_note AS "actionNote", actor.full_name AS "actionedBy"
    FROM camera_alerts a JOIN cameras c ON c.id = a.camera_id
    LEFT JOIN users u ON u.id = a.reviewed_by LEFT JOIN users actor ON actor.id = a.actioned_by
    WHERE a.id = $1 AND a.status = 'report'`;

  app.get('/api/alerts/:id/report', requireAuth, handle(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid report ID.' });
    const { rows } = await pool.query(reportDetails + (req.session.user.role === 'tanod' ? ' AND a.actioned_at IS NULL' : ''), [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Report not found.' });
    res.set('Cache-Control', 'private, no-store').json(rows[0]);
  }));
  app.patch('/api/alerts/:id/action', allow('tanod', 'captain', 'admin'), handle(async (req, res) => {
    const note = req.body?.note;
    if (!validId(req.params.id) || typeof note !== 'string' || !note.trim() || note.length > 1000) return res.status(400).json({ error: 'Describe the action taken (1 to 1,000 characters).' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query(`UPDATE camera_alerts SET actioned_by = $1, actioned_at = NOW(), action_note = $2
        WHERE id = $3 AND status = 'report' AND actioned_at IS NULL`, [req.session.user.id, note.trim(), req.params.id]);
      if (!result.rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This report is already actioned or is no longer available. Refresh reports.' }); }
      await client.query('INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address) VALUES ($1, $2, $3, $4, $5, $6)',
        [req.session.user.id, 'actioned', 'camera_alert', req.params.id, JSON.stringify({ note: note.trim() }), req.ip]);
      const { rows } = await client.query(reportDetails, [req.params.id]);
      await client.query('COMMIT');
      res.json({ ok: true, alert: rows[0] });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }));

  app.get('/api/report-notifications', allow('tanod', 'captain'), handle(async (req, res) => {
    const { rows: [counts] } = await pool.query(`SELECT COUNT(*) AS unread FROM report_notifications n
      JOIN camera_alerts a ON a.id = n.alert_id
      WHERE n.user_id = $1 AND n.read_at IS NULL AND a.actioned_at IS NULL`, [req.session.user.id]);
    const { rows } = await pool.query(`SELECT a.id, n.id AS "notificationId", n.read_at AS "readAt", n.created_at AS "notifiedAt",
      a.camera_id AS "cameraId", c.name AS "cameraName", c.location, a.detected_at AS "detectedAt",
      a.face_count AS "faceCount", a.status, a.reviewed_at AS "reviewedAt", a.review_note AS "reviewNote", u.full_name AS "reviewedBy",
      a.actioned_at AS "actionedAt", a.action_note AS "actionNote", actor.full_name AS "actionedBy"
      FROM report_notifications n JOIN camera_alerts a ON a.id = n.alert_id
      JOIN cameras c ON c.id = a.camera_id LEFT JOIN users u ON u.id = a.reviewed_by
      LEFT JOIN users actor ON actor.id = a.actioned_by
      WHERE n.user_id = $1 AND a.actioned_at IS NULL ORDER BY (n.read_at IS NULL) DESC, n.created_at DESC, n.id DESC LIMIT 20`, [req.session.user.id]);
    res.set('Cache-Control', 'private, no-store').json({ unread: Number(counts.unread), notifications: rows });
  }));
  app.patch('/api/report-notifications/:id/read', allow('tanod', 'captain'), handle(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid notification ID.' });
    const { rowCount } = await pool.query('UPDATE report_notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = $1 AND user_id = $2', [req.params.id, req.session.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'Notification not found.' });
    res.json({ ok: true });
  }));

  app.get('/api/alerts', requireAuth, handle(async (req, res) => {
    const view = req.query.view || (req.session.user.role === 'tanod' ? 'reports' : 'pending');
    if (req.session.user.role === 'tanod' && view !== 'reports') return res.status(403).json({ error: 'Tanod accounts can only view Reports.' });
    if (view === 'archived' && req.session.user.role === 'captain') return res.status(403).json({ error: 'Archive is unavailable for Captain accounts.' });
    const offset = Number(req.query.offset || 0);
    if (!['pending', 'archived', 'reports'].includes(view) || !/^\d+$/.test(String(req.query.offset || 0)) || !Number.isSafeInteger(offset) || offset < 0) {
      return res.status(400).json({ error: 'Choose Pending, Archive or Reports and a valid page.' });
    }
    // Reports stay active until actioned; the action timestamp archives them
    // automatically without changing the original review or snapshot.
    const statuses = view === 'archived' ? ['approved', 'dismissed', 'recognized', 'unrecognized', 'report'] : view === 'reports' ? ['report'] : ['pending'];
    const { rows } = await pool.query(`SELECT a.id, a.camera_id AS "cameraId", c.name AS "cameraName", c.location,
      a.detected_at AS "detectedAt", a.face_count AS "faceCount", a.status,
      a.reviewed_at AS "reviewedAt", a.review_note AS "reviewNote", u.full_name AS "reviewedBy",
      a.actioned_at AS "actionedAt", a.action_note AS "actionNote", actor.full_name AS "actionedBy"
      FROM camera_alerts a JOIN cameras c ON c.id = a.camera_id
      LEFT JOIN users u ON u.id = a.reviewed_by
      LEFT JOIN users actor ON actor.id = a.actioned_by
      WHERE a.status = ANY($1::text[])
      ${view === 'reports' ? 'AND a.actioned_at IS NULL' : view === 'archived' ? "AND (a.status <> 'report' OR a.actioned_at IS NOT NULL)" : ''}
      ORDER BY a.detected_at DESC, a.id DESC LIMIT 21 OFFSET $2`, [statuses, offset]);
    res.set('Cache-Control', 'no-store').json(rows);
  }));
  app.get('/api/alerts/:id/snapshot', requireAuth, handle(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid alert ID.' });
    const restriction = req.session.user.role === 'tanod' ? " AND status = 'report' AND actioned_at IS NULL" : '';
    const { rows } = await pool.query('SELECT snapshot FROM camera_alerts WHERE id = $1' + restriction, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Snapshot not found.' });
    res.set('Cache-Control', 'private, no-store').set('X-Content-Type-Options', 'nosniff').type('image/jpeg').send(rows[0].snapshot);
  }));
  app.post('/api/alerts', requireAuth, handle(async (req, res) => {
    const { cameraId, snapshot, faceCount } = req.body || {};
    if (!validId(cameraId) || !Number.isInteger(faceCount) || faceCount < 1 || faceCount > 50 || typeof snapshot !== 'string' || !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(snapshot)) {
      return res.status(400).json({ error: 'Send a saved camera, face count, and JPEG snapshot.' });
    }
    const picture = Buffer.from(snapshot.split(',')[1], 'base64');
    if (picture.length > 409600) return res.status(413).json({ error: 'Snapshot must be 400 KB or smaller.' });
    if (picture.length < 4 || picture[0] !== 0xff || picture[1] !== 0xd8 || picture[picture.length - 2] !== 0xff || picture[picture.length - 1] !== 0xd9) return res.status(400).json({ error: 'Invalid JPEG snapshot.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize submissions from viewers watching the same camera.
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`camera-alert:${cameraId}`]);
      const camera = await client.query('SELECT id FROM cameras WHERE id = $1 AND is_enabled = true AND is_archived = false', [cameraId]);
      if (!camera.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Camera is not available.' }); }
      const recent = await client.query("SELECT id FROM camera_alerts WHERE camera_id = $1 AND detected_at > NOW() - INTERVAL '60 seconds' LIMIT 1", [cameraId]);
      if (recent.rowCount) { await client.query('COMMIT'); return res.json({ id: recent.rows[0].id, duplicate: true }); }
      const { rows } = await client.query('INSERT INTO camera_alerts (camera_id, created_by, face_count, snapshot) VALUES ($1, $2, $3, $4) RETURNING id', [cameraId, req.session.user.id, faceCount, picture]);
      await client.query('COMMIT');
      res.status(201).json({ id: rows[0].id });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }));
  app.patch('/api/alerts/:id/review', allow('captain', 'admin'), handle(async (req, res) => {
    const { status, note = '' } = req.body || {};
    if (!validId(req.params.id) || !['approved', 'dismissed', 'recognized', 'unrecognized', 'report'].includes(status) || typeof note !== 'string' || note.length > 1000) return res.status(400).json({ error: 'Choose Recognized, Unrecognized or Report and keep notes within 1,000 characters.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(`UPDATE camera_alerts SET status = $1, review_note = $2, reviewed_by = $3, reviewed_at = NOW()
        WHERE id = $4 AND status = 'pending'`, [status, note.trim(), req.session.user.id, req.params.id]);
      if (!rowCount) { await client.query('ROLLBACK'); return res.status(409).json({ error: 'This alert has already been reviewed or no longer exists. Refresh alerts.' }); }
      let notified = 0;
      if (status === 'report') {
        const result = await client.query(`INSERT INTO report_notifications (alert_id, user_id)
          SELECT $1, id FROM users WHERE role IN ('tanod', 'captain') AND is_active = true AND approval_status = 'approved'
          ON CONFLICT (alert_id, user_id) DO NOTHING`, [req.params.id]);
        notified = result.rowCount;
      }
      await client.query('COMMIT');
      res.json({ ok: true, notified });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }));
  return ensureSchema;
};
