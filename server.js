require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex');
const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'barangay_dashboard',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  dateStrings: true
});

app.use(express.json({ limit: '2mb' }));
app.use(session({
  name: 'barangay.sid',
  secret: sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

const roles = ['tanod', 'captain', 'admin'];
const validUsername = (value) => /^[a-zA-Z0-9._-]{3,60}$/.test(String(value || '').trim());
const validProfile = ({ firstName, middleName, lastName, gender, dateOfBirth }) => Boolean(String(firstName || '').trim() && String(firstName).trim().length <= 60 && String(middleName || '').trim().length <= 60 && String(lastName || '').trim() && String(lastName).trim().length <= 60 && ['female', 'male'].includes(gender) && /^\d{4}-\d{2}-\d{2}$/.test(String(dateOfBirth || '')) && !Number.isNaN(Date.parse(`${dateOfBirth}T00:00:00Z`)) && dateOfBirth < new Date().toISOString().slice(0, 10));
const publicUser = (user) => ({ id: user.id, fullName: user.full_name, username: user.username, role: user.role });
const requireAuth = (req, res, next) => req.session.user ? next() : res.status(401).json({ error: 'Please log in.' });
const allow = (...allowed) => (req, res, next) => {
  if (!req.session.user) return res.status(401).json({ error: 'Please log in.' });
  if (!allowed.includes(req.session.user.role)) return res.status(403).json({ error: 'Your account does not have permission for this action.' });
  next();
};
const audit = async (userId, action, entityType, entityId, details, ip) => {
  await pool.execute('INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address) VALUES (?, ?, ?, ?, ?, ?)',
    [userId || null, action, entityType, entityId || null, details ? JSON.stringify(details) : null, ip || null]);
};

app.get('/api/health', async (_req, res) => {
  try { await pool.query('SELECT 1'); res.json({ ok: true, service: 'barangay-dashboard-api', database: 'connected' }); }
  catch { res.status(503).json({ ok: false, service: 'barangay-dashboard-api', database: 'disconnected' }); }
});

app.get('/api/auth/status', async (req, res) => {
  try {
    const [[{ total }]] = await pool.query("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND approval_status = 'approved' AND is_active = 1");
    res.json({ setupRequired: Number(total) === 0, user: req.session.user || null });
  } catch (error) { res.status(503).json({ error: 'Cannot connect to the barangay_dashboard database. Check .env and XAMPP MySQL.' }); }
});

app.post('/api/auth/register', async (req, res) => {
  const { firstName, middleName = '', lastName, gender, dateOfBirth, username, password, requestedRole } = req.body || {};
  if (!validProfile({ firstName, middleName, lastName, gender, dateOfBirth }) || !validUsername(username) || !password || String(password).length < 10 || String(password).length > 128 || !['tanod', 'captain'].includes(requestedRole)) {
    return res.status(400).json({ error: 'Enter your name, a valid username, a password of 10–128 characters, and a requested role.' });
  }
  try {
    const hash = await bcrypt.hash(String(password), 12);
    const fullName = [String(firstName).trim(), String(middleName).trim(), String(lastName).trim()].filter(Boolean).join(' ');
    await pool.execute("INSERT INTO users (full_name, first_name, middle_name, last_name, gender, date_of_birth, username, password_hash, role, requested_role, approval_status, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'tanod', ?, 'pending', 0)",
      [fullName, String(firstName).trim(), String(middleName).trim() || null, String(lastName).trim(), gender, dateOfBirth, String(username).trim().toLowerCase(), hash, requestedRole]);
    res.status(201).json({ pending: true, message: 'Your account request has been sent to an administrator for review.' });
  } catch (error) {
    res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ error: error.code === 'ER_DUP_ENTRY' ? 'That username is already in use.' : 'Unable to submit your account request.' });
  }
});

app.post('/api/auth/setup', async (req, res) => {
  const { firstName, middleName = '', lastName, gender, dateOfBirth, username, password } = req.body || {};
  if (!validProfile({ firstName, middleName, lastName, gender, dateOfBirth }) || !validUsername(username) || !password || String(password).length < 10 || String(password).length > 128) return res.status(400).json({ error: 'Enter your profile details, a valid username, and a password of 10–128 characters.' });
  const conn = await pool.getConnection();
  let setupLock = false;
  try {
    const [[lock]] = await conn.query("SELECT GET_LOCK('barangay_dashboard_first_admin', 5) AS acquired");
    setupLock = Number(lock.acquired) === 1;
    if (!setupLock) return res.status(503).json({ error: 'Admin setup is busy. Please try again.' });
    await conn.beginTransaction();
    const [[{ total }]] = await conn.query("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND approval_status = 'approved' AND is_active = 1 FOR UPDATE");
    if (Number(total) !== 0) { await conn.rollback(); return res.status(403).json({ error: 'Initial admin setup is already complete.' }); }
    const hash = await bcrypt.hash(String(password), 12);
    const fullName = [String(firstName).trim(), String(middleName).trim(), String(lastName).trim()].filter(Boolean).join(' ');
    const [result] = await conn.execute("INSERT INTO users (full_name, first_name, middle_name, last_name, gender, date_of_birth, username, password_hash, role, approval_status, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'admin', 'approved', 1)", [fullName, String(firstName).trim(), String(middleName).trim() || null, String(lastName).trim(), gender, dateOfBirth, String(username).trim().toLowerCase().slice(0, 60), hash]);
    await conn.commit();
    const user = { id: result.insertId, full_name: String(fullName).trim(), username: String(username).trim().toLowerCase(), role: 'admin' };
    req.session.regenerate((err) => { if (err) return res.status(500).json({ error: 'Could not start your session.' }); req.session.user = publicUser(user); res.status(201).json({ user: req.session.user }); });
  } catch (error) {
    await conn.rollback();
    res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ error: error.code === 'ER_DUP_ENTRY' ? 'That username is already in use.' : 'Unable to create the first admin.' });
  } finally { if (setupLock) await conn.query("SELECT RELEASE_LOCK('barangay_dashboard_first_admin')"); conn.release(); }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Enter your username and password.' });
  try {
    const [[user]] = await pool.execute('SELECT id, full_name, username, password_hash, role, approval_status, is_active FROM users WHERE username = ?', [String(username).trim().toLowerCase()]);
    if (!user || !(await bcrypt.compare(String(password), user.password_hash))) return res.status(401).json({ error: 'Username or password is incorrect.' });
    if (user.approval_status === 'pending') return res.status(403).json({ error: 'Your account request is waiting for admin approval.' });
    if (user.approval_status !== 'approved') return res.status(403).json({ error: 'This account request was declined. Contact your barangay administrator.' });
    if (!user.is_active) return res.status(403).json({ error: 'This account is inactive. Contact your barangay administrator.' });
    req.session.regenerate((err) => { if (err) return res.status(500).json({ error: 'Could not start your session.' }); req.session.user = publicUser(user); res.json({ user: req.session.user }); });
  } catch { res.status(503).json({ error: 'Unable to log in. Check the database connection.' }); }
});
app.post('/api/auth/logout', (req, res) => req.session.destroy(() => { res.clearCookie('barangay.sid'); res.json({ ok: true }); }));

