require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const mysql = require('mysql2/promise');
const path = require('path');
const crypto = require('crypto');
const fs = require('fs/promises');
const { spawn } = require('child_process');

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
const recordingsRoot = path.resolve(process.env.RECORDINGS_DIR || path.join(__dirname, 'storage', 'recordings'));
const ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg';
const segmentSeconds = Math.min(900, Math.max(60, Number(process.env.RECORDING_SEGMENT_SECONDS) || 300));
const cameraRecorders = new Map();
const recorderStates = new Map();

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

function sqlDateTime(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
function parseCsvRow(row) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < row.length; index += 1) {
    const char = row[index];
    if (char === '"' && quoted && row[index + 1] === '"') { value += '"'; index += 1; }
    else if (char === '"') quoted = !quoted;
    else if (char === ',' && !quoted) { values.push(value); value = ''; }
    else value += char;
  }
  values.push(value);
  return values;
}
async function indexClosedSegments(cameraId, directory) {
  const listedDurations = new Map();
  try {
    const listing = await fs.readFile(path.join(directory, 'segments.csv'), 'utf8');
    for (const row of listing.trim().split(/\r?\n/).filter(Boolean)) {
      const [fileName, segmentStart, segmentEnd] = parseCsvRow(row);
      const duration = Number(segmentEnd) - Number(segmentStart);
      if (fileName && Number.isFinite(duration) && duration > 0) listedDurations.set(path.basename(fileName), duration);
    }
  } catch (error) {
    if (error.code !== 'ENOENT') console.warn(`Could not read camera ${cameraId} recording list:`, error.message);
  }

  let files;
  try { files = await fs.readdir(directory); }
  catch (error) { if (error.code !== 'ENOENT') console.warn(`Could not scan camera ${cameraId} clips:`, error.message); return; }
  for (const fileName of files) {
    if (!/^camera_\d+_\d{8}_\d{6}\.mp4$/.test(fileName)) continue;
    const match = fileName.match(/^camera_\d+_(\d{4})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\.mp4$/);
    if (!match) continue;
    let file;
    try {
      const filePath = path.join(directory, fileName);
      const stat = await fs.stat(filePath);
      if (!stat.isFile() || stat.size < 32 || Date.now() - stat.mtimeMs < 15000) continue;
      file = await fs.open(filePath, 'r');
      const head = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
      const { bytesRead: headLength } = await file.read(head, 0, head.length, 0);
      let hasMovieHeader = head.subarray(0, headLength).includes(Buffer.from('moov'));
      if (!hasMovieHeader && stat.size > headLength) {
        const tail = Buffer.alloc(Math.min(stat.size, 1024 * 1024));
        const { bytesRead: tailLength } = await file.read(tail, 0, tail.length, Math.max(0, stat.size - tail.length));
        hasMovieHeader = tail.subarray(0, tailLength).includes(Buffer.from('moov'));
      }
      await file.close();
      file = null;
      if (!hasMovieHeader) continue;

      const startedAt = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]), Number(match[6]));
      const durationSeconds = listedDurations.get(fileName) || Math.max(1, Math.round((stat.mtimeMs - startedAt.getTime()) / 1000));
      await pool.execute('INSERT IGNORE INTO camera_recordings (camera_id, file_name, started_at, ended_at, duration_seconds, file_size_bytes) VALUES (?, ?, ?, ?, ?, ?)',
        [cameraId, fileName, sqlDateTime(startedAt), sqlDateTime(new Date(stat.mtimeMs)), durationSeconds, stat.size]);
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EBUSY' && error.code !== 'EPERM') console.warn(`Could not index camera ${cameraId} clip:`, error.message);
    } finally { await file?.close().catch(() => {}); }
  }
}
async function purgeExpiredArchivedRecordings() {
  try {
    const [expired] = await pool.query(`SELECT id, camera_id, file_name FROM camera_recordings WHERE archived_at < DATE_SUB(NOW(), INTERVAL 1 YEAR)`);
    for (const recording of expired) {
      const fileName = path.basename(recording.file_name);
      if (!/^camera_\d+_\d{8}_\d{6}\.mp4$/.test(fileName)) continue;
      try { await fs.unlink(path.join(recordingsRoot, String(recording.camera_id), fileName)); }
      catch (error) { if (error.code !== 'ENOENT') { console.warn(`Could not purge expired recording ${recording.id}:`, error.message); continue; } }
      await pool.execute('DELETE FROM camera_recordings WHERE id = ? AND archived_at < DATE_SUB(NOW(), INTERVAL 1 YEAR)', [recording.id]);
    }
    if (expired.length) console.log(`Purged ${expired.length} expired archived recording(s).`);
  } catch (error) { console.warn('Could not purge expired archived recordings:', error.message); }
}
function stopCameraRecorder(cameraId) {
  const recorder = cameraRecorders.get(Number(cameraId));
  if (!recorder) return;
  cameraRecorders.delete(Number(cameraId));
  recorder.stopping = true;
  if (recorder.retryTimer) clearTimeout(recorder.retryTimer);
  if (recorder.indexTimer) clearInterval(recorder.indexTimer);
  if (recorder.child && recorder.child.exitCode === null) {
    try { recorder.child.stdin?.write('q\n'); } catch { /* Fall through to the forced-stop timer. */ }
    recorder.stopTimer = setTimeout(() => {
      if (recorder.child?.exitCode === null) recorder.child.kill();
    }, 8000);
  }
  recorderStates.set(Number(cameraId), { status: 'stopped', error: null });
}
async function runCameraRecorder(recorder) {
  if (recorder.stopping || cameraRecorders.get(recorder.cameraId) !== recorder) return;
  try { await fs.mkdir(recorder.directory, { recursive: true }); }
  catch (error) {
    recorderStates.set(recorder.cameraId, { status: 'error', error: error.message });
    recorder.retryTimer = setTimeout(() => runCameraRecorder(recorder), 15000);
    return;
  }
  await indexClosedSegments(recorder.cameraId, recorder.directory);
  const pattern = `camera_${recorder.cameraId}_%Y%m%d_%H%M%S.mp4`;
  const args = [
    '-hide_banner', '-loglevel', 'warning', '-y',
    '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_on_network_error', '1', '-reconnect_delay_max', '10', '-rw_timeout', '15000000',
    // MJPEG over Wi-Fi can occasionally lose a frame; drop damaged packets and keep recording.
    '-fflags', '+discardcorrupt', '-err_detect', 'ignore_err',
    '-i', recorder.streamUrl,
    '-map', '0:v:0', '-an', '-vf', 'fps=10,scale=in_range=full:out_range=tv', '-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency',
    '-pix_fmt', 'yuv420p', '-b:v', '500k', '-maxrate', '600k', '-bufsize', '1000k',
    '-force_key_frames', `expr:gte(t,n_forced*${segmentSeconds})`,
    '-f', 'segment', '-segment_time', String(segmentSeconds), '-reset_timestamps', '1', '-strftime', '1',
    '-segment_list', 'segments.csv', '-segment_list_type', 'csv', '-segment_list_size', '1', '-segment_list_flags', '+live',
    '-segment_format', 'mp4', '-segment_format_options', 'movflags=+faststart', pattern
  ];
  let child;
  try { child = spawn(ffmpegPath, args, { cwd: recorder.directory, stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true }); }
  catch (error) {
    recorderStates.set(recorder.cameraId, { status: 'error', error: error.message });
    recorder.retryTimer = setTimeout(() => runCameraRecorder(recorder), 15000);
    return;
  }
  recorder.child = child;
  recorderStates.set(recorder.cameraId, { status: 'recording', error: null });
  recorder.indexTimer = setInterval(() => { void indexClosedSegments(recorder.cameraId, recorder.directory); }, 5000);
  let stderr = '';
  child.stderr?.on('data', (chunk) => { stderr = `${stderr}${chunk}`.slice(-2000); });
  child.on('error', (error) => {
    recorderStates.set(recorder.cameraId, { status: 'error', error: error.message });
  });
  child.on('close', async (code) => {
    if (recorder.indexTimer) clearInterval(recorder.indexTimer);
    if (recorder.stopTimer) clearTimeout(recorder.stopTimer);
    await indexClosedSegments(recorder.cameraId, recorder.directory);
    if (recorder.stopping || cameraRecorders.get(recorder.cameraId) !== recorder) return;
    const message = stderr.trim() || (code ? `FFmpeg exited with code ${code}.` : 'Camera recorder stopped.');
    recorderStates.set(recorder.cameraId, { status: 'reconnecting', error: message });
    recorder.retryTimer = setTimeout(() => runCameraRecorder(recorder), 5000);
  });
}
function startCameraRecorder(camera) {
  const cameraId = Number(camera.id);
  const current = cameraRecorders.get(cameraId);
  if (current?.streamUrl === camera.stream_url) return;
  if (current) stopCameraRecorder(cameraId);
  const recorder = { cameraId, streamUrl: camera.stream_url, directory: path.join(recordingsRoot, String(cameraId)), child: null, retryTimer: null, stopping: false };
  cameraRecorders.set(cameraId, recorder);
  void runCameraRecorder(recorder);
}
async function syncCameraRecorders() {
  const [cameras] = await pool.query('SELECT id, stream_url FROM cameras WHERE is_archived = 0 AND is_enabled = 1');
  const activeIds = new Set(cameras.map((camera) => Number(camera.id)));
  for (const cameraId of cameraRecorders.keys()) if (!activeIds.has(cameraId)) stopCameraRecorder(cameraId);
  for (const camera of cameras) startCameraRecorder(camera);
}

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
  if (!validProfile({ firstName, middleName, lastName, gender, dateOfBirth }) || !validUsername(username) || typeof password !== 'string' || password.length < 8 || password.length > 16 || !['tanod', 'captain'].includes(requestedRole)) {
    return res.status(400).json({ error: 'Enter your name, a valid username, a password of 8–16 characters, and a requested role.' });
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
  if (!validProfile({ firstName, middleName, lastName, gender, dateOfBirth }) || !validUsername(username) || typeof password !== 'string' || password.length < 8 || password.length > 16) return res.status(400).json({ error: 'Enter your profile details, a valid username, and a password of 8–16 characters.' });
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
app.get('/api/recording/status', requireAuth, async (_req, res) => {
  try {
    const [cameras] = await pool.query('SELECT id, name FROM cameras WHERE is_archived = 0 AND is_enabled = 1 ORDER BY name');
    res.json(cameras.map((camera) => ({ ...camera, ...(recorderStates.get(Number(camera.id)) || { status: 'starting', error: null }) })));
  } catch { res.status(500).json({ error: 'Unable to load recording status.' }); }
});
app.get('/api/recordings', requireAuth, async (req, res) => {
  const { cameraId, from, to } = req.query;
  const parseLocalDateTime = (value) => {
    if (!value) return null;
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return false;
    const normalized = value.replace('T', ' ');
    return normalized.length === 16 ? `${normalized}:00` : normalized;
  };
  const start = parseLocalDateTime(from);
  const end = parseLocalDateTime(to);
  if (start === false || end === false || (cameraId && !/^\d+$/.test(String(cameraId)))) return res.status(400).json({ error: 'Choose a valid camera and date/time range.' });
  if (start && end && start > end) return res.status(400).json({ error: 'The start date/time must be before the end date/time.' });
  const archived = req.query.archived === 'true';
  const conditions = ['r.archived_at IS ' + (archived ? 'NOT ' : '') + 'NULL'];
  if (!archived) conditions.push('c.is_archived = 0', 'c.is_enabled = 1');
  const params = [];
  if (cameraId) { conditions.push('r.camera_id = ?'); params.push(Number(cameraId)); }
  if (start) { conditions.push('r.ended_at >= ?'); params.push(start); }
  if (end) { conditions.push('r.started_at <= ?'); params.push(end); }
  try {
    const [rows] = await pool.execute(`SELECT r.id, r.camera_id AS cameraId, c.name AS cameraName, r.started_at AS startedAt, r.ended_at AS endedAt, r.duration_seconds AS durationSeconds, r.file_size_bytes AS fileSizeBytes, r.archived_at AS archivedAt FROM camera_recordings r JOIN cameras c ON c.id = r.camera_id WHERE ${conditions.join(' AND ')} ORDER BY r.started_at DESC LIMIT 500`, params);
    res.json(rows);
  } catch (error) {
    console.error('Unable to query camera recordings:', error.message);
    res.status(500).json({ error: 'Unable to load recorded footage. Apply the camera recordings database migration first.' });
  }
});
app.patch('/api/recordings/:id/archive', allow('admin'), async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid recording ID.' });
  try {
    const [result] = await pool.execute('UPDATE camera_recordings SET archived_at = NOW() WHERE id = ? AND archived_at IS NULL', [Number(req.params.id)]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Active recording not found.' });
    await audit(req.session.user.id, 'archived', 'recording', req.params.id, null, req.ip);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Unable to archive recording.' }); }
});
app.patch('/api/recordings/:id/restore', allow('admin'), async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid recording ID.' });
  try {
    const [result] = await pool.execute('UPDATE camera_recordings SET archived_at = NULL WHERE id = ? AND archived_at IS NOT NULL AND archived_at >= DATE_SUB(NOW(), INTERVAL 1 YEAR)', [Number(req.params.id)]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Archived recording not found or past its one-year retention period.' });
    await audit(req.session.user.id, 'restored', 'recording', req.params.id, null, req.ip);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Unable to restore recording.' }); }
});
app.delete('/api/recordings/:id', allow('admin'), async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid recording ID.' });
  try {
    const [[recording]] = await pool.execute('SELECT camera_id, file_name, archived_at FROM camera_recordings WHERE id = ?', [Number(req.params.id)]);
    if (!recording || !recording.archived_at) return res.status(404).json({ error: 'Archived recording not found.' });
    const fileName = path.basename(recording.file_name);
    if (!/^camera_\d+_\d{8}_\d{6}\.mp4$/.test(fileName)) return res.status(400).json({ error: 'Invalid recording file.' });
    try { await fs.unlink(path.join(recordingsRoot, String(recording.camera_id), fileName)); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await pool.execute('DELETE FROM camera_recordings WHERE id = ?', [Number(req.params.id)]);
    await audit(req.session.user.id, 'deleted', 'recording', req.params.id, null, req.ip);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Unable to delete recording.' }); }
});
app.get('/api/recordings/:id/video', requireAuth, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid recording ID.' });
  try {
    const [[recording]] = await pool.execute('SELECT camera_id, file_name FROM camera_recordings WHERE id = ? AND archived_at IS NULL', [Number(req.params.id)]);
    if (!recording || !/^camera_\d+_\d{8}_\d{6}\.mp4$/.test(recording.file_name)) return res.status(404).json({ error: 'Recording not found.' });
    const filePath = path.join(recordingsRoot, String(recording.camera_id), recording.file_name);
    await fs.access(filePath);
    res.type('video/mp4').sendFile(filePath, { headers: { 'Cache-Control': 'private, max-age=3600' } });
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ error: 'Recording file is no longer available.' });
    res.status(500).json({ error: 'Unable to play this recording.' });
  }
});
app.post('/api/cameras', allow('admin'), async (req, res) => {
  const { name, streamUrl, location = '' } = req.body || {};
  if (!name || !streamUrl || !/^https?:\/\//i.test(streamUrl)) return res.status(400).json({ error: 'Enter a camera name and valid HTTP(S) stream URL.' });
  try { const [r] = await pool.execute('INSERT INTO cameras (name, stream_url, location, created_by) VALUES (?, ?, ?, ?)', [name.slice(0, 100), streamUrl.slice(0, 2048), location.slice(0, 200), req.session.user.id]); await audit(req.session.user.id, 'created', 'camera', r.insertId, null, req.ip); await syncCameraRecorders(); res.status(201).json({ id: r.insertId, name, streamUrl, location, status: 'unknown' }); }
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
    await syncCameraRecorders();
    res.json({ id, streamUrl: parsedUrl.href });
  } catch { res.status(500).json({ error: 'Unable to save the shared camera URL.' }); }
});
app.patch('/api/cameras/:id', allow('admin'), async (req, res) => {
  const { name, streamUrl, location, isEnabled, status } = req.body || {};
  try { await pool.execute('UPDATE cameras SET name = COALESCE(?, name), stream_url = COALESCE(?, stream_url), location = COALESCE(?, location), is_enabled = COALESCE(?, is_enabled), last_status = COALESCE(?, last_status), last_checked_at = IF(? IS NULL, last_checked_at, NOW()) WHERE id = ? AND is_archived = 0', [name || null, streamUrl || null, location ?? null, isEnabled === undefined ? null : Number(Boolean(isEnabled)), status || null, status || null, req.params.id]); await syncCameraRecorders(); res.json({ ok: true }); }
  catch { res.status(500).json({ error: 'Unable to update camera.' }); }
});
app.patch('/api/cameras/:id/archive', allow('admin'), async (req, res) => {
  try { const [r] = await pool.execute('UPDATE cameras SET is_archived = 1 WHERE id = ?', [req.params.id]); if (!r.affectedRows) return res.status(404).json({ error: 'Camera not found.' }); await audit(req.session.user.id, 'archived', 'camera', req.params.id, null, req.ip); await syncCameraRecorders(); res.json({ ok: true }); }
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
app.get('/api/events', requireAuth, async (req, res) => {
  const month = String(req.query.month || '');
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: 'Choose a valid calendar month.' });
  const [year, monthNumber] = month.split('-').map(Number);
  const monthStart = `${month}-01 00:00:00`;
  const nextMonth = new Date(year, monthNumber, 1);
  const monthEnd = `${nextMonth.getFullYear()}-${String(nextMonth.getMonth() + 1).padStart(2, '0')}-01 00:00:00`;
  try {
    const [rows] = await pool.execute(`SELECT e.id, e.title, e.details, e.location, e.starts_at AS startsAt, e.ends_at AS endsAt, e.created_by AS createdBy, u.full_name AS creatorName, 'captain' AS createdByRole FROM calendar_events e LEFT JOIN users u ON u.id = e.created_by WHERE e.starts_at < ? AND e.ends_at >= ? ORDER BY e.starts_at`, [monthEnd, monthStart]);
    res.json(rows);
  } catch (error) {
    console.error('Unable to load calendar events:', error.message);
    res.status(500).json({ error: 'Unable to load calendar events. Apply the calendar events database migration first.' });
  }
});
app.post('/api/events', allow('captain'), async (req, res) => {
  const { title, details = '', location = '', startsAt, endsAt } = req.body || {};
  const validDateTime = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 180 || typeof details !== 'string' || details.length > 5000 || typeof location !== 'string' || location.length > 200 || !validDateTime(startsAt) || !validDateTime(endsAt) || endsAt <= startsAt) return res.status(400).json({ error: 'Enter an event name, valid start and end times, and details or location within the allowed lengths.' });
  try {
    const [result] = await pool.execute('INSERT INTO calendar_events (title, details, location, starts_at, ends_at, created_by) VALUES (?, ?, ?, ?, ?, ?)', [title.trim(), details.trim() || null, location.trim() || null, startsAt.replace('T', ' '), endsAt.replace('T', ' '), req.session.user.id]);
    await audit(req.session.user.id, 'created', 'calendar_event', result.insertId, null, req.ip);
    res.status(201).json({ id: result.insertId, title: title.trim(), details, location, startsAt: startsAt.replace('T', ' '), endsAt: endsAt.replace('T', ' '), creatorName: req.session.user.full_name, createdByRole: 'captain' });
  } catch (error) {
    console.error('Unable to create calendar event:', error.message);
    res.status(500).json({ error: 'Unable to create calendar event. Apply the calendar events database migration first.' });
  }
});
app.patch('/api/events/:id', allow('admin'), async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid event ID.' });
  const { title, details = '', location = '', startsAt, endsAt } = req.body || {};
  const validDateTime = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 180 || typeof details !== 'string' || details.length > 5000 || typeof location !== 'string' || location.length > 200 || !validDateTime(startsAt) || !validDateTime(endsAt) || endsAt <= startsAt) return res.status(400).json({ error: 'Enter an event name, valid start and end times, and details or location within the allowed lengths.' });
  try {
    const [[existing]] = await pool.execute('SELECT id FROM calendar_events WHERE id = ? AND created_by IS NOT NULL', [Number(req.params.id)]);
    if (!existing) return res.status(404).json({ error: 'Captain-created event not found.' });
    await pool.execute('UPDATE calendar_events SET title = ?, details = ?, location = ?, starts_at = ?, ends_at = ?, updated_by = ? WHERE id = ?', [title.trim(), details.trim() || null, location.trim() || null, startsAt.replace('T', ' '), endsAt.replace('T', ' '), req.session.user.id, Number(req.params.id)]);
    await audit(req.session.user.id, 'updated', 'calendar_event', req.params.id, null, req.ip);
    res.json({ ok: true });
  } catch (error) {
    console.error('Unable to update calendar event:', error.message);
    res.status(500).json({ error: 'Unable to update calendar event.' });
  }
});
app.post('/api/announcements', allow('captain', 'admin'), async (req, res) => { const { title, body } = req.body || {}; if (!title || !body) return res.status(400).json({ error: 'Title and announcement are required.' }); try { const [r] = await pool.execute('INSERT INTO announcements (title, body, created_by, published_at) VALUES (?, ?, ?, NOW())', [title.slice(0, 180), body.slice(0, 10000), req.session.user.id]); await audit(req.session.user.id, 'published', 'announcement', r.insertId, null, req.ip); res.status(201).json({ id: r.insertId, title, body }); } catch { res.status(500).json({ error: 'Unable to publish announcement.' }); } });
app.patch('/api/announcements/:id/archive', allow('admin'), async (req, res) => { try { const [r] = await pool.execute('UPDATE announcements SET is_published = 0 WHERE id = ?', [req.params.id]); if (!r.affectedRows) return res.status(404).json({ error: 'Announcement not found.' }); await audit(req.session.user.id, 'archived', 'announcement', req.params.id, null, req.ip); res.json({ ok: true }); } catch { res.status(500).json({ error: 'Unable to hide announcement.' }); } });

