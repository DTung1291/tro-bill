BEGIN;

ALTER TABLE rent_invoices
  ADD COLUMN IF NOT EXISTS detail_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_invoices_detail_snapshot_valid'
  ) THEN
    ALTER TABLE rent_invoices
      ADD CONSTRAINT rent_invoices_detail_snapshot_valid CHECK (
        jsonb_typeof(detail_snapshot)='object'
        AND octet_length(detail_snapshot::text) <= 8192
      );
  END IF;
END $$;

-- Backfill hóa đơn lịch sử bằng dữ liệu đã chốt trong history_bills. Chỉ lấy
-- dòng có tổng trùng để không gắn một breakdown cũ vào hóa đơn đã điều chỉnh.
UPDATE rent_invoices invoice
SET detail_snapshot = jsonb_build_object(
      'rent', jsonb_build_object(
        'amountVnd', COALESCE(bill.rent_price, 0),
        'basePriceVnd', COALESCE(NULLIF(bill.rent_base_price, 0), bill.rent_price, 0),
        'chargedDays', COALESCE(bill.rent_days, CASE WHEN COALESCE(bill.rent_price, 0) > 0 THEN EXTRACT(DAY FROM (date_trunc('month', to_date(invoice.period || '-01', 'YYYY-MM-DD')) + interval '1 month - 1 day'))::int ELSE 0 END),
        'daysInMonth', COALESCE(bill.rent_days_in_month, EXTRACT(DAY FROM (date_trunc('month', to_date(invoice.period || '-01', 'YYYY-MM-DD')) + interval '1 month - 1 day'))::int),
        'prorated', COALESCE(bill.rent_prorated, false),
        'startsAfterPeriod', COALESCE(bill.rent_starts_after_period, false)
      ),
      'electricity', jsonb_build_object(
        'previousReading', COALESCE(bill.electric_old, 0),
        'currentReading', COALESCE(bill.electric_new, bill.electric_old, 0),
        'units', COALESCE(bill.kwh, 0),
        'rateVnd', COALESCE(bill.electric_rate, 0),
        'amountVnd', COALESCE(bill.electric_amt, 0)
      ),
      'water', jsonb_build_object(
        'billingType', CASE WHEN bill.water_type='khối' THEN 'cubic_meter' ELSE 'person' END,
        'previousReading', CASE WHEN bill.water_type='khối' THEN COALESCE(bill.water_prev, 0) ELSE NULL END,
        'currentReading', CASE WHEN bill.water_type='khối' THEN COALESCE(bill.water_new, bill.water_prev, 0) ELSE NULL END,
        'units', COALESCE(bill.water_units, 0),
        'rateVnd', COALESCE(bill.water_rate, 0),
        'amountVnd', COALESCE(bill.water_amt, 0)
      ),
      'services', jsonb_build_object(
        'trashVnd', COALESCE(bill.trash_fee, 0),
        'wifiVnd', COALESCE(bill.wifi_fee, 0),
        'managementVnd', COALESCE(bill.manage_fee, 0)
      ),
      'adjustments', jsonb_build_object(
        'discountVnd', COALESCE(bill.discount_amount, 0),
        'surchargeVnd', COALESCE(bill.surcharge_amount, 0),
        'lateFeeVnd', COALESCE(bill.late_fee_amount, 0)
      ),
      'utilityOnly', COALESCE(bill.utility_only, false)
    ),
    updated_at = now()
FROM history_bills bill
JOIN history_snapshots snapshot ON snapshot.id=bill.snapshot_id
WHERE invoice.user_id=snapshot.user_id
  AND invoice.room_id=bill.room_id
  AND invoice.period=snapshot.period
  AND invoice.detail_snapshot='{}'::jsonb
  AND ROUND(COALESCE(bill.total, 0))=invoice.issued_total_vnd;

COMMIT;

SELECT
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='rent_invoices'
      AND column_name='detail_snapshot'
  ) AS detail_snapshot_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_invoices_detail_snapshot_valid'
  ) AS detail_constraint_ready,
  has_column_privilege(
    'tro_bill_runtime', 'rent_invoices', 'detail_snapshot', 'SELECT'
  ) AS runtime_detail_read_ready;
