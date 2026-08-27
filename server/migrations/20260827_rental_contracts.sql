BEGIN;

CREATE TABLE IF NOT EXISTS rental_contracts (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contract_code         TEXT NOT NULL,
  room_id               TEXT NOT NULL,
  room_name_snapshot    TEXT NOT NULL,
  tenant_id             TEXT NOT NULL,
  tenant_name_snapshot  TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'draft',
  starts_on             DATE NOT NULL,
  ends_on               DATE,
  monthly_rent_vnd      BIGINT NOT NULL,
  deposit_vnd           BIGINT NOT NULL DEFAULT 0,
  terms                 TEXT NOT NULL DEFAULT '',
  status_reason         TEXT NOT NULL DEFAULT '',
  activated_at          TIMESTAMPTZ,
  ended_at              TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rental_contracts_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT rental_contracts_code_unique UNIQUE (user_id, contract_code),
  CONSTRAINT rental_contracts_code_valid
    CHECK (contract_code ~ '^HD-[0-9]{4}-[A-Z0-9]{6}$'),
  CONSTRAINT rental_contracts_status_valid
    CHECK (status IN ('draft','active','ended','cancelled')),
  CONSTRAINT rental_contracts_dates_valid CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT rental_contracts_amounts_valid CHECK (
    monthly_rent_vnd BETWEEN 0 AND 999999999999
    AND deposit_vnd BETWEEN 0 AND 999999999999
  ),
  CONSTRAINT rental_contracts_snapshot_valid CHECK (
    room_id <> '' AND char_length(room_id) <= 200
    AND tenant_id <> '' AND char_length(tenant_id) <= 200
    AND room_name_snapshot <> '' AND char_length(room_name_snapshot) <= 200
    AND tenant_name_snapshot <> '' AND char_length(tenant_name_snapshot) <= 200
    AND char_length(terms) <= 5000
    AND char_length(status_reason) <= 500
  ),
  CONSTRAINT rental_contracts_status_time_valid CHECK (
    (status='draft' AND activated_at IS NULL AND ended_at IS NULL AND cancelled_at IS NULL)
    OR (status='active' AND activated_at IS NOT NULL AND ended_at IS NULL AND cancelled_at IS NULL)
    OR (status='ended' AND activated_at IS NOT NULL AND ended_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status='cancelled' AND cancelled_at IS NOT NULL AND ended_at IS NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rental_contracts_one_active_room
  ON rental_contracts(user_id, room_id) WHERE status='active';
CREATE INDEX IF NOT EXISTS idx_rental_contracts_user_room
  ON rental_contracts(user_id, room_id, created_at DESC);

CREATE TABLE IF NOT EXISTS rental_contract_amendments (
  id                         BIGSERIAL PRIMARY KEY,
  user_id                    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contract_id                BIGINT NOT NULL,
  amendment_code             TEXT NOT NULL,
  effective_from             TEXT NOT NULL,
  previous_monthly_rent_vnd  BIGINT NOT NULL,
  new_monthly_rent_vnd       BIGINT NOT NULL,
  reason                     TEXT NOT NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rental_contract_amendments_contract_owner_fk
    FOREIGN KEY (user_id, contract_id)
    REFERENCES rental_contracts(user_id, id) ON DELETE CASCADE,
  CONSTRAINT rental_contract_amendments_period_unique
    UNIQUE (user_id, contract_id, effective_from),
  CONSTRAINT rental_contract_amendments_code_unique UNIQUE (user_id, amendment_code),
  CONSTRAINT rental_contract_amendments_code_valid
    CHECK (amendment_code ~ '^PL-[0-9]{6}-[A-Z0-9]{6}$'),
  CONSTRAINT rental_contract_amendments_period_valid
    CHECK (effective_from ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT rental_contract_amendments_amounts_valid CHECK (
    previous_monthly_rent_vnd BETWEEN 0 AND 999999999999
    AND new_monthly_rent_vnd BETWEEN 0 AND 999999999999
    AND previous_monthly_rent_vnd <> new_monthly_rent_vnd
  ),
  CONSTRAINT rental_contract_amendments_reason_valid
    CHECK (char_length(reason) BETWEEN 10 AND 500)
);
CREATE INDEX IF NOT EXISTS idx_rental_contract_amendments_contract
  ON rental_contract_amendments(user_id, contract_id, effective_from, id);

DO $$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'tro_bill_runtime',
    'tro_bill_runtime_sql',
    'tro_bill_app'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format(
        'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rental_contracts FROM %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT SELECT, INSERT ON rental_contracts TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT UPDATE (status, status_reason, activated_at, ended_at, cancelled_at, updated_at) ON rental_contracts TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE rental_contracts_id_seq TO %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rental_contract_amendments FROM %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT SELECT, INSERT ON rental_contract_amendments TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE rental_contract_amendments_id_seq TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;

COMMIT;

SELECT
  to_regclass('public.rental_contracts') IS NOT NULL AS contracts_ready,
  to_regclass('public.rental_contract_amendments') IS NOT NULL AS amendments_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rental_contract_amendments_contract_owner_fk'
  ) AS amendment_ownership_ready,
  EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='idx_rental_contracts_one_active_room'
  ) AS one_active_contract_ready,
  NOT EXISTS (
    SELECT 1 FROM information_schema.role_table_grants
    WHERE table_schema='public' AND table_name='rental_contract_amendments'
      AND grantee IN ('tro_bill_runtime','tro_bill_runtime_sql','tro_bill_app')
      AND privilege_type IN ('UPDATE','DELETE','TRUNCATE')
  ) AS amendments_append_only;