app.get('/api/tasks', requireAuth, async (req, res) => { try { const [rows] = await pool.execute(`SELECT t.id, t.title, t.details, t.status, t.due_at AS dueAt, t.duty_starts_at AS dutyStartsAt, t.duty_ends_at AS dutyEndsAt, t.assigned_to AS assignedTo, u.full_name AS assignee FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to ${req.session.user.role === 'tanod' ? 'WHERE t.assigned_to = ?' : ''} ORDER BY t.duty_starts_at DESC, t.created_at DESC`, req.session.user.role === 'tanod' ? [req.session.user.id] : []); res.json(rows); } catch { res.status(500).json({ error: 'Unable to load tasks. Apply the task duty database migration first.' }); } });
app.post('/api/tasks', allow('captain', 'admin'), async (req, res) => {
  const { title, details, assignedTo, dutyStartsAt, dutyEndsAt } = req.body || {};
  const validDateTime = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 180 || typeof details !== 'string' || !details.trim() || details.length > 5000 || !/^\d+$/.test(String(assignedTo || '')) || !validDateTime(dutyStartsAt) || !validDateTime(dutyEndsAt) || dutyEndsAt <= dutyStartsAt) return res.status(400).json({ error: 'Enter the task name, work description, a valid duty start and end time, and Tanod assignee.' });
  try {
    const [result] = await pool.execute("INSERT INTO tasks (title, details, assigned_to, assigned_by, duty_starts_at, duty_ends_at) SELECT ?, ?, id, ?, ?, ? FROM users WHERE id = ? AND role = 'tanod' AND is_active = 1", [title.trim(), details.trim(), req.session.user.id, dutyStartsAt.replace('T', ' '), dutyEndsAt.replace('T', ' '), Number(assignedTo)]);
    if (!result.affectedRows) return res.status(400).json({ error: 'Choose an active Tanod account.' });
    await audit(req.session.user.id, 'assigned', 'task', result.insertId, { assignedTo: Number(assignedTo), dutyStartsAt, dutyEndsAt }, req.ip);
    res.status(201).json({ id: result.insertId, title: title.trim(), details: details.trim(), status: 'Pending', assignedTo: Number(assignedTo), dutyStartsAt, dutyEndsAt });
  } catch (error) {
    console.error('Unable to assign task:', error.message);
    res.status(500).json({ error: 'Unable to assign task. Apply the task duty database migration first.' });
  }
});
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
app.post('/api/users', allow('admin'), async (req, res) => { const { fullName, username, password, role } = req.body || {}; if (!fullName || !validUsername(username) || typeof password !== 'string' || password.length < 8 || password.length > 16 || !roles.includes(role)) return res.status(400).json({ error: 'Provide a name, valid username, role, and password of 8–16 characters.' }); try { const hash = await bcrypt.hash(password, 12); const [r] = await pool.execute('INSERT INTO users (full_name, username, password_hash, role) VALUES (?, ?, ?, ?)', [fullName.trim().slice(0, 120), username.trim().toLowerCase().slice(0, 60), hash, role]); await audit(req.session.user.id, 'created', 'user', r.insertId, { role }, req.ip); res.status(201).json({ id: r.insertId, fullName, username, role, isActive: 1 }); } catch (error) { res.status(error.code === 'ER_DUP_ENTRY' ? 409 : 500).json({ error: error.code === 'ER_DUP_ENTRY' ? 'That username is already in use.' : 'Unable to create user.' }); } });
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

const httpServer = app.listen(PORT, '0.0.0.0', () => {
  console.log(`Barangay dashboard running at http://localhost:${PORT}`);
  purgeExpiredArchivedRecordings();
  setInterval(purgeExpiredArchivedRecordings, 24 * 60 * 60 * 1000).unref();
  syncCameraRecorders().catch((error) => console.error('Could not start camera recorders:', error.message));
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    for (const cameraId of cameraRecorders.keys()) stopCameraRecorder(cameraId);
    httpServer.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
