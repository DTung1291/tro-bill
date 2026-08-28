BEGIN;

ALTER TABLE rental_contracts
  ADD COLUMN IF NOT EXISTS billing_cycle_months SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE rental_contracts
  ADD COLUMN IF NOT EXISTS payment_due_day SMALLINT NOT NULL DEFAULT 5;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rental_contracts_payment_schedule_valid'
  ) THEN
    ALTER TABLE rental_contracts
      ADD CONSTRAINT rental_contracts_payment_schedule_valid CHECK (
        billing_cycle_months IN (1, 3, 6, 12)
        AND payment_due_day BETWEEN 1 AND 28
      );
  END IF;
END $$;

COMMIT;

SELECT
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='rental_contracts'
      AND column_name='billing_cycle_months' AND is_nullable='NO'
  ) AS billing_cycle_ready,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='rental_contracts'
      AND column_name='payment_due_day' AND is_nullable='NO'
  ) AS payment_due_day_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rental_contracts_payment_schedule_valid'
  ) AS payment_schedule_constraint_ready;
