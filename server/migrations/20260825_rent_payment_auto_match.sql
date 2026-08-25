BEGIN;

ALTER TABLE rent_bank_transactions
  ADD COLUMN IF NOT EXISTS match_reason TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS matched_receipt_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_bank_transactions_receipt_owner_fk'
  ) THEN
    ALTER TABLE rent_bank_transactions
      ADD CONSTRAINT rent_bank_transactions_receipt_owner_fk
      FOREIGN KEY (user_id, matched_receipt_id)
      REFERENCES rent_payment_receipts(user_id, id) ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE rent_bank_transactions
  DROP CONSTRAINT IF EXISTS rent_bank_transactions_match_consistent;
ALTER TABLE rent_bank_transactions
  ADD CONSTRAINT rent_bank_transactions_match_consistent CHECK (
    (match_status='matched'
      AND matched_invoice_id IS NOT NULL
      AND matched_receipt_id IS NOT NULL
      AND matched_at IS NOT NULL)
    OR (match_status<>'matched'
      AND matched_invoice_id IS NULL
      AND matched_receipt_id IS NULL
      AND matched_at IS NULL)
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_bank_transactions_match_reason_valid'
  ) THEN
    ALTER TABLE rent_bank_transactions
      ADD CONSTRAINT rent_bank_transactions_match_reason_valid
      CHECK (match_reason ~ '^[a-z0-9_]{0,100}$');
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime') THEN
    EXECUTE 'GRANT UPDATE (match_status, match_reason, matched_invoice_id, matched_receipt_id, matched_at, updated_at) ON rent_bank_transactions TO tro_bill_runtime';
  END IF;
END $$;

COMMIT;

SELECT
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='rent_bank_transactions'
      AND column_name='matched_receipt_id'
  ) AS matched_receipt_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_bank_transactions_receipt_owner_fk'
  ) AS receipt_ownership_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_bank_transactions_match_reason_valid'
  ) AS reason_constraint_ready,
  has_column_privilege(
    'tro_bill_runtime', 'rent_bank_transactions', 'matched_receipt_id', 'UPDATE'
  ) AS runtime_match_update_ready;
