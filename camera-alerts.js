const schemas = require('./database/runtime-schemas');
const crypto = require('node:crypto');

module.exports = function registerCameraAlerts(app, pool, requireAuth, allow) {
  const emailReviewSecret = () => process.env.EMAIL_REVIEW_SECRET || process.env.SESSION_SECRET || '';
  const reviewSignature = (alertId, decision, expires) => crypto.createHmac('sha256', emailReviewSecret())
    .update(`${alertId}:${decision}:${expires}`).digest('hex');
  const validEmailReview = (alertId, decision, expires, signature) => {
    if (!/^[1-9]\d{0,15}$/.test(String(alertId)) || !['recognized', 'unrecognized'].includes(decision)
      || !/^\d{13}$/.test(String(expires)) || Number(expires) < Date.now()
      || Number(expires) > Date.now() + 24 * 60 * 60 * 1000 || !/^[a-f0-9]{64}$/i.test(String(signature || ''))
      || !emailReviewSecret()) return false;
    const expected = Buffer.from(reviewSignature(alertId, decision, expires), 'hex');
    const supplied = Buffer.from(signature, 'hex');
    return expected.length === supplied.length && crypto.timingSafeEqual(expected, supplied);
  };
  const emailReviewPage = (title, message, actionUrl = '') => {
    const form = actionUrl ? `<form method="post" action="${safeHtml(actionUrl)}"><button type="submit" style="background:#185abc;color:#fff;padding:12px 20px;border:0;border-radius:6px;font-weight:bold;cursor:pointer">Confirm decision</button></form>` : '';
    return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${safeHtml(title)}</title><body style="font-family:Arial,sans-serif;background:#f5f7fa;color:#172033;margin:0;padding:32px"><main style="max-width:560px;margin:8vh auto;background:#fff;padding:28px;border:1px solid #dce3eb;border-radius:12px"><h1 style="font-size:22px">${safeHtml(title)}</h1><p>${safeHtml(message)}</p>${form}</main></body></html>`;
  };
  const safeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[character]));
  function emailReviewUrl(baseUrl, alertId, decision, expires) {
    const signature = reviewSignature(alertId, decision, expires);
    const url = new URL(`/api/alerts/${alertId}/email-review/${decision}`, baseUrl);
    url.searchParams.set('expires', String(expires));
    url.searchParams.set('signature', signature);
    return url.toString();
  }
  function appBaseUrl(req) {
    const configured = process.env.PUBLIC_APP_URL
      || (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : '')
      || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '')
      || `${req.protocol}://${req.get('host')}`;
    const url = new URL(configured);
    if (!['http:', 'https:'].includes(url.protocol)) throw new Error('PUBLIC_APP_URL must use HTTP or HTTPS.');
    return url.origin;
  }
  async function emailOwner(cameraName, cameraLocation, faceCount, detectedAt, snapshot, alertId, baseUrl) {
    const apiKey = process.env.RESEND_API_KEY;
    const recipient = process.env.CAMERA_ALERT_EMAIL;
    const sender = process.env.CAMERA_ALERT_FROM;
    if (!apiKey || !recipient || !sender) return false;
    const expires = Date.now() + 24 * 60 * 60 * 1000;
    const recognizeUrl = emailReviewUrl(baseUrl, alertId, 'recognized', expires);
    const unrecognizeUrl = emailReviewUrl(baseUrl, alertId, 'unrecognized', expires);
    const reviewLinks = `Recognize: ${recognizeUrl}\nUnrecognize: ${unrecognizeUrl}`;
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: sender,
        to: [recipient],
        subject: `Unknown person detected: ${cameraName}`,
        text: `The camera monitoring dashboard detected ${faceCount} face(s) that did not match an enrolled person.\n\nCamera: ${cameraName}\nLocation: ${cameraLocation || 'Not set'}\nDetected: ${new Date(detectedAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}\n\nChoose one option (links expire in 24 hours and can be used once):\n${reviewLinks}\n\nThis is an automated face match and may be inaccurate.`,
        html: `<div style="font-family:Arial,sans-serif;color:#172033;max-width:600px"><h2>Unknown person detected</h2><p>${faceCount} face(s) did not match an enrolled person.</p><p><strong>Camera:</strong> ${safeHtml(cameraName)}<br><strong>Location:</strong> ${safeHtml(cameraLocation || 'Not set')}<br><strong>Detected:</strong> ${safeHtml(new Date(detectedAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' }))}</p><p>Choose whether this person is recognized. The link expires in 24 hours and works once.</p><p><a href="${recognizeUrl}" style="display:inline-block;background:#16803c;color:#fff;padding:12px 20px;margin-right:8px;border-radius:6px;text-decoration:none;font-weight:bold">Recognize</a><a href="${unrecognizeUrl}" style="display:inline-block;background:#b42318;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold">Unrecognize</a></p><p style="font-size:12px;color:#667085">This is an automated face match and may be inaccurate. Each button opens a confirmation page before changing the dashboard alert.</p></div>`,
        attachments: [{ filename: 'unknown-person-snapshot.jpg', content: snapshot.toString('base64') }]
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Email provider returned HTTP ${response.status}`);
    return true;
  }
  async function emailConfirmedUnrecognized(alertId, baseUrl) {
    const apiKey = process.env.RESEND_API_KEY;
    const recipient = process.env.INTRUDER_ALERT_EMAIL;
    const sender = process.env.CAMERA_ALERT_FROM;
    if (!apiKey || !recipient || !sender) return false;
    const { rows } = await pool.query(`SELECT c.name AS "cameraName", c.location,
      a.detected_at AS "detectedAt", a.face_count AS "faceCount", a.snapshot
      FROM camera_alerts a JOIN cameras c ON c.id = a.camera_id WHERE a.id = $1 AND a.status = 'report'`, [alertId]);
    const alert = rows[0];
    if (!alert) throw new Error('Confirmed unfamiliar-face alert was not found.');
    const dashboardUrl = new URL('/', baseUrl).toString();
    const detectedAt = new Date(alert.detectedAt).toLocaleString('en-PH', { timeZone: 'Asia/Manila' });
    const cameraLocation = alert.location || 'Not set';
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: sender,
        to: [recipient],
        subject: `Possible intruder alert: ${alert.cameraName}`,
        text: `The homeowner confirmed that the unfamiliar person in this camera snapshot was not recognized. Please review the alert promptly in the barangay dashboard. This confirmation means the person was unfamiliar to the homeowner; it does not by itself establish unlawful entry.\n\nCamera: ${alert.cameraName}\nLocation: ${cameraLocation}\nDetected: ${detectedAt}\nFaces: ${alert.faceCount}\n\nOpen the dashboard: ${dashboardUrl}`,
        html: `<div style="font-family:Arial,sans-serif;color:#172033;max-width:600px"><h2>Possible intruder alert</h2><p>The homeowner confirmed that the unfamiliar person in this camera snapshot was not recognized. Please review the alert promptly in the barangay dashboard.</p><p><strong>Camera:</strong> ${safeHtml(alert.cameraName)}<br><strong>Location:</strong> ${safeHtml(cameraLocation)}<br><strong>Detected:</strong> ${safeHtml(detectedAt)}<br><strong>Faces:</strong> ${safeHtml(alert.faceCount)}</p><p>This confirmation means the person was unfamiliar to the homeowner; it does not by itself establish unlawful entry.</p><p><a href="${safeHtml(dashboardUrl)}" style="display:inline-block;background:#185abc;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none;font-weight:bold">Open dashboard</a></p></div>`,
        attachments: [{ filename: 'unfamiliar-face-snapshot.jpg', content: alert.snapshot.toString('base64') }]
      }),
      signal: AbortSignal.timeout(15000)
    });
    if (!response.ok) throw new Error(`Email provider returned HTTP ${response.status}`);
    return true;
  }
  const ownerEmailConfigured = () => Boolean(process.env.RESEND_API_KEY && process.env.CAMERA_ALERT_EMAIL && process.env.CAMERA_ALERT_FROM && emailReviewSecret());
  let schemaReady;
  const ensureSchema = () => {
    schemaReady ||= pool.query(schemas.cameraAlerts + '\n' + schemas.reportNotifications + '\n' + schemas.snapshotNotifications)
      .catch((error) => { schemaReady = null; throw error; });
    return schemaReady;
  };
  const handle = (fn) => async (req, res) => {
    try { await ensureSchema(); await fn(req, res); }
    catch (error) { console.error('Camera alert:', error.message); if (!res.headersSent) res.status(503).json({ error: 'Unable to save or load camera alerts. Please try again.' }); }
  };
  const validId = (id) => /^[1-9]\d{0,15}$/.test(String(id));
  const validBulkIds = (ids) => Array.isArray(ids) && ids.length > 0 && ids.length <= 100
    && ids.every(validId) && new Set(ids.map(String)).size === ids.length;
  const reportDetails = `SELECT a.id, a.camera_id AS "cameraId", c.name AS "cameraName", c.location,
    a.detected_at AS "detectedAt", a.face_count AS "faceCount", a.status,
    a.reviewed_at AS "reviewedAt", a.review_note AS "reviewNote", u.full_name AS "reviewedBy",
    a.actioned_at AS "actionedAt", a.action_note AS "actionNote", actor.full_name AS "actionedBy"
    FROM camera_alerts a JOIN cameras c ON c.id = a.camera_id
    LEFT JOIN users u ON u.id = a.reviewed_by LEFT JOIN users actor ON actor.id = a.actioned_by
    WHERE a.id = $1 AND a.status = 'report'`;
  const snapshotDetails = `SELECT a.id, a.camera_id AS "cameraId", c.name AS "cameraName", c.location,
    a.detected_at AS "detectedAt", a.face_count AS "faceCount", a.status,
    a.reviewed_at AS "reviewedAt", a.review_note AS "reviewNote", u.full_name AS "reviewedBy",
    a.actioned_at AS "actionedAt", a.action_note AS "actionNote", actor.full_name AS "actionedBy"
    FROM camera_alerts a JOIN cameras c ON c.id = a.camera_id
    LEFT JOIN users u ON u.id = a.reviewed_by LEFT JOIN users actor ON actor.id = a.actioned_by
    WHERE a.id = $1`;

  app.post('/api/alerts/bulk-archive', allow('admin', 'captain'), handle(async (req, res) => {
    const { ids } = req.body || {};
    if (!validBulkIds(ids)) return res.status(400).json({ error: 'Select between 1 and 100 unique snapshot alerts.' });
    const result = await pool.query(`UPDATE camera_alerts SET status = 'dismissed', review_note = 'Archived in bulk from the dashboard.',
      reviewed_by = $1, reviewed_at = NOW() WHERE id = ANY($2::bigint[]) AND status = 'pending'`, [req.session.user.id, ids]);
    res.json({ ok: true, archived: result.rowCount });
  }));

  app.delete('/api/alerts/bulk', allow('admin'), handle(async (req, res) => {
    const { ids } = req.body || {};
    if (!validBulkIds(ids)) return res.status(400).json({ error: 'Select between 1 and 100 unique archived snapshot alerts.' });
    const result = await pool.query(`DELETE FROM camera_alerts WHERE id = ANY($1::bigint[])
      AND (status IN ('approved', 'dismissed', 'recognized', 'unrecognized') OR (status = 'report' AND actioned_at IS NOT NULL))`, [ids]);
    res.json({ ok: true, deleted: result.rowCount });
  }));

  app.get('/api/alerts/:id/details', allow('admin', 'captain'), handle(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid snapshot ID.' });
    const { rows } = await pool.query(snapshotDetails, [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Snapshot not found.' });
    res.set('Cache-Control', 'private, no-store').json(rows[0]);
  }));

  app.get('/api/alerts/:id/email-review/:decision', handle(async (req, res) => {
    const { decision } = req.params;
    const { expires, signature } = req.query;
    if (!validEmailReview(req.params.id, decision, expires, signature)) return res.status(400).type('html').send(emailReviewPage('Invalid or expired link', 'This email decision link is invalid or has expired. Open the latest face alert email.'));
    const { rows } = await pool.query('SELECT status, reviewed_at FROM camera_alerts WHERE id = $1', [req.params.id]);
    if (!rows[0] || !['email_pending', 'pending'].includes(rows[0].status) || rows[0].reviewed_at) return res.status(409).type('html').send(emailReviewPage('Already reviewed', 'This face snapshot has already been reviewed in the dashboard or by another email action.'));
    const label = decision === 'recognized' ? 'Recognize this person' : 'Unrecognize this person';
    res.set('Cache-Control', 'no-store').set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'")
      .type('html').send(emailReviewPage('Confirm face review', `Confirm '${label}'? This will update the matching snapshot in the dashboard.`, req.originalUrl));
  }));
  app.post('/api/alerts/:id/email-review/:decision', handle(async (req, res) => {
    const { decision } = req.params;
    const { expires, signature } = req.query;
    if (!validEmailReview(req.params.id, decision, expires, signature)) return res.status(400).type('html').send(emailReviewPage('Invalid or expired link', 'This email decision link is invalid or has expired. Open the latest face alert email.'));
    const client = await pool.connect();
    let rowCount = 0;
    try {
      await client.query('BEGIN');
      const nextStatus = decision === 'recognized' ? 'recognized' : 'report';
      const updated = await client.query(`UPDATE camera_alerts SET status = $1, review_note = $2,
        reviewed_by = NULL, reviewed_at = NOW() WHERE id = $3 AND status IN ('email_pending', 'pending') AND reviewed_at IS NULL`,
      [nextStatus, decision === 'recognized' ? 'Recognized from the email review link.' : 'Homeowner confirmed an unfamiliar face; staff follow-up required.', req.params.id]);
      rowCount = updated.rowCount;
      if (rowCount && decision === 'unrecognized') {
        await client.query(`INSERT INTO report_notifications (alert_id, user_id)
          SELECT $1, id FROM users WHERE role IN ('tanod', 'captain') AND is_active = true AND approval_status = 'approved'
          ON CONFLICT (alert_id, user_id) DO NOTHING`, [req.params.id]);
      }
      await client.query('COMMIT');
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
    if (!rowCount) return res.status(409).type('html').send(emailReviewPage('Already reviewed', 'This face snapshot has already been reviewed in the dashboard or by another email action.'));
    let staffEmailSent = false;
    if (decision === 'unrecognized') {
      try { staffEmailSent = await emailConfirmedUnrecognized(req.params.id, appBaseUrl(req)); }
      catch (error) { console.error('Confirmed unfamiliar-face staff email:', error.message); }
    }
    const message = decision === 'recognized'
      ? 'The face snapshot was recognized. It will not appear in dashboard alerts.'
      : staffEmailSent
        ? 'The unfamiliar face was confirmed. The alert is in the Reports queue and an email with the snapshot was sent to barangay staff.'
        : 'The unfamiliar face was confirmed and added to the Reports queue for staff follow-up. The staff email could not be sent; please contact the administrator.';
    res.set('Cache-Control', 'no-store').set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'")
      .type('html').send(emailReviewPage('Dashboard updated', message));
  }));

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
  app.get('/api/snapshot-notifications', allow('admin', 'captain'), handle(async (req, res) => {
    const { rows: [counts] } = await pool.query(`SELECT COUNT(*) AS unread FROM snapshot_notifications n
      JOIN camera_alerts a ON a.id = n.alert_id
      WHERE n.user_id = $1 AND n.read_at IS NULL AND a.status = 'pending'`, [req.session.user.id]);
    const { rows } = await pool.query(`SELECT a.id, n.id AS "notificationId", n.read_at AS "readAt", n.created_at AS "notifiedAt",
      a.camera_id AS "cameraId", c.name AS "cameraName", c.location, a.detected_at AS "detectedAt",
      a.face_count AS "faceCount", a.status
      FROM snapshot_notifications n JOIN camera_alerts a ON a.id = n.alert_id
      JOIN cameras c ON c.id = a.camera_id
      WHERE n.user_id = $1 AND a.status = 'pending'
      ORDER BY (n.read_at IS NULL) DESC, n.created_at DESC, n.id DESC LIMIT 20`, [req.session.user.id]);
    res.set('Cache-Control', 'private, no-store').json({ unread: Number(counts.unread), notifications: rows });
  }));
  app.patch('/api/snapshot-notifications/:id/read', allow('admin', 'captain'), handle(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid notification ID.' });
    const { rowCount } = await pool.query('UPDATE snapshot_notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = $1 AND user_id = $2', [req.params.id, req.session.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'Notification not found.' });
    res.json({ ok: true });
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
  app.get('/api/alerts/email-status', requireAuth, (_req, res) => {
    res.set('Cache-Control', 'no-store').json({ configured: ownerEmailConfigured() });
  });
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
      const camera = await client.query('SELECT id, name, location FROM cameras WHERE id = $1 AND is_enabled = true AND is_archived = false', [cameraId]);
      if (!camera.rowCount) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Camera is not available.' }); }
      const recent = await client.query("SELECT id FROM camera_alerts WHERE camera_id = $1 AND detected_at > NOW() - INTERVAL '60 seconds' LIMIT 1", [cameraId]);
      if (recent.rowCount) { await client.query('COMMIT'); return res.json({ id: recent.rows[0].id, duplicate: true, emailConfigured: ownerEmailConfigured(), emailSent: false }); }
      const startsInEmailReview = ownerEmailConfigured();
      const { rows } = await client.query('INSERT INTO camera_alerts (camera_id, created_by, face_count, snapshot, status) VALUES ($1, $2, $3, $4, $5) RETURNING id', [cameraId, req.session.user.id, faceCount, picture, startsInEmailReview ? 'email_pending' : 'pending']);
      await client.query('COMMIT');
      // Save first, then attempt email delivery. Email failure never rolls back
      // the snapshot, and the caller gets an explicit delivery status.
      let emailSent = false;
      const detectedAt = new Date().toISOString();
      if (ownerEmailConfigured()) {
        try { emailSent = await emailOwner(camera.rows[0].name, camera.rows[0].location, faceCount, detectedAt, picture, rows[0].id, appBaseUrl(req)); }
        catch (error) { console.error('Unknown-person alert email:', error.message); }
      }
      // An emailed snapshot stays hidden while awaiting the recipient's choice.
      // If email delivery fails, fall back to the regular dashboard alert.
      if (!startsInEmailReview || !emailSent) {
        try {
          if (startsInEmailReview && !emailSent) await pool.query("UPDATE camera_alerts SET status = 'pending' WHERE id = $1 AND status = 'email_pending'", [rows[0].id]);
        await pool.query(`INSERT INTO snapshot_notifications (alert_id, user_id)
          SELECT $1, id FROM users WHERE role IN ('admin', 'captain') AND is_active = true AND approval_status = 'approved'
          ON CONFLICT (alert_id, user_id) DO NOTHING`, [rows[0].id]);
        } catch (error) { console.error('Unknown-person dashboard notification:', error.message); }
      }
      res.status(201).json({ id: rows[0].id, emailConfigured: ownerEmailConfigured(), emailSent });
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
  ensureSchema.sendUnknownFaceEmail = emailOwner;
  ensureSchema.ownerEmailConfigured = ownerEmailConfigured;
  return ensureSchema;
};
