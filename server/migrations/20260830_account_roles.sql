BEGIN;

CREATE TABLE IF NOT EXISTS account_memberships (
  account_user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  member_user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role               TEXT NOT NULL,
  created_by_user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (account_user_id, member_user_id),
  CONSTRAINT account_memberships_role_valid
    CHECK (role IN ('owner', 'manager', 'accountant', 'meter_reader')),
  CONSTRAINT account_memberships_owner_shape_valid CHECK (
    (role='owner' AND account_user_id=member_user_id)
    OR (role<>'owner' AND account_user_id<>member_user_id)
  )
);

CREATE INDEX IF NOT EXISTS idx_account_memberships_member
  ON account_memberships(member_user_id, role, account_user_id);

INSERT INTO account_memberships
  (account_user_id, member_user_id, role, created_by_user_id)
SELECT id, id, 'owner', id
FROM users
ON CONFLICT (account_user_id, member_user_id) DO NOTHING;

CREATE OR REPLACE FUNCTION assign_owner_account_membership()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  INSERT INTO account_memberships
    (account_user_id, member_user_id, role, created_by_user_id)
  VALUES (NEW.id, NEW.id, 'owner', NEW.id)
  ON CONFLICT (account_user_id, member_user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS users_assign_owner_account_membership ON users;
CREATE TRIGGER users_assign_owner_account_membership
AFTER INSERT ON users
FOR EACH ROW EXECUTE FUNCTION assign_owner_account_membership();

DO $$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'tro_bill_runtime', 'tro_bill_runtime_sql', 'tro_bill_app'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON account_memberships TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;

COMMIT;

SELECT
  to_regclass('public.account_memberships') IS NOT NULL AS memberships_table_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='account_memberships_role_valid'
  ) AS membership_roles_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='account_memberships_owner_shape_valid'
  ) AS membership_owner_guard_ready,
  EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='users_assign_owner_account_membership' AND NOT tgisinternal
  ) AS owner_membership_trigger_ready,
  NOT EXISTS (
    SELECT 1 FROM users
    WHERE NOT EXISTS (
      SELECT 1 FROM account_memberships membership
      WHERE membership.account_user_id=users.id
        AND membership.member_user_id=users.id
        AND membership.role='owner'
    )
  ) AS owner_membership_backfill_ready,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime_sql') THEN
    has_table_privilege('tro_bill_runtime_sql', 'account_memberships', 'SELECT')
    AND has_table_privilege('tro_bill_runtime_sql', 'account_memberships', 'INSERT')
    AND has_table_privilege('tro_bill_runtime_sql', 'account_memberships', 'UPDATE')
    AND has_table_privilege('tro_bill_runtime_sql', 'account_memberships', 'DELETE')
  ELSE TRUE END AS memberships_runtime_ready;
