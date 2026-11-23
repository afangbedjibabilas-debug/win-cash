
module.exports = function installAdmin(app, pool, requireAuth) {
  async function requireAdmin(req, res, next) {
    try {
      const result = await pool.query(
        "SELECT role, activation_status FROM users WHERE id=$1",
        [req.session.userId]
      );

      if (
        !result.rows[0] ||
        result.rows[0].role !== "admin" ||
        result.rows[0].activation_status !== "active"
      ) {
        return res.status(403).json({ error: "Accès administrateur requis." });
      }

      next();
    } catch (err) {
      console.error("Admin authorization error:", err.message);
      res.status(500).json({ error: "Vérification administrateur impossible." });
    }
  }

  app.get("/api/admin/overview", requireAuth, requireAdmin, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE role='admin')::int AS admins,
          COUNT(*) FILTER (WHERE role='user')::int AS members,
          COUNT(*) FILTER (WHERE activation_status='active')::int AS active,
          COUNT(*) FILTER (WHERE activation_status='suspended')::int AS suspended,
          COUNT(*) FILTER (WHERE activation_status='banned')::int AS banned
        FROM users
      `);

      res.json({ overview: result.rows[0] });
    } catch (err) {
      console.error("Admin overview error:", err.message);
      res.status(500).json({ error: "Impossible de charger les statistiques." });
    }
  });

  app.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
    try {
      const q = typeof req.query.q === "string"
        ? req.query.q.trim().slice(0, 100)
        : "";

      const result = await pool.query(`
        SELECT
          u.id, u.first_name, u.last_name, u.email, u.phone,
          u.role, u.created_at, u.referral_code,
          COALESCE(u.activation_status, 'active') AS account_status,
          COUNT(child.id)::int AS referral_count
        FROM users u
        LEFT JOIN users child ON child.referred_by = u.id
        WHERE (
          $1 = '' OR
          u.first_name ILIKE '%' || $1 || '%' OR
          u.last_name ILIKE '%' || $1 || '%' OR
          u.email ILIKE '%' || $1 || '%' OR
          u.phone ILIKE '%' || $1 || '%' OR
          u.referral_code ILIKE '%' || $1 || '%'
        )
        GROUP BY u.id
        ORDER BY u.created_at DESC
        LIMIT 500
      `, [q]);

      res.json({ users: result.rows });
    } catch (err) {
      console.error("Admin users error:", err.message);
      res.status(500).json({ error: "Impossible de charger les membres." });
    }
  });

  app.patch("/api/admin/users/:id/status", requireAuth, requireAdmin, async (req, res) => {
    const id = Number(req.params.id);
    const status = req.body && req.body.status;

    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({ error: "Identifiant invalide." });
    }

    if (!["active", "suspended", "banned"].includes(status)) {
      return res.status(400).json({ error: "Statut non autorisé." });
    }

    if (String(id) === String(req.session.userId)) {
      return res.status(400).json({
        error: "Tu ne peux pas modifier le statut de ton propre compte."
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const target = await client.query(
        "SELECT id, role FROM users WHERE id=$1 FOR UPDATE",
        [id]
      );

      if (!target.rows[0]) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Membre introuvable." });
      }

      if (target.rows[0].role === "admin") {
        await client.query("ROLLBACK");
        return res.status(403).json({
          error: "La modification d'un compte administrateur est bloquée."
        });
      }

      await client.query(
        "UPDATE users SET activation_status=$1, updated_at=NOW() WHERE id=$2",
        [status, id]
      );

      await client.query(
        `INSERT INTO admin_audit_logs
         (admin_user_id, target_user_id, action, details)
         VALUES ($1, $2, $3, $4)`,
        [
          req.session.userId,
          id,
          "member_status_changed",
          JSON.stringify({ status })
        ]
      );

      await client.query("COMMIT");
      res.json({ ok: true, status });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Member status update error:", err.message);
      res.status(500).json({
        error: "Impossible de modifier le statut du membre."
      });
    } finally {
      client.release();
    }
  });

  app.delete("/api/admin/users/:id", requireAuth, requireAdmin, async (req, res) => {
    const id = Number(req.params.id);

    if (!Number.isSafeInteger(id) || id < 1) {
      return res.status(400).json({ error: "Identifiant invalide." });
    }

    if (String(id) === String(req.session.userId)) {
      return res.status(400).json({
        error: "Tu ne peux pas archiver ton propre compte."
      });
    }

    const client = await pool.connect();

    try {
      await client.query("BEGIN");

      const target = await client.query(
        "SELECT id, role FROM users WHERE id=$1 FOR UPDATE",
        [id]
      );

      if (!target.rows[0]) {
        await client.query("ROLLBACK");
        return res.status(404).json({ error: "Membre introuvable." });
      }

      if (target.rows[0].role === "admin") {
        await client.query("ROLLBACK");
        return res.status(403).json({
          error: "Un compte administrateur ne peut pas être archivé ici."
        });
      }

      await client.query(
        "UPDATE users SET activation_status='archived', updated_at=NOW() WHERE id=$1",
        [id]
      );

      await client.query(
        `INSERT INTO admin_audit_logs
         (admin_user_id, target_user_id, action)
         VALUES ($1, $2, 'member_archived')`,
        [req.session.userId, id]
      );

      await client.query("COMMIT");
      res.json({ ok: true, status: "archived" });
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Member archive error:", err.message);
      res.status(500).json({ error: "Impossible d'archiver ce membre." });
    } finally {
      client.release();
    }
  });

  app.get("/api/admin/referrals", requireAuth, requireAdmin, async (req, res) => {
    try {
      const result = await pool.query(`
        SELECT
          u.id, u.first_name, u.last_name, u.referral_code,
          COUNT(child.id)::int AS referral_count
        FROM users u
        LEFT JOIN users child ON child.referred_by = u.id
        WHERE u.referral_code IS NOT NULL
        GROUP BY u.id
        ORDER BY referral_count DESC, u.created_at DESC
        LIMIT 500
      `);

      res.json({ referrals: result.rows });
    } catch (err) {
      console.error("Referral report error:", err.message);
      res.status(500).json({
        error: "Impossible de charger les codes de parrainage."
      });
    }
  });

  app.get("/api/admin/operations", requireAuth, requireAdmin, async (req, res) => {
    try {
      const payments = await pool.query(`
        SELECT
          p.id, p.user_id, p.amount, 'XOF' AS currency,
          p.status, p.created_at, u.first_name, u.last_name,
          'activation' AS type
        FROM activation_payments p
        JOIN users u ON u.id = p.user_id
        ORDER BY p.created_at DESC
        LIMIT 200
      `);

      const withdrawals = await pool.query(`
        SELECT
          w.id, w.user_id, w.amount, 'XOF' AS currency,
          w.status, w.created_at, u.first_name, u.last_name,
          'withdrawal' AS type
        FROM withdrawals w
        JOIN users u ON u.id = w.user_id
        ORDER BY w.created_at DESC
        LIMIT 200
      `);

      const operations = [...payments.rows, ...withdrawals.rows]
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      res.json({ operations });
    } catch (err) {
      console.error("Admin operations error:", err.message);
      res.status(500).json({
        error: "Historique indisponible : vérifie les tables de transactions."
      });
    }
  });
};
          
