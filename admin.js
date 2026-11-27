
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
    }  });

    app.get("/api/admin/history", requireAuth, requireAdmin, async (req, res) => {
      try {
        const result = await pool.query(`
          SELECT
            log.id,
            log.action,
            log.details,
            log.created_at,
            log.admin_user_id,
            admin.first_name AS admin_first_name,
            admin.last_name AS admin_last_name,
            log.target_user_id,
            target.first_name AS target_first_name,
            target.last_name AS target_last_name
          FROM admin_audit_logs log
          LEFT JOIN users admin ON admin.id = log.admin_user_id
          LEFT JOIN users target ON target.id = log.target_user_id
          ORDER BY log.created_at DESC
          LIMIT 300
        `);

        res.json({ history: result.rows });
      } catch (err) {
        console.error("Admin history error:", err.message);
        res.status(500).json({
          error: "Impossible de charger l'historique administratif."
        });
      }
    });

  // ==========================================
  // WIN CASH SPORT — MATCHS ET LOTERIE
  // ==========================================

  async function ensureSportSchema() {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS sport_matches (
        id BIGSERIAL PRIMARY KEY,
        home_team VARCHAR(100) NOT NULL,
        away_team VARCHAR(100) NOT NULL,
        competition VARCHAR(150) NOT NULL,
        starts_at TIMESTAMPTZ NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'scheduled'
          CHECK (status IN ('scheduled','open','closed','finished','published')),
        home_score INTEGER,
        away_score INTEGER,
        result_note TEXT,
        created_by BIGINT REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

ALTER TABLE sport_matches
  ADD COLUMN IF NOT EXISTS odds_home NUMERIC(8,3),
  ADD COLUMN IF NOT EXISTS odds_draw NUMERIC(8,3),
  ADD COLUMN IF NOT EXISTS odds_away NUMERIC(8,3);
  
      CREATE INDEX IF NOT EXISTS sport_matches_date_idx
        ON sport_matches(starts_at DESC);

      CREATE TABLE IF NOT EXISTS sport_loto_draws (
        id BIGSERIAL PRIMARY KEY,
        draw_date DATE NOT NULL UNIQUE,
        opens_at TIMESTAMPTZ NOT NULL,
        closes_at TIMESTAMPTZ NOT NULL,
        results_at TIMESTAMPTZ NOT NULL,
        status VARCHAR(20) NOT NULL DEFAULT 'scheduled'
          CHECK (status IN ('scheduled','open','closed','published')),
        winning_numbers INTEGER[],
        result_note TEXT,
        created_by BIGINT REFERENCES users(id),
        published_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CHECK (closes_at > opens_at),
        CHECK (results_at >= closes_at),
        
        CHECK (
          winning_numbers IS NULL OR
          (
            cardinality(winning_numbers) = 5
            AND array_position(winning_numbers, NULL) IS NULL
            AND winning_numbers <@ ARRAY[
              1,2,3,4,5,6,7,8,9,10,
              11,12,13,14,15,16,17,18,19,20,
              21,22,23,24,25,26,27,28,29,30,
              31,32,33,34,35,36,37,38,39,40,
              41,42,43,44,45,46,47,48,49,50,
              51,52,53,54,55,56,57,58,59,60,
              61,62,63,64,65,66,67,68,69,70,
              71,72,73,74,75,76,77,78,79,80,
              81,82,83,84,85,86,87,88,89,90,
              91,92,93,94,95,96,97,98,99,100
            ]
          )
        )
      );


      CREATE INDEX IF NOT EXISTS sport_loto_date_idx
        ON sport_loto_draws(draw_date DESC);
    `);
  }

  // ADMIN — programmer un match
  app.post(
    "/api/admin/sport/matches",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        await ensureSportSchema();

        const home = String(req.body.homeTeam || "").trim();
        const away = String(req.body.awayTeam || "").trim();
        const competition = String(req.body.competition || "").trim();
        const startsAt = new Date(req.body.startsAt);

const oddsHome = Number(req.body.oddsHome);
const oddsDraw = Number(req.body.oddsDraw);
const oddsAway = Number(req.body.oddsAway);
        
        if (
          !home || !away || home === away ||
          !competition ||
          Number.isNaN(startsAt.getTime()) || 
          !Number.isFinite(oddsHome) || oddsHome < 1.01 || oddsHome > 1000 ||
!Number.isFinite(oddsDraw) || oddsDraw < 1.01 || oddsDraw > 1000 ||
!Number.isFinite(oddsAway) || oddsAway < 1.01 || oddsAway > 1000
        ) {
          return res.status(400).json({
            error: "Informations du match invalides."
          });
        }

        
const result = await pool.query(`
  INSERT INTO sport_matches
    (home_team, away_team, competition, starts_at, created_by,
     odds_home, odds_draw, odds_away)
  VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
  RETURNING *
`, [
  home,
  away,
  competition,
  startsAt,
  req.session.userId,
  oddsHome,
  oddsDraw,
  oddsAway
]);


        await pool.query(`
          INSERT INTO admin_audit_logs
            (admin_user_id, action, details)
          VALUES ($1, 'sport_match_created', $2)
        `, [
          req.session.userId,
          JSON.stringify({ matchId: result.rows[0].id })
        ]);

        res.status(201).json({
          ok: true,
          match: result.rows[0]
        });
      } catch (err) {
        console.error("Sport match creation:", err.message);
        res.status(500).json({
          error: "Impossible de programmer ce match."
        });
      }
    }
  );

  // ADMIN — consulter les matchs
  app.get(
    "/api/admin/sport/matches",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        await ensureSportSchema();

        const result = await pool.query(`
          SELECT *
          FROM sport_matches
          ORDER BY starts_at DESC
          LIMIT 300
        `);

        res.json({ matches: result.rows });
      } catch (err) {
        console.error("Sport matches:", err.message);
        res.status(500).json({
          error: "Impossible de charger les matchs."
        });
      }
    }
  );

  // ADMIN — ouvrir ou clôturer un match
  app.patch(
    "/api/admin/sport/matches/:id/status",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        await ensureSportSchema();

        const id = Number(req.params.id);
        const status = req.body.status;

        if (
          !Number.isSafeInteger(id) || id < 1 ||
          !["open", "closed"].includes(status)
        ) {
          return res.status(400).json({
            error: "Identifiant ou statut invalide."
          });
        }

        const result = await pool.query(`
          UPDATE sport_matches
          SET status = $1, updated_at = NOW()
          WHERE id = $2
            AND status IN ('scheduled','open')
          RETURNING *
        `, [status, id]);

        if (!result.rowCount) {
          return res.status(404).json({
            error: "Match introuvable ou déjà terminé."
          });
        }

        res.json({ ok: true, match: result.rows[0] });
      } catch (err) {
        console.error("Sport match status:", err.message);
        res.status(500).json({
          error: "Impossible de modifier le match."
        });
      }
    }
  );

  // ADMIN — saisir et publier le résultat d'un match
  app.post(
    "/api/admin/sport/matches/:id/result",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        await ensureSportSchema();

        const id = Number(req.params.id);
        const homeScore = req.body.homeScore;
        const awayScore = req.body.awayScore;

        if (
          !Number.isSafeInteger(id) || id < 1 ||
          !Number.isInteger(homeScore) || homeScore < 0 ||
          !Number.isInteger(awayScore) || awayScore < 0
        ) {
          return res.status(400).json({
            error: "Résultat du match invalide."
          });
        }

        const result = await pool.query(`
          UPDATE sport_matches
          SET home_score = $1,
              away_score = $2,
              status = 'published',
              updated_at = NOW()
          WHERE id = $3
            AND status IN ('open','closed','finished')
          RETURNING *
        `, [homeScore, awayScore, id]);

        if (!result.rowCount) {
          return res.status(409).json({
            error: "Match introuvable ou non clôturé."
          });
        }

        await pool.query(`
          INSERT INTO admin_audit_logs
            (admin_user_id, action, details)
          VALUES ($1, 'sport_match_result_published', $2)
        `, [
          req.session.userId,
          JSON.stringify({
            matchId: id,
            homeScore,
            awayScore
          })
        ]);

        res.json({ ok: true, match: result.rows[0] });
      } catch (err) {
        console.error("Sport match result:", err.message);
        res.status(500).json({
          error: "Impossible de publier le résultat."
        });
      }
    }
  );

  // ADMIN — créer un tirage LOTO
  app.post(
    "/api/admin/sport/loto/draws",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        await ensureSportSchema();

        const drawDate = req.body.drawDate;
        const opensAt = new Date(req.body.opensAt);
        const closesAt = new Date(req.body.closesAt);
        const resultsAt = new Date(req.body.resultsAt);

        if (
          !/^\d{4}-\d{2}-\d{2}$/.test(String(drawDate || "")) ||
          Number.isNaN(opensAt.getTime()) ||
          Number.isNaN(closesAt.getTime()) ||
          Number.isNaN(resultsAt.getTime()) ||
          closesAt <= opensAt ||
          resultsAt < closesAt
        ) {
          return res.status(400).json({
            error: "Date ou horaires du tirage invalides."
          });
        }

        const result = await pool.query(`
          INSERT INTO sport_loto_draws
            (draw_date, opens_at, closes_at, results_at, created_by)
          VALUES ($1, $2, $3, $4, $5)
          ON CONFLICT (draw_date) DO NOTHING
          RETURNING *
        `, [
          drawDate,
          opensAt,
          closesAt,
          resultsAt,
          req.session.userId
        ]);

        if (!result.rowCount) {
          return res.status(409).json({
            error: "Un tirage existe déjà pour cette date."
          });
        }

        res.status(201).json({
          ok: true,
          draw: result.rows[0]
        });
      } catch (err) {
        console.error("Loto draw creation:", err.message);
        res.status(500).json({
          error: "Impossible de créer le tirage."
        });
      }
    }
  );

  // ADMIN — consulter les tirages
  app.get(
    "/api/admin/sport/loto/draws",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        await ensureSportSchema();

        const result = await pool.query(`
          SELECT *
          FROM sport_loto_draws
          ORDER BY draw_date DESC
          LIMIT 300
        `);

        res.json({ draws: result.rows });
      } catch (err) {
        console.error("Loto draws:", err.message);
        res.status(500).json({
          error: "Impossible de charger les tirages."
        });
      }
    }
  );

  // ADMIN — ouvrir ou clôturer un tirage
  app.patch(
    "/api/admin/sport/loto/draws/:id/status",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        await ensureSportSchema();

        const id = Number(req.params.id);
        const status = req.body.status;

        if (
          !Number.isSafeInteger(id) || id < 1 ||
          !["open", "closed"].includes(status)
        ) {
          return res.status(400).json({
            error: "Identifiant ou statut invalide."
          });
        }

        const result = await pool.query(`
          UPDATE sport_loto_draws
          SET status = $1, updated_at = NOW()
          WHERE id = $2
            AND status IN ('scheduled','open')
          RETURNING *
        `, [status, id]);

        if (!result.rowCount) {
          return res.status(404).json({
            error: "Tirage introuvable ou déjà publié."
          });
        }

        res.json({ ok: true, draw: result.rows[0] });
      } catch (err) {
        console.error("Loto draw status:", err.message);
        res.status(500).json({
          error: "Impossible de modifier le tirage."
        });
      }
    }
  );

  // ADMIN — publier exactement cinq numéros gagnants
  app.post(
    "/api/admin/sport/loto/draws/:id/result",
    requireAuth,
    requireAdmin,
    async (req, res) => {
      try {
        await ensureSportSchema();

        const id = Number(req.params.id);
        const numbers = req.body.numbers;

        if (
          !Number.isSafeInteger(id) || id < 1 ||
          !Array.isArray(numbers) ||
          numbers.length !== 5 ||
          numbers.some(n => !Number.isInteger(n) || n < 1 || n > 100) ||
          new Set(numbers).size !== 5
        ) {
          return res.status(400).json({
            error: "Il faut exactement cinq numéros différents entre 1 et 100."
          });
        }

        const result = await pool.query(`
          UPDATE sport_loto_draws
          SET winning_numbers = $1,
              status = 'published',
              published_at = NOW(),
              updated_at = NOW()
          WHERE id = $2
            AND status = 'closed'
          RETURNING *
        `, [numbers, id]);

        if (!result.rowCount) {
          return res.status(409).json({
            error: "Le tirage doit être clôturé avant la publication."
          });
        }

        await pool.query(`
          INSERT INTO admin_audit_logs
            (admin_user_id, action, details)
          VALUES ($1, 'loto_result_published', $2)
        `, [
          req.session.userId,
          JSON.stringify({ drawId: id, numbers })
        ]);

        res.json({ ok: true, draw: result.rows[0] });
      } catch (err) {
        console.error("Loto result:", err.message);
        res.status(500).json({
          error: "Impossible de publier le résultat du tirage."
        });
      }
    }
  );

  // MEMBRES — consulter les matchs publiés ou ouverts
  app.get(
    "/api/sport/matches",
    requireAuth,
    async (req, res) => {
      try {
        await ensureSportSchema();

        const result = await pool.query(`
          SELECT id, home_team, away_team, competition,
       starts_at, status, home_score, away_score,
       odds_home, odds_draw, odds_away
FROM sport_matches
          WHERE status IN ('open','closed','published')
          ORDER BY starts_at ASC
          LIMIT 200
        `);

        res.json({ matches: result.rows });
      } catch (err) {
        console.error("Public sport matches:", err.message);
        res.status(500).json({
          error: "Impossible de charger les matchs."
        });
      }
    }
  );

  // MEMBRES — consulter les tirages et résultats publiés
  app.get(
    "/api/sport/loto/draws",
    requireAuth,
    async (req, res) => {
      try {
        await ensureSportSchema();

        const result = await pool.query(`
          SELECT id, draw_date, opens_at, closes_at,
                 results_at, status, winning_numbers, published_at
          FROM sport_loto_draws
          WHERE status IN ('open','closed','published')
          ORDER BY draw_date DESC
          LIMIT 100
        `);

        res.json({ draws: result.rows });
      } catch (err) {
        console.error("Public loto draws:", err.message);
        res.status(500).json({
          error: "Impossible de charger les tirages."
        });
      }
    }
  );
      
};
