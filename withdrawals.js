
module.exports = function installWithdrawals(app, pool, requireAuth) {

  // Préparer les colonnes et l'historique des retraits
  async function ensureWithdrawalSchema() {
    await pool.query(`
      ALTER TABLE withdrawals
      ADD COLUMN IF NOT EXISTS mobile_money_provider VARCHAR(50);

      ALTER TABLE withdrawals
      ADD COLUMN IF NOT EXISTS reviewed_by BIGINT REFERENCES users(id);

      ALTER TABLE withdrawals
      ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

      CREATE TABLE IF NOT EXISTS withdrawal_transactions (
        id BIGSERIAL PRIMARY KEY,
        withdrawal_id BIGINT NOT NULL REFERENCES withdrawals(id),
        user_id BIGINT NOT NULL REFERENCES users(id),
        amount_xof BIGINT NOT NULL,
        action VARCHAR(30) NOT NULL,
        performed_by BIGINT REFERENCES users(id),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS withdrawals_user_idx
      ON withdrawals(user_id, created_at DESC);
    `);
  }

  // Vérifier que la personne connectée est administrateur
  async function requireWithdrawalAdmin(req, res, next) {
    try {
      const result = await pool.query(
        `SELECT role, activation_status
         FROM users
         WHERE id = $1`,
        [req.session.userId]
      );

      const admin = result.rows[0];

      if (
        !admin ||
        admin.role !== "admin" ||
        admin.activation_status !== "active"
      ) {
        return res.status(403).json({
          error: "Accès administrateur requis."
        });
      }

      next();
    } catch (err) {
      console.error("Withdrawal admin check:", err.message);

      res.status(500).json({
        error: "Vérification administrateur impossible."
      });
    }
  }

  // MEMBRE — demander un retrait
  app.post(
    "/api/withdrawals",
    requireAuth,
    async (req, res) => {
      const amount = Number(req.body.amount);

      const provider = typeof req.body.mobileMoneyProvider === "string"
        ? req.body.mobileMoneyProvider.trim().slice(0, 50)
        : "";

      const number = typeof req.body.mobileMoneyNumber === "string"
        ? req.body.mobileMoneyNumber.trim().slice(0, 30)
        : "";

      if (!Number.isSafeInteger(amount) || amount < 5000) {
        return res.status(400).json({
          error: "Le retrait minimum est de 5 000 FCFA."
        });
      }

      if (!provider || provider.length < 2) {
        return res.status(400).json({
          error: "Choisis ton opérateur Mobile Money."
        });
      }

      if (!/^[0-9+\s().-]{6,30}$/.test(number)) {
        return res.status(400).json({
          error: "Le numéro Mobile Money est invalide."
        });
      }

      const client = await pool.connect();

      try {
        await ensureWithdrawalSchema();
        await client.query("BEGIN");

        // Vérifier que le compte est actif et qu'il s'agit d'un membre
        const userResult = await client.query(
          `SELECT role, activation_status
           FROM users
           WHERE id = $1
           FOR UPDATE`,
          [req.session.userId]
        );

        const user = userResult.rows[0];

        if (!user || user.role !== "user") {
          await client.query("ROLLBACK");

          return res.status(403).json({
            error: "Seuls les membres peuvent demander un retrait."
          });
        }

        if (user.activation_status !== "active") {
          await client.query("ROLLBACK");

          return res.status(403).json({
            error: "Ton compte doit être actif pour effectuer un retrait."
          });
        }

        // Créer le portefeuille s'il n'existe pas encore
        await client.query(
          `INSERT INTO wallets (user_id, balance_xof)
           VALUES ($1, 0)
           ON CONFLICT (user_id) DO NOTHING`,
          [req.session.userId]
        );

        // Verrouiller le portefeuille pour empêcher les doubles débits
        const walletResult = await client.query(
          `SELECT balance_xof
           FROM wallets
           WHERE user_id = $1
           FOR UPDATE`,
          [req.session.userId]
        );

        const balance = Number(walletResult.rows[0].balance_xof);

        if (balance < amount) {
          await client.query("ROLLBACK");

          return res.status(400).json({
            error: "Ton solde est insuffisant pour ce retrait."
          });
        }

        // Débiter immédiatement le portefeuille
        await client.query(
          `UPDATE wallets
           SET balance_xof = balance_xof - $1,
               updated_at = NOW()
           WHERE user_id = $2`,
          [amount, req.session.userId]
        );

        // Enregistrer la demande en attente
        const withdrawalResult = await client.query(
          `INSERT INTO withdrawals
           (user_id, amount, mobile_money_number,
            mobile_money_provider, status)
           VALUES ($1, $2, $3, $4, 'pending')
           RETURNING id, amount, mobile_money_number,
                     mobile_money_provider, status, created_at`,
          [
            req.session.userId,
            amount,
            number,
            provider
          ]
        );

        const withdrawal = withdrawalResult.rows[0];

        // Garder une trace du débit
        await client.query(
          `INSERT INTO withdrawal_transactions
           (withdrawal_id, user_id, amount_xof, action)
           VALUES ($1, $2, $3, 'request')`,
          [withdrawal.id, req.session.userId, amount]
        );

        await client.query("COMMIT");

        res.status(201).json({
          ok: true,
          message: "Demande de retrait envoyée. Elle est en attente de validation.",
          withdrawal
        });

      } catch (err) {
        await client.query("ROLLBACK");

        console.error("Create withdrawal:", err.message);

        res.status(500).json({
          error: "Impossible d'enregistrer ta demande de retrait."
        });
      } finally {
        client.release();
      }
    }
  );

  // MEMBRE — consulter ses propres retraits
  app.get(
    "/api/withdrawals/mine",
    requireAuth,
    async (req, res) => {
      try {
        await ensureWithdrawalSchema();

        const result = await pool.query(
          `SELECT id, amount, mobile_money_number,
                  mobile_money_provider, status, created_at,
                  reviewed_at
           FROM withdrawals
           WHERE user_id = $1
           ORDER BY created_at DESC
           LIMIT 100`,
          [req.session.userId]
        );

        res.json({
          withdrawals: result.rows
        });

      } catch (err) {
        console.error("Member withdrawals:", err.message);

        res.status(500).json({
          error: "Impossible de charger tes retraits."
        });
      }
    }
  );

  // ADMIN — consulter toutes les demandes
  app.get(
    "/api/admin/withdrawals",
    requireAuth,
    requireWithdrawalAdmin,
    async (req, res) => {
      try {
        await ensureWithdrawalSchema();

        const result = await pool.query(
          `SELECT
             w.id,
             w.user_id,
             w.amount,
             w.mobile_money_number,
             w.mobile_money_provider,
             w.status,
             w.created_at,
             w.reviewed_at,
             u.first_name,
             u.last_name,
             u.email,
             u.phone
           FROM withdrawals w
           JOIN users u ON u.id = w.user_id
           ORDER BY
             CASE WHEN w.status = 'pending' THEN 0 ELSE 1 END,
             w.created_at DESC
           LIMIT 500`
        );

        res.json({
          withdrawals: result.rows
        });

      } catch (err) {
        console.error("Admin withdrawals:", err.message);

        res.status(500).json({
          error: "Impossible de charger les demandes de retrait."
        });
      }
    }
  );

  // ADMIN — valider ou refuser une demande
  app.patch(
    "/api/admin/withdrawals/:id/status",
    requireAuth,
    requireWithdrawalAdmin,
    async (req, res) => {
      const id = Number(req.params.id);
      const status = req.body.status;

      if (
        !Number.isSafeInteger(id) ||
        id < 1 ||
        !["validated", "failed"].includes(status)
      ) {
        return res.status(400).json({
          error: "Identifiant ou statut invalide."
        });
      }

      const client = await pool.connect();

      try {
        await ensureWithdrawalSchema();
        await client.query("BEGIN");

        const result = await client.query(
          `SELECT id, user_id, amount, status
           FROM withdrawals
           WHERE id = $1
           FOR UPDATE`,
          [id]
        );

        const withdrawal = result.rows[0];

        if (!withdrawal) {
          await client.query("ROLLBACK");

          return res.status(404).json({
            error: "Demande de retrait introuvable."
          });
        }

        if (withdrawal.status !== "pending") {
          await client.query("ROLLBACK");

          return res.status(409).json({
            error: "Cette demande a déjà été traitée."
          });
        }

        await client.query(
          `UPDATE withdrawals
           SET status = $1,
               reviewed_by = $2,
               reviewed_at = NOW()
           WHERE id = $3`,
          [status, req.session.userId, id]
        );

        await client.query(
          `INSERT INTO withdrawal_transactions
           (withdrawal_id, user_id, amount_xof, action, performed_by)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            id,
            withdrawal.user_id,
            withdrawal.amount,
            status,
            req.session.userId
          ]
        );

        // Important : aucun remboursement automatique si le retrait échoue.
        // Le membre devra contacter l'administration via les réclamations.

        await client.query("COMMIT");

        res.json({
          ok: true,
          message: status === "validated"
            ? "Retrait validé."
            : "Retrait refusé. Aucun remboursement automatique effectué.",
          status
        });

      } catch (err) {
        await client.query("ROLLBACK");

        console.error("Update withdrawal:", err.message);

        res.status(500).json({
          error: "Impossible de traiter cette demande."
        });
      } finally {
        client.release();
      }
    }
  );
};
