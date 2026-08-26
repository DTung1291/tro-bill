BEGIN;

CREATE TABLE IF NOT EXISTS rent_invoice_deliveries (
  id                       BIGSERIAL PRIMARY KEY,
  user_id                  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_id               BIGINT NOT NULL,
  tenant_id                TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  channel                  TEXT NOT NULL DEFAULT 'email',
  template_type            TEXT NOT NULL DEFAULT 'invoice',
  scheduled_for            DATE NOT NULL,
  recipient_email_snapshot TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'scheduled',
  attempt_count            INTEGER NOT NULL DEFAULT 0,
  provider_message_id      TEXT,
  last_error_code          TEXT,
  sent_at                  TIMESTAMPTZ,
  cancelled_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rent_invoice_deliveries_invoice_owner_fk
    FOREIGN KEY (user_id, invoice_id)
    REFERENCES rent_invoices(user_id, id) ON DELETE CASCADE,
  CONSTRAINT rent_invoice_deliveries_unique
    UNIQUE (user_id, invoice_id, tenant_id, channel, template_type, scheduled_for),
  CONSTRAINT rent_invoice_deliveries_channel_valid CHECK (channel='email'),
  CONSTRAINT rent_invoice_deliveries_template_valid
    CHECK (template_type IN ('invoice','reminder')),
  CONSTRAINT rent_invoice_deliveries_status_valid
    CHECK (status IN ('scheduled','sending','sent','failed','skipped','cancelled')),
  CONSTRAINT rent_invoice_deliveries_attempt_valid CHECK (attempt_count BETWEEN 0 AND 5),
  CONSTRAINT rent_invoice_deliveries_email_valid CHECK (
    char_length(recipient_email_snapshot) <= 254
    AND recipient_email_snapshot ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  CONSTRAINT rent_invoice_deliveries_error_code_valid CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{3,64}$'
  ),
  CONSTRAINT rent_invoice_deliveries_sent_consistent CHECK (
    (status='sent' AND sent_at IS NOT NULL) OR (status<>'sent' AND sent_at IS NULL)
  ),
  CONSTRAINT rent_invoice_deliveries_cancel_consistent CHECK (
    (status='cancelled' AND cancelled_at IS NOT NULL)
    OR (status<>'cancelled' AND cancelled_at IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_rent_invoice_deliveries_due
  ON rent_invoice_deliveries(status, scheduled_for, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_rent_invoice_deliveries_invoice
  ON rent_invoice_deliveries(user_id, invoice_id, scheduled_for DESC, id DESC);

DO $$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['tro_bill_runtime', 'tro_bill_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format(
        'REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON rent_invoice_deliveries FROM %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE ON rent_invoice_deliveries TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE rent_invoice_deliveries_id_seq TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;

COMMIT;

SELECT
  to_regclass('public.rent_invoice_deliveries') IS NOT NULL AS delivery_table_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='rent_invoice_deliveries_unique'
  ) AS duplicate_protection_ready,
  NOT EXISTS (
    SELECT 1
    FROM information_schema.role_table_grants
    WHERE table_schema='public'
      AND table_name='rent_invoice_deliveries'
      AND grantee='tro_bill_app'
      AND privilege_type IN ('DELETE','TRUNCATE')
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.role_table_grants
    WHERE table_schema='public'
      AND table_name='rent_invoice_deliveries'
      AND grantee='tro_bill_app'
      AND privilege_type='UPDATE'
  ) AS direct_app_permissions_ready;