app.get('/api/incidents', requireAuth, async (req, res) => {
  try {
    const [rows] = await pool.query(`SELECT i.id AS dbId, i.reference_no AS referenceNo, i.type, i.note, i.status, i.occurred_at AS date, c.name AS camera, u.full_name AS reportedBy
      FROM incidents i LEFT JOIN cameras c ON c.id = i.camera_id LEFT JOIN users u ON u.id = i.reported_by
      WHERE i.archived_at IS NULL ORDER BY i.occurred_at DESC LIMIT 500`);
    res.json(rows.map((row) => ({ ...row, id: row.referenceNo, camera: row.camera || 'Unassigned camera' })));
  } catch { res.status(500).json({ error: 'Unable to load incidents.' }); }
});
app.post('/api/incidents', allow('captain', 'admin'), async (req, res) => {
  const { type, note = '', cameraId = null } = req.body || {};
  if (!type || typeof type !== 'string') return res.status(400).json({ error: 'type is required' });
  try {
    const ref = `INC-${Date.now().toString(36).toUpperCase()}`;
    const [result] = await pool.execute('INSERT INTO incidents (reference_no, type, note, camera_id, reported_by) VALUES (?, ?, ?, ?, ?)', [ref, type.slice(0, 100), String(note).slice(0, 5000), cameraId || null, req.session.user.id]);
    await audit(req.session.user.id, 'created', 'incident', result.insertId, { referenceNo: ref }, req.ip);
    res.status(201).json({ incident: { id: ref, type, note, camera: 'Unassigned camera', status: 'Active', date: new Date().toISOString() } });
  } catch { res.status(500).json({ error: 'Unable to save incident.' }); }
});
app.patch('/api/incidents/:id/archive', allow('admin'), async (req, res) => {
  try { const [r] = await pool.execute('UPDATE incidents SET archived_at = NOW(), status = \'Archived\' WHERE id = ?', [req.params.id]); if (!r.affectedRows) return res.status(404).json({ error: 'Incident not found.' }); await audit(req.session.user.id, 'archived', 'incident', req.params.id, null, req.ip); res.json({ ok: true }); }
  catch { res.status(500).json({ error: 'Unable to archive incident.' }); }
});

