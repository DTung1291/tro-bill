BEGIN;

ALTER TABLE electronic_invoice_profiles
  ADD COLUMN IF NOT EXISTS seller_legal_name TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='electronic_invoice_profiles_seller_name_length_valid'
  ) THEN
    ALTER TABLE electronic_invoice_profiles
      ADD CONSTRAINT electronic_invoice_profiles_seller_name_length_valid
      CHECK (char_length(seller_legal_name) <= 300);
  END IF;
END $$;

DO $$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'tro_bill_runtime', 'tro_bill_runtime_sql', 'tro_bill_app'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE ON electronic_invoice_profiles TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;

COMMIT;

SELECT
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='electronic_invoice_profiles'
      AND column_name='seller_legal_name'
      AND is_nullable='NO'
  ) AS electronic_invoice_seller_name_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='electronic_invoice_profiles_seller_name_length_valid'
  ) AS electronic_invoice_seller_name_constraint_ready,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime_sql') THEN
    has_table_privilege('tro_bill_runtime_sql', 'electronic_invoice_profiles', 'SELECT')
    AND has_table_privilege('tro_bill_runtime_sql', 'electronic_invoice_profiles', 'INSERT')
    AND has_table_privilege('tro_bill_runtime_sql', 'electronic_invoice_profiles', 'UPDATE')
    AND NOT has_table_privilege('tro_bill_runtime_sql', 'electronic_invoice_profiles', 'DELETE')
  ELSE TRUE END AS electronic_invoice_profile_runtime_ready;
