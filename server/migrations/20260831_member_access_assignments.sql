BEGIN;

CREATE TABLE IF NOT EXISTS account_member_property_access (
  account_user_id    BIGINT NOT NULL,
  member_user_id     BIGINT NOT NULL,
  property_id        BIGINT NOT NULL,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_user_id, member_user_id, property_id),
  CONSTRAINT account_member_property_membership_fk
    FOREIGN KEY (account_user_id, member_user_id)
    REFERENCES account_memberships(account_user_id, member_user_id)
    ON DELETE CASCADE,
  CONSTRAINT account_member_property_owner_fk
    FOREIGN KEY (account_user_id, property_id)
    REFERENCES properties(user_id, id)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_member_property_access_lookup
  ON account_member_property_access(member_user_id, account_user_id, property_id);

CREATE TABLE IF NOT EXISTS account_member_operation_access (
  account_user_id    BIGINT NOT NULL,
  member_user_id     BIGINT NOT NULL,
  operation          TEXT NOT NULL,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_user_id, member_user_id, operation),
  CONSTRAINT account_member_operation_membership_fk
    FOREIGN KEY (account_user_id, member_user_id)
    REFERENCES account_memberships(account_user_id, member_user_id)
    ON DELETE CASCADE,
  CONSTRAINT account_member_operation_valid CHECK (
    operation IN ('overview', 'rooms', 'meters', 'expenses', 'invoices')
  )
);

CREATE INDEX IF NOT EXISTS idx_member_operation_access_lookup
  ON account_member_operation_access(member_user_id, account_user_id, operation);

DO $$
DECLARE
  runtime_role text;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'tro_bill_runtime', 'tro_bill_runtime_sql', 'tro_bill_app'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, DELETE ON account_member_property_access TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT SELECT, INSERT, DELETE ON account_member_operation_access TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;

COMMIT;

SELECT
  to_regclass('public.account_member_property_access') IS NOT NULL
    AS member_property_access_table_ready,
  to_regclass('public.account_member_operation_access') IS NOT NULL
    AS member_operation_access_table_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='account_member_property_membership_fk'
  ) AS member_property_membership_fk_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='account_member_property_owner_fk'
  ) AS member_property_owner_fk_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='account_member_operation_valid'
  ) AS member_operation_constraint_ready,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime_sql') THEN
    has_table_privilege('tro_bill_runtime_sql', 'account_member_property_access', 'SELECT')
    AND has_table_privilege('tro_bill_runtime_sql', 'account_member_property_access', 'INSERT')
    AND has_table_privilege('tro_bill_runtime_sql', 'account_member_property_access', 'DELETE')
    AND has_table_privilege('tro_bill_runtime_sql', 'account_member_operation_access', 'SELECT')
    AND has_table_privilege('tro_bill_runtime_sql', 'account_member_operation_access', 'INSERT')
    AND has_table_privilege('tro_bill_runtime_sql', 'account_member_operation_access', 'DELETE')
  ELSE TRUE END AS member_access_runtime_ready;
