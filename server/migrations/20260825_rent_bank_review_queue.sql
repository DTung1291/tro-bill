BEGIN;

ALTER TABLE rent_bank_transactions
  ADD COLUMN IF NOT EXISTS review_note TEXT NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS reviewed_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reviewed_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_bank_transactions_review_note_length'
  ) THEN
    ALTER TABLE rent_bank_transactions
      ADD CONSTRAINT rent_bank_transactions_review_note_length
      CHECK (char_length(review_note) <= 500);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_rent_bank_transactions_reviewed_by
  ON rent_bank_transactions(reviewed_by_user_id, reviewed_at DESC)
  WHERE reviewed_by_user_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime') THEN
    EXECUTE 'GRANT UPDATE (match_status, match_reason, matched_invoice_id, matched_receipt_id, matched_at, review_note, reviewed_by_user_id, reviewed_at, updated_at) ON rent_bank_transactions TO tro_bill_runtime';
  END IF;
END $$;

COMMIT;

SELECT
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='rent_bank_transactions'
      AND column_name='review_note'
  ) AS review_note_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_bank_transactions_review_note_length'
  ) AS review_note_constraint_ready,
  has_column_privilege(
    'tro_bill_runtime', 'rent_bank_transactions', 'review_note', 'UPDATE'
  ) AS runtime_review_ready;
