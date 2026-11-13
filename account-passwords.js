const bcrypt = require('bcryptjs');

module.exports = function registerAccountPasswords(app, pool, allow) {
  app.post('/api/users/:id/reset-password', allow('admin'), async (req, res) => {
    const { newPassword, confirmPassword } = req.body || {};
    if (!/^[1-9]\d{0,15}$/.test(req.params.id) || typeof newPassword !== 'string' || newPassword.length < 8 || newPassword.length > 16 || newPassword !== confirmPassword) {
      return res.status(400).json({ error: 'Enter matching new passwords of 8 to 16 characters and a valid account.' });
    }
    let client;
    try {
      const hash = await bcrypt.hash(newPassword, 12);
      client = await pool.connect();
      await client.query('BEGIN');
      const { rows } = await client.query(`UPDATE users SET password_hash = $1
        WHERE id = $2 AND role IN ('tanod', 'captain') AND approval_status = 'approved'
        RETURNING id, role`, [hash, req.params.id]);
      if (!rows[0]) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Approved Tanod or Captain account not found.' }); }
      // Remove the target's sessions while preserving the administrator's session.
      await client.query("DELETE FROM private.user_sessions WHERE sess->'user'->>'id' = $1", [req.params.id]);
      await client.query('INSERT INTO audit_logs (user_id, action, entity_type, entity_id, details, ip_address) VALUES ($1, $2, $3, $4, $5, $6)',
        [req.session.user.id, 'password_reset', 'user', req.params.id, JSON.stringify({ role: rows[0].role }), req.ip]);
      await client.query('COMMIT');
      res.set('Cache-Control', 'no-store').json({ ok: true, message: 'Password reset successfully. The account must log in again with the new password.' });
    } catch (error) {
      if (client) await client.query('ROLLBACK').catch(() => {});
      console.error('Unable to reset account password:', error.code || error.name);
      res.status(500).json({ error: 'Unable to reset the password. Please try again.' });
    } finally { client?.release(); }
  });
};
