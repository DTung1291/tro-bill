BEGIN;

CREATE TABLE IF NOT EXISTS rental_contract_notifications (
  id                       BIGSERIAL PRIMARY KEY,
  user_id                  BIGINT NOT NULL,
  contract_id              BIGINT NOT NULL,
  notification_type        TEXT NOT NULL,
  scheduled_for            DATE NOT NULL,
  recipient_email_snapshot TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'sending',
  attempt_count            INTEGER NOT NULL DEFAULT 1,
  provider_message_id      TEXT,
  last_error_code          TEXT,
  sent_at                  TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rental_contract_notifications_owner_fk
    FOREIGN KEY (user_id, contract_id)
    REFERENCES rental_contracts(user_id, id) ON DELETE CASCADE,
  CONSTRAINT rental_contract_notifications_unique
    UNIQUE (contract_id, notification_type, scheduled_for),
  CONSTRAINT rental_contract_notifications_type_valid
    CHECK (notification_type IN ('expiry_30d','expiry_14d','expiry_7d','expiry_3d','expiry_1d')),
  CONSTRAINT rental_contract_notifications_status_valid
    CHECK (status IN ('sending','sent','failed')),
  CONSTRAINT rental_contract_notifications_attempt_positive CHECK (attempt_count > 0),
  CONSTRAINT rental_contract_notifications_email_valid
    CHECK (char_length(recipient_email_snapshot) BETWEEN 3 AND 254),
  CONSTRAINT rental_contract_notifications_error_code_valid
    CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{3,64}$'),
  CONSTRAINT rental_contract_notifications_sent_at_required
    CHECK (status <> 'sent' OR sent_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_rental_contract_notifications_status_updated
  ON rental_contract_notifications(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_rental_contract_notifications_user_created
  ON rental_contract_notifications(user_id, created_at DESC);

DO $$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'tro_bill_runtime',
    'tro_bill_runtime_sql',
    'tro_bill_app'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format(
        'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rental_contract_notifications FROM %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT SELECT, INSERT ON rental_contract_notifications TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT UPDATE (status, recipient_email_snapshot, attempt_count, provider_message_id, last_error_code, sent_at, updated_at) ON rental_contract_notifications TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE rental_contract_notifications_id_seq TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;

COMMIT;

SELECT
  to_regclass('public.rental_contract_notifications') IS NOT NULL AS notifications_table_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rental_contract_notifications_owner_fk'
  ) AS notification_ownership_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rental_contract_notifications_unique'
  ) AS notification_deduplication_ready,
  NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='public'
      AND table_name='rental_contract_notifications'
      AND grantee IN ('tro_bill_runtime','tro_bill_runtime_sql','tro_bill_app')
      AND privilege_type IN ('DELETE','TRUNCATE')
  ) AS notification_delete_blocked;
