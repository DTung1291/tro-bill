BEGIN;

ALTER TABLE rent_invoice_share_links
  ADD COLUMN IF NOT EXISTS tenancy_start_period TEXT;

-- Link cũ chỉ được xem đúng hóa đơn đã chia sẻ. Không suy đoán đợt thuê cũ từ
-- dữ liệu phòng đang thay đổi vì có thể làm lộ hóa đơn của khách trước đó.
UPDATE rent_invoice_share_links link
SET tenancy_start_period=invoice.period
FROM rent_invoices invoice
WHERE invoice.user_id=link.user_id
  AND invoice.id=link.invoice_id
  AND link.tenancy_start_period IS NULL;

ALTER TABLE rent_invoice_share_links
  ALTER COLUMN tenancy_start_period SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_invoice_share_links_tenancy_period_valid'
  ) THEN
    ALTER TABLE rent_invoice_share_links
      ADD CONSTRAINT rent_invoice_share_links_tenancy_period_valid
      CHECK (tenancy_start_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
  END IF;
END $$;

COMMIT;

SELECT
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='rent_invoice_share_links'
      AND column_name='tenancy_start_period'
      AND is_nullable='NO'
  ) AS tenancy_scope_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_invoice_share_links_tenancy_period_valid'
  ) AS tenancy_scope_constraint_ready,
  has_column_privilege(
    'tro_bill_runtime', 'rent_invoice_share_links', 'tenancy_start_period', 'SELECT'
  ) AS runtime_scope_select_ready;
