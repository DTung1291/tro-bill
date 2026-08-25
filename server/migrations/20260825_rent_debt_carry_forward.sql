BEGIN;

CREATE TABLE IF NOT EXISTS rent_payment_receipts (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id            TEXT NOT NULL,
  target_period      TEXT NOT NULL,
  receipt_code       TEXT NOT NULL,
  amount_vnd         NUMERIC(12, 0) NOT NULL,
  payment_method     TEXT NOT NULL DEFAULT 'manual',
  note               TEXT NOT NULL DEFAULT '',
  source             TEXT NOT NULL DEFAULT 'manual_current',
  idempotency_key    TEXT NOT NULL,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rent_payment_receipts_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT rent_payment_receipts_idempotency_unique UNIQUE (user_id, idempotency_key),
  CONSTRAINT rent_payment_receipts_code_unique UNIQUE (user_id, receipt_code),
  CONSTRAINT rent_payment_receipts_period_format
    CHECK (target_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT rent_payment_receipts_amount_positive CHECK (amount_vnd > 0),
  CONSTRAINT rent_payment_receipts_room_id_length CHECK (char_length(room_id) BETWEEN 1 AND 200),
  CONSTRAINT rent_payment_receipts_method_format
    CHECK (payment_method ~ '^[a-z][a-z0-9_]{1,31}$'),
  CONSTRAINT rent_payment_receipts_source_format
    CHECK (source ~ '^[a-z][a-z0-9_]{2,63}$'),
  CONSTRAINT rent_payment_receipts_note_length CHECK (char_length(note) <= 500),
  CONSTRAINT rent_payment_receipts_idempotency_length
    CHECK (char_length(idempotency_key) BETWEEN 8 AND 300)
);

CREATE INDEX IF NOT EXISTS idx_rent_payment_receipts_room_period
  ON rent_payment_receipts(user_id, room_id, target_period DESC, occurred_at DESC);

ALTER TABLE rent_payment_transactions
  ADD COLUMN IF NOT EXISTS receipt_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_payment_transactions_receipt_owner_fk'
  ) THEN
    ALTER TABLE rent_payment_transactions
      ADD CONSTRAINT rent_payment_transactions_receipt_owner_fk
      FOREIGN KEY (user_id, receipt_id)
      REFERENCES rent_payment_receipts(user_id, id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rent_payment_receipt_invoice
  ON rent_payment_transactions(user_id, receipt_id, invoice_id)
  WHERE receipt_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tro_bill_runtime') THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rent_payment_receipts FROM tro_bill_runtime';
    EXECUTE 'GRANT SELECT, INSERT ON rent_payment_receipts TO tro_bill_runtime';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE rent_payment_receipts_id_seq TO tro_bill_runtime';
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rent_payment_transactions FROM tro_bill_runtime';
    EXECUTE 'GRANT SELECT, INSERT ON rent_payment_transactions TO tro_bill_runtime';
  END IF;
END $$;

COMMIT;

SELECT
  to_regclass('public.rent_payment_receipts') IS NOT NULL AS receipts_ready,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='rent_payment_transactions'
      AND column_name='receipt_id'
  ) AS allocations_ready,
  has_table_privilege('tro_bill_runtime', 'rent_payment_receipts', 'SELECT,INSERT')
    AS receipt_runtime_ready,
  NOT has_table_privilege('tro_bill_runtime', 'rent_payment_receipts', 'UPDATE')
    AND NOT has_table_privilege('tro_bill_runtime', 'rent_payment_receipts', 'DELETE')
    AS receipts_append_only,
  NOT has_table_privilege('tro_bill_runtime', 'rent_payment_transactions', 'UPDATE')
    AND NOT has_table_privilege('tro_bill_runtime', 'rent_payment_transactions', 'DELETE')
    AS ledger_append_only;
