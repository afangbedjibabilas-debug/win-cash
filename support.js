
module.exports = function installSupport(app, pool, requireAuth) {
  async function ensureSupportSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS support_threads (
        id BIGSERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id),
        subject VARCHAR(150) NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'open'
          CHECK (status IN ('open','in_progress','resolved')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS support_messages (
        id BIGSERIAL PRIMARY KEY,
        thread_id BIGINT NOT NULL
          REFERENCES support_threads(id) ON DELETE CASCADE,
        sender_id BIGINT NOT NULL REFERENCES users(id),
        sender_role VARCHAR(10) NOT NULL
          CHECK (sender_role IN ('user','admin')),
        message TEXT NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS support_threads_user_idx
      ON support_threads(user_id, updated_at DESC);

      CREATE INDEX IF NOT EXISTS support_messages_thread_idx
      ON support_messages(thread_id, created_at ASC);
    `);
  }

  async function requireAdmin(req, res, next) {
    try {
      const result = await pool.query(
        `SELECT role, activation_status
         FROM users WHERE id = $1`,
        [req.session.userId]
      );

      if (
        !result.rows[0] ||
        result.rows[0].role !== 'admin' ||
        result.rows[0].activation_status !== 'active'
      ) {
        return res.status(403).json({
          error: "Accès administrateur requis."
        });
      }

      next();
    } catch (err) {
      console.error("Support admin authorization:", err.message);
      res.status(500).json({
        error: "Vérification administrateur impossible."
      });
    }
  }

  // MEMBRE — consulter ses réclamations
  app.get(
    "/api/support/threads",
    requireAuth,
    async (req, res) => {
      try {
        await ensureSupportSchema();

        const result = await pool.query(`
          SELECT
            t.id, t.subject, t.status, t.created_at, t.updated_at,
            (
              SELECT message
              FROM support_messages m
              WHERE m.thread_id = t.id
              ORDER BY m.created_at DESC
              LIMIT 1
            ) AS last_message
          FROM support_threads t
          WHERE t.user_id = $1
          ORDER BY t.updated_at DESC
        `, [req.session.userId]);

        res.json({ threads: result.rows });
      } catch (err) {
        console.error("Member support threads:", err.message);
        res.status(500).json({
          error: "Impossible de charger tes réclamations."
        });
      }
    }
  );

  // MEMBRE — créer une réclamation
  app.post(
    "/api/support/threads",
    requireAuth,
    async (req, res) => {
      const subject = typeof req.body.subject === "string"
        ? req.body.subject.trim().slice(0, 150)
        : "";

      const message = typeof req.body.message === "string"
        ? req.body.message.trim().slice(0, 5000)
        : "";

      if (!subject || !message) {
        return res.status(400).json({
          error: "Le sujet et le message sont obligatoires."
        });
      }

      if (subject.length < 3 || message.length < 5) {
        return res.status(400).json({
          error: "Le sujet ou le message est trop court."
        });
      }

      try {
        await ensureSupportSchema();

        const client = await pool.connect();

        try {
          await client.query("BEGIN");

          const thread = await client.query(`
            INSERT INTO support_threads (user_id, subject)
            VALUES ($1, $2)
            RETURNING *
          `, [req.session.userId, subject]);

          await client.query(`
            INSERT INTO support_messages
              (thread_id, sender_id, sender_role, message)
            VALUES ($1, $2, 'user', $3)
          `, [thread.rows[0].id, req.session.userId, message]);

          await client.query("COMMIT");

          res.status(201).json({
            ok: true,
            thread: thread.rows[0]
          });
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
      } catch (err) {
        console.error("Create support thread:", err.message);
        res.status(500).json({
          error: "Impossible d'envoyer ta réclamation."
        });
      }
    }
  );

  // MEMBRE — lire les messages de sa réclamation
  app.get(
    "/api/support/threads/:id/messages",
    requireAuth,
    async (req, res) => {
      try {
        await ensureSupportSchema();

        const id = Number(req.params.id);

        if (!Number.isSafeInteger(id) || id < 1) {
          return res.status(400).json({
            error: "Identifiant invalide."
          });
        }

        const thread = await pool.query(
          `SELECT id FROM support_threads
           WHERE id = $1 AND user_id = $2`,
          [id, req.session.userId]
        );

        if (!thread.rowCount) {
          return res.status(404).json({
            error: "Réclamation introuvable."
          });
        }

        const result = await pool.query(`
          SELECT id, sender_role, message, created_at
          FROM support_messages
          WHERE thread_id = $1
          ORDER BY created_at ASC
        `, [id]);

        res.json({ messages: result.rows });
      } catch (err) {
        console.error("Member support messages:", err.message);
        res.status(500).json({
          error: "Impossible de charger les messages."
        });
      }
    }
  );

  // MEMBRE — répondre à sa réclamation
  app.post(
    "/api/support/threads/:id/messages",
    requireAuth,
    async (req, res) => {
      const id = Number(req.params.id);
      const message = typeof req.body.message === "string"
        ? req.body.message.trim().slice(0, 5000)
        : "";

      if (!Number.isSafeInteger(id) || id < 1 || message.length < 1) {
        return res.status(400).json({
          error: "Identifiant ou message invalide."
        });
      }

      try {
        await ensureSupportSchema();

        const client = await pool.connect();

        try {
          await client.query("BEGIN");

          const thread = await client.query(`
            SELECT id, status FROM support_threads
            WHERE id = $1 AND user_id = $2
            FOR UPDATE
          `, [id, req.session.userId]);

          if (!thread.rowCount) {
            await client.query("ROLLBACK");
            return res.status(404).json({
              error: "Réclamation introuvable."
            });
          }

          await client.query(`
            INSERT INTO support_messages
              (thread_id, sender_id, sender_role, message)
            VALUES ($1, $2, 'user', $3)
          `, [id, req.session.userId, message]);

          await client.query(`
            UPDATE support_threads
            SET status = 'open', updated_at = NOW()
            WHERE id = $1
          `, [id]);

          await client.query("COMMIT");
          res.status(201).json({ ok: true });
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
      } catch (err) {
        console.error("Member support reply:", err.message);
        res.status(500).json({
          error: "Impossible d'envoyer ta réponse."
        });
      }
    }
  );

  // ADMIN — consulter toutes les réclamations
  app.get(
    "/api/admin/support/threads",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        await ensureSupportSchema();

        const result = await pool.query(`
          SELECT
            t.id, t.user_id, t.subject, t.status,
            t.created_at, t.updated_at,
            u.first_name, u.last_name, u.email, u.phone,
            (
              SELECT message
              FROM support_messages m
              WHERE m.thread_id = t.id
              ORDER BY m.created_at DESC
              LIMIT 1
            ) AS last_message
          FROM support_threads t
          JOIN users u ON u.id = t.user_id
          ORDER BY
            CASE WHEN t.status = 'resolved' THEN 1 ELSE 0 END,
            t.updated_at DESC
          LIMIT 500
        `);

        res.json({ threads: result.rows });
      } catch (err) {
        console.error("Admin support threads:", err.message);
        res.status(500).json({
          error: "Impossible de charger les réclamations."
        });
      }
    }
  );

  // ADMIN — lire une conversation
  app.get(
    "/api/admin/support/threads/:id/messages",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        await ensureSupportSchema();

        const id = Number(req.params.id);

        if (!Number.isSafeInteger(id) || id < 1) {
          return res.status(400).json({
            error: "Identifiant invalide."
          });
        }

        const thread = await pool.query(
          "SELECT id FROM support_threads WHERE id = $1",
          [id]
        );

        if (!thread.rowCount) {
          return res.status(404).json({
            error: "Réclamation introuvable."
          });
        }

        const result = await pool.query(`
          SELECT
            m.id, m.sender_role, m.message, m.created_at,
            u.first_name, u.last_name
          FROM support_messages m
          JOIN users u ON u.id = m.sender_id
          WHERE m.thread_id = $1
          ORDER BY m.created_at ASC
        `, [id]);

        res.json({ messages: result.rows });
      } catch (err) {
        console.error("Admin support messages:", err.message);
        res.status(500).json({
          error: "Impossible de charger la conversation."
        });
      }
    }
  );

  // ADMIN — répondre à un membre
  app.post(
    "/api/admin/support/threads/:id/messages",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const id = Number(req.params.id);
      const message = typeof req.body.message === "string"
        ? req.body.message.trim().slice(0, 5000)
        : "";

      if (!Number.isSafeInteger(id) || id < 1 || !message) {
        return res.status(400).json({
          error: "Identifiant ou message invalide."
        });
      }

      try {
        await ensureSupportSchema();

        const client = await pool.connect();

        try {
          await client.query("BEGIN");

          const thread = await client.query(
            "SELECT id FROM support_threads WHERE id = $1 FOR UPDATE",
            [id]
          );

          if (!thread.rowCount) {
            await client.query("ROLLBACK");
            return res.status(404).json({
              error: "Réclamation introuvable."
            });
          }

          await client.query(`
            INSERT INTO support_messages
              (thread_id, sender_id, sender_role, message)
            VALUES ($1, $2, 'admin', $3)
          `, [id, req.session.userId, message]);

          await client.query(`
            UPDATE support_threads
            SET status = 'in_progress', updated_at = NOW()
            WHERE id = $1
          `, [id]);

          await client.query("COMMIT");
          res.status(201).json({ ok: true });
        } catch (err) {
          await client.query("ROLLBACK");
          throw err;
        } finally {
          client.release();
        }
      } catch (err) {
        console.error("Admin support reply:", err.message);
        res.status(500).json({
          error: "Impossible d'envoyer la réponse."
        });
      }
    }
  );

  // ADMIN — modifier le statut
  app.patch(
    "/api/admin/support/threads/:id/status",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      const id = Number(req.params.id);
      const status = req.body.status;

      if (
        !Number.isSafeInteger(id) || id < 1 ||
        !["open", "in_progress", "resolved"].includes(status)
      ) {
        return res.status(400).json({
          error: "Identifiant ou statut invalide."
        });
      }

      try {
        await ensureSupportSchema();

        const result = await pool.query(`
          UPDATE support_threads
          SET status = $1, updated_at = NOW()
          WHERE id = $2
          RETURNING id, status
        `, [status, id]);

        if (!result.rowCount) {
          return res.status(404).json({
            error: "Réclamation introuvable."
          });
        }

        res.json({ ok: true, thread: result.rows[0] });
      } catch (err) {
        console.error("Admin support status:", err.message);
        res.status(500).json({
          error: "Impossible de modifier le statut."
        });
      }
    }
  );
};
    
