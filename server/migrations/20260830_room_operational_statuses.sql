BEGIN;

-- Trống/giữ chỗ/đang thuê được suy ra từ nguồn nghiệp vụ hiện có. Bảng này chỉ
-- ghi các đợt sửa phòng, có snapshot để PUT /state không làm mất lịch sử.
CREATE TABLE IF NOT EXISTS room_maintenance_periods (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  maintenance_code      TEXT NOT NULL,
  room_id               TEXT NOT NULL,
  room_name_snapshot    TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'active',
  starts_on             DATE NOT NULL,
  expected_ends_on      DATE,
  ended_on              DATE,
  reason                TEXT NOT NULL,
  completion_note       TEXT NOT NULL DEFAULT '',
  completed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT room_maintenance_periods_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT room_maintenance_periods_code_unique UNIQUE (user_id, maintenance_code),
  CONSTRAINT room_maintenance_periods_code_valid
    CHECK (maintenance_code ~ '^SUA-[0-9]{4}-[A-Z0-9]{6}$'),
  CONSTRAINT room_maintenance_periods_status_valid
    CHECK (status IN ('active','completed')),
  CONSTRAINT room_maintenance_periods_dates_valid CHECK (
    expected_ends_on IS NULL OR expected_ends_on >= starts_on
  ),
  CONSTRAINT room_maintenance_periods_status_time_valid CHECK (
    (status='active' AND ended_on IS NULL AND completed_at IS NULL
      AND completion_note='')
    OR (status='completed' AND ended_on IS NOT NULL AND ended_on >= starts_on
      AND completed_at IS NOT NULL AND char_length(completion_note) BETWEEN 10 AND 500)
  ),
  CONSTRAINT room_maintenance_periods_content_valid CHECK (
    char_length(room_id) BETWEEN 1 AND 200
    AND char_length(room_name_snapshot) BETWEEN 1 AND 200
    AND char_length(reason) BETWEEN 10 AND 500
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_room_maintenance_one_active_room
  ON room_maintenance_periods(user_id, room_id) WHERE status='active';
CREATE INDEX IF NOT EXISTS idx_room_maintenance_user_room_date
  ON room_maintenance_periods(user_id, room_id, starts_on DESC, id DESC);

ALTER TABLE rental_lifecycle_events
  ADD COLUMN IF NOT EXISTS maintenance_id BIGINT;

ALTER TABLE rental_lifecycle_events
  DROP CONSTRAINT IF EXISTS rental_lifecycle_events_type_valid;
ALTER TABLE rental_lifecycle_events
  ADD CONSTRAINT rental_lifecycle_events_type_valid CHECK (
    event_type IN (
      'reservation_created','reservation_cancelled','reservation_converted',
      'room_transferred','checked_out',
      'maintenance_started','maintenance_completed'
    )
  );

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rental_lifecycle_events_maintenance_owner_fk'
  ) THEN
    ALTER TABLE rental_lifecycle_events
      ADD CONSTRAINT rental_lifecycle_events_maintenance_owner_fk
      FOREIGN KEY (user_id, maintenance_id)
      REFERENCES room_maintenance_periods(user_id, id) ON DELETE CASCADE;
  END IF;
END $$;

DO $$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'tro_bill_runtime', 'tro_bill_runtime_sql', 'tro_bill_app'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format(
        'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON room_maintenance_periods FROM %I',
        runtime_role
      );
      EXECUTE format('GRANT SELECT, INSERT ON room_maintenance_periods TO %I', runtime_role);
      EXECUTE format(
        'GRANT UPDATE (status, ended_on, completion_note, completed_at, updated_at) ON room_maintenance_periods TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE room_maintenance_periods_id_seq TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;

COMMIT;

SELECT
  to_regclass('public.room_maintenance_periods') IS NOT NULL
    AS maintenance_table_ready,
  EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname='public'
      AND indexname='idx_room_maintenance_one_active_room'
  ) AS maintenance_unique_active_ready,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='rental_lifecycle_events'
      AND column_name='maintenance_id'
  ) AS lifecycle_maintenance_link_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rental_lifecycle_events_maintenance_owner_fk'
  ) AS lifecycle_maintenance_owner_ready,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime_sql') THEN
    has_table_privilege('tro_bill_runtime_sql', 'room_maintenance_periods', 'INSERT')
    AND has_column_privilege('tro_bill_runtime_sql', 'room_maintenance_periods', 'status', 'UPDATE')
    AND NOT has_table_privilege('tro_bill_runtime_sql', 'room_maintenance_periods', 'DELETE')
  ELSE TRUE END AS maintenance_runtime_ready;
