const schemas = require('./database/runtime-schemas');
const multer = require('multer');

module.exports = function registerFaceManagement(app, pool, requireAuth, allow) {
  let schemaReady;
  const ensureSchema = () => {
    schemaReady ||= pool.query(schemas.enrolledFaces)
      .catch((error) => { schemaReady = null; throw error; });
    return schemaReady;
  };
  const handle = (fn) => async (req, res) => {
    try { await ensureSchema(); await fn(req, res); }
    catch (error) { console.error('Face management:', error.message); if (!res.headersSent) res.status(503).json({ error: 'Unable to access enrolled faces. Check the database connection and enrolled_faces schema.' }); }
  };
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 4 * 1024 * 1024, files: 1, fields: 2 } });
  const parsePhoto = (req, res, next) => upload.single('picture')(req, res, (error) => {
    if (error) return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: 'Upload one JPEG, PNG or WebP picture, 4 MB or smaller.' });
    next();
  });
  const validId = (id) => /^[1-9]\d{0,15}$/.test(String(id));
  const audit = (client, req, action, id, details) => client.query(
    'INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address) VALUES ($1, $2, $3, $4, $5, $6)',
    [req.session.user.id, action, 'enrolled_face', id, JSON.stringify(details), req.ip]);

  // Camera viewers need descriptors for browser matching. Photos and enrollment
  // management remain admin-only; none of these responses may be cached.
  app.get('/api/faces/descriptors', requireAuth, handle(async (_req, res) => {
    const { rows } = await pool.query('SELECT id, full_name AS "fullName", descriptor FROM enrolled_faces ORDER BY id');
    res.set('Cache-Control', 'private, no-store').json(rows);
  }));
  app.get('/api/faces', allow('admin'), handle(async (_req, res) => {
    const { rows } = await pool.query('SELECT id, full_name AS "fullName", enrolled_at AS "enrolledAt" FROM enrolled_faces ORDER BY enrolled_at DESC, id DESC');
    res.set('Cache-Control', 'private, no-store').json(rows);
  }));
  app.get('/api/faces/:id/photo', allow('admin'), handle(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid person ID.' });
    const { rows } = await pool.query('SELECT photo, photo_type FROM enrolled_faces WHERE id = $1', [req.params.id]);
    if (!rows[0]) return res.status(404).json({ error: 'Enrollment not found.' });
    res.set('Cache-Control', 'private, no-store').set('X-Content-Type-Options', 'nosniff').type(rows[0].photo_type).send(rows[0].photo);
  }));
  app.post('/api/faces', allow('admin'), parsePhoto, handle(async (req, res) => {
    const fullName = typeof req.body?.fullName === 'string' ? req.body.fullName.trim() : '';
    let descriptor;
    try { descriptor = JSON.parse(req.body?.descriptor); } catch { /* Validate below. */ }
    if (!fullName || fullName.length > 120 || !Array.isArray(descriptor) || descriptor.length !== 128
      || !descriptor.every((value) => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 2)
      || !descriptor.some((value) => value !== 0)) {
      return res.status(400).json({ error: 'Enter a name and upload a picture with exactly one clear face.' });
    }
    const photo = req.file?.buffer;
    const mime = req.file?.mimetype;
    const jpeg = mime === 'image/jpeg' && photo?.[0] === 255 && photo?.[1] === 216 && photo?.at(-2) === 255 && photo?.at(-1) === 217;
    const png = mime === 'image/png' && photo?.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const webp = mime === 'image/webp' && photo?.subarray(0, 4).toString() === 'RIFF' && photo?.subarray(8, 12).toString() === 'WEBP';
    if (!photo || (!jpeg && !png && !webp)) return res.status(400).json({ error: 'Upload a valid JPEG, PNG or WebP picture.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('INSERT INTO enrolled_faces (full_name, descriptor, photo, photo_type, enrolled_by) VALUES ($1, $2, $3, $4, $5) RETURNING id, full_name AS "fullName", enrolled_at AS "enrolledAt"', [fullName, descriptor, photo, mime, req.session.user.id]);
      await audit(client, req, 'created', rows[0].id, { fullName });
      await client.query('COMMIT');
      res.status(201).set('Cache-Control', 'no-store').json(rows[0]);
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }));
  app.delete('/api/faces/:id', allow('admin'), handle(async (req, res) => {
    if (!validId(req.params.id)) return res.status(400).json({ error: 'Invalid person ID.' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query('DELETE FROM enrolled_faces WHERE id = $1 RETURNING id, full_name AS "fullName"', [req.params.id]);
      if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Enrollment not found.' }); }
      await audit(client, req, 'deleted', rows[0].id, { fullName: rows[0].fullName });
      await client.query('COMMIT');
      res.json({ ok: true });
    } catch (error) { await client.query('ROLLBACK'); throw error; }
    finally { client.release(); }
  }));
};
