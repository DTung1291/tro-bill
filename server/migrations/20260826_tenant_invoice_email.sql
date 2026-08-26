BEGIN;

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='tenants_email_valid'
  ) THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_email_valid CHECK (
      email = '' OR (
        char_length(email) <= 254
        AND email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      )
    );
  END IF;
END $$;

COMMIT;

SELECT
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='tenants' AND column_name='email'
  ) AS tenant_email_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='tenants_email_valid'
  ) AS tenant_email_constraint_ready;
