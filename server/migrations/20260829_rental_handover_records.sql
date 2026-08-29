BEGIN;

-- Biên bản nhận/trả phòng là snapshot bất biến. Số dư cọc chỉ được chụp từ
-- tenant_deposit_transactions; bảng này không tạo một nguồn số dư mới.
CREATE TABLE IF NOT EXISTS rental_handover_records (
  id                           BIGSERIAL PRIMARY KEY,
  user_id                      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contract_id                  BIGINT NOT NULL,
  handover_code                TEXT NOT NULL,
  handover_type                TEXT NOT NULL,
  occurred_on                  DATE NOT NULL,
  contract_code_snapshot       TEXT NOT NULL,
  room_id_snapshot             TEXT NOT NULL,
  room_name_snapshot           TEXT NOT NULL,
  tenant_id_snapshot           TEXT NOT NULL,
  tenant_name_snapshot         TEXT NOT NULL,
  lessor_name_snapshot         TEXT NOT NULL,
  property_address_snapshot    TEXT NOT NULL,
  deposit_account_id           BIGINT,
  expected_deposit_vnd         BIGINT NOT NULL DEFAULT 0,
  deposit_balance_snapshot_vnd BIGINT NOT NULL DEFAULT 0,
  electricity_reading          NUMERIC(15, 3),
  water_reading                NUMERIC(15, 3),
  key_count                    SMALLINT NOT NULL DEFAULT 0,
  general_condition            TEXT NOT NULL,
  notes                        TEXT NOT NULL DEFAULT '',
  confirmed_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rental_handover_records_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT rental_handover_records_contract_owner_fk
    FOREIGN KEY (user_id, contract_id)
    REFERENCES rental_contracts(user_id, id) ON DELETE CASCADE,
  CONSTRAINT rental_handover_records_deposit_owner_fk
    FOREIGN KEY (user_id, deposit_account_id)
    REFERENCES tenant_deposit_accounts(user_id, id) ON DELETE RESTRICT,
  CONSTRAINT rental_handover_records_type_unique UNIQUE (user_id, contract_id, handover_type),
  CONSTRAINT rental_handover_records_code_unique UNIQUE (user_id, handover_code),
  CONSTRAINT rental_handover_records_code_valid
    CHECK (handover_code ~ '^BBBG-[0-9]{4}-(IN|OUT)-[A-Z0-9]{6}$'),
  CONSTRAINT rental_handover_records_type_valid
    CHECK (handover_type IN ('check_in', 'check_out')),
  CONSTRAINT rental_handover_records_amounts_valid CHECK (
    expected_deposit_vnd BETWEEN 0 AND 999999999999
    AND deposit_balance_snapshot_vnd BETWEEN 0 AND 999999999999
  ),
  CONSTRAINT rental_handover_records_readings_valid CHECK (
    (electricity_reading IS NULL OR electricity_reading BETWEEN 0 AND 999999999999)
    AND (water_reading IS NULL OR water_reading BETWEEN 0 AND 999999999999)
  ),
  CONSTRAINT rental_handover_records_content_valid CHECK (
    char_length(contract_code_snapshot) BETWEEN 1 AND 50
    AND char_length(room_id_snapshot) BETWEEN 1 AND 200
    AND char_length(room_name_snapshot) BETWEEN 1 AND 200
    AND char_length(tenant_id_snapshot) BETWEEN 1 AND 200
    AND char_length(tenant_name_snapshot) BETWEEN 1 AND 200
    AND char_length(lessor_name_snapshot) BETWEEN 1 AND 200
    AND char_length(property_address_snapshot) BETWEEN 1 AND 1000
    AND key_count BETWEEN 0 AND 1000
    AND char_length(general_condition) BETWEEN 3 AND 2000
    AND char_length(notes) <= 3000
  )
);

CREATE INDEX IF NOT EXISTS idx_rental_handover_records_contract
  ON rental_handover_records(user_id, contract_id, occurred_on, id);

CREATE TABLE IF NOT EXISTS rental_handover_items (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  handover_id    BIGINT NOT NULL,
  item_order     SMALLINT NOT NULL,
  item_name      TEXT NOT NULL,
  quantity       NUMERIC(10, 2) NOT NULL,
  unit           TEXT NOT NULL DEFAULT 'cái',
  item_condition TEXT NOT NULL,
  note           TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rental_handover_items_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT rental_handover_items_record_owner_fk
    FOREIGN KEY (user_id, handover_id)
    REFERENCES rental_handover_records(user_id, id) ON DELETE CASCADE,
  CONSTRAINT rental_handover_items_order_unique UNIQUE (user_id, handover_id, item_order),
  CONSTRAINT rental_handover_items_content_valid CHECK (
    item_order BETWEEN 1 AND 50
    AND char_length(item_name) BETWEEN 1 AND 200
    AND quantity > 0 AND quantity <= 99999999
    AND char_length(unit) BETWEEN 1 AND 50
    AND char_length(item_condition) BETWEEN 1 AND 500
    AND char_length(note) <= 500
  )
);

CREATE INDEX IF NOT EXISTS idx_rental_handover_items_record
  ON rental_handover_items(user_id, handover_id, item_order, id);

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
        'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rental_handover_records FROM %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT SELECT, INSERT ON rental_handover_records TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE rental_handover_records_id_seq TO %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rental_handover_items FROM %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT SELECT, INSERT ON rental_handover_items TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE rental_handover_items_id_seq TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;

COMMIT;

SELECT
  to_regclass('public.rental_handover_records') IS NOT NULL AS records_ready,
  to_regclass('public.rental_handover_items') IS NOT NULL AS items_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rental_handover_records_contract_owner_fk'
  ) AS contract_owner_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rental_handover_records_deposit_owner_fk'
  ) AS deposit_owner_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rental_handover_records_type_unique'
  ) AS one_per_type_ready,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime_sql') THEN
    has_table_privilege('tro_bill_runtime_sql', 'rental_handover_records', 'INSERT')
    AND NOT has_table_privilege('tro_bill_runtime_sql', 'rental_handover_records', 'UPDATE')
    AND NOT has_table_privilege('tro_bill_runtime_sql', 'rental_handover_records', 'DELETE')
  ELSE TRUE END AS append_only_ready;
