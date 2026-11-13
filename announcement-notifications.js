const schemas = require('./database/runtime-schemas');

module.exports = function registerAnnouncementNotifications(app, pool, allow) {
  let schemaReady;
  const handle = (fn) => async (req, res) => {
    try {
      schemaReady ||= pool.query(schemas.announcementReads).catch((error) => { schemaReady = null; throw error; });
      await schemaReady;
      await fn(req, res);
    } catch (error) {
      console.error('Announcement notifications:', error.message);
      res.status(503).json({ error: 'Unable to load announcement notifications. Retrying automatically.' });
    }
  };
  app.get('/api/announcement-notifications', allow('tanod', 'captain'), handle(async (req, res) => {
    const { rows: [counts] } = await pool.query(`SELECT COUNT(*) FILTER (WHERE r.read_at IS NULL) AS unread
      FROM announcements a LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = $1
      WHERE a.is_published = true`, [req.session.user.id]);
    const { rows } = await pool.query(`SELECT a.id, a.title, a.body, a.published_at AS "notifiedAt", r.read_at AS "readAt", u.full_name AS author
      FROM announcements a LEFT JOIN announcement_reads r ON r.announcement_id = a.id AND r.user_id = $1
      LEFT JOIN users u ON u.id = a.created_by WHERE a.is_published = true
      ORDER BY (r.read_at IS NULL) DESC, a.published_at DESC, a.id DESC LIMIT 20`, [req.session.user.id]);
    res.set('Cache-Control', 'private, no-store').json({ unread: Number(counts.unread), announcements: rows });
  }));
  app.patch('/api/announcement-notifications/:id/read', allow('tanod', 'captain'), handle(async (req, res) => {
    if (!/^[1-9]\d{0,15}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid announcement ID.' });
    const { rowCount } = await pool.query(`INSERT INTO announcement_reads (announcement_id, user_id)
      SELECT id, $2 FROM announcements WHERE id = $1 AND is_published = true
      ON CONFLICT (user_id, announcement_id) DO UPDATE SET read_at = announcement_reads.read_at`, [req.params.id, req.session.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'Announcement is no longer available.' });
    res.json({ ok: true });
  }));
};
