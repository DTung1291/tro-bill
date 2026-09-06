BEGIN;

ALTER TABLE expense_entries ADD COLUMN IF NOT EXISTS maintenance_request_user_id BIGINT;
ALTER TABLE expense_entries ADD COLUMN IF NOT EXISTS maintenance_request_id BIGINT;
ALTER TABLE expense_entries ADD COLUMN IF NOT EXISTS maintenance_request_code_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE expense_entries ADD COLUMN IF NOT EXISTS maintenance_room_id_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE expense_entries ADD COLUMN IF NOT EXISTS maintenance_room_name_snapshot TEXT NOT NULL DEFAULT '';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='expense_entries_user_id_id_unique'
  ) THEN
    ALTER TABLE expense_entries ADD CONSTRAINT expense_entries_user_id_id_unique
      UNIQUE (user_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='expense_entries_maintenance_request_owner_fk'
  ) THEN
    ALTER TABLE expense_entries ADD CONSTRAINT expense_entries_maintenance_request_owner_fk
      FOREIGN KEY (maintenance_request_user_id, maintenance_request_id)
      REFERENCES tenant_maintenance_requests(user_id, id) ON DELETE SET NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='expense_entries_maintenance_request_pair_valid'
  ) THEN
    ALTER TABLE expense_entries ADD CONSTRAINT expense_entries_maintenance_request_pair_valid
      CHECK (
        (maintenance_request_user_id IS NULL AND maintenance_request_id IS NULL)
        OR
        (maintenance_request_user_id=user_id AND maintenance_request_id IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='expense_entries_maintenance_snapshot_valid'
  ) THEN
    ALTER TABLE expense_entries ADD CONSTRAINT expense_entries_maintenance_snapshot_valid
      CHECK (
        char_length(maintenance_request_code_snapshot) <= 50
        AND char_length(maintenance_room_id_snapshot) <= 200
        AND char_length(maintenance_room_name_snapshot) <= 200
      );
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_expenses_maintenance_request
  ON expense_entries(user_id, maintenance_request_id, period);

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
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema='public'
      AND table_name='expense_entries'
      AND column_name IN (
        'maintenance_request_user_id',
        'maintenance_request_id',
        'maintenance_request_code_snapshot',
        'maintenance_room_id_snapshot',
        'maintenance_room_name_snapshot'
      )
    GROUP BY table_schema, table_name
    HAVING count(*)=5
  ) AS maintenance_expense_columns_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='expense_entries_maintenance_request_owner_fk'
  ) AS maintenance_expense_owner_fk_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='expense_entries_maintenance_request_pair_valid'
  ) AS maintenance_expense_pair_check_ready,
  to_regclass('public.idx_expenses_maintenance_request') IS NOT NULL
    AS maintenance_expense_index_ready,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime_sql') THEN
    has_table_privilege('tro_bill_runtime_sql', 'expense_entries', 'SELECT')
    AND has_table_privilege('tro_bill_runtime_sql', 'expense_entries', 'INSERT')
    AND has_table_privilege('tro_bill_runtime_sql', 'expense_entries', 'UPDATE')
    AND has_table_privilege('tro_bill_runtime_sql', 'expense_entries', 'DELETE')
  ELSE TRUE END AS maintenance_expense_runtime_ready,
  NOT EXISTS (
    SELECT 1
    FROM expense_entries expense
    LEFT JOIN tenant_maintenance_requests request
      ON request.user_id=expense.maintenance_request_user_id
     AND request.id=expense.maintenance_request_id
    WHERE expense.maintenance_request_id IS NOT NULL
      AND (
        expense.maintenance_request_user_id<>expense.user_id
        OR request.id IS NULL
      )
  ) AS maintenance_expense_ownership_ready;
