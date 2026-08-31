BEGIN;

-- NULL giữ nguyên ý nghĩa dữ liệu cũ: chi phí chung của toàn tài khoản. Không
-- tự backfill sang khu mặc định vì việc đó sẽ làm sai báo cáo từng khu.
ALTER TABLE expense_entries ADD COLUMN IF NOT EXISTS property_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='expense_entries_property_owner_fk'
  ) THEN
    ALTER TABLE expense_entries ADD CONSTRAINT expense_entries_property_owner_fk
      FOREIGN KEY (user_id, property_id)
      REFERENCES properties(user_id, id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_expenses_user_property_period
  ON expense_entries(user_id, property_id, period);

DO $$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'tro_bill_runtime', 'tro_bill_runtime_sql', 'tro_bill_app'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON expense_entries TO %I',
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
      AND table_name='expense_entries'
      AND column_name='property_id'
      AND is_nullable='YES'
  ) AS expense_property_column_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='expense_entries_property_owner_fk'
  ) AS expense_property_owner_ready,
  to_regclass('public.idx_expenses_user_property_period') IS NOT NULL
    AS expense_property_index_ready,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime_sql') THEN
    has_table_privilege('tro_bill_runtime_sql', 'expense_entries', 'SELECT')
    AND has_table_privilege('tro_bill_runtime_sql', 'expense_entries', 'INSERT')
    AND has_table_privilege('tro_bill_runtime_sql', 'expense_entries', 'UPDATE')
    AND has_table_privilege('tro_bill_runtime_sql', 'expense_entries', 'DELETE')
  ELSE TRUE END AS expense_runtime_ready,
  NOT EXISTS (
    SELECT 1
    FROM expense_entries expense
    LEFT JOIN properties property
      ON property.user_id=expense.user_id AND property.id=expense.property_id
    WHERE expense.property_id IS NOT NULL AND property.id IS NULL
  ) AS expense_property_ownership_ready;