app.get('/api/cameras', requireAuth, async (_req, res) => {
  try { const [rows] = await pool.query('SELECT id, name, stream_url AS streamUrl, location, is_enabled AS isEnabled, last_status AS status FROM cameras WHERE is_archived = 0 ORDER BY id'); res.json(rows); }
  catch { res.status(500).json({ error: 'Unable to load cameras.' }); }
});
app.post('/api/cameras', allow('admin'), async (req, res) => {
  const { name, streamUrl, location = '' } = req.body || {};
  if (!name || !streamUrl || !/^https?:\/\//i.test(streamUrl)) return res.status(400).json({ error: 'Enter a camera name and valid HTTP(S) stream URL.' });
  try { const [r] = await pool.execute('INSERT INTO cameras (name, stream_url, location, created_by) VALUES (?, ?, ?, ?)', [name.slice(0, 100), streamUrl.slice(0, 2048), location.slice(0, 200), req.session.user.id]); await audit(req.session.user.id, 'created', 'camera', r.insertId, null, req.ip); res.status(201).json({ id: r.insertId, name, streamUrl, location, status: 'unknown' }); }
  catch { res.status(500).json({ error: 'Unable to save camera.' }); }
});
app.put('/api/camera-stream', allow('admin'), async (req, res) => {
  const { streamUrl, cameraId } = req.body || {};
  let parsedUrl;
  try { parsedUrl = new URL(String(streamUrl || '').trim()); }
  catch { return res.status(400).json({ error: 'Enter a valid HTTP or HTTPS camera stream URL.' }); }
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.href.length > 2048) return res.status(400).json({ error: 'Enter a valid HTTP or HTTPS camera stream URL.' });
  try {
    let id = Number(cameraId) || null;
    if (!id) {
      const [[existing]] = await pool.query('SELECT id FROM cameras WHERE is_archived = 0 ORDER BY id LIMIT 1');
      id = existing?.id || null;
    }
    if (id) {
      await pool.execute("UPDATE cameras SET stream_url = ?, last_status = 'unknown', last_checked_at = NULL WHERE id = ? AND is_archived = 0", [parsedUrl.href, id]);
      const [[camera]] = await pool.execute('SELECT id FROM cameras WHERE id = ? AND is_archived = 0', [id]);
      if (!camera) return res.status(404).json({ error: 'Camera not found. Refresh the dashboard and try again.' });
    } else {
      const [result] = await pool.execute("INSERT INTO cameras (name, stream_url, is_enabled, created_by) VALUES ('ESP32-CAM 01', ?, 1, ?)", [parsedUrl.href, req.session.user.id]);
      id = result.insertId;
    }
    await audit(req.session.user.id, 'updated', 'camera_stream', id, null, req.ip);
    res.json({ id, streamUrl: parsedUrl.href });
  } catch { res.status(500).json({ error: 'Unable to save the shared camera URL.' }); }
});
app.patch('/api/cameras/:id', allow('admin'), async (req, res) => {
  const { name, streamUrl, location, isEnabled, status } = req.body || {};
  try { await pool.execute('UPDATE cameras SET name = COALESCE(?, name), stream_url = COALESCE(?, stream_url), location = COALESCE(?, location), is_enabled = COALESCE(?, is_enabled), last_status = COALESCE(?, last_status), last_checked_at = IF(? IS NULL, last_checked_at, NOW()) WHERE id = ? AND is_archived = 0', [name || null, streamUrl || null, location ?? null, isEnabled === undefined ? null : Number(Boolean(isEnabled)), status || null, status || null, req.params.id]); res.json({ ok: true }); }
  catch { res.status(500).json({ error: 'Unable to update camera.' }); }
});
app.patch('/api/cameras/:id/archive', allow('admin'), async (req, res) => {
  try { const [r] = await pool.execute('UPDATE cameras SET is_archived = 1 WHERE id = ?', [req.params.id]); if (!r.affectedRows) return res.status(404).json({ error: 'Camera not found.' }); await audit(req.session.user.id, 'archived', 'camera', req.params.id, null, req.ip); res.json({ ok: true }); }
  catch { res.status(500).json({ error: 'Unable to archive camera.' }); }
});
app.patch('/api/cameras/:id/status', requireAuth, async (req, res) => {
  const { status } = req.body || {};
  if (!['online', 'offline'].includes(status)) return res.status(400).json({ error: 'Invalid camera status.' });
  try { await pool.execute('UPDATE cameras SET last_status = ?, last_checked_at = NOW() WHERE id = ? AND is_archived = 0', [status, req.params.id]); res.json({ ok: true }); }
  catch { res.status(500).json({ error: 'Unable to update camera status.' }); }
});
app.get('/api/stats', requireAuth, async (_req, res) => {
  try { const [[cams]] = await pool.query('SELECT COUNT(*) AS total, SUM(last_status = \'online\') AS online FROM cameras WHERE is_archived = 0 AND is_enabled = 1'); const [[incidents]] = await pool.query('SELECT SUM(status = \'Active\' AND archived_at IS NULL) AS active, SUM(DATE(occurred_at) = CURDATE() AND archived_at IS NULL) AS today FROM incidents'); res.json({ cameras: Number(cams.total || 0), online: Number(cams.online || 0), active: Number(incidents.active || 0), today: Number(incidents.today || 0) }); }
  catch { res.status(500).json({ error: 'Unable to load dashboard totals.' }); }
});

