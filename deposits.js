// WIN CASH — Dépôts réels SASPAY
// Première phase : Togo / XOF uniquement.
// Les retraits ne sont pas concernés.

const SASPAY_BASE_URL = "https://api.saspay.me/api/v1";
const MIN_DEPOSIT_XOF = 3000;

const RETURN_URL =
  "https://win-cash-production-d2c6ee74.up.railway.app/?deposit=return";

function getSasPayKey() {
  const key = process.env.SASPAY_SECRET_KEY || "";

  if (!key.startsWith("sk_live_")) {
    throw new Error("Clé SASPAY de production absente ou invalide.");
  }

  return key;
}

async function sasPayRequest(endpoint, options = {}) {
  const response = await fetch(`${SASPAY_BASE_URL}${endpoint}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${getSasPayKey()}`,
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    signal: AbortSignal.timeout(20000)
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok || body.success === false) {
    const error = new Error("La demande SASPAY a été refusée.");
    error.status = response.status;
    throw error;
  }

  return body.data && typeof body.data === "object"
    ? body.data
    : body;
}

function isValidCheckoutUrl(value) {
  try {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      (
        url.hostname === "saspay.me" ||
        url.hostname.endsWith(".saspay.me")
      )
    );
  } catch {
    return false;
  }
}

