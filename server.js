require('dotenv').config();

const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const database = require('./database');
const PgSession = require('connect-pg-simple')(session);
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs/promises');
const { Readable } = require('stream');
const multer = require('multer');

const app = express();
const PORT = Number(process.env.PORT || 3000);
if (process.env.VERCEL || process.env.RENDER) app.set('trust proxy', 1);
if ((process.env.VERCEL || process.env.NODE_ENV === 'production') && !process.env.SESSION_SECRET) {
  throw new Error('SESSION_SECRET must be set in production.');
}
const sessionSecret = process.env.SESSION_SECRET || crypto.randomBytes(48).toString('hex');
const pool = database;
const recordingsRoot = path.resolve(process.env.RECORDINGS_DIR || path.join(__dirname, 'storage', 'recordings'));
const supabaseUrl = process.env.SUPABASE_URL?.replace(/\/$/, '');
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
async function storageRequest(filePath, options = {}) {
  if (!supabaseUrl || !supabaseServiceKey) throw new Error('Supabase Storage environment is not configured.');
  return fetch(`${supabaseUrl}/storage/v1/object/${filePath}`, {
    ...options,
    headers: { Authorization: `Bearer ${supabaseServiceKey}`, apikey: supabaseServiceKey, ...(options.headers || {}) }
  });
}
const taskProofUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024 }, fileFilter: (_req, file, callback) => callback(null, ['image/jpeg', 'image/png', 'image/webp'].includes(file.mimetype)) });
const cameraRecordingUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 250 * 1024 * 1024 }, fileFilter: (_req, file, callback) => callback(null, ['video/webm', 'video/mp4'].includes(file.mimetype.split(';')[0].toLowerCase())) });
const parseTaskProofUpload = (req, res, next) => taskProofUpload.single('picture')(req, res, (error) => {
  if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Proof pictures must be 4 MB or smaller.' : 'Unable to read the proof picture.' });
  next();
});

app.use(express.json({ limit: '2mb' }));
app.use(session({
  name: 'barangay.sid',
  secret: process.env.SESSION_SECRET || sessionSecret,
  store: new PgSession({ pool: database.pool, createTableIfMissing: true, schemaName: 'private', tableName: 'user_sessions' }),
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' || Boolean(process.env.VERCEL), maxAge: 8 * 60 * 60 * 1000 }
}));
app.use(express.static(path.join(__dirname, 'public')));

const validUsername = (value) => /^[a-zA-Z0-9._-]{3,60}$/.test(String(value || '').trim());
const isAtLeast18 = (value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return false;
  const birthDate = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(birthDate.getTime()) || birthDate.toISOString().slice(0, 10) !== value) return false;
  const today = new Date();
  const cutoff = new Date(Date.UTC(today.getUTCFullYear() - 18, today.getUTCMonth(), today.getUTCDate()));
  return value <= cutoff.toISOString().slice(0, 10);
};
const validProfile = ({ firstName, middleName, lastName, gender, dateOfBirth }) => Boolean(String(firstName || '').trim() && String(firstName).trim().length <= 60 && String(middleName || '').trim().length <= 60 && String(lastName || '').trim() && String(lastName).trim().length <= 60 && ['female', 'male'].includes(gender) && isAtLeast18(dateOfBirth));
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
  if (!validProfile({ firstName, middleName, lastName, gender, dateOfBirth }) || !validUsername(username) || typeof password !== 'string' || password.length < 8 || password.length > 16 || !['tanod', 'captain'].includes(requestedRole)) {
    return res.status(400).json({ error: 'You must be at least 18 years old. Enter your profile details, username, password, and requested role.' });
  }
  try {
    const hash = await bcrypt.hash(String(password), 12);
    const fullName = [String(firstName).trim(), String(middleName).trim(), String(lastName).trim()].filter(Boolean).join(' ');
    await pool.execute("INSERT INTO users (full_name, first_name, middle_name, last_name, gender, date_of_birth, username, password_hash, role, requested_role, approval_status, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'tanod', ?, 'pending', 0)",
      [fullName, String(firstName).trim(), String(middleName).trim() || null, String(lastName).trim(), gender, dateOfBirth, String(username).trim().toLowerCase(), hash, requestedRole]);
    res.status(201).json({ pending: true, message: 'Your account request has been sent to an administrator for review.' });
  } catch (error) {
    res.status(['ER_DUP_ENTRY', '23505'].includes(error.code) ? 409 : 500).json({ error: ['ER_DUP_ENTRY', '23505'].includes(error.code) ? 'That username is already in use.' : 'Unable to submit your account request.' });
  }
});

