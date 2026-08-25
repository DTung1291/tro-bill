BEGIN;

-- Không tham chiếu trực tiếp rooms/tenants vì PUT /api/state thay toàn bộ các
-- bảng đó trong một transaction. Snapshot vẫn giữ được sổ cọc khi khách rời đi.
CREATE TABLE IF NOT EXISTS tenant_deposit_accounts (
  id                   BIGSERIAL PRIMARY KEY,
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id            TEXT NOT NULL,
  tenant_name_snapshot TEXT NOT NULL DEFAULT '',
  room_id              TEXT NOT NULL,
  room_name_snapshot   TEXT NOT NULL DEFAULT '',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tenant_deposit_accounts_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT tenant_deposit_accounts_tenant_unique UNIQUE (user_id, tenant_id),
  CONSTRAINT tenant_deposit_accounts_tenant_id_length
    CHECK (char_length(tenant_id) BETWEEN 1 AND 200),
  CONSTRAINT tenant_deposit_accounts_room_id_length
    CHECK (char_length(room_id) BETWEEN 1 AND 200)
);

CREATE INDEX IF NOT EXISTS idx_tenant_deposit_accounts_room
  ON tenant_deposit_accounts(user_id, room_id, id);

CREATE TABLE IF NOT EXISTS tenant_deposit_transactions (
  id                      BIGSERIAL PRIMARY KEY,
  user_id                 BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id              BIGINT NOT NULL,
  transaction_code        TEXT NOT NULL,
  entry_type              TEXT NOT NULL,
  amount_vnd              NUMERIC(12, 0) NOT NULL,
  payment_method          TEXT NOT NULL DEFAULT 'manual',
  note                    TEXT NOT NULL DEFAULT '',
  source                  TEXT NOT NULL DEFAULT 'manual',
  idempotency_key         TEXT,
  reverses_transaction_id BIGINT,
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tenant_deposit_transactions_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT tenant_deposit_transactions_code_unique UNIQUE (user_id, transaction_code),
  CONSTRAINT tenant_deposit_transactions_account_owner_fk
    FOREIGN KEY (user_id, account_id)
    REFERENCES tenant_deposit_accounts(user_id, id) ON DELETE CASCADE,
  CONSTRAINT tenant_deposit_transactions_reversal_owner_fk
    FOREIGN KEY (user_id, reverses_transaction_id)
    REFERENCES tenant_deposit_transactions(user_id, id) ON DELETE RESTRICT,
  CONSTRAINT tenant_deposit_transactions_type_valid
    CHECK (entry_type IN ('collection', 'deduction', 'refund', 'reversal')),
  CONSTRAINT tenant_deposit_transactions_amount_valid CHECK (
    (entry_type = 'collection' AND amount_vnd > 0)
    OR (entry_type IN ('deduction', 'refund') AND amount_vnd < 0)
    OR (entry_type = 'reversal' AND amount_vnd <> 0)
  ),
  CONSTRAINT tenant_deposit_transactions_reversal_target CHECK (
    (entry_type = 'reversal' AND reverses_transaction_id IS NOT NULL)
    OR (entry_type <> 'reversal' AND reverses_transaction_id IS NULL)
  ),
  CONSTRAINT tenant_deposit_transactions_method_format
    CHECK (payment_method ~ '^[a-z][a-z0-9_]{1,31}$'),
  CONSTRAINT tenant_deposit_transactions_source_format
    CHECK (source ~ '^[a-z][a-z0-9_]{2,63}$'),
  CONSTRAINT tenant_deposit_transactions_note_length CHECK (char_length(note) <= 500),
  CONSTRAINT tenant_deposit_transactions_idempotency_length
    CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 300)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_deposit_transactions_idempotency
  ON tenant_deposit_transactions(user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_deposit_transactions_reversal_once
  ON tenant_deposit_transactions(user_id, reverses_transaction_id)
  WHERE reverses_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tenant_deposit_transactions_account_time
  ON tenant_deposit_transactions(user_id, account_id, occurred_at DESC, id DESC);

CREATE OR REPLACE FUNCTION enforce_tenant_deposit_nonnegative()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  current_balance NUMERIC(12, 0);
BEGIN
  PERFORM 1
  FROM tenant_deposit_accounts
  WHERE user_id=NEW.user_id AND id=NEW.account_id
  FOR UPDATE;

  SELECT COALESCE(SUM(amount_vnd), 0)
  INTO current_balance
  FROM tenant_deposit_transactions
  WHERE user_id=NEW.user_id AND account_id=NEW.account_id;

  IF current_balance + NEW.amount_vnd < 0 THEN
    RAISE EXCEPTION 'tenant deposit balance cannot be negative'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='tenant_deposit_nonnegative_before_insert'
      AND tgrelid='public.tenant_deposit_transactions'::regclass
  ) THEN
    CREATE TRIGGER tenant_deposit_nonnegative_before_insert
      BEFORE INSERT ON tenant_deposit_transactions
      FOR EACH ROW EXECUTE FUNCTION enforce_tenant_deposit_nonnegative();
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime') THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON tenant_deposit_accounts FROM tro_bill_runtime';
    EXECUTE 'GRANT SELECT, INSERT ON tenant_deposit_accounts TO tro_bill_runtime';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE tenant_deposit_accounts_id_seq TO tro_bill_runtime';
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON tenant_deposit_transactions FROM tro_bill_runtime';
    EXECUTE 'GRANT SELECT, INSERT ON tenant_deposit_transactions TO tro_bill_runtime';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE tenant_deposit_transactions_id_seq TO tro_bill_runtime';
  END IF;
END $$;

COMMIT;

SELECT
  to_regclass('public.tenant_deposit_accounts') IS NOT NULL AS accounts_ready,
  to_regclass('public.tenant_deposit_transactions') IS NOT NULL AS transactions_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='tenant_deposit_transactions_amount_valid'
  ) AS signed_amount_constraint_ready,
  EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public'
      AND indexname='idx_tenant_deposit_transactions_idempotency'
  ) AS idempotency_ready,
  EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='tenant_deposit_nonnegative_before_insert'
      AND tgrelid='public.tenant_deposit_transactions'::regclass
  ) AS nonnegative_trigger_ready,
  NOT has_table_privilege('tro_bill_runtime', 'tenant_deposit_transactions', 'UPDATE')
    AND NOT has_table_privilege('tro_bill_runtime', 'tenant_deposit_transactions', 'DELETE')
    AS ledger_append_only;
