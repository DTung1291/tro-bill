BEGIN;

CREATE TABLE IF NOT EXISTS rent_invoice_share_links (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_id     BIGINT NOT NULL,
  token_hash     TEXT NOT NULL UNIQUE,
  token_last4    TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  view_count     BIGINT NOT NULL DEFAULT 0,
  last_viewed_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rent_invoice_share_links_invoice_owner_fk
    FOREIGN KEY (user_id, invoice_id)
    REFERENCES rent_invoices(user_id, id) ON DELETE CASCADE,
  CONSTRAINT rent_invoice_share_links_token_hash_valid
    CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT rent_invoice_share_links_token_last4_valid
    CHECK (token_last4 ~ '^[A-Za-z0-9_-]{4}$'),
  CONSTRAINT rent_invoice_share_links_expiry_valid CHECK (expires_at > created_at),
  CONSTRAINT rent_invoice_share_links_revocation_valid
    CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CONSTRAINT rent_invoice_share_links_view_count_valid CHECK (view_count >= 0)
);

CREATE INDEX IF NOT EXISTS idx_rent_invoice_share_links_invoice
  ON rent_invoice_share_links(user_id, invoice_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS idx_rent_invoice_share_links_active
  ON rent_invoice_share_links(token_hash, expires_at)
  WHERE revoked_at IS NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime') THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rent_invoice_share_links FROM tro_bill_runtime';
    EXECUTE 'GRANT SELECT, INSERT ON rent_invoice_share_links TO tro_bill_runtime';
    EXECUTE 'GRANT UPDATE (revoked_at, view_count, last_viewed_at) ON rent_invoice_share_links TO tro_bill_runtime';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE rent_invoice_share_links_id_seq TO tro_bill_runtime';
  END IF;
END $$;

COMMIT;

SELECT
  to_regclass('public.rent_invoice_share_links') IS NOT NULL AS share_links_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_invoice_share_links_invoice_owner_fk'
  ) AS ownership_ready,
  has_table_privilege(
    'tro_bill_runtime', 'rent_invoice_share_links', 'SELECT,INSERT'
  ) AND NOT has_table_privilege(
    'tro_bill_runtime', 'rent_invoice_share_links', 'DELETE'
  ) AS runtime_base_privileges_ready,
  has_column_privilege(
    'tro_bill_runtime', 'rent_invoice_share_links', 'revoked_at', 'UPDATE'
  ) AS runtime_revoke_ready;
