BEGIN;

-- Hóa đơn đã tồn tại có thể đã được gửi qua Zalo/email trước khi có nhật ký.
-- Không được suy diễn chúng là "chưa gửi".
ALTER TABLE rent_invoices
  ADD COLUMN IF NOT EXISTS delivery_tracking_baseline TEXT NOT NULL DEFAULT 'legacy_unknown';
ALTER TABLE rent_invoices
  ALTER COLUMN delivery_tracking_baseline SET DEFAULT 'tracked';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='rent_invoices_delivery_tracking_baseline_valid'
  ) THEN
    ALTER TABLE rent_invoices
      ADD CONSTRAINT rent_invoices_delivery_tracking_baseline_valid
      CHECK (delivery_tracking_baseline IN ('legacy_unknown', 'tracked'));
  END IF;
END $$;

-- Chỉ lưu bằng chứng email được provider chấp nhận hoặc chủ trọ xác nhận đã
-- thực sự gửi qua Zalo. Tạo link/sao chép/mở bảng chia sẻ không sinh sự kiện.
CREATE TABLE IF NOT EXISTS rent_invoice_send_events (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_id          BIGINT NOT NULL,
  tenant_id           TEXT NOT NULL,
  channel             TEXT NOT NULL,
  evidence            TEXT NOT NULL,
  template_type       TEXT NOT NULL,
  provider_message_id TEXT,
  idempotency_key     TEXT NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rent_invoice_send_events_invoice_owner_fk
    FOREIGN KEY (user_id, invoice_id)
    REFERENCES rent_invoices(user_id, id) ON DELETE CASCADE,
  CONSTRAINT rent_invoice_send_events_channel_evidence_valid CHECK (
    (channel='email' AND evidence='provider_accepted')
    OR (channel='zalo' AND evidence='owner_confirmed')
  ),
  CONSTRAINT rent_invoice_send_events_template_valid
    CHECK (template_type IN ('invoice', 'reminder')),
  CONSTRAINT rent_invoice_send_events_tenant_valid
    CHECK (char_length(tenant_id) BETWEEN 1 AND 200),
  CONSTRAINT rent_invoice_send_events_idempotency_valid
    CHECK (char_length(idempotency_key) BETWEEN 16 AND 160),
  CONSTRAINT rent_invoice_send_events_provider_valid CHECK (
    provider_message_id IS NULL OR char_length(provider_message_id) BETWEEN 1 AND 200
  ),
  CONSTRAINT rent_invoice_send_events_idempotency_unique UNIQUE (user_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS idx_rent_invoice_send_events_invoice
  ON rent_invoice_send_events(user_id, invoice_id, template_type, created_at DESC);

DO $$
DECLARE runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['tro_bill_runtime', 'tro_bill_runtime_sql', 'tro_bill_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format('GRANT SELECT (delivery_tracking_baseline) ON rent_invoices TO %I', runtime_role);
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rent_invoice_send_events FROM %I', runtime_role);
      EXECUTE format('GRANT SELECT, INSERT ON rent_invoice_send_events TO %I', runtime_role);
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE rent_invoice_send_events_id_seq TO %I', runtime_role);
    END IF;
  END LOOP;
END $$;

COMMIT;

SELECT
  to_regclass('public.rent_invoice_send_events') IS NOT NULL AS events_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_invoices_delivery_tracking_baseline_valid'
  ) AS baseline_ready,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime_sql') THEN
    has_column_privilege('tro_bill_runtime_sql', 'rent_invoices', 'delivery_tracking_baseline', 'SELECT')
    AND has_table_privilege('tro_bill_runtime_sql', 'rent_invoice_send_events', 'SELECT,INSERT')
    AND NOT has_table_privilege('tro_bill_runtime_sql', 'rent_invoice_send_events', 'DELETE')
  ELSE TRUE END AS runtime_grants_ready;
