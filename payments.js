module.exports = function installPayments(app, pool, requireAuth) {
  app.post("/api/payments/activation", requireAuth, (req, res) => {
    res.status(503).json({
      error: "Le paiement est en cours de configuration."
    });
  });

  app.get("/api/payments/activation/:id/status", requireAuth, (req, res) => {
    res.status(503).json({
      error: "La vérification du paiement est en cours de configuration."
    });
  });
};
