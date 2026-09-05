BEGIN;

CREATE TABLE IF NOT EXISTS tenant_maintenance_portal_links (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contract_id           BIGINT NOT NULL,
  room_id               TEXT NOT NULL,
  room_name_snapshot    TEXT NOT NULL,
  tenant_id             TEXT NOT NULL,
  tenant_name_snapshot  TEXT NOT NULL,
  token_hash            TEXT NOT NULL UNIQUE,
  token_last4           TEXT NOT NULL,
  expires_at            TIMESTAMPTZ NOT NULL,
  revoked_at            TIMESTAMPTZ,
  view_count            BIGINT NOT NULL DEFAULT 0,
  last_viewed_at        TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tenant_maintenance_portal_user_contract_id_unique
    UNIQUE (user_id, contract_id, id),
  CONSTRAINT tenant_maintenance_portal_contract_fk
    FOREIGN KEY (user_id, contract_id)
    REFERENCES rental_contracts(user_id, id) ON DELETE CASCADE,
  CONSTRAINT tenant_maintenance_portal_token_hash_valid
    CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT tenant_maintenance_portal_token_last4_valid
    CHECK (token_last4 ~ '^[A-Za-z0-9_-]{4}$'),
  CONSTRAINT tenant_maintenance_portal_content_valid CHECK (
    char_length(room_id) BETWEEN 1 AND 200
    AND char_length(room_name_snapshot) BETWEEN 1 AND 200
    AND char_length(tenant_id) BETWEEN 1 AND 200
    AND char_length(tenant_name_snapshot) BETWEEN 1 AND 200
  ),
  CONSTRAINT tenant_maintenance_portal_expiry_valid
    CHECK (expires_at > created_at),
  CONSTRAINT tenant_maintenance_portal_revocation_valid
    CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CONSTRAINT tenant_maintenance_portal_view_count_valid CHECK (view_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_tenant_maintenance_portal_contract
  ON tenant_maintenance_portal_links(user_id, contract_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_maintenance_portal_active
  ON tenant_maintenance_portal_links(token_hash, expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS tenant_maintenance_requests (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contract_id           BIGINT NOT NULL,
  portal_link_id        BIGINT NOT NULL,
  request_code          TEXT NOT NULL,
  room_id               TEXT NOT NULL,
  room_name_snapshot    TEXT NOT NULL,
  tenant_id             TEXT NOT NULL,
  tenant_name_snapshot  TEXT NOT NULL,
  category              TEXT NOT NULL,
  urgency               TEXT NOT NULL DEFAULT 'normal',
  description           TEXT NOT NULL,
  contact_phone         TEXT NOT NULL DEFAULT '',
  available_time        TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'new',
  idempotency_key       UUID NOT NULL,
  submitted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tenant_maintenance_requests_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT tenant_maintenance_requests_code_unique UNIQUE (user_id, request_code),
  CONSTRAINT tenant_maintenance_requests_idempotency_unique
    UNIQUE (portal_link_id, idempotency_key),
  CONSTRAINT tenant_maintenance_requests_portal_fk
    FOREIGN KEY (user_id, contract_id, portal_link_id)
    REFERENCES tenant_maintenance_portal_links(user_id, contract_id, id)
    ON DELETE CASCADE,
  CONSTRAINT tenant_maintenance_requests_code_valid
    CHECK (request_code ~ '^YC-[0-9]{4}-[A-Z0-9]{6}$'),
  CONSTRAINT tenant_maintenance_requests_category_valid
    CHECK (category IN ('electricity','water','appliance','structure','security','other')),
  CONSTRAINT tenant_maintenance_requests_urgency_valid
    CHECK (urgency IN ('low','normal','high','emergency')),
  CONSTRAINT tenant_maintenance_requests_status_valid
    CHECK (status IN ('new','acknowledged','in_progress','resolved','cancelled')),
  CONSTRAINT tenant_maintenance_requests_content_valid CHECK (
    char_length(room_id) BETWEEN 1 AND 200
    AND char_length(room_name_snapshot) BETWEEN 1 AND 200
    AND char_length(tenant_id) BETWEEN 1 AND 200
    AND char_length(tenant_name_snapshot) BETWEEN 1 AND 200
    AND char_length(description) BETWEEN 10 AND 2000
    AND char_length(contact_phone) <= 50
    AND char_length(available_time) <= 200
  ),
  CONSTRAINT tenant_maintenance_requests_time_valid
    CHECK (updated_at >= created_at)
);

CREATE INDEX IF NOT EXISTS idx_tenant_maintenance_requests_contract_status
  ON tenant_maintenance_requests(user_id, contract_id, status, submitted_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_tenant_maintenance_requests_room_status
  ON tenant_maintenance_requests(user_id, room_id, status, submitted_at DESC, id DESC);

DO $$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'tro_bill_runtime', 'tro_bill_runtime_sql', 'tro_bill_app'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format(
        'GRANT SELECT, INSERT ON tenant_maintenance_portal_links TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT UPDATE (revoked_at, view_count, last_viewed_at) ON tenant_maintenance_portal_links TO %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON tenant_maintenance_portal_links FROM %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE tenant_maintenance_portal_links_id_seq TO %I',
        runtime_role
      );

      EXECUTE format('GRANT SELECT, INSERT ON tenant_maintenance_requests TO %I', runtime_role);
      EXECUTE format(
        'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON tenant_maintenance_requests FROM %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE tenant_maintenance_requests_id_seq TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;

COMMIT;

SELECT
  to_regclass('public.tenant_maintenance_portal_links') IS NOT NULL
    AS tenant_maintenance_portals_ready,
  to_regclass('public.tenant_maintenance_requests') IS NOT NULL
    AS tenant_maintenance_requests_ready,
  to_regclass('public.idx_tenant_maintenance_requests_contract_status') IS NOT NULL
    AS tenant_maintenance_contract_index_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='tenant_maintenance_requests_portal_fk'
  ) AS tenant_maintenance_portal_fk_ready,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime_sql') THEN
    has_table_privilege('tro_bill_runtime_sql', 'tenant_maintenance_portal_links', 'SELECT')
    AND has_table_privilege('tro_bill_runtime_sql', 'tenant_maintenance_requests', 'INSERT')
    AND has_column_privilege(
      'tro_bill_runtime_sql', 'tenant_maintenance_portal_links', 'revoked_at', 'UPDATE'
    )
    AND NOT has_table_privilege(
      'tro_bill_runtime_sql', 'tenant_maintenance_requests', 'DELETE'
    )
  ELSE TRUE END AS tenant_maintenance_runtime_ready,
  NOT EXISTS (
    SELECT 1 FROM tenant_maintenance_requests request
    LEFT JOIN tenant_maintenance_portal_links link
      ON link.user_id=request.user_id
     AND link.contract_id=request.contract_id
     AND link.id=request.portal_link_id
    WHERE link.id IS NULL
  ) AS tenant_maintenance_ownership_ready;
