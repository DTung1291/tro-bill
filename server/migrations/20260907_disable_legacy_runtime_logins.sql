BEGIN;

-- Vercel phải dùng tro_bill_runtime_sql trước khi chạy migration này. Giữ các
-- role cũ làm mẫu quyền cho schema/migration nhưng vô hiệu mọi credential cũ.
-- Không tự ngắt kết nối đang chạy: nếu còn session, rollback toàn bộ để tránh
-- làm gián đoạn một deployment chưa chuyển xong.
DO $$
DECLARE
  legacy_role text;
  active_session_count integer;
BEGIN
  FOREACH legacy_role IN ARRAY ARRAY['tro_bill_runtime', 'tro_bill_app'] LOOP
    IF EXISTS (
      SELECT 1
      FROM pg_roles
      WHERE rolname=legacy_role AND rolcanlogin
    ) THEN
      SELECT count(*)
      INTO active_session_count
      FROM pg_stat_activity
      WHERE usename=legacy_role AND pid <> pg_backend_pid();

      IF active_session_count > 0 THEN
        RAISE EXCEPTION
          'Refusing to disable login for role %: % active session(s)',
          legacy_role,
          active_session_count;
      END IF;

      EXECUTE format('ALTER ROLE %I NOLOGIN', legacy_role);
    END IF;
  END LOOP;
END $$;

COMMIT;

SELECT
  EXISTS (
    SELECT 1
    FROM pg_roles role
    WHERE role.rolname='tro_bill_runtime_sql'
      AND role.rolcanlogin
      AND NOT role.rolsuper
      AND NOT role.rolcreaterole
      AND NOT role.rolcreatedb
      AND NOT role.rolreplication
      AND NOT role.rolbypassrls
      AND NOT role.rolinherit
  ) AS restricted_runtime_login_ready,
  NOT EXISTS (
    SELECT 1
    FROM pg_roles
    WHERE rolname IN ('tro_bill_runtime', 'tro_bill_app') AND rolcanlogin
  ) AS legacy_runtime_logins_disabled,
  NOT EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    JOIN pg_roles member ON member.oid=membership.member
    JOIN pg_roles parent ON parent.oid=membership.roleid
    WHERE member.rolname IN (
      'tro_bill_runtime_sql',
      'tro_bill_runtime',
      'tro_bill_app'
    )
      AND parent.rolname='neon_superuser'
  ) AS no_runtime_neon_superuser_membership;
