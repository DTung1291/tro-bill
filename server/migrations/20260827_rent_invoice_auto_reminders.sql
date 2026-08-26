BEGIN;

ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS invoice_reminder_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS invoice_reminder_before_days INTEGER[] NOT NULL DEFAULT ARRAY[3,1];
ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS invoice_reminder_after_days INTEGER[] NOT NULL DEFAULT ARRAY[1,3,7];

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='settings_invoice_reminder_before_valid'
  ) THEN
    ALTER TABLE settings ADD CONSTRAINT settings_invoice_reminder_before_valid CHECK (
      cardinality(invoice_reminder_before_days) <= 6
      AND invoice_reminder_before_days <@ ARRAY[1,2,3,5,7,14]
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='settings_invoice_reminder_after_valid'
  ) THEN
    ALTER TABLE settings ADD CONSTRAINT settings_invoice_reminder_after_valid CHECK (
      cardinality(invoice_reminder_after_days) <= 7
      AND invoice_reminder_after_days <@ ARRAY[1,2,3,5,7,14,30]
    );
  END IF;
END $$;

ALTER TABLE rent_invoice_deliveries
  ADD COLUMN IF NOT EXISTS trigger_source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE rent_invoice_deliveries
  ADD COLUMN IF NOT EXISTS reminder_offset_days INTEGER;
-- tenants được putState xóa rồi tạo lại trong cùng transaction. tenant_id là
-- định danh snapshot; lúc gửi worker vẫn khóa lại theo user + room + tenant.
ALTER TABLE rent_invoice_deliveries
  DROP CONSTRAINT IF EXISTS rent_invoice_deliveries_tenant_id_fkey;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_invoice_deliveries_trigger_source_valid'
  ) THEN
    ALTER TABLE rent_invoice_deliveries
      ADD CONSTRAINT rent_invoice_deliveries_trigger_source_valid
      CHECK (trigger_source IN ('manual','automatic'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_invoice_deliveries_reminder_offset_valid'
  ) THEN
    ALTER TABLE rent_invoice_deliveries
      ADD CONSTRAINT rent_invoice_deliveries_reminder_offset_valid CHECK (
        (trigger_source='manual' AND reminder_offset_days IS NULL)
        OR (
          trigger_source='automatic' AND template_type='reminder'
          AND reminder_offset_days BETWEEN -30 AND 14
          AND reminder_offset_days <> 0
        )
      );
  END IF;
END $$;

COMMIT;

SELECT
  EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='settings'
      AND column_name='invoice_reminder_enabled'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='settings'
      AND column_name='invoice_reminder_before_days'
  ) AND EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public' AND table_name='settings'
      AND column_name='invoice_reminder_after_days'
  ) AS reminder_settings_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_invoice_deliveries_trigger_source_valid'
  ) AND EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_invoice_deliveries_reminder_offset_valid'
  ) AS delivery_audit_ready,
  NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints
    WHERE table_schema='public'
      AND table_name='rent_invoice_deliveries'
      AND constraint_name='rent_invoice_deliveries_tenant_id_fkey'
  ) AS tenant_autosave_safe,
  NOT EXISTS (
    SELECT 1
    FROM information_schema.role_table_grants
    WHERE table_schema='public'
      AND table_name='rent_invoice_deliveries'
      AND grantee='tro_bill_app'
      AND privilege_type IN ('DELETE','TRUNCATE')
  ) AS direct_app_delete_blocked;