app.get('/api/announcements', requireAuth, async (_req, res) => { try { const [rows] = await pool.query('SELECT a.id, a.title, a.body, a.published_at AS publishedAt, u.full_name AS author FROM announcements a LEFT JOIN users u ON u.id = a.created_by WHERE a.is_published = 1 ORDER BY a.published_at DESC, a.id DESC'); res.json(rows); } catch { res.status(500).json({ error: 'Unable to load announcements.' }); } });
app.post('/api/announcements', allow('captain', 'admin'), async (req, res) => { const { title, body } = req.body || {}; if (!title || !body) return res.status(400).json({ error: 'Title and announcement are required.' }); try { const [r] = await pool.execute('INSERT INTO announcements (title, body, created_by, published_at) VALUES (?, ?, ?, NOW())', [title.slice(0, 180), body.slice(0, 10000), req.session.user.id]); await audit(req.session.user.id, 'published', 'announcement', r.insertId, null, req.ip); res.status(201).json({ id: r.insertId, title, body }); } catch { res.status(500).json({ error: 'Unable to publish announcement.' }); } });
app.patch('/api/announcements/:id/archive', allow('admin'), async (req, res) => { try { const [r] = await pool.execute('UPDATE announcements SET is_published = 0 WHERE id = ?', [req.params.id]); if (!r.affectedRows) return res.status(404).json({ error: 'Announcement not found.' }); await audit(req.session.user.id, 'archived', 'announcement', req.params.id, null, req.ip); res.json({ ok: true }); } catch { res.status(500).json({ error: 'Unable to hide announcement.' }); } });