async function ensureDepositSchema(pool) {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS wallets (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL UNIQUE REFERENCES users(id),
      balance_xof BIGINT NOT NULL DEFAULT 0
        CHECK (balance_xof >= 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS deposits (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      country_code VARCHAR(10) NOT NULL,
      currency VARCHAR(10) NOT NULL,
      local_amount NUMERIC(20,2) NOT NULL,
      exchange_rate NUMERIC(20,10) NOT NULL,
      amount_xof BIGINT NOT NULL CHECK (amount_xof >= 3000),
      provider_reference VARCHAR(150) UNIQUE,
      checkout_url TEXT,
      status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (
          status IN ('pending', 'paid', 'failed', 'cancelled')
        ),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      confirmed_at TIMESTAMPTZ
    );

    CREATE TABLE IF NOT EXISTS wallet_transactions (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id),
      deposit_id BIGINT NOT NULL UNIQUE REFERENCES deposits(id),
      type VARCHAR(20) NOT NULL DEFAULT 'deposit',
      amount_xof BIGINT NOT NULL CHECK (amount_xof > 0),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS deposits_user_created_idx
      ON deposits(user_id, created_at DESC);
  `);
}

async function verifyAndCreditDeposit(
  pool,
  userId,
  paymentId,
  verified
) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const result = await client.query(
      `SELECT *
       FROM deposits
       WHERE user_id = $1
         AND provider_reference = $2
       FOR UPDATE`,
      [userId, paymentId]
    );

    const deposit = result.rows[0];

    if (!deposit) {
      throw new Error("Dépôt introuvable.");
    }

    if (deposit.status === "paid") {
      const wallet = await client.query(
        "SELECT balance_xof FROM wallets WHERE user_id = $1",
        [userId]
      );

      await client.query("COMMIT");

      return {
        status: "SUCCESS",
        credited: true,
        balanceXof: Number(
          wallet.rows[0]?.balance_xof || 0
        )
      };
    }

    const verifiedAmountRaw =
  verified.amounts?.requested ??
  verified.amounts?.requested_amount ??
  verified.requested_amount ??
  verified.amount;

const verifiedAmount = Number(verifiedAmountRaw);

    if (
      String(verified.id || "") !==
        String(deposit.provider_reference) ||
      String(verified.currency || "") !==
        String(deposit.currency) ||
      !Number.isFinite(verifiedAmount) ||
      Math.round(verifiedAmount * 100) !==
        Math.round(Number(deposit.local_amount) * 100)
    ) {
      throw new Error(
        "Les informations du paiement SASPAY ne correspondent pas au dépôt."
      );
    }

    if (verified.status !== "SUCCESS") {
      let localStatus = "pending";

      if (
        ["FAILED", "EXPIRED"].includes(verified.status)
      ) {
        localStatus = "failed";
      } else if (verified.status === "CANCELLED") {
        localStatus = "cancelled";
      }

      await client.query(
        `UPDATE deposits
         SET status = $1
         WHERE id = $2
           AND status = 'pending'`,
        [localStatus, deposit.id]
      );

      await client.query("COMMIT");

      return {
        status: verified.status || "PENDING",
        credited: false,
        balanceXof: null
      };
    }

    await client.query(
      `INSERT INTO wallets (user_id, balance_xof)
       VALUES ($1, 0)
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );

    const ledger = await client.query(
      `INSERT INTO wallet_transactions
         (user_id, deposit_id, type, amount_xof)
       VALUES ($1, $2, 'deposit', $3)
       ON CONFLICT (deposit_id) DO NOTHING
       RETURNING id`,
      [userId, deposit.id, deposit.amount_xof]
    );

    if (ledger.rowCount === 1) {
      await client.query(
        `UPDATE wallets
         SET balance_xof = balance_xof + $1,
             updated_at = NOW()
         WHERE user_id = $2`,
        [deposit.amount_xof, userId]
      );
    }

    await client.query(
      `UPDATE deposits
       SET status = 'paid',
           confirmed_at = COALESCE(confirmed_at, NOW())
       WHERE id = $1`,
      [deposit.id]
    );

    const wallet = await client.query(
      "SELECT balance_xof FROM wallets WHERE user_id = $1",
      [userId]
    );

    await client.query("COMMIT");

    return {
      status: "SUCCESS",
      credited: true,
      balanceXof: Number(wallet.rows[0].balance_xof)
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = function installDeposits(
  app,
  pool,
  requireAuth
) {

  // Consulter le portefeuille
  app.get(
    "/api/payments/wallet",
    requireAuth,
    async (req, res) => {
      try {
        await ensureDepositSchema(pool);

        await pool.query(
          `INSERT INTO wallets (user_id, balance_xof)
           VALUES ($1, 0)
           ON CONFLICT (user_id) DO NOTHING`,
          [req.session.userId]
        );

        const result = await pool.query(
          `SELECT balance_xof
           FROM wallets
           WHERE user_id = $1`,
          [req.session.userId]
        );

        return res.json({
          ok: true,
          balanceXof: Number(result.rows[0].balance_xof)
        });
      } catch (error) {
        console.error("Wallet read error:", error.message);

        return res.status(500).json({
          error: "Impossible de charger le portefeuille."
        });
      }
    }
  );

  // Créer une demande de dépôt
  app.post(
    "/api/payments/deposit",
    requireAuth,
    async (req, res) => {
      let depositId = null;

      try {
        await ensureDepositSchema(pool);

        
        const amount = Number(req.body.amount);

        const userResult = await pool.query(
          `SELECT id, first_name, last_name, email,
                  country_code, currency, activation_status
           FROM users
           WHERE id = $1`,
          [req.session.userId]
        );

        const user = userResult.rows[0];

        if (!user) {
          return res.status(404).json({
            error: "Compte introuvable."
          });
        }

        const minimumLocalAmounts = {
          XOF: 3000,
          XAF: 3000,
          NGN: 6802,
          GHS: 59.45,
          GNF: 44517
        };

        const minimumLocalAmount =
          minimumLocalAmounts[user.currency];

        if (user.activation_status !== "active") {
          return res.status(403).json({
            error: "Votre compte doit être activé."
          });
        }

        if (
          !user.country_code ||
          !minimumLocalAmount ||
          !Number.isFinite(amount) ||
          amount < minimumLocalAmount
        ) {
          return res.status(400).json({
            error: "Montant minimum ou devise non prise en charge."
          });
        }

        const exchangeRate = 3000 / minimumLocalAmount;
        const amountXof = Math.round(amount * exchangeRate);

        if (
          !Number.isSafeInteger(amountXof) ||
          amountXof < 3000
        ) {
          return res.status(400).json({
            error: "Le dépôt doit représenter au moins 3 000 FCFA."
          });
        }


        // Dépôts internationaux selon le pays et la devise du membre.
        const client = await pool.connect();

        try {
          await client.query("BEGIN");

          await client.query(
            "SELECT id FROM users WHERE id = $1 FOR UPDATE",
            [user.id]
          );

          const pendingResult = await client.query(
            `SELECT provider_reference, checkout_url
             FROM deposits
             WHERE user_id = $1
               AND status = 'pending'
             ORDER BY created_at DESC
             LIMIT 1`,
            [user.id]
          );

          const pending = pendingResult.rows[0];

          if (pending) {
            await client.query("COMMIT");

            if (
              pending.provider_reference &&
              pending.checkout_url
            ) {
              return res.json({
                ok: true,
                checkoutUrl: pending.checkout_url,
                paymentId: pending.provider_reference,
                message: "Reprends ton dépôt en attente."
              });
            }

            return res.status(409).json({
              error:
                "Une demande de dépôt est déjà en cours. Réessaie dans un instant."
            });
          }

          
          const inserted = await client.query(
            `INSERT INTO deposits
               (user_id, country_code, currency,
                local_amount, exchange_rate,
                amount_xof, status)
             VALUES ($1, $2, $3, $4, $5, $6, 'pending')
             RETURNING id`,
            [
              user.id,
              user.country_code,
              user.currency,
              amount,
              exchangeRate,
              amountXof
            ]
          );


          depositId = inserted.rows[0].id;

          await client.query("COMMIT");
        } catch (error) {
          await client.query("ROLLBACK");
          throw error;
        } finally {
          client.release();
        }

        const checkout = await sasPayRequest(
          "/checkout-sessions/",
          {
            method: "POST",
            body: JSON.stringify({
              amount: amount.toFixed(2),
currency: user.currency,
country: user.country_code,
              description: "Dépôt portefeuille WIN CASH",
              customer_email: user.email,
              customer_name:
                `${user.first_name} ${user.last_name}`,
              return_url: RETURN_URL
            })
          }
        );

        if (
          !checkout.id ||
          !isValidCheckoutUrl(checkout.checkout_url)
        ) {
          throw new Error(
            "SASPAY n'a pas fourni une page de paiement valide."
          );
        }

        await pool.query(
          `UPDATE deposits
           SET provider_reference = $1,
               checkout_url = $2
           WHERE id = $3
             AND user_id = $4
             AND status = 'pending'`,
          [
            checkout.id,
            checkout.checkout_url,
            depositId,
            user.id
          ]
        );

        return res.status(201).json({
          ok: true,
          checkoutUrl: checkout.checkout_url,
          paymentId: checkout.id
        });

      } catch (error) {
        if (depositId) {
          await pool.query(
            `UPDATE deposits
             SET status = 'failed'
             WHERE id = $1
               AND status = 'pending'
               AND provider_reference IS NULL`,
            [depositId]
          ).catch(() => {});
        }

        console.error(
          "Deposit creation error:",
          error.status || "",
          error.message
        );

        return res.status(502).json({
          error:
            error.status === 401 || error.status === 403
              ? "SASPAY refuse cette demande. Vérifie les droits Payin de la clé."
              : "Impossible de démarrer le dépôt. Réessaie plus tard."
        });
      }
    }
  );

  // Vérifier le paiement et créditer le portefeuille
  app.get(
    "/api/payments/deposit/:id/status",
    requireAuth,
    async (req, res) => {
      try {
        await ensureDepositSchema(pool);

        const result = await pool.query(
          `SELECT id, local_amount, currency,
                  provider_reference, status
           FROM deposits
           WHERE user_id = $1
             AND provider_reference = $2`,
          [req.session.userId, req.params.id]
        );

        const deposit = result.rows[0];

        if (!deposit) {
          return res.status(404).json({
            error: "Dépôt introuvable."
          });
        }

        if (deposit.status === "paid") {
          const wallet = await pool.query(
            `SELECT balance_xof
             FROM wallets
             WHERE user_id = $1`,
            [req.session.userId]
          );

          return res.json({
            ok: true,
            status: "SUCCESS",
            credited: true,
            balanceXof: Number(
              wallet.rows[0]?.balance_xof || 0
            )
          });
        }

        const verified = await sasPayRequest(
          `/payments/${encodeURIComponent(
            deposit.provider_reference
          )}/verify/`,
          { method: "GET" }
        );

        const outcome = await verifyAndCreditDeposit(
          pool,
          req.session.userId,
          deposit.provider_reference,
          verified
        );

        return res.json({
          ok: true,
          status: outcome.status,
          credited: outcome.credited,
          balanceXof: outcome.balanceXof
        });

      } catch (error) {
        console.error(
          "Deposit verification error:",
          error.status || "",
          error.message
        );

        return res.status(502).json({
          error:
            "Impossible de confirmer le dépôt auprès de SASPAY pour le moment."
        });
      }
    }
  );
};
