BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime_sql') THEN
    CREATE ROLE tro_bill_runtime_sql
      WITH NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
           NOREPLICATION NOBYPASSRLS NOINHERIT;
  END IF;
END $$;

-- Đồng bộ quyền trực tiếp từ role chuẩn cũ sang login runtime SQL. Role đích
-- không kế thừa role quản trị; mỗi lần init-db sẽ thu hồi quyền dư trước khi
-- cấp lại đúng quyền bảng/cột/sequence đang có ở tro_bill_runtime.
DO $$
DECLARE
  source_role CONSTANT text := 'tro_bill_runtime';
  target_role CONSTANT text := 'tro_bill_runtime_sql';
  object_row record;
  column_row record;
  sequence_row record;
  privilege_name text;
  privileges text[];
  qualified_name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=source_role)
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=target_role) THEN
    RETURN;
  END IF;

  EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I', current_database(), target_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I', target_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', target_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', target_role);

  FOR column_row IN
    SELECT table_schema, table_name, column_name
    FROM information_schema.columns
    WHERE table_schema='public'
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES (%I) ON TABLE %I.%I FROM %I',
      column_row.column_name,
      column_row.table_schema,
      column_row.table_name,
      target_role
    );
  END LOOP;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), target_role);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', target_role);

  FOR object_row IN
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE'
    ORDER BY table_name
  LOOP
    qualified_name := format('%I.%I', object_row.table_schema, object_row.table_name);
    privileges := ARRAY[]::text[];
    FOREACH privilege_name IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
      IF has_table_privilege(source_role, qualified_name, privilege_name) THEN
        privileges := array_append(privileges, privilege_name);
      END IF;
    END LOOP;
    IF cardinality(privileges) > 0 THEN
      EXECUTE format(
        'GRANT %s ON TABLE %s TO %I',
        array_to_string(privileges, ', '),
        qualified_name,
        target_role
      );
    END IF;
  END LOOP;

  FOR column_row IN
    SELECT table_schema, table_name, column_name
    FROM information_schema.columns
    WHERE table_schema='public'
  LOOP
    qualified_name := format('%I.%I', column_row.table_schema, column_row.table_name);
    privileges := ARRAY[]::text[];
    FOREACH privilege_name IN ARRAY ARRAY['SELECT','INSERT','UPDATE','REFERENCES'] LOOP
      IF has_column_privilege(source_role, qualified_name, column_row.column_name, privilege_name)
         AND NOT has_table_privilege(source_role, qualified_name, privilege_name) THEN
        privileges := array_append(
          privileges,
          format('%s (%I)', privilege_name, column_row.column_name)
        );
      END IF;
    END LOOP;
    IF cardinality(privileges) > 0 THEN
      EXECUTE format(
        'GRANT %s ON TABLE %s TO %I',
        array_to_string(privileges, ', '),
        qualified_name,
        target_role
      );
    END IF;
  END LOOP;

  FOR sequence_row IN
    SELECT class.oid, namespace.nspname AS schema_name, class.relname AS sequence_name
    FROM pg_class class
    JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
    WHERE namespace.nspname='public' AND class.relkind='S'
  LOOP
    privileges := ARRAY[]::text[];
    FOREACH privilege_name IN ARRAY ARRAY['USAGE','SELECT','UPDATE'] LOOP
      IF has_sequence_privilege(source_role, sequence_row.oid, privilege_name) THEN
        privileges := array_append(privileges, privilege_name);
      END IF;
    END LOOP;
    IF cardinality(privileges) > 0 THEN
      EXECUTE format(
        'GRANT %s ON SEQUENCE %I.%I TO %I',
        array_to_string(privileges, ', '),
        sequence_row.schema_name,
        sequence_row.sequence_name,
        target_role
      );
    END IF;
  END LOOP;
END $$;

COMMIT;

SELECT
  role.rolcanlogin,
  NOT role.rolinherit AS no_inherit,
  NOT role.rolcreaterole AS no_create_role,
  NOT role.rolcreatedb AS no_create_database,
  NOT role.rolreplication AS no_replication,
  NOT role.rolbypassrls AS no_bypass_rls,
  NOT EXISTS (
    SELECT 1
    FROM pg_auth_members membership
    JOIN pg_roles parent ON parent.oid=membership.roleid
    WHERE membership.member=role.oid AND parent.rolname='neon_superuser'
  ) AS no_neon_superuser,
  has_schema_privilege(role.rolname, 'public', 'USAGE') AS schema_usage,
  NOT has_schema_privilege(role.rolname, 'public', 'CREATE') AS schema_create_forbidden
FROM pg_roles role
WHERE role.rolname='tro_bill_runtime_sql';