app.get('/api/tasks', requireAuth, async (req, res) => { try { const [rows] = await pool.execute(`SELECT t.id, t.title, t.details, t.status, t.due_at AS dueAt, t.assigned_to AS assignedTo, u.full_name AS assignee FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to ${req.session.user.role === 'tanod' ? 'WHERE t.assigned_to = ?' : ''} ORDER BY t.created_at DESC`, req.session.user.role === 'tanod' ? [req.session.user.id] : []); res.json(rows); } catch { res.status(500).json({ error: 'Unable to load tasks.' }); } });
app.post('/api/tasks', allow('captain', 'admin'), async (req, res) => { const { title, details = '', assignedTo, dueAt = null } = req.body || {}; if (!title || !assignedTo) return res.status(400).json({ error: 'Task title and Tanod assignee are required.' }); try { const [r] = await pool.execute("INSERT INTO tasks (title, details, assigned_to, assigned_by, due_at) SELECT ?, ?, id, ?, ? FROM users WHERE id = ? AND role = 'tanod' AND is_active = 1", [title.slice(0, 180), details.slice(0, 5000), req.session.user.id, dueAt || null, assignedTo]); if (!r.affectedRows) return res.status(400).json({ error: 'Choose an active Tanod account.' }); await audit(req.session.user.id, 'assigned', 'task', r.insertId, { assignedTo }, req.ip); res.status(201).json({ id: r.insertId, title, details, status: 'Pending', assignedTo }); } catch { res.status(500).json({ error: 'Unable to assign task.' }); } });
app.patch('/api/tasks/:id', requireAuth, async (req, res) => { const { status } = req.body || {}; if (!['Pending', 'In Progress', 'Completed', 'Cancelled'].includes(status)) return res.status(400).json({ error: 'Invalid task status.' }); try { const [r] = await pool.execute(`UPDATE tasks SET status = ?, completed_at = IF(? = 'Completed', NOW(), NULL) WHERE id = ? ${req.session.user.role === 'tanod' ? 'AND assigned_to = ?' : ''}`, req.session.user.role === 'tanod' ? [status, status, req.params.id, req.session.user.id] : [status, status, req.params.id]); if (!r.affectedRows) return res.status(404).json({ error: 'Task not found.' }); res.json({ ok: true }); } catch { res.status(500).json({ error: 'Unable to update task.' }); } });

app.get('/api/users', allow('admin'), async (_req, res) => { try { const [rows] = await pool.query("SELECT id, full_name AS fullName, username, role, is_active AS isActive FROM users WHERE approval_status = 'approved' ORDER BY full_name"); res.json(rows); } catch { res.status(500).json({ error: 'Unable to load users.' }); } });
app.get('/api/users/requests', allow('admin'), async (_req, res) => { try { const [rows] = await pool.query("SELECT id, full_name AS fullName, username, requested_role AS requestedRole, created_at AS requestedAt FROM users WHERE approval_status = 'pending' ORDER BY created_at"); res.json(rows); } catch { res.status(500).json({ error: 'Unable to load account requests.' }); } });
app.post('/api/users/:id/decision', allow('admin'), async (req, res) => {
  const { decision } = req.body || {};
  if (!['approved', 'declined'].includes(decision)) return res.status(400).json({ error: 'Choose approve or decline.' });
  try {
    const [result] = await pool.execute("UPDATE users SET approval_status = ?, role = IF(? = 'approved', COALESCE(requested_role, role), role), is_active = IF(? = 'approved', 1, 0), reviewed_by = ?, reviewed_at = NOW() WHERE id = ? AND approval_status = 'pending'", [decision, decision, decision, req.session.user.id, req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Pending account request not found.' });
    await audit(req.session.user.id, decision, 'user_registration', req.params.id, null, req.ip);
    res.json({ ok: true, decision });
  } catch { res.status(500).json({ error: 'Unable to update the account request.' }); }
});
app.get('/api/tanods', allow('captain', 'admin'), async (_req, res) => { try { const [rows] = await pool.query("SELECT id, full_name AS fullName FROM users WHERE role = 'tanod' AND is_active = 1 ORDER BY full_name"); res.json(rows); } catch { res.status(500).json({ error: 'Unable to load Tanod accounts.' }); } });
app.post('/api/users', allow('admin'), async (req, res) => { const { fullName, username, password, role } = req.body || {}; if (!fullName || !validUsername(username) || !password || String(password).length < 10 || String(password).length > 128 || !roles.includes(role)) return res.status(400).json({ error: 'Provide a name, valid username, role, and password of 10–128 characters.' }); try { const hash = await bcrypt.hash(String(password), 12); const [r] = await pool.execute('INSERT INTO users (full_name, username, password_hash, role) VALUES (?, ?, ?, ?)', [fullName.trim().slice(0, 120), username.trim().toLowerCase().slice(0, 60), hash, role]); await audit(req.session.user.id, 'created', 'user', r.insertId, { role }, req.ip); res.status(201).json({ id: r.insertId, fullName, username, role, isActive: 1 }); } catch (error) { res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ error: error.code === 'ER_DUP_ENTRY' ? 'That username is already in use.' : 'Unable to create user.' }); } });
app.patch('/api/users/:id/role', allow('admin'), async (req, res) => { const { role } = req.body || {}; if (!roles.includes(role)) return res.status(400).json({ error: 'Invalid role.' }); if (Number(req.params.id) === req.session.user.id && role !== 'admin') return res.status(400).json({ error: 'You cannot remove your own admin role.' }); try { await pool.execute('UPDATE users SET role = ? WHERE id = ?', [role, req.params.id]); await audit(req.session.user.id, 'role_changed', 'user', req.params.id, { role }, req.ip); res.json({ ok: true }); } catch { res.status(500).json({ error: 'Unable to update role.' }); } });

