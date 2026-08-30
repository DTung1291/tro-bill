BEGIN;

CREATE TABLE IF NOT EXISTS properties (
  id          BIGSERIAL PRIMARY KEY,
  user_id     BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  address     TEXT NOT NULL DEFAULT '',
  note        TEXT NOT NULL DEFAULT '',
  is_default  BOOLEAN NOT NULL DEFAULT false,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT properties_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT properties_content_valid CHECK (
    char_length(name) BETWEEN 1 AND 200
    AND char_length(address) <= 1000
    AND char_length(note) <= 500
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_properties_one_default
  ON properties(user_id) WHERE is_default;
CREATE UNIQUE INDEX IF NOT EXISTS idx_properties_name_unique
  ON properties(user_id, lower(name));
CREATE INDEX IF NOT EXISTS idx_properties_user_sort
  ON properties(user_id, sort_order, id);

INSERT INTO properties (user_id, name, is_default, sort_order)
SELECT users.id, 'Khu trọ chính', true, 0
FROM users
WHERE NOT EXISTS (
  SELECT 1 FROM properties WHERE properties.user_id=users.id
)
ON CONFLICT DO NOTHING;

ALTER TABLE rooms ADD COLUMN IF NOT EXISTS property_id BIGINT;

-- Giữ zero-downtime khi migration chạy trước deployment: phiên bản server cũ
-- chưa gửi property_id vẫn được tự gắn khu mặc định trong khoảng rollout.
CREATE OR REPLACE FUNCTION assign_default_room_property()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
BEGIN
  IF NEW.property_id IS NULL THEN
    INSERT INTO properties (user_id, name, is_default, sort_order)
    VALUES (NEW.user_id, 'Khu trọ chính', true, 0)
    ON CONFLICT DO NOTHING;

    SELECT id INTO NEW.property_id
    FROM properties
    WHERE user_id=NEW.user_id AND is_default
    LIMIT 1;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS rooms_assign_default_property ON rooms;
CREATE TRIGGER rooms_assign_default_property
BEFORE INSERT ON rooms
FOR EACH ROW EXECUTE FUNCTION assign_default_room_property();

UPDATE rooms
SET property_id=properties.id
FROM properties
WHERE properties.user_id=rooms.user_id
  AND properties.is_default
  AND rooms.property_id IS NULL;

ALTER TABLE rooms ALTER COLUMN property_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='rooms_property_owner_fk'
  ) THEN
    ALTER TABLE rooms ADD CONSTRAINT rooms_property_owner_fk
      FOREIGN KEY (user_id, property_id)
      REFERENCES properties(user_id, id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_rooms_user_property_sort
  ON rooms(user_id, property_id, sort_order, id);

DO $$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'tro_bill_runtime', 'tro_bill_runtime_sql', 'tro_bill_app'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON properties TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE properties_id_seq TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;

COMMIT;

SELECT
  to_regclass('public.properties') IS NOT NULL AS properties_table_ready,
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='rooms' AND column_name='property_id'
      AND is_nullable='NO'
  ) AS room_property_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='rooms_property_owner_fk'
  ) AS room_property_owner_ready,
  EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='rooms_assign_default_property' AND NOT tgisinternal
  ) AS legacy_room_insert_ready,
  NOT EXISTS (
    SELECT 1 FROM users
    WHERE NOT EXISTS (
      SELECT 1 FROM properties
      WHERE properties.user_id=users.id AND properties.is_default
    )
  ) AS default_property_backfill_ready,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime_sql') THEN
    has_table_privilege('tro_bill_runtime_sql', 'properties', 'SELECT')
    AND has_table_privilege('tro_bill_runtime_sql', 'properties', 'INSERT')
    AND has_table_privilege('tro_bill_runtime_sql', 'properties', 'UPDATE')
    AND has_table_privilege('tro_bill_runtime_sql', 'properties', 'DELETE')
  ELSE TRUE END AS properties_runtime_ready;
