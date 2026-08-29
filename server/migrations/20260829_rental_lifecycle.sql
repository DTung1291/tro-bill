BEGIN;

-- Giữ chỗ có vòng đời riêng; phòng/khách trong state có thể được ghi lại bởi
-- PUT /state nên reservation chỉ lưu reference và snapshot, không FK trực tiếp.
CREATE TABLE IF NOT EXISTS rental_reservations (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reservation_code      TEXT NOT NULL,
  room_id               TEXT NOT NULL,
  room_name_snapshot    TEXT NOT NULL,
  guest_name_snapshot   TEXT NOT NULL,
  guest_phone_snapshot  TEXT NOT NULL DEFAULT '',
  reserved_on           DATE NOT NULL,
  expected_move_in_on   DATE NOT NULL,
  expires_on            DATE NOT NULL,
  expected_deposit_vnd  BIGINT NOT NULL DEFAULT 0,
  note                  TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'active',
  status_reason         TEXT NOT NULL DEFAULT '',
  converted_contract_id BIGINT,
  converted_at          TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  expired_at            TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rental_reservations_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT rental_reservations_code_unique UNIQUE (user_id, reservation_code),
  CONSTRAINT rental_reservations_code_valid
    CHECK (reservation_code ~ '^GC-[0-9]{4}-[A-Z0-9]{6}$'),
  CONSTRAINT rental_reservations_status_valid
    CHECK (status IN ('active','converted','cancelled','expired')),
  CONSTRAINT rental_reservations_dates_valid CHECK (
    expires_on >= reserved_on
    AND expected_move_in_on >= reserved_on
  ),
  CONSTRAINT rental_reservations_amount_valid
    CHECK (expected_deposit_vnd BETWEEN 0 AND 999999999999),
  CONSTRAINT rental_reservations_content_valid CHECK (
    char_length(room_id) BETWEEN 1 AND 200
    AND char_length(room_name_snapshot) BETWEEN 1 AND 200
    AND char_length(guest_name_snapshot) BETWEEN 1 AND 200
    AND char_length(guest_phone_snapshot) <= 50
    AND char_length(note) <= 1000
    AND char_length(status_reason) <= 500
  ),
  CONSTRAINT rental_reservations_status_time_valid CHECK (
    (status='active' AND converted_contract_id IS NULL AND converted_at IS NULL
      AND cancelled_at IS NULL AND expired_at IS NULL)
    OR (status='converted' AND converted_contract_id IS NOT NULL AND converted_at IS NOT NULL
      AND cancelled_at IS NULL AND expired_at IS NULL)
    OR (status='cancelled' AND converted_contract_id IS NULL AND converted_at IS NULL
      AND cancelled_at IS NOT NULL AND expired_at IS NULL)
    OR (status='expired' AND converted_contract_id IS NULL AND converted_at IS NULL
      AND cancelled_at IS NULL AND expired_at IS NOT NULL)
  ),
  CONSTRAINT rental_reservations_converted_contract_owner_fk
    FOREIGN KEY (user_id, converted_contract_id)
    REFERENCES rental_contracts(user_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_rental_reservations_one_active_room
  ON rental_reservations(user_id, room_id) WHERE status='active';
CREATE INDEX IF NOT EXISTS idx_rental_reservations_user_room_created
  ON rental_reservations(user_id, room_id, created_at DESC);

-- Nhật ký lifecycle là append-only để chuyển/trả phòng không làm mất dấu vết.
CREATE TABLE IF NOT EXISTS rental_lifecycle_events (
  id                         BIGSERIAL PRIMARY KEY,
  user_id                    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_code                 TEXT NOT NULL,
  event_type                 TEXT NOT NULL,
  contract_id                BIGINT,
  related_contract_id        BIGINT,
  reservation_id             BIGINT,
  tenant_id_snapshot         TEXT NOT NULL DEFAULT '',
  tenant_name_snapshot       TEXT NOT NULL DEFAULT '',
  source_room_id_snapshot    TEXT NOT NULL DEFAULT '',
  source_room_name_snapshot  TEXT NOT NULL DEFAULT '',
  target_room_id_snapshot    TEXT NOT NULL DEFAULT '',
  target_room_name_snapshot  TEXT NOT NULL DEFAULT '',
  occurred_on                DATE NOT NULL,
  reason                     TEXT NOT NULL DEFAULT '',
  metadata                   JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rental_lifecycle_events_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT rental_lifecycle_events_code_unique UNIQUE (user_id, event_code),
  CONSTRAINT rental_lifecycle_events_code_valid
    CHECK (event_code ~ '^VDT-[0-9]{4}-[A-Z0-9]{6}$'),
  CONSTRAINT rental_lifecycle_events_type_valid CHECK (
    event_type IN (
      'reservation_created','reservation_cancelled','reservation_converted',
      'room_transferred','checked_out'
    )
  ),
  CONSTRAINT rental_lifecycle_events_contract_owner_fk
    FOREIGN KEY (user_id, contract_id)
    REFERENCES rental_contracts(user_id, id) ON DELETE CASCADE,
  CONSTRAINT rental_lifecycle_events_related_contract_owner_fk
    FOREIGN KEY (user_id, related_contract_id)
    REFERENCES rental_contracts(user_id, id) ON DELETE CASCADE,
  CONSTRAINT rental_lifecycle_events_reservation_owner_fk
    FOREIGN KEY (user_id, reservation_id)
    REFERENCES rental_reservations(user_id, id) ON DELETE CASCADE,
  CONSTRAINT rental_lifecycle_events_content_valid CHECK (
    char_length(tenant_id_snapshot) <= 200
    AND char_length(tenant_name_snapshot) <= 200
    AND char_length(source_room_id_snapshot) <= 200
    AND char_length(source_room_name_snapshot) <= 200
    AND char_length(target_room_id_snapshot) <= 200
    AND char_length(target_room_name_snapshot) <= 200
    AND char_length(reason) <= 500
    AND jsonb_typeof(metadata)='object'
  )
);

CREATE INDEX IF NOT EXISTS idx_rental_lifecycle_events_user_room_date
  ON rental_lifecycle_events(user_id, source_room_id_snapshot, target_room_id_snapshot, occurred_on DESC, id DESC);

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
        'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rental_reservations FROM %I',
        runtime_role
      );
      EXECUTE format('GRANT SELECT, INSERT ON rental_reservations TO %I', runtime_role);
      EXECUTE format(
        'GRANT UPDATE (status, status_reason, converted_contract_id, converted_at, cancelled_at, expired_at, updated_at) ON rental_reservations TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE rental_reservations_id_seq TO %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rental_lifecycle_events FROM %I',
        runtime_role
      );
      EXECUTE format('GRANT SELECT, INSERT ON rental_lifecycle_events TO %I', runtime_role);
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE rental_lifecycle_events_id_seq TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;

COMMIT;

SELECT
  to_regclass('public.rental_reservations') IS NOT NULL AS reservations_ready,
  to_regclass('public.rental_lifecycle_events') IS NOT NULL AS events_ready,
  EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public' AND indexname='idx_rental_reservations_one_active_room'
  ) AS one_active_reservation_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rental_reservations_converted_contract_owner_fk'
  ) AS reservation_contract_owner_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rental_lifecycle_events_contract_owner_fk'
  ) AS event_contract_owner_ready,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime_sql') THEN
    has_table_privilege('tro_bill_runtime_sql', 'rental_lifecycle_events', 'INSERT')
    AND NOT has_table_privilege('tro_bill_runtime_sql', 'rental_lifecycle_events', 'UPDATE')
    AND NOT has_table_privilege('tro_bill_runtime_sql', 'rental_lifecycle_events', 'DELETE')
  ELSE TRUE END AS events_append_only_ready;