app.get('/api/faces/recognize', requireAuth, async (_req, res) => {
  try {
    const cameraUrl = process.env.ESP32_CAPTURE_URL?.trim();
    const comprefaceUrl = process.env.COMPREFACE_URL?.trim();
    const apiKey = process.env.COMPREFACE_API_KEY?.trim();
    if (!cameraUrl || !comprefaceUrl || !apiKey) return res.status(500).json({ success: false, error: 'Face recognition is not configured in .env' });
    // Always recognize a fresh ESP32 snapshot; some camera firmware or
    // intermediate caches otherwise keep returning the previous JPEG.
    const cameraResponse = await fetch(cameraUrl, { cache: 'no-store', signal: AbortSignal.timeout(10000) });
    if (!cameraResponse.ok) throw new Error(`Camera returned HTTP ${cameraResponse.status}`);
    const form = new FormData(); form.append('file', new Blob([Buffer.from(await cameraResponse.arrayBuffer())], { type: 'image/jpeg' }), 'capture.jpg');
    const url = new URL(`${comprefaceUrl.replace(/\/+$/, '')}/api/v1/recognition/recognize`);
    const configuredDetectionThreshold = Number(process.env.COMPREFACE_DET_PROB_THRESHOLD);
    const detectionThreshold = Number.isFinite(configuredDetectionThreshold)
      ? Math.min(1, Math.max(0, configuredDetectionThreshold))
      : 0.7;
    url.searchParams.set('det_prob_threshold', String(detectionThreshold));
    const response = await fetch(url, { method: 'POST', headers: { 'x-api-key': apiKey }, body: form });
    const data = await response.json(); if (!response.ok) throw new Error(data.message || 'Recognition service failed.');
    const configuredRecognitionThreshold = Number(process.env.COMPREFACE_RECOGNITION_THRESHOLD);
    const recognitionThreshold = Number.isFinite(configuredRecognitionThreshold)
      ? Math.min(1, Math.max(0, configuredRecognitionThreshold))
      : 0.85;
    const faces = (data.result || []).map((face) => {
      const match = [...(face.subjects || [])]
        .filter((subject) => Number.isFinite(Number(subject.similarity)))
        .sort((a, b) => Number(b.similarity) - Number(a.similarity))[0];
      const similarity = match ? Number(match.similarity) : null;
      return {
        box: face.box,
        recognized: Boolean(match && similarity >= recognitionThreshold),
        name: match?.subject || null,
        similarity
      };
    });
    res.json({ success: true, detected: faces.length > 0, detectionThreshold, recognitionThreshold, faces });
  } catch (error) { res.status(500).json({ success: false, error: error.message }); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`Barangay dashboard running at http://localhost:${PORT}`));
