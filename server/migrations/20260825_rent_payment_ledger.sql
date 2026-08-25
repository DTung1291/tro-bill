BEGIN;

CREATE TABLE IF NOT EXISTS rent_invoices (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id            TEXT NOT NULL,
  room_name_snapshot TEXT NOT NULL DEFAULT '',
  period             TEXT NOT NULL,
  issued_total_vnd   NUMERIC(12, 0) NOT NULL,
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rent_invoices_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT rent_invoices_room_period_unique UNIQUE (user_id, room_id, period),
  CONSTRAINT rent_invoices_period_format CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT rent_invoices_total_nonnegative CHECK (issued_total_vnd >= 0),
  CONSTRAINT rent_invoices_room_id_length CHECK (char_length(room_id) BETWEEN 1 AND 200)
);

CREATE INDEX IF NOT EXISTS idx_rent_invoices_user_period
  ON rent_invoices(user_id, period DESC, room_id);

CREATE TABLE IF NOT EXISTS rent_payment_transactions (
  id                      BIGSERIAL PRIMARY KEY,
  user_id                 BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_id              BIGINT NOT NULL,
  entry_type              TEXT NOT NULL,
  amount_vnd              NUMERIC(12, 0) NOT NULL,
  payment_method          TEXT NOT NULL DEFAULT 'manual',
  external_reference      TEXT,
  note                    TEXT NOT NULL DEFAULT '',
  source                  TEXT NOT NULL DEFAULT 'manual_full',
  idempotency_key         TEXT,
  reverses_transaction_id BIGINT,
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rent_payment_transactions_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT rent_payment_transactions_invoice_owner_fk
    FOREIGN KEY (user_id, invoice_id)
    REFERENCES rent_invoices(user_id, id) ON DELETE CASCADE,
  CONSTRAINT rent_payment_transactions_reversal_owner_fk
    FOREIGN KEY (user_id, reverses_transaction_id)
    REFERENCES rent_payment_transactions(user_id, id) ON DELETE RESTRICT,
  CONSTRAINT rent_payment_transactions_type_valid
    CHECK (entry_type IN ('payment', 'reversal', 'adjustment')),
  CONSTRAINT rent_payment_transactions_amount_valid CHECK (
    (entry_type = 'payment' AND amount_vnd > 0)
    OR (entry_type = 'reversal' AND amount_vnd < 0)
    OR (entry_type = 'adjustment' AND amount_vnd <> 0)
  ),
  CONSTRAINT rent_payment_transactions_method_format
    CHECK (payment_method ~ '^[a-z][a-z0-9_]{1,31}$'),
  CONSTRAINT rent_payment_transactions_source_format
    CHECK (source ~ '^[a-z][a-z0-9_]{2,63}$'),
  CONSTRAINT rent_payment_transactions_note_length CHECK (char_length(note) <= 500),
  CONSTRAINT rent_payment_transactions_reference_length
    CHECK (external_reference IS NULL OR char_length(external_reference) BETWEEN 1 AND 200),
  CONSTRAINT rent_payment_transactions_idempotency_length
    CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 300),
  CONSTRAINT rent_payment_transactions_reversal_target CHECK (
    (entry_type = 'reversal' AND reverses_transaction_id IS NOT NULL)
    OR (entry_type <> 'reversal' AND reverses_transaction_id IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rent_payment_idempotency
  ON rent_payment_transactions(user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rent_payment_one_reversal
  ON rent_payment_transactions(user_id, reverses_transaction_id)
  WHERE reverses_transaction_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_rent_payment_invoice_occurred
  ON rent_payment_transactions(user_id, invoice_id, occurred_at DESC, id DESC);

INSERT INTO rent_invoices
  (user_id, room_id, room_name_snapshot, period, issued_total_vnd, issued_at)
SELECT hs.user_id, hb.room_id, COALESCE(hb.room_name, ''), hs.period,
       GREATEST(0, ROUND(COALESCE(hb.total, 0))),
       to_timestamp(GREATEST(0, hs.created_at) / 1000.0)
FROM history_bills hb
JOIN history_snapshots hs ON hs.id=hb.snapshot_id
WHERE hb.room_id IS NOT NULL AND hb.room_id <> ''
ON CONFLICT (user_id, room_id, period) DO NOTHING;

INSERT INTO rent_payment_transactions
  (user_id, invoice_id, entry_type, amount_vnd, payment_method, note, source,
   idempotency_key, occurred_at)
SELECT ri.user_id, ri.id, 'payment', ri.issued_total_vnd, 'manual',
       'Chuyển từ trạng thái đã thu của dữ liệu cũ', 'legacy_paid',
       'legacy:' || ri.period || ':' || ri.room_id, ri.issued_at
FROM rent_invoices ri
JOIN history_snapshots hs
  ON hs.user_id=ri.user_id AND hs.period=ri.period
JOIN history_bills hb
  ON hb.snapshot_id=hs.id AND hb.room_id=ri.room_id
WHERE hb.paid=true AND ri.issued_total_vnd > 0
ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tro_bill_app') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON rent_invoices TO tro_bill_app';
    EXECUTE 'GRANT SELECT, INSERT ON rent_payment_transactions TO tro_bill_app';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE rent_invoices_id_seq TO tro_bill_app';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE rent_payment_transactions_id_seq TO tro_bill_app';
  END IF;
END $$;

COMMIT;

SELECT
  to_regclass('public.rent_invoices') IS NOT NULL AS invoices_ready,
  to_regclass('public.rent_payment_transactions') IS NOT NULL AS transactions_ready,
  has_table_privilege('tro_bill_app', 'rent_invoices', 'SELECT,INSERT,UPDATE') AS invoice_runtime_ready,
  has_table_privilege('tro_bill_app', 'rent_payment_transactions', 'SELECT,INSERT') AS transaction_runtime_ready,
  NOT has_table_privilege('tro_bill_app', 'rent_payment_transactions', 'UPDATE,DELETE') AS ledger_append_only;
