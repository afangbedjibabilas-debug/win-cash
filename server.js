const express = require("express");
const helmet = require("helmet");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const { Pool } = require("pg");
const { rateLimit } = require("express-rate-limit");
const path = require("path");
const crypto = require("crypto");

const app = express();
const PORT = Number(process.env.PORT || 3000);
const isProduction = process.env.NODE_ENV === "production";

if (!process.env.DATABASE_URL || !process.env.SESSION_SECRET) {
  console.error("Missing DATABASE_URL or SESSION_SECRET environment variable.");
  process.exit(1);
}
if (process.env.SESSION_SECRET.length < 32) {
  console.error("SESSION_SECRET must contain at least 32 characters.");
  process.exit(1);
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false }
});

app.disable("x-powered-by");
if (isProduction) app.set("trust proxy", 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));

app.use(session({
  store: new PgSession({ pool, tableName: "user_sessions", createTableIfMissing: true }),
  name: "wincash.sid",
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    maxAge: 1000 * 60 * 60 * 24 * 7
  }
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-7",
  legacyHeaders: false,
  message: { error: "Trop de tentatives. Réessaie dans quelques minutes." }
});

function cleanText(value, max = 120) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}
function validEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
function hashPassword(password, salt) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, 64, (err, key) => {
      if (err) reject(err);
      else resolve(key.toString("hex"));
    });
  });
}
async function passwordMatches(password, salt, expectedHex) {
  const actual = Buffer.from(await hashPassword(password, salt), "hex");
  const expected = Buffer.from(expectedHex, "hex");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
function publicUser(row) {
  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    email: row.email,
    phone: row.phone,
    role: row.role,
    createdAt: row.created_at
  };
}
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: "Connexion requise." });
  next();
}

async function initializeDatabase() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      first_name VARCHAR(80) NOT NULL,
      last_name VARCHAR(80) NOT NULL,
      email VARCHAR(254) NOT NULL UNIQUE,
      phone VARCHAR(30) NOT NULL,
      password_hash CHAR(128) NOT NULL,
      password_salt CHAR(32) NOT NULL,
      role VARCHAR(20) NOT NULL DEFAULT 'user' CHECK (role IN ('user','admin')),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS users_created_at_idx ON users(created_at DESC);
  `);
}

app.get("/api/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ ok: true, service: "WIN CASH", database: "connected", realMoneyEnabled: false });
  } catch {
    res.status(503).json({ ok: false, service: "WIN CASH", database: "unavailable" });
  }
});

app.post("/api/auth/register", authLimiter, async (req, res) => {
  try {
    const firstName = cleanText(req.body.firstName, 80);
    const lastName = cleanText(req.body.lastName, 80);
    const email = cleanText(req.body.email, 254).toLowerCase();
    const phone = cleanText(req.body.phone, 30);
    const password = typeof req.body.password === "string" ? req.body.password : "";

    if (!firstName || !lastName || !validEmail(email) || !phone) {
      return res.status(400).json({ error: "Vérifie ton nom, prénom, e-mail et téléphone." });
    }
    if (password.length < 10 || password.length > 200) {
      return res.status(400).json({ error: "Le mot de passe doit contenir au moins 10 caractères." });
    }

    const salt = crypto.randomBytes(16).toString("hex");
    const passwordHash = await hashPassword(password, salt);
    const result = await pool.query(
      `INSERT INTO users (first_name,last_name,email,phone,password_hash,password_salt)
       VALUES ($1,$2,$3,$4,$5,$6)
       RETURNING id,first_name,last_name,email,phone,role,created_at`,
      [firstName,lastName,email,phone,passwordHash,salt]
    );
    req.session.userId = result.rows[0].id;
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ error: "Impossible d'ouvrir la session." });
      req.session.userId = result.rows[0].id;
      req.session.save(saveErr => {
        if (saveErr) return res.status(500).json({ error: "Session non enregistrée." });
        res.status(201).json({ user: publicUser(result.rows[0]) });
      });
    });
  } catch (err) {
    if (err.code === "23505") return res.status(409).json({ error: "Cette adresse e-mail possède déjà un compte." });
    console.error("Registration error:", err.message);
    res.status(500).json({ error: "Une erreur est survenue pendant l'inscription." });
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
  try {
    const email = cleanText(req.body.email, 254).toLowerCase();
    const password = typeof req.body.password === "string" ? req.body.password : "";
    const result = await pool.query("SELECT * FROM users WHERE email=$1", [email]);
    const user = result.rows[0];
    if (!user || !(await passwordMatches(password, user.password_salt, user.password_hash))) {
      return res.status(401).json({ error: "Adresse e-mail ou mot de passe incorrect." });
    }
    req.session.regenerate(err => {
      if (err) return res.status(500).json({ error: "Impossible d'ouvrir la session." });
      req.session.userId = user.id;
      req.session.save(saveErr => {
        if (saveErr) return res.status(500).json({ error: "Session non enregistrée." });
        res.json({ user: publicUser(user) });
      });
    });
  } catch (err) {
    console.error("Login error:", err.message);
    res.status(500).json({ error: "Une erreur est survenue pendant la connexion." });
  }
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  const result = await pool.query(
    "SELECT id,first_name,last_name,email,phone,role,created_at FROM users WHERE id=$1",
    [req.session.userId]
  );
  if (!result.rows[0]) {
    return req.session.destroy(() => res.status(401).json({ error: "Session expirée." }));
  }
  res.json({ user: publicUser(result.rows[0]) });
});

app.post("/api/auth/logout", requireAuth, (req, res) => {
  req.session.destroy(err => {
    if (err) return res.status(500).json({ error: "Déconnexion impossible." });
    res.clearCookie("wincash.sid", { httpOnly: true, sameSite: "lax", secure: isProduction });
    res.json({ ok: true });
  });
});

app.get("/api/admin/users", requireAuth, async (req, res) => {
  const me = await pool.query("SELECT role FROM users WHERE id=$1", [req.session.userId]);
  if (me.rows[0]?.role !== "admin") return res.status(403).json({ error: "Accès administrateur requis." });
  const result = await pool.query(
    "SELECT id,first_name,last_name,email,phone,role,created_at FROM users ORDER BY created_at DESC LIMIT 500"
  );
  res.json({ users: result.rows.map(publicUser) });
});

app.use(express.static(path.join(__dirname, "public"), { extensions: ["html"] }));
app.get("*", (_req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

initializeDatabase().then(() => {
  app.listen(PORT, "0.0.0.0", () => console.log(`WIN CASH listening on ${PORT}`));
}).catch(err => {
  console.error("Database initialization failed:", err.message);
  process.exit(1);
});
