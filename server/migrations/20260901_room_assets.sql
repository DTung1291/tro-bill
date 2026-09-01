BEGIN;

-- Danh mục tài sản/nội thất theo phòng. Tài sản ngừng sử dụng được lưu lịch sử,
-- không xóa vật lý. Không FK trực tiếp tới rooms vì PUT /state thay lại rooms.
CREATE TABLE IF NOT EXISTS room_assets (
  id                  BIGSERIAL PRIMARY KEY,
  user_id             BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset_code          TEXT NOT NULL,
  room_id             TEXT NOT NULL,
  room_name_snapshot  TEXT NOT NULL,
  name                TEXT NOT NULL,
  quantity            NUMERIC(10,2) NOT NULL,
  unit                TEXT NOT NULL DEFAULT 'cái',
  condition_status    TEXT NOT NULL DEFAULT 'good',
  condition_note      TEXT NOT NULL DEFAULT '',
  serial_number       TEXT NOT NULL DEFAULT '',
  acquired_on         DATE,
  purchase_price_vnd  BIGINT,
  note                TEXT NOT NULL DEFAULT '',
  status              TEXT NOT NULL DEFAULT 'active',
  archived_reason     TEXT NOT NULL DEFAULT '',
  archived_at         TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT room_assets_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT room_assets_code_unique UNIQUE (user_id, asset_code),
  CONSTRAINT room_assets_code_valid
    CHECK (asset_code ~ '^TS-[0-9]{4}-[A-Z0-9]{6}$'),
  CONSTRAINT room_assets_condition_valid
    CHECK (condition_status IN ('good','fair','damaged','lost')),
  CONSTRAINT room_assets_status_valid
    CHECK (status IN ('active','archived')),
  CONSTRAINT room_assets_quantity_valid
    CHECK (quantity > 0 AND quantity <= 99999999),
  CONSTRAINT room_assets_price_valid
    CHECK (purchase_price_vnd IS NULL OR purchase_price_vnd BETWEEN 0 AND 999999999999),
  CONSTRAINT room_assets_content_valid CHECK (
    char_length(room_id) BETWEEN 1 AND 200
    AND char_length(room_name_snapshot) BETWEEN 1 AND 200
    AND char_length(name) BETWEEN 1 AND 200
    AND char_length(unit) BETWEEN 1 AND 50
    AND char_length(condition_note) <= 500
    AND char_length(serial_number) <= 200
    AND char_length(note) <= 1000
  ),
  CONSTRAINT room_assets_archive_valid CHECK (
    (status='active' AND archived_reason='' AND archived_at IS NULL)
    OR (status='archived' AND char_length(archived_reason) BETWEEN 3 AND 500
      AND archived_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_room_assets_user_room_status
  ON room_assets(user_id, room_id, status, name, id);
CREATE INDEX IF NOT EXISTS idx_room_assets_user_status_updated
  ON room_assets(user_id, status, updated_at DESC, id DESC);

DO $$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'tro_bill_runtime', 'tro_bill_runtime_sql', 'tro_bill_app'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format('GRANT SELECT, INSERT ON room_assets TO %I', runtime_role);
      EXECUTE format(
        'GRANT UPDATE (room_id, room_name_snapshot, name, quantity, unit, condition_status, condition_note, serial_number, acquired_on, purchase_price_vnd, note, status, archived_reason, archived_at, updated_at) ON room_assets TO %I',
        runtime_role
      );
      EXECUTE format('GRANT USAGE, SELECT ON SEQUENCE room_assets_id_seq TO %I', runtime_role);
      EXECUTE format('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON room_assets FROM %I', runtime_role);
    END IF;
  END LOOP;
END $$;

COMMIT;

SELECT
  to_regclass('public.room_assets') IS NOT NULL AS room_assets_table_ready,
  to_regclass('public.idx_room_assets_user_room_status') IS NOT NULL
    AS room_assets_room_index_ready,
  to_regclass('public.idx_room_assets_user_status_updated') IS NOT NULL
    AS room_assets_status_index_ready,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime_sql') THEN
    has_table_privilege('tro_bill_runtime_sql', 'room_assets', 'SELECT')
    AND has_table_privilege('tro_bill_runtime_sql', 'room_assets', 'INSERT')
    AND has_column_privilege('tro_bill_runtime_sql', 'room_assets', 'status', 'UPDATE')
    AND NOT has_table_privilege('tro_bill_runtime_sql', 'room_assets', 'DELETE')
  ELSE TRUE END AS room_assets_runtime_ready,
  NOT EXISTS (
    SELECT 1 FROM room_assets asset
    LEFT JOIN rooms room ON room.user_id=asset.user_id AND room.id=asset.room_id
    WHERE asset.status='active' AND room.id IS NULL
  ) AS room_assets_active_ownership_ready;
