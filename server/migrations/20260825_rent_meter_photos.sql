BEGIN;

-- Chỉ lưu ảnh khung số đã nén, không lưu ảnh gốc/EXIF. Mỗi phòng có tối đa
-- một ảnh điện và một ảnh nước cho mỗi tháng.
CREATE TABLE IF NOT EXISTS rent_meter_photos (
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id    TEXT NOT NULL,
  period     TEXT NOT NULL,
  meter_type TEXT NOT NULL,
  mime_type  TEXT NOT NULL DEFAULT 'image/jpeg',
  image_data BYTEA NOT NULL,
  byte_size  INTEGER NOT NULL,
  sha256     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, room_id, period, meter_type),
  CONSTRAINT rent_meter_photos_room_id_length CHECK (char_length(room_id) BETWEEN 1 AND 200),
  CONSTRAINT rent_meter_photos_period_format CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT rent_meter_photos_meter_type_valid CHECK (meter_type IN ('electricity', 'water')),
  CONSTRAINT rent_meter_photos_mime_type_valid CHECK (mime_type='image/jpeg'),
  CONSTRAINT rent_meter_photos_byte_size_valid CHECK (
    byte_size BETWEEN 100 AND 98304 AND octet_length(image_data)=byte_size
  ),
  CONSTRAINT rent_meter_photos_sha256_valid CHECK (sha256 ~ '^[a-f0-9]{64}$')
);

CREATE INDEX IF NOT EXISTS idx_rent_meter_photos_user_period
  ON rent_meter_photos(user_id, period DESC, room_id);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime') THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rent_meter_photos FROM tro_bill_runtime';
    EXECUTE 'GRANT SELECT, INSERT ON rent_meter_photos TO tro_bill_runtime';
    EXECUTE 'GRANT UPDATE (mime_type, image_data, byte_size, sha256, updated_at) ON rent_meter_photos TO tro_bill_runtime';
  END IF;
END $$;

COMMIT;

SELECT
  to_regclass('public.rent_meter_photos') IS NOT NULL AS meter_photos_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_meter_photos_byte_size_valid'
  ) AS size_constraint_ready,
  has_table_privilege(
    'tro_bill_runtime', 'rent_meter_photos', 'SELECT,INSERT'
  ) AS runtime_base_privileges_ready,
  has_column_privilege(
    'tro_bill_runtime', 'rent_meter_photos', 'image_data', 'UPDATE'
  ) AS runtime_photo_update_ready;
