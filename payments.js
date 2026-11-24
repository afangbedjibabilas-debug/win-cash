
const crypto = require("crypto");

const SASPAY_BASE_URL = "https://api.saspay.me/api/v1";
const ACTIVATION_AMOUNT = 3000;
const ACTIVATION_CURRENCY = "XOF";
const ACTIVATION_COUNTRY = "TG";

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

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    console.error("SasPay API error:", response.status, data.code || "");
    throw new Error("Le prestataire de paiement a refusé la demande.");
  }

  return data;
}

async function ensurePaymentSchema(pool) {
  await pool.query(`
    ALTER TABLE activation_payments
    ADD COLUMN IF NOT EXISTS checkout_url TEXT
  `);
}

async function activateMember(pool, userId, paymentId) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");

    const paymentResult = await client.query(
      `SELECT *
       FROM activation_payments
       WHERE user_id = $1
         AND provider_reference = $2
       FOR UPDATE`,
      [userId, paymentId]
    );

    const payment = paymentResult.rows[0];

    if (!payment) {
      throw new Error("Paiement introuvable.");
    }

    if (Number(payment.amount) !== ACTIVATION_AMOUNT) {
      throw new Error("Montant du paiement incorrect.");
    }

    if (payment.status === "paid") {
      await client.query("COMMIT");
      return;
    }

    await client.query(
      `UPDATE activation_payments
       SET status = 'paid',
           confirmed_at = NOW()
       WHERE id = $1`,
      [payment.id]
    );

    const userResult = await client.query(
      `UPDATE users
       SET activation_status = 'active',
           activated_at = COALESCE(activated_at, NOW()),
           updated_at = NOW()
       WHERE id = $1
       RETURNING referred_by`,
      [userId]
    );

    if (!userResult.rows[0]) {
      throw new Error("Membre introuvable.");
    }

    const referrerId = userResult.rows[0].referred_by;

    if (referrerId) {
      await client.query(
        `INSERT INTO commissions
         (referrer_id, referred_user_id, amount)
         VALUES ($1, $2, 1000)
         ON CONFLICT (referred_user_id) DO NOTHING`,
        [referrerId, userId]
      );
    }

    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

module.exports = function installPayments(app, pool, requireAuth) {
  app.post(
    "/api/payments/activation",
    requireAuth,
    async (req, res) => {
      try {
        await ensurePaymentSchema(pool);

        const userResult = await pool.query(
          `SELECT id, first_name, last_name, email, activation_status
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

        if (user.activation_status === "active") {
          return res.status(409).json({
            error: "Ton compte est déjà activé."
          });
        }

        const existing = await pool.query(
          `SELECT provider_reference, checkout_url, status
           FROM activation_payments
           WHERE user_id = $1`,
          [user.id]
        );

        const previousPayment = existing.rows[0];

        if (previousPayment && previousPayment.status === "pending") {
          if (previousPayment.checkout_url) {
            return res.json({
              ok: true,
              checkoutUrl: previousPayment.checkout_url,
              paymentId: previousPayment.provider_reference,
              message: "Reprends ton paiement en attente."
            });
          }

          return res.status(409).json({
            error: "Une demande de paiement est déjà en cours. Réessaie dans quelques instants."
          });
        }

        const payload = {
          amount: "3000.00",
          currency: ACTIVATION_CURRENCY,
          country: ACTIVATION_COUNTRY,
          description: "Activation du compte WIN CASH",
          customer_email: user.email,
          customer_name: `${user.first_name} ${user.last_name}`
        };

        const checkout = await sasPayRequest(
          "/checkout-sessions/",
          {
            method: "POST",
            body: JSON.stringify(payload)
          }
        );

        if (
          !checkout.id ||
          !checkout.checkout_url ||
          !checkout.checkout_url.startsWith("https://pay.saspay.me/")
        ) {
          console.error("Unexpected SasPay checkout response.");
          return res.status(502).json({
            error: "Réponse de paiement invalide."
          });
        }

        await pool.query(
          `INSERT INTO activation_payments
           (user_id, amount, provider_reference, status, checkout_url)
           VALUES ($1, $2, $3, 'pending', $4)
           ON CONFLICT (user_id)
           DO UPDATE SET
             amount = EXCLUDED.amount,
             provider_reference = EXCLUDED.provider_reference,
             status = 'pending',
             checkout_url = EXCLUDED.checkout_url,
             confirmed_at = NULL`,
          [
            user.id,
            ACTIVATION_AMOUNT,
            checkout.id,
            checkout.checkout_url
          ]
        );

        res.status(201).json({
          ok: true,
          checkoutUrl: checkout.checkout_url,
          paymentId: checkout.id
        });
      } catch (error) {
        console.error("Activation payment error:", error.message);
        res.status(500).json({
          error: "Impossible de démarrer le paiement. Réessaie plus tard."
        });
      }
    }
  );

  app.get(
    "/api/payments/activation/:id/status",
    requireAuth,
    async (req, res) => {
      try {
        await ensurePaymentSchema(pool);

        const paymentResult = await pool.query(
          `SELECT id, amount, provider_reference, status
           FROM activation_payments
           WHERE user_id = $1
             AND provider_reference = $2`,
          [req.session.userId, req.params.id]
        );

        const payment = paymentResult.rows[0];

        if (!payment) {
          return res.status(404).json({
            error: "Paiement introuvable."
          });
        }

        if (payment.status === "paid") {
          return res.json({
            ok: true,
            status: "PAID",
            activated: true
          });
        }

        const result = await sasPayRequest(
          `/checkout-sessions/${encodeURIComponent(payment.provider_reference)}/status/`,
          { method: "GET" }
        );

        if (
          result.id !== payment.provider_reference
        ) {
          return res.status(502).json({
            error: "Identifiant de paiement non reconnu."
          });
        }

        if (
          result.status === "PAID" &&
          result.transaction_status === "SUCCESS"
        ) {
          await activateMember(
            pool,
            req.session.userId,
            payment.provider_reference
          );

          return res.json({
            ok: true,
            status: "PAID",
            activated: true
          });
        }

        if (
          result.status === "FAILED" ||
          result.status === "CANCELLED" ||
          result.status === "EXPIRED"
        ) {
          await pool.query(
            `UPDATE activation_payments
             SET status = 'failed'
             WHERE id = $1 AND status <> 'paid'`,
            [payment.id]
          );
        }

        res.json({
          ok: true,
          status: result.status || "PENDING",
          activated: false
        });
      } catch (error) {
        console.error("Payment status error:", error.message);
        res.status(500).json({
          error: "Impossible de vérifier le paiement pour le moment."
        });
      }
    }
  );
};
