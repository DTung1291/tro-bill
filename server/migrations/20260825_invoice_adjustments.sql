BEGIN;

ALTER TABLE billing_entries
  ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12, 0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS surcharge_amount NUMERIC(12, 0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS late_fee_amount NUMERIC(12, 0) NOT NULL DEFAULT 0;

ALTER TABLE history_bills
  ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12, 0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS surcharge_amount NUMERIC(12, 0) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS late_fee_amount NUMERIC(12, 0) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='billing_entries_adjustments_nonnegative'
  ) THEN
    ALTER TABLE billing_entries
      ADD CONSTRAINT billing_entries_adjustments_nonnegative
      CHECK (discount_amount >= 0 AND surcharge_amount >= 0 AND late_fee_amount >= 0);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='history_bills_adjustments_nonnegative'
  ) THEN
    ALTER TABLE history_bills
      ADD CONSTRAINT history_bills_adjustments_nonnegative
      CHECK (discount_amount >= 0 AND surcharge_amount >= 0 AND late_fee_amount >= 0);
  END IF;
END $$;

COMMIT;

SELECT
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='billing_entries'
      AND column_name='discount_amount'
  ) AS billing_adjustments_ready,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='history_bills'
      AND column_name='late_fee_amount'
  ) AS history_adjustments_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='billing_entries_adjustments_nonnegative'
  ) AS billing_constraints_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='history_bills_adjustments_nonnegative'
  ) AS history_constraints_ready;
