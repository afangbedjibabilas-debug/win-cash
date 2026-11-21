BEGIN;

-- Ajouter les informations d'activation et de parrainage
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS activated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS referral_code VARCHAR(20),
  ADD COLUMN IF NOT EXISTS referred_by_user_id BIGINT
    REFERENCES users(id);

-- Les anciens membres sont conservés comme membres activés.
UPDATE users
SET is_active = TRUE,  activated_at = COALESCE(activated_at, created_at),
    referral_code = COALESCE(
      referral_code,
      'WC' || UPPER(SUBSTRING(
        MD5(id::TEXT || RANDOM()::TEXT), 1, 10
      ))
    );

-- Les nouveaux comptes seront inactifs par défaut.
ALTER TABLE users ALTER COLUMN is_active SET DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS users_referral_code_unique
ON users(referral_code);

CREATE INDEX IF NOT EXISTS users_referred_by_idx
ON users(referred_by_user_id);

-- Historique des paiements d'activation
CREATE TABLE IF NOT EXISTS activation_payments (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  amount BIGINT NOT NULL CHECK (amount = 3000),
  currency VARCHAR(3) NOT NULL DEFAULT 'XOF',
  provider VARCHAR(30) NOT NULL DEFAULT 'SASPAY',
  provider_reference VARCHAR(150) UNIQUE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'success', 'failed', 'cancelled')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS activation_payments_user_idx
ON activation_payments(user_id);

-- Commissions des parrainages directs
CREATE TABLE IF NOT EXISTS referral_commissions (
  id BIGSERIAL PRIMARY KEY,
  referrer_user_id BIGINT NOT NULL REFERENCES users(id),
  referred_user_id BIGINT NOT NULL REFERENCES users(id),
  activation_payment_id BIGINT NOT NULL UNIQUE
    REFERENCES activation_payments(id),
  amount BIGINT NOT NULL DEFAULT 1000 CHECK (amount = 1000),
  status VARCHAR(20) NOT NULL DEFAULT 'available'
    CHECK (status IN ('available', 'withdrawn')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (referrer_user_id, referred_user_id)
);

CREATE INDEX IF NOT EXISTS referral_commissions_referrer_idx
ON referral_commissions(referrer_user_id, status);

-- Demandes de retrait
CREATE TABLE IF NOT EXISTS withdrawals (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT NOT NULL REFERENCES users(id),
  amount BIGINT NOT NULL CHECK (amount >= 5000),
  phone VARCHAR(30) NOT NULL,
  mobile_money_provider VARCHAR(50) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'success', 'failed', 'cancelled')),
  provider_reference VARCHAR(150),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS withdrawals_user_idx
ON withdrawals(user_id, status);

COMMIT;
