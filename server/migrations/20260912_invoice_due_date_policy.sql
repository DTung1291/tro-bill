BEGIN;

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS invoice_due_days SMALLINT NOT NULL DEFAULT 10;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='settings_invoice_due_days_valid'
  ) THEN
    ALTER TABLE settings ADD CONSTRAINT settings_invoice_due_days_valid CHECK (
      invoice_due_days BETWEEN 1 AND 90
    );
  END IF;
END $$;

-- DEFAULT +10 giữ tương thích trong lúc deploy rolling. Code mới luôn truyền
-- snapshot theo cài đặt của workspace khi INSERT hóa đơn.
ALTER TABLE rent_invoices
  ADD COLUMN IF NOT EXISTS due_date DATE;

UPDATE rent_invoices
SET due_date=((issued_at AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 10)
WHERE due_date IS NULL;

ALTER TABLE rent_invoices
  ALTER COLUMN due_date SET DEFAULT ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Ho_Chi_Minh')::date + 10),
  ALTER COLUMN due_date SET NOT NULL;

CREATE OR REPLACE FUNCTION protect_finalized_rent_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.due_date IS DISTINCT FROM OLD.due_date THEN
    RAISE EXCEPTION 'rent invoice due date is immutable'
      USING ERRCODE='23514';
  END IF;
  IF OLD.finalized_at IS NOT NULL AND (
    NEW.room_name_snapshot IS DISTINCT FROM OLD.room_name_snapshot
    OR NEW.issued_total_vnd IS DISTINCT FROM OLD.issued_total_vnd
    OR NEW.detail_snapshot IS DISTINCT FROM OLD.detail_snapshot
    OR NEW.final_total_vnd IS DISTINCT FROM OLD.final_total_vnd
    OR NEW.final_detail_snapshot IS DISTINCT FROM OLD.final_detail_snapshot
    OR NEW.finalization_contract_id IS DISTINCT FROM OLD.finalization_contract_id
    OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at
  ) THEN
    RAISE EXCEPTION 'finalized rent invoice is immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'tro_bill_runtime', 'tro_bill_runtime_sql', 'tro_bill_app'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format('REVOKE UPDATE ON rent_invoices FROM %I', runtime_role);
      EXECUTE format('GRANT SELECT, INSERT ON rent_invoices TO %I', runtime_role);
      EXECUTE format(
        'GRANT UPDATE (room_name_snapshot, issued_total_vnd, detail_snapshot, final_total_vnd, final_detail_snapshot, finalization_contract_id, finalized_at, updated_at) ON rent_invoices TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;

COMMIT;

SELECT
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='settings'
      AND column_name='invoice_due_days' AND is_nullable='NO'
  ) AS invoice_due_policy_ready,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='rent_invoices'
      AND column_name='due_date' AND is_nullable='NO'
  ) AS invoice_due_snapshot_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='settings_invoice_due_days_valid'
  ) AS invoice_due_constraint_ready,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime_sql') THEN
    has_column_privilege('tro_bill_runtime_sql', 'rent_invoices', 'due_date', 'SELECT')
    AND NOT has_column_privilege('tro_bill_runtime_sql', 'rent_invoices', 'due_date', 'UPDATE')
  ELSE TRUE END AS invoice_due_immutable_ready;
