const crypto = require('node:crypto');
const schemas = require('./database/runtime-schemas');
const createStorage = require('./r2-storage');
const MAX_BYTES = 64 * 1024 * 1024;
const validId = (id) => /^[1-9]\d{0,15}$/.test(String(id));
const digest = (token) => crypto.createHash('sha256').update(token).digest('hex');

module.exports = function registerDeviceRecordings(app, pool, requireAuth, allow, storage = createStorage()) {
  let schemaReady;
  const ensureSchema = () => schemaReady ||= pool.query(schemas.deviceRecordings).catch((error) => { schemaReady = null; throw error; });
  const handle = (fn) => async (req, res) => {
    try { await ensureSchema(); await fn(req, res); }
    catch (error) {
      console.error('Device recordings:', error.code || error.name);
      if (!res.headersSent) res.status(error.status || 503).json({ error: error.status === 503 ? error.message : 'Unable to access device recordings. Check the database and R2 configuration.' });
    }
  };
  const deviceAuth = async (req, res, next) => {
    const match = /^Bearer (bwcam_\d+_[a-f0-9]{64})$/.exec(req.headers.authorization || '');
    if (!match) return res.status(401).json({ error: 'A valid camera device token is required.' });
    const cameraId = match[1].split('_')[1];
    if (!validId(cameraId)) return res.sendStatus(401);
    try {
      await ensureSchema();
      const { rows: [row] } = await pool.query(`SELECT t.token_hash FROM camera_device_tokens t JOIN cameras c ON c.id = t.camera_id
        WHERE t.camera_id = $1 AND c.is_enabled = true AND c.is_archived = false`, [cameraId]);
      const actual = Buffer.from(digest(match[1]), 'hex');
      const expected = Buffer.from(row?.token_hash || '', 'hex');
      if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return res.status(401).json({ error: 'Camera token is invalid, revoked, or disabled.' });
      req.deviceCameraId = cameraId;
      next();
    } catch { res.status(503).json({ error: 'Unable to authenticate this camera.' }); }
  };

  app.post('/api/cameras/:id/device-token', allow('admin'), handle(async (req, res) => {
    if (!validId(req.params.id)) return res.sendStatus(400);
    const { rows: [camera] } = await pool.query('SELECT id FROM cameras WHERE id = $1 AND is_enabled = true AND is_archived = false', [req.params.id]);
    if (!camera) return res.status(404).json({ error: 'Save and enable the camera first.' });
    const token = `bwcam_${req.params.id}_${crypto.randomBytes(32).toString('hex')}`;
    await pool.query(`INSERT INTO camera_device_tokens (camera_id, token_hash) VALUES ($1, $2)
      ON CONFLICT (camera_id) DO UPDATE SET token_hash = EXCLUDED.token_hash, created_at = now()`, [req.params.id, digest(token)]);
    res.set('Cache-Control', 'no-store').json({ cameraId: req.params.id, token });
  }));
  app.delete('/api/cameras/:id/device-token', allow('admin'), handle(async (req, res) => {
    if (!validId(req.params.id)) return res.sendStatus(400);
    await pool.query('DELETE FROM camera_device_tokens WHERE camera_id = $1', [req.params.id]);
    res.json({ ok: true });
  }));

  app.post('/api/device/recordings/upload-url', deviceAuth, handle(async (req, res) => {
    const { recordingId, startedAt, endedAt, fileSize } = req.body || {};
    const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
    const start = new Date(startedAt), end = new Date(endedAt);
    const duration = (end - start) / 1000;
    if (typeof recordingId !== 'string' || typeof startedAt !== 'string' || typeof endedAt !== 'string'
      || !/^[a-f0-9]{32}$/.test(recordingId) || !iso.test(startedAt) || !iso.test(endedAt)
      || !Number.isFinite(duration) || duration < 1 || duration > 120 || end.getTime() > Date.now() + 300000
      || !Number.isSafeInteger(fileSize) || fileSize < 224 || fileSize > MAX_BYTES) {
      return res.status(400).json({ error: 'Send a recording ID, UTC start/end times (1–120 seconds), and an AVI size up to 64 MiB.' });
    }
    const camera = req.deviceCameraId;
    const { rows: [completed] } = await pool.query('SELECT id FROM camera_recordings WHERE camera_id = $1 AND device_recording_id = $2', [camera, recordingId]);
    if (completed) return res.json({ complete: true, id: completed.id });
    const fileName = `camera_${camera}_${recordingId}.avi`;
    const key = `recordings/${camera}/${start.toISOString().slice(0, 10)}/${fileName}`;
    const { rows: [upload] } = await pool.query(`INSERT INTO device_recording_uploads
      (camera_id, recording_id, storage_path, file_name, started_at, ended_at, file_size_bytes)
      VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (camera_id, recording_id)
      DO UPDATE SET recording_id = EXCLUDED.recording_id RETURNING *`, [camera, recordingId, key, fileName, start, end, fileSize]);
    if (Number(upload.file_size_bytes) !== fileSize || new Date(upload.started_at).getTime() !== start.getTime() || new Date(upload.ended_at).getTime() !== end.getTime()) {
      return res.status(409).json({ error: 'Recording ID already belongs to a different clip.' });
    }
    // The upload may have succeeded before a Wi-Fi drop. Never overwrite the existing object.
    let exists = false;
    try { exists = Number((await storage.head(upload.storage_path)).ContentLength) === fileSize; }
    catch (error) { if (error.$metadata?.httpStatusCode !== 404 && error.name !== 'NotFound' && error.name !== 'NoSuchKey') throw error; }
    res.set('Cache-Control', 'no-store').json(exists ? { uploaded: true, recordingId } : {
      recordingId, uploadUrl: await storage.uploadUrl(upload.storage_path, fileSize), expiresIn: 900,
      headers: { 'Content-Type': 'video/x-msvideo', 'If-None-Match': '*' }
    });
  }));

  app.post('/api/device/recordings/complete', deviceAuth, handle(async (req, res) => {
    const recordingId = req.body?.recordingId;
    if (typeof recordingId !== 'string' || !/^[a-f0-9]{32}$/.test(recordingId)) return res.sendStatus(400);
    const camera = req.deviceCameraId;
    const { rows: [completed] } = await pool.query('SELECT id FROM camera_recordings WHERE camera_id = $1 AND device_recording_id = $2', [camera, recordingId]);
    if (completed) return res.json({ ok: true, id: completed.id });
    const { rows: [upload] } = await pool.query('SELECT * FROM device_recording_uploads WHERE camera_id = $1 AND recording_id = $2', [camera, recordingId]);
    if (!upload) return res.status(404).json({ error: 'Request an upload URL first.' });
    let head;
    try { head = await storage.head(upload.storage_path); }
    catch (error) {
      if (error.$metadata?.httpStatusCode === 404 || ['NotFound', 'NoSuchKey'].includes(error.name)) return res.status(409).json({ error: 'Upload the AVI before confirming.' });
      throw error;
    }
    if (Number(head.ContentLength) !== Number(upload.file_size_bytes) || head.ContentType !== 'video/x-msvideo') return res.status(409).json({ error: 'Uploaded object size or type does not match.' });
    const header = await storage.header(upload.storage_path);
    if (header.length < 224 || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'AVI '
      || header.readUInt32LE(4) + 8 !== Number(upload.file_size_bytes)
      || header.toString('ascii', 112, 116) !== 'MJPG' || header.readUInt32LE(48) < 1) return res.status(422).json({ error: 'Upload a finalized MJPEG AVI from the supplied camera firmware.' });
    // Store UTC as naive timestamps to match legacy recording rows. The history API labels R2 rows explicitly.
    const { rows: [row] } = await pool.query(`INSERT INTO camera_recordings
      (camera_id,file_name,started_at,ended_at,duration_seconds,file_size_bytes,storage_path,storage_provider,device_recording_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,'r2',$8) ON CONFLICT (camera_id,device_recording_id)
      DO UPDATE SET device_recording_id = EXCLUDED.device_recording_id RETURNING id`, [camera, upload.file_name,
      new Date(upload.started_at).toISOString().slice(0, 19).replace('T', ' '), new Date(upload.ended_at).toISOString().slice(0, 19).replace('T', ' '),
      Math.round((new Date(upload.ended_at) - new Date(upload.started_at)) / 1000), upload.file_size_bytes, upload.storage_path, recordingId]);
    res.status(201).json({ ok: true, id: row.id });
  }));

  app.get('/api/recordings/:id/source', requireAuth, handle(async (req, res) => {
    if (!validId(req.params.id)) return res.sendStatus(400);
    const { rows: [row] } = await pool.query(`SELECT r.* FROM camera_recordings r JOIN cameras c ON c.id = r.camera_id
      WHERE r.id = $1 AND r.archived_at IS NULL AND c.is_enabled = true AND c.is_archived = false`, [req.params.id]);
    if (!row) return res.status(404).json({ error: 'Recording not found.' });
    res.set('Cache-Control', 'private, no-store').json(row.storage_provider === 'r2' ? {
      format: 'mjpeg-avi', url: await storage.videoUrl(row.storage_path), fileName: row.file_name, size: Number(row.file_size_bytes)
    } : { format: 'video', url: `/api/recordings/${row.id}/video` });
  }));
  // Existing browser recordings and archive routes also need the provider columns.
  app.use('/api/recordings', requireAuth, (req, res, next) => handle(async () => next())(req, res));
  return { ensureSchema, storage };
};
