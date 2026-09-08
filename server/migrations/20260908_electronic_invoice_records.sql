BEGIN;

CREATE TABLE IF NOT EXISTS electronic_invoice_records (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  source_invoice_id     BIGINT NOT NULL,
  provider              TEXT NOT NULL,
  provider_document_id  TEXT NOT NULL,
  source_fingerprint    TEXT NOT NULL,
  lookup_code           TEXT NOT NULL DEFAULT '',
  tax_authority_code    TEXT NOT NULL DEFAULT '',
  invoice_number        TEXT NOT NULL DEFAULT '',
  normalized_status     TEXT NOT NULL,
  provider_status       TEXT NOT NULL DEFAULT '',
  issued_at             TIMESTAMPTZ,
  last_event_at         TIMESTAMPTZ NOT NULL,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT electronic_invoice_records_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT electronic_invoice_records_provider_document_unique
    UNIQUE (user_id, provider, provider_document_id),
  CONSTRAINT electronic_invoice_records_source_owner_fk
    FOREIGN KEY (user_id, source_invoice_id)
    REFERENCES rent_invoices(user_id, id) ON DELETE RESTRICT,
  CONSTRAINT electronic_invoice_records_provider_valid CHECK (
    provider IN ('misa_meinvoice', 'vnpt_invoice', 'viettel_sinvoice', 'other')
  ),
  CONSTRAINT electronic_invoice_records_status_valid CHECK (
    normalized_status IN (
      'draft', 'submitted', 'issued', 'rejected',
      'adjusted', 'replaced', 'cancelled'
    )
  ),
  CONSTRAINT electronic_invoice_records_fingerprint_valid CHECK (
    source_fingerprint ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT electronic_invoice_records_content_valid CHECK (
    char_length(provider_document_id) BETWEEN 1 AND 300
    AND char_length(lookup_code) <= 300
    AND char_length(tax_authority_code) <= 300
    AND char_length(invoice_number) <= 100
    AND char_length(provider_status) <= 200
  ),
  CONSTRAINT electronic_invoice_records_time_valid CHECK (
    updated_at >= created_at
  )
);

CREATE INDEX IF NOT EXISTS idx_electronic_invoice_records_source
  ON electronic_invoice_records(user_id, source_invoice_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_electronic_invoice_records_status
  ON electronic_invoice_records(user_id, normalized_status, last_event_at DESC);

CREATE TABLE IF NOT EXISTS electronic_invoice_status_events (
  id                   BIGSERIAL PRIMARY KEY,
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  record_id            BIGINT NOT NULL,
  provider             TEXT NOT NULL,
  provider_event_id    TEXT NOT NULL,
  previous_status      TEXT,
  new_status           TEXT NOT NULL,
  provider_status      TEXT NOT NULL DEFAULT '',
  payload_sha256       TEXT NOT NULL,
  occurred_at          TIMESTAMPTZ NOT NULL,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT electronic_invoice_events_record_owner_fk
    FOREIGN KEY (user_id, record_id)
    REFERENCES electronic_invoice_records(user_id, id) ON DELETE RESTRICT,
  CONSTRAINT electronic_invoice_events_provider_event_unique
    UNIQUE (user_id, provider, provider_event_id),
  CONSTRAINT electronic_invoice_events_provider_valid CHECK (
    provider IN ('misa_meinvoice', 'vnpt_invoice', 'viettel_sinvoice', 'other')
  ),
  CONSTRAINT electronic_invoice_events_previous_status_valid CHECK (
    previous_status IS NULL OR previous_status IN (
      'draft', 'submitted', 'issued', 'rejected',
      'adjusted', 'replaced', 'cancelled'
    )
  ),
  CONSTRAINT electronic_invoice_events_new_status_valid CHECK (
    new_status IN (
      'draft', 'submitted', 'issued', 'rejected',
      'adjusted', 'replaced', 'cancelled'
    )
  ),
  CONSTRAINT electronic_invoice_events_payload_hash_valid CHECK (
    payload_sha256 ~ '^[a-f0-9]{64}$'
  ),
  CONSTRAINT electronic_invoice_events_content_valid CHECK (
    char_length(provider_event_id) BETWEEN 8 AND 300
    AND char_length(provider_status) <= 200
  )
);

CREATE INDEX IF NOT EXISTS idx_electronic_invoice_events_record
  ON electronic_invoice_status_events(user_id, record_id, occurred_at, id);

CREATE OR REPLACE FUNCTION protect_electronic_invoice_record_identity()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.user_id IS DISTINCT FROM OLD.user_id
    OR NEW.source_invoice_id IS DISTINCT FROM OLD.source_invoice_id
    OR NEW.provider IS DISTINCT FROM OLD.provider
    OR NEW.provider_document_id IS DISTINCT FROM OLD.provider_document_id
    OR NEW.source_fingerprint IS DISTINCT FROM OLD.source_fingerprint
    OR (OLD.lookup_code <> '' AND NEW.lookup_code IS DISTINCT FROM OLD.lookup_code)
    OR (OLD.tax_authority_code <> '' AND NEW.tax_authority_code IS DISTINCT FROM OLD.tax_authority_code)
    OR (OLD.invoice_number <> '' AND NEW.invoice_number IS DISTINCT FROM OLD.invoice_number)
    OR (OLD.issued_at IS NOT NULL AND NEW.issued_at IS DISTINCT FROM OLD.issued_at)
  THEN
    RAISE EXCEPTION 'electronic invoice record identity is immutable'
      USING ERRCODE='23514';
  END IF;
  IF NOT (
    (OLD.normalized_status='draft' AND NEW.normalized_status IN ('draft','submitted','issued','rejected','cancelled'))
    OR (OLD.normalized_status='submitted' AND NEW.normalized_status IN ('submitted','issued','rejected','cancelled'))
    OR (OLD.normalized_status='rejected' AND NEW.normalized_status IN ('rejected','submitted','cancelled'))
    OR (OLD.normalized_status='issued' AND NEW.normalized_status IN ('issued','adjusted','replaced','cancelled'))
    OR (OLD.normalized_status='adjusted' AND NEW.normalized_status IN ('adjusted','replaced','cancelled'))
    OR (OLD.normalized_status='replaced' AND NEW.normalized_status='replaced')
    OR (OLD.normalized_status='cancelled' AND NEW.normalized_status='cancelled')
  ) THEN
    RAISE EXCEPTION 'electronic invoice status transition is invalid'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS electronic_invoice_record_identity_before_update
  ON electronic_invoice_records;
CREATE TRIGGER electronic_invoice_record_identity_before_update
BEFORE UPDATE ON electronic_invoice_records
FOR EACH ROW EXECUTE FUNCTION protect_electronic_invoice_record_identity();

CREATE OR REPLACE FUNCTION reject_electronic_invoice_event_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'electronic invoice status events are append-only'
    USING ERRCODE='55000';
END;
$$;

DROP TRIGGER IF EXISTS electronic_invoice_event_append_only_before_update
  ON electronic_invoice_status_events;
CREATE TRIGGER electronic_invoice_event_append_only_before_update
BEFORE UPDATE OR DELETE ON electronic_invoice_status_events
FOR EACH ROW EXECUTE FUNCTION reject_electronic_invoice_event_mutation();

DO $$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'tro_bill_runtime', 'tro_bill_runtime_sql', 'tro_bill_app'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE ON electronic_invoice_records TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT SELECT, INSERT ON electronic_invoice_status_events TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE electronic_invoice_records_id_seq TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE electronic_invoice_status_events_id_seq TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;

COMMIT;

SELECT
  to_regclass('public.electronic_invoice_records') IS NOT NULL
    AND to_regclass('public.electronic_invoice_status_events') IS NOT NULL
    AS electronic_invoice_record_tables_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='electronic_invoice_records_source_owner_fk'
  ) AS electronic_invoice_record_ownership_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='electronic_invoice_events_provider_event_unique'
  ) AS electronic_invoice_event_idempotency_ready,
  EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='electronic_invoice_event_append_only_before_update'
  ) AS electronic_invoice_event_append_only_ready,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime_sql') THEN
    has_table_privilege('tro_bill_runtime_sql', 'electronic_invoice_records', 'SELECT')
    AND has_table_privilege('tro_bill_runtime_sql', 'electronic_invoice_records', 'INSERT')
    AND has_table_privilege('tro_bill_runtime_sql', 'electronic_invoice_records', 'UPDATE')
    AND NOT has_table_privilege('tro_bill_runtime_sql', 'electronic_invoice_records', 'DELETE')
    AND has_table_privilege('tro_bill_runtime_sql', 'electronic_invoice_status_events', 'SELECT')
    AND has_table_privilege('tro_bill_runtime_sql', 'electronic_invoice_status_events', 'INSERT')
    AND NOT has_table_privilege('tro_bill_runtime_sql', 'electronic_invoice_status_events', 'UPDATE')
    AND NOT has_table_privilege('tro_bill_runtime_sql', 'electronic_invoice_status_events', 'DELETE')
  ELSE TRUE END AS electronic_invoice_record_runtime_ready;
