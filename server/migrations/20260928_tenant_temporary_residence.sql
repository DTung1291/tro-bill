BEGIN;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS temporary_residence_registered_on DATE,
  ADD COLUMN IF NOT EXISTS temporary_residence_expires_on DATE;

CREATE INDEX IF NOT EXISTS idx_rental_contracts_user_tenant_status
  ON rental_contracts(user_id, tenant_id, status);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='tenants_temporary_residence_dates_valid'
  ) THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_temporary_residence_dates_valid
      CHECK (temporary_residence_registered_on IS NULL
        OR temporary_residence_expires_on IS NULL
        OR temporary_residence_expires_on >= temporary_residence_registered_on);
  END IF;
END $$;

DO $$
DECLARE runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['tro_bill_runtime', 'tro_bill_runtime_sql', 'tro_bill_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format(
        'GRANT SELECT (temporary_residence_registered_on, temporary_residence_expires_on), INSERT (temporary_residence_registered_on, temporary_residence_expires_on), UPDATE (temporary_residence_registered_on, temporary_residence_expires_on) ON tenants TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;

COMMIT;

SELECT
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='tenants'
      AND column_name='temporary_residence_registered_on' AND data_type='date'
  ) AS registered_on_ready,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='tenants'
      AND column_name='temporary_residence_expires_on' AND data_type='date'
  ) AS expires_on_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='tenants_temporary_residence_dates_valid'
  ) AS date_constraint_ready,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime_sql') THEN
    has_column_privilege('tro_bill_runtime_sql', 'tenants', 'temporary_residence_registered_on', 'SELECT')
    AND has_column_privilege('tro_bill_runtime_sql', 'tenants', 'temporary_residence_expires_on', 'INSERT')
  ELSE TRUE END AS runtime_grants_ready;
