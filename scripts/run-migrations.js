const { Pool } = require("pg");
const fs = require("fs");
const path = require("path");

async function run() {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL manquant");
  }

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSLMODE === "disable"
      ? false
      : { rejectUnauthorized: false }
  });

  const client = await pool.connect();

  try {
    await client.query(
      "SELECT pg_advisory_lock(741852963)"
    );

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        name VARCHAR(255) PRIMARY KEY,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    const name = "001_activation_referrals.sql";

    const existing = await client.query(
      "SELECT name FROM schema_migrations WHERE name = $1",
      [name]
    );

    if (existing.rowCount > 0) {
      console.log("Migration déjà exécutée.");
      return;
    }

    const file = path.join(
      __dirname,
      "..",
      "migrations",
      name
    );

    let sql = fs.readFileSync(file, "utf8");

    sql = sql.replace(/^\s*BEGIN\s*;/i, "");
    sql = sql.replace(/COMMIT\s*;\s*$/i, "");

    await client.query("BEGIN");

    try {
      await client.query(sql);

      await client.query(
        "INSERT INTO schema_migrations (name) VALUES ($1)",
        [name]
      );

      await client.query("COMMIT");
      console.log("Migration appliquée avec succès.");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  } finally {
    try {
      await client.query(
        "SELECT pg_advisory_unlock(741852963)"
      );
    } finally {
      client.release();
      await pool.end();
    }
  }
}

run().catch(error => {
  console.error("Erreur migration :", error);
  process.exit(1);
});