app.post('/api/auth/setup', async (req, res) => {
  const { firstName, middleName = '', lastName, gender, dateOfBirth, username, password } = req.body || {};
  if (!validProfile({ firstName, middleName, lastName, gender, dateOfBirth }) || !validUsername(username) || typeof password !== 'string' || password.length < 8 || password.length > 16) return res.status(400).json({ error: 'You must be at least 18 years old. Enter your profile details, username, and password.' });
  const conn = await pool.getConnection();
  let setupLock = false;
  try {
    await conn.beginTransaction();
    const [[lock]] = await conn.query("SELECT GET_LOCK('barangay_dashboard_first_admin', 5) AS acquired");
    setupLock = lock.acquired === true || Number(lock.acquired) === 1;
    if (!setupLock) { await conn.rollback(); return res.status(503).json({ error: 'Admin setup is busy. Please try again.' }); }
    const [[{ total }]] = await conn.query("SELECT COUNT(*) AS total FROM users WHERE role = 'admin' AND approval_status = 'approved' AND is_active = 1");
    if (Number(total) !== 0) { await conn.rollback(); return res.status(403).json({ error: 'Initial admin setup is already complete.' }); }
    const hash = await bcrypt.hash(String(password), 12);
    const fullName = [String(firstName).trim(), String(middleName).trim(), String(lastName).trim()].filter(Boolean).join(' ');
    const [result] = await conn.execute("INSERT INTO users (full_name, first_name, middle_name, last_name, gender, date_of_birth, username, password_hash, role, approval_status, is_active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'admin', 'approved', 1)", [fullName, String(firstName).trim(), String(middleName).trim() || null, String(lastName).trim(), gender, dateOfBirth, String(username).trim().toLowerCase().slice(0, 60), hash]);
    await conn.commit();
    const user = { id: result.insertId, full_name: String(fullName).trim(), username: String(username).trim().toLowerCase(), role: 'admin' };
    req.session.regenerate((err) => { if (err) return res.status(500).json({ error: 'Could not start your session.' }); req.session.user = publicUser(user); res.status(201).json({ user: req.session.user }); });
  } catch (error) {
    await conn.rollback();
    res.status(['ER_DUP_ENTRY', '23505'].includes(error.code) ? 409 : 500).json({ error: ['ER_DUP_ENTRY', '23505'].includes(error.code) ? 'That username is already in use.' : 'Unable to create the first admin.' });
  } finally { conn.release(); }
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

const ensureCameraAlerts = require('./camera-alerts')(app, database.pool, requireAuth, allow);
require('./face-management')(app, database.pool, requireAuth, allow);
const deviceRecordings = require('./device-recordings')(app, database.pool, requireAuth, allow);
require('./announcement-notifications')(app, database.pool, allow);
require('./account-passwords')(app, database.pool, allow);

app.get('/api/cameras', requireAuth, async (_req, res) => {
  try { const [rows] = await pool.query('SELECT id, name, stream_url AS streamUrl, location, is_enabled AS isEnabled, last_status AS status, last_checked_at AS lastCheckedAt FROM cameras WHERE is_archived = 0 ORDER BY id'); res.json(rows); }
  catch { res.status(500).json({ error: 'Unable to load cameras.' }); }
});
app.get('/api/cameras/:id/relay-url', requireAuth, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid camera ID.' });
  const relayBase = process.env.CAMERA_RELAY_BASE_URL?.replace(/\/$/, '');
  const relaySecret = process.env.CAMERA_RELAY_SECRET;
  let parsedRelayBase;
  try { parsedRelayBase = new URL(relayBase); } catch { return res.status(503).json({ error: 'The secure camera relay has not been configured.' }); }
  if (parsedRelayBase.protocol !== 'https:' || parsedRelayBase.pathname !== '/' || parsedRelayBase.search || parsedRelayBase.hash || parsedRelayBase.username || parsedRelayBase.password || !relaySecret || Buffer.byteLength(relaySecret) < 32) return res.status(503).json({ error: 'The secure camera relay has not been configured.' });
  try {
    const [[camera]] = await pool.execute('SELECT stream_url FROM cameras WHERE id = ? AND is_archived = false AND is_enabled = true', [Number(req.params.id)]);
    if (!camera) return res.status(404).json({ error: 'Camera is not available.' });
    const payload = Buffer.from(JSON.stringify({ cameraId: Number(req.params.id), streamUrl: camera.stream_url, expiresAt: Date.now() + 5 * 60 * 1000 })).toString('base64url');
    const signature = crypto.createHmac('sha256', relaySecret).update(payload).digest('base64url');
    res.set('Cache-Control', 'no-store').json({ url: `${relayBase}/cameras/${Number(req.params.id)}/stream?token=${payload}.${signature}` });
  } catch { res.status(500).json({ error: 'Unable to authorize the camera stream.' }); }
});
app.get('/api/cameras/:id/stream', requireAuth, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid camera ID.' });
  const abortController = new AbortController();
  res.on('close', () => abortController.abort());
  try {
    const [[camera]] = await pool.execute('SELECT stream_url FROM cameras WHERE id = ? AND is_archived = false AND is_enabled = true', [Number(req.params.id)]);
    if (!camera) return res.status(404).json({ error: 'Camera is not available.' });
    let streamUrl = camera.stream_url;
    const relayBase = process.env.CAMERA_RELAY_BASE_URL?.replace(/\/$/, '');
    const relaySecret = process.env.CAMERA_RELAY_SECRET;
    if (relayBase && relaySecret && Buffer.byteLength(relaySecret) >= 32) {
      const payload = Buffer.from(JSON.stringify({ cameraId: Number(req.params.id), streamUrl, expiresAt: Date.now() + 5 * 60 * 1000 })).toString('base64url');
      const signature = crypto.createHmac('sha256', relaySecret).update(payload).digest('base64url');
      streamUrl = `${relayBase}/cameras/${Number(req.params.id)}/stream?token=${payload}.${signature}`;
    }
    const upstream = await fetch(streamUrl, { signal: abortController.signal, headers: { Accept: 'multipart/x-mixed-replace, image/jpeg' } });
    if (!upstream.ok || !upstream.body) return res.status(502).json({ error: 'Unable to connect to the camera stream.' });
    res.status(200).set('Content-Type', upstream.headers.get('content-type') || 'multipart/x-mixed-replace; boundary=frame').set('Cache-Control', 'no-store');
    for await (const chunk of Readable.fromWeb(upstream.body)) {
      if (res.destroyed) break;
      if (!res.write(chunk)) await new Promise((resolve) => res.once('drain', resolve));
    }
    if (!res.destroyed) res.end();
  } catch (error) {
    if (!res.headersSent && !abortController.signal.aborted) res.status(502).json({ error: 'Unable to connect to the camera stream.' });
  }
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
  if (archived && req.session.user.role !== 'admin') return res.status(403).json({ error: 'Archive is available only to administrators.' });
  const conditions = ['r.archived_at IS ' + (archived ? 'NOT ' : '') + 'NULL'];
  if (!archived) conditions.push('c.is_archived = 0', 'c.is_enabled = 1');
  const params = [];
  if (cameraId) { conditions.push('r.camera_id = ?'); params.push(Number(cameraId)); }
  if (start) { conditions.push("(CASE WHEN r.storage_provider = 'r2' THEN r.ended_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila' ELSE r.ended_at END) >= ?"); params.push(start); }
  if (end) { conditions.push("(CASE WHEN r.storage_provider = 'r2' THEN r.started_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Manila' ELSE r.started_at END) <= ?"); params.push(end); }
  try {
    const [rows] = await pool.execute(`SELECT r.id, r.camera_id AS cameraId, c.name AS cameraName,
      to_char(r.started_at, 'YYYY-MM-DD"T"HH24:MI:SS') || CASE WHEN r.storage_provider = 'r2' THEN 'Z' ELSE '' END AS startedAt,
      to_char(r.ended_at, 'YYYY-MM-DD"T"HH24:MI:SS') || CASE WHEN r.storage_provider = 'r2' THEN 'Z' ELSE '' END AS endedAt,
      r.duration_seconds AS durationSeconds, r.file_size_bytes AS fileSizeBytes, r.archived_at AS archivedAt, r.storage_provider AS storageProvider, r.file_name AS fileName
      FROM camera_recordings r JOIN cameras c ON c.id = r.camera_id WHERE ${conditions.join(' AND ')} ORDER BY r.started_at DESC LIMIT 500`, params);
    res.json(rows);
  } catch (error) {
    console.error('Unable to query camera recordings:', error.message);
    res.status(500).json({ error: 'Unable to load recorded footage. Apply the camera recordings database migration first.' });
  }
});
app.post('/api/recordings/upload-url', requireAuth, async (req, res) => {
  const cameraId = Number(req.body?.cameraId);
  const contentType = String(req.body?.contentType || '').split(';')[0].toLowerCase();
  if (!Number.isSafeInteger(cameraId) || cameraId < 1 || !['video/webm', 'video/mp4'].includes(contentType)) return res.status(400).json({ error: 'Choose a camera and supported recording format.' });
  if (!supabaseUrl || !supabaseServiceKey) return res.json({ localUpload: true });
  if (!process.env.SUPABASE_PUBLISHABLE_KEY) return res.status(503).json({ error: 'Set SUPABASE_PUBLISHABLE_KEY to enable direct recording uploads.' });
  try {
    const [[camera]] = await pool.execute('SELECT id FROM cameras WHERE id = ? AND is_archived = false AND is_enabled = true', [cameraId]);
    if (!camera) return res.status(404).json({ error: 'Camera is not available.' });
    const extension = contentType === 'video/mp4' ? 'mp4' : 'webm';
    const fileName = String(req.body?.fileName || '');
    if (!new RegExp(`^camera_${cameraId}_\\d{8}_\\d{6}_[a-f0-9]{8}\\.${extension}$`).test(fileName)) return res.status(400).json({ error: 'Invalid recording file name.' });
    const storagePath = `recordings/${cameraId}/${fileName}`;
    const signed = await storageRequest(`upload/sign/camera-evidence/${storagePath}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
    if (!signed.ok) throw new Error(`Could not create upload link (${signed.status}).`);
    const result = await signed.json();
    const uploadUrl = result.url.startsWith('http') ? result.url : `${supabaseUrl}/storage/v1${result.url}`;
    res.set('Cache-Control', 'no-store').json({ uploadUrl, publishableKey: process.env.SUPABASE_PUBLISHABLE_KEY, storagePath, fileName });
  } catch (error) {
    console.error('Unable to prepare recording upload:', error.message);
    res.status(500).json({ error: 'Unable to prepare secure recording upload.' });
  }
});
app.post('/api/recordings', requireAuth, (req, res, next) => {
  if (!req.is('multipart/form-data')) return next();
  cameraRecordingUpload.single('video')(req, res, (error) => {
    if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Recordings must be 250 MB or smaller.' : 'Upload a supported WebM or MP4 recording.' });
    next();
  });
}, async (req, res) => {
  const cameraId = Number(req.body?.cameraId);
  const startedValue = String(req.body?.startedAt || '');
  const endedValue = String(req.body?.endedAt || '');
  const fileNameFromClient = String(req.body?.fileName || '');
  const requestedStoragePath = String(req.body?.storagePath || '');
  const fileSize = Number(req.body?.fileSize || req.file?.size || 0);
  const contentType = (req.file?.mimetype || String(req.body?.contentType || '')).split(';')[0].toLowerCase();
  const localTimestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(startedValue) && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(endedValue);
  const startedAt = new Date(startedValue);
  const endedAt = new Date(endedValue);
  const durationSeconds = Math.round((endedAt - startedAt) / 1000);
  if ((!req.file && !requestedStoragePath) || !Number.isSafeInteger(cameraId) || cameraId < 1 || !localTimestamp || Number.isNaN(startedAt.getTime()) || Number.isNaN(endedAt.getTime()) || durationSeconds < 1 || durationSeconds > 86400 || !Number.isSafeInteger(fileSize) || fileSize < 1 || fileSize > 250 * 1024 * 1024 || !['video/webm', 'video/mp4'].includes(contentType)) {
    return res.status(400).json({ error: 'A camera, video, and valid recording time are required.' });
  }
  let storagePath = null;
  let localFilePath = null;
  let insertedRecordingId = null;
  const extension = contentType === 'video/mp4' ? 'mp4' : 'webm';
  const stamp = `${startedValue.slice(0, 10).replace(/-/g, '')}_${startedValue.slice(11, 19).replace(/:/g, '')}`;
  const fileName = fileNameFromClient || `camera_${cameraId}_${stamp}_${crypto.randomBytes(4).toString('hex')}.${extension}`;
  if (!new RegExp(`^camera_${cameraId}_\\d{8}_\\d{6}_[a-f0-9]{8}\\.${extension}$`).test(fileName)) return res.status(400).json({ error: 'Invalid recording file name.' });
  if (requestedStoragePath && (!supabaseUrl || !supabaseServiceKey || requestedStoragePath !== `recordings/${cameraId}/${fileName}`)) return res.status(400).json({ error: 'Invalid recording storage path.' });
  if (!requestedStoragePath && !req.file) return res.status(400).json({ error: 'The recording upload is missing.' });
  try {
    const [[camera]] = await pool.execute('SELECT id FROM cameras WHERE id = ? AND is_archived = false AND is_enabled = true', [cameraId]);
    if (!camera) return res.status(404).json({ error: 'Camera is not available.' });
    if (requestedStoragePath) {
      storagePath = requestedStoragePath;
    } else {
      const directory = path.join(recordingsRoot, String(cameraId));
      await fs.mkdir(directory, { recursive: true });
      localFilePath = path.join(directory, fileName);
      await fs.writeFile(localFilePath, req.file.buffer, { flag: 'wx' });
    }
    const dbStartedAt = startedValue.replace('T', ' ').slice(0, 19);
    const dbEndedAt = endedValue.replace('T', ' ').slice(0, 19);
    const [result] = await pool.execute('INSERT INTO camera_recordings (camera_id, file_name, started_at, ended_at, duration_seconds, file_size_bytes, storage_path) VALUES (?, ?, ?, ?, ?, ?, ?)', [cameraId, fileName, dbStartedAt, dbEndedAt, durationSeconds, fileSize, storagePath]);
    insertedRecordingId = result.insertId;
    await audit(req.session.user.id, 'created', 'recording', result.insertId, { cameraId, fileName }, req.ip);
    res.status(201).json({ id: result.insertId, fileName, durationSeconds, fileSizeBytes: fileSize });
  } catch (error) {
    if (insertedRecordingId) await pool.execute('DELETE FROM camera_recordings WHERE id = ?', [insertedRecordingId]).catch(() => {});
    if (storagePath) await storageRequest(`camera-evidence/${storagePath}`, { method: 'DELETE' }).catch(() => {});
    if (localFilePath) await fs.unlink(localFilePath).catch(() => {});
    console.error('Unable to save camera recording:', error.message);
    res.status(500).json({ error: 'Unable to save this recording. Confirm the camera_recordings table and camera-evidence bucket are configured.' });
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
    const [[recording]] = await pool.execute('SELECT camera_id, file_name, archived_at, storage_path, storage_provider FROM camera_recordings WHERE id = ?', [Number(req.params.id)]);
    if (!recording || !recording.archived_at) return res.status(404).json({ error: 'Archived recording not found.' });
    const fileName = path.basename(recording.file_name);
    if (!/^camera_\d+_(?:\d{8}_\d{6}(?:_[a-f0-9]{8})?\.(?:mp4|webm)|[a-f0-9]{32}\.avi)$/.test(fileName)) return res.status(400).json({ error: 'Invalid recording file.' });
    if (recording.storage_provider === 'r2') {
      await deviceRecordings.storage.remove(recording.storage_path);
    } else if (recording.storage_path) {
      const removed = await storageRequest(`camera-evidence/${recording.storage_path}`, { method: 'DELETE' });
      if (!removed.ok && removed.status !== 404) throw new Error(`Could not delete stored video (${removed.status}).`);
    } else {
      try { await fs.unlink(path.join(recordingsRoot, String(recording.camera_id), fileName)); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    await pool.execute('DELETE FROM camera_recordings WHERE id = ?', [Number(req.params.id)]);
    await audit(req.session.user.id, 'deleted', 'recording', req.params.id, null, req.ip);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Unable to delete recording.' }); }
});
app.get('/api/recordings/:id/video', requireAuth, async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid recording ID.' });
  try {
    const [[recording]] = await pool.execute('SELECT r.camera_id, r.file_name, r.storage_path, r.storage_provider FROM camera_recordings r JOIN cameras c ON c.id = r.camera_id WHERE r.id = ? AND r.archived_at IS NULL AND c.is_enabled = true AND c.is_archived = false', [Number(req.params.id)]);
    if (!recording || !/^camera_\d+_(?:\d{8}_\d{6}(?:_[a-f0-9]{8})?\.(?:mp4|webm)|[a-f0-9]{32}\.avi)$/.test(recording.file_name)) return res.status(404).json({ error: 'Recording not found.' });
    if (recording.storage_provider === 'r2') return res.set('Cache-Control', 'private, no-store').redirect(302, await deviceRecordings.storage.videoUrl(recording.storage_path, true));
    if (recording.storage_path) {
      const signed = await storageRequest(`sign/camera-evidence/${recording.storage_path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresIn: 300 }) });
      if (!signed.ok) throw new Error(`Could not create signed video link (${signed.status}).`);
      const result = await signed.json();
      const url = result.signedURL || result.signedUrl;
      if (!url) throw new Error('Storage returned no signed video link.');
      return res.redirect(302, url.startsWith('http') ? url : `${supabaseUrl}/storage/v1${url}`);
    }
    const filePath = path.join(recordingsRoot, String(recording.camera_id), recording.file_name);
    await fs.access(filePath);
    res.type(path.extname(filePath)).sendFile(filePath, { headers: { 'Cache-Control': 'private, max-age=3600' } });
  } catch (error) {
    if (error.code === 'ENOENT') return res.status(404).json({ error: 'Recording file is no longer available.' });
    res.status(500).json({ error: 'Unable to play this recording.' });
  }
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
  try { const [[cams]] = await pool.query('SELECT COUNT(*) AS total, SUM(last_status = \'online\') AS online FROM cameras WHERE is_archived = 0 AND is_enabled = 1'); await ensureCameraAlerts(); const { rows: [alerts] } = await database.pool.query("SELECT COUNT(*) FILTER (WHERE status = 'pending') AS active, COUNT(*) FILTER (WHERE (detected_at AT TIME ZONE 'Asia/Manila')::date = (NOW() AT TIME ZONE 'Asia/Manila')::date) AS today FROM camera_alerts"); res.json({ cameras: Number(cams.total || 0), online: Number(cams.online || 0), active: Number(alerts.active || 0), today: Number(alerts.today || 0) }); }
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
    const [rows] = await pool.execute(`SELECT e.id, e.title, e.details, e.location, to_char(e.starts_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS startsAt, to_char(e.ends_at, 'YYYY-MM-DD"T"HH24:MI:SS') AS endsAt, e.created_by AS createdBy, u.full_name AS creatorName, 'captain' AS createdByRole FROM calendar_events e LEFT JOIN users u ON u.id = e.created_by WHERE e.starts_at < ? AND e.ends_at >= ? ORDER BY e.starts_at`, [monthEnd, monthStart]);
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
app.patch('/api/events/:id', allow('captain', 'admin'), async (req, res) => {
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid event ID.' });
  const { title, details = '', location = '', startsAt, endsAt } = req.body || {};
  const validDateTime = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) && !Number.isNaN(Date.parse(value));
  if (typeof title !== 'string' || !title.trim() || title.trim().length > 180 || typeof details !== 'string' || details.length > 5000 || typeof location !== 'string' || location.length > 200 || !validDateTime(startsAt) || !validDateTime(endsAt) || endsAt <= startsAt) return res.status(400).json({ error: 'Enter an event name, valid start and end times, and details or location within the allowed lengths.' });
  try {
    const [[existing]] = await pool.execute('SELECT id, created_by AS createdBy FROM calendar_events WHERE id = ? AND created_by IS NOT NULL', [Number(req.params.id)]);
    if (!existing) return res.status(404).json({ error: 'Captain-created event not found.' });
    if (req.session.user.role === 'captain' && Number(existing.createdBy) !== Number(req.session.user.id)) return res.status(403).json({ error: 'You can only edit events you created.' });
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

app.get('/api/tasks', requireAuth, async (req, res) => { try { const filter = req.session.user.role === 'tanod' ? 'WHERE t.assigned_to = ?' : ''; const [rows] = await pool.execute(`SELECT t.id, t.title, t.details, t.status, t.due_at AS dueAt, t.duty_starts_at AS dutyStartsAt, t.duty_ends_at AS dutyEndsAt, t.assigned_to AS assignedTo, u.full_name AS assignee, t.proof_description AS proofDescription, t.proof_image AS proofImage, t.proof_submitted_at AS proofSubmittedAt, t.proof_status AS proofStatus FROM tasks t LEFT JOIN users u ON u.id = t.assigned_to ${filter} ORDER BY t.duty_starts_at DESC, t.created_at DESC`, req.session.user.role === 'tanod' ? [req.session.user.id] : []); res.json(rows); } catch { res.status(500).json({ error: 'Unable to load tasks. Apply the task proof migration first.' }); } });
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
app.post('/api/tasks/:id/proof', allow('tanod'), parseTaskProofUpload, async (req, res) => {
  const description = String(req.body.description || '').trim();
  if (!description || description.length > 2000 || !req.file) return res.status(400).json({ error: 'Add a description and a JPG, PNG, or WebP proof picture (up to 4 MB).' });
  const extension = ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' })[req.file.mimetype];
  if (!extension) return res.status(400).json({ error: 'Only JPG, PNG, and WebP pictures are accepted.' });
  const bytes = req.file.buffer;
  const validImage = extension === '.jpg' ? bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff
    : extension === '.png' ? bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (!validImage) return res.status(400).json({ error: 'The uploaded file is not a valid JPG, PNG, or WebP picture.' });
  try {
    const [[task]] = await pool.execute("SELECT id, status, proof_status FROM tasks WHERE id = ? AND assigned_to = ?", [req.params.id, req.session.user.id]);
    if (!task) return res.status(404).json({ error: 'Task not found.' });
    if (['Completed', 'Cancelled'].includes(task.status) || task.proof_status === 'Pending') return res.status(409).json({ error: 'This task cannot accept a proof submission right now.' });
    const filename = `${crypto.randomUUID()}${extension}`;
    const upload = await storageRequest(`task-proofs/${filename}`, { method: 'POST', headers: { 'Content-Type': req.file.mimetype, 'x-upsert': 'false' }, body: req.file.buffer });
    if (!upload.ok) throw new Error(`Supabase Storage upload failed (${upload.status}).`);
    await pool.execute("UPDATE tasks SET status = 'In Progress', proof_description = ?, proof_image = ?, proof_submitted_at = NOW(), proof_status = 'Pending', proof_reviewed_by = NULL, proof_reviewed_at = NULL WHERE id = ? AND assigned_to = ?", [description, filename, req.params.id, req.session.user.id]);
    await audit(req.session.user.id, 'proof_submitted', 'task', req.params.id, null, req.ip);
    res.status(201).json({ ok: true });
  } catch (error) { console.error('Unable to save task proof:', error.message); res.status(500).json({ error: 'Unable to submit task proof.' }); }
});
app.get('/api/tasks/:id/proof', requireAuth, async (req, res) => {
  try {
    const [[task]] = await pool.execute('SELECT assigned_to AS assignedTo, assigned_by AS assignedBy, proof_image AS proofImage FROM tasks WHERE id = ?', [req.params.id]);
    const user = req.session.user;
    if (!task || !task.proofImage || (user.role === 'tanod' && Number(task.assignedTo) !== Number(user.id))) return res.status(404).json({ error: 'Proof not found.' });
    const file = await storageRequest(`authenticated/task-proofs/${encodeURIComponent(path.basename(task.proofImage))}`);
    if (!file.ok) return res.status(file.status === 404 ? 404 : 502).json({ error: 'Unable to load proof picture.' });
    const bytes = Buffer.from(await file.arrayBuffer());
    res.set('Cache-Control', 'private, no-store').set('X-Content-Type-Options', 'nosniff').type(path.extname(task.proofImage)).send(bytes);
  } catch { res.status(500).json({ error: 'Unable to load proof picture.' }); }
});
app.post('/api/tasks/:id/review', allow('captain', 'admin'), async (req, res) => {
  const { decision } = req.body || {};
  if (!['approved', 'rejected'].includes(decision)) return res.status(400).json({ error: 'Choose approve or reject.' });
  try {
    const [result] = await pool.execute("UPDATE tasks SET proof_status = ?, proof_reviewed_by = ?, proof_reviewed_at = NOW(), status = IF(? = 'approved', 'Completed', 'In Progress'), completed_at = IF(? = 'approved', NOW(), NULL) WHERE id = ? AND proof_status = 'Pending'", [decision === 'approved' ? 'Approved' : 'Rejected', req.session.user.id, decision, decision, req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Pending proof not found for a task you can review.' });
    await audit(req.session.user.id, `proof_${decision}`, 'task', req.params.id, null, req.ip);
    res.json({ ok: true });
  } catch (error) { console.error('Unable to review task proof:', error.message); res.status(500).json({ error: 'Unable to review task proof.' }); }
});
app.patch('/api/tasks/:id', requireAuth, async (_req, res) => res.status(403).json({ error: 'Tasks can only be completed after proof is submitted and approved.' }));

app.get('/api/users', allow('admin'), async (_req, res) => { try { const [rows] = await pool.query("SELECT id, full_name AS fullName, username, role, is_active AS isActive FROM users WHERE approval_status = 'approved' AND role IN ('tanod', 'captain') ORDER BY full_name"); res.json(rows); } catch { res.status(500).json({ error: 'Unable to load users.' }); } });
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
app.post('/api/users', allow('admin'), async (req, res) => {
  const { fullName, username, password, role } = req.body || {};
  if (!fullName || !validUsername(username) || typeof password !== 'string' || password.length < 8 || password.length > 16 || !['tanod', 'captain'].includes(role)) return res.status(400).json({ error: 'Provide a name, valid username, Tanod or Captain role, and password of 8–16 characters.' });
  try {
    const hash = await bcrypt.hash(password, 12);
    const [result] = await pool.execute('INSERT INTO users (full_name, username, password_hash, role) VALUES (?, ?, ?, ?)', [fullName.trim().slice(0, 120), username.trim().toLowerCase().slice(0, 60), hash, role]);
    await audit(req.session.user.id, 'created', 'user', result.insertId, { role }, req.ip);
    res.status(201).json({ id: result.insertId, fullName, username, role, isActive: 1 });
  } catch (error) {
    const duplicate = ['ER_DUP_ENTRY', '23505'].includes(error.code);
    res.status(duplicate ? 409 : 500).json({ error: duplicate ? 'That username is already in use.' : 'Unable to create user.' });
  }
});
app.patch('/api/users/:id/role', allow('admin'), async (req, res) => {
  const { role } = req.body || {};
  if (!['tanod', 'captain'].includes(role)) return res.status(400).json({ error: 'Only Tanod and Captain roles can be assigned here.' });
  if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid user ID.' });
  try {
    const [result] = await pool.execute("UPDATE users SET role = ? WHERE id = ? AND role IN ('tanod', 'captain') AND approval_status = 'approved'", [role, Number(req.params.id)]);
    if (!result.affectedRows) return res.status(404).json({ error: 'Approved Tanod or Captain account not found.' });
    await audit(req.session.user.id, 'role_changed', 'user', req.params.id, { role }, req.ip);
    res.json({ ok: true });
  } catch { res.status(500).json({ error: 'Unable to update role.' }); }
});
app.patch('/api/auth/password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword, confirmPassword } = req.body || {};
  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 16 || newPassword !== confirmPassword) {
    return res.status(400).json({ error: 'Enter your current password, a matching new password, and confirm it (8–16 characters).' });
  }
  try {
    const [[user]] = await pool.execute('SELECT password_hash AS passwordHash FROM users WHERE id = ?', [req.session.user.id]);
    if (!user || !(await bcrypt.compare(currentPassword, user.passwordHash))) return res.status(401).json({ error: 'Your current password is incorrect.' });
    const hash = await bcrypt.hash(newPassword, 12);
    await pool.execute('UPDATE users SET password_hash = ? WHERE id = ?', [hash, req.session.user.id]);
    await audit(req.session.user.id, 'password_changed', 'user', req.session.user.id, null, req.ip);
    const signedInUser = req.session.user;
    req.session.regenerate((error) => {
      if (error) return res.status(500).json({ error: 'Password changed, but the session could not be refreshed. Please log in again.' });
      req.session.user = signedInUser;
      req.session.save((saveError) => {
        if (saveError) return res.status(500).json({ error: 'Password changed, but the session could not be saved. Please log in again.' });
        res.json({ ok: true, message: 'Your password has been updated.' });
      });
    });
  } catch (error) {
    console.error('Unable to change account password:', error.message);
    res.status(500).json({ error: 'Unable to change your password.' });
  }
});

if (require.main === module) {
  const httpServer = app.listen(PORT, '0.0.0.0', () => {
    console.log(`Barangay dashboard running at http://localhost:${PORT}`);
    if (!process.env.VERCEL) {
      const addresses = Object.values(os.networkInterfaces()).flatMap((interfaces) => interfaces || [])
        .filter((network) => network.family === 'IPv4' && !network.internal)
        .map((network) => network.address);
      for (const address of [...new Set(addresses)]) console.log(`On this Wi-Fi, open http://${address}:${PORT}`);
    }
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      httpServer.close(() => pool.end().finally(() => process.exit(0)));
      setTimeout(() => process.exit(1), 10000).unref();
    });
  }
}

module.exports = app;
