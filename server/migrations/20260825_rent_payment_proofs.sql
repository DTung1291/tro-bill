BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_invoice_share_links_user_invoice_id_unique'
  ) THEN
    ALTER TABLE rent_invoice_share_links
      ADD CONSTRAINT rent_invoice_share_links_user_invoice_id_unique
      UNIQUE (user_id, invoice_id, id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS rent_payment_proofs (
  id            BIGSERIAL PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_id    BIGINT NOT NULL,
  share_link_id BIGINT NOT NULL UNIQUE,
  mime_type     TEXT NOT NULL DEFAULT 'image/jpeg',
  image_data    BYTEA NOT NULL,
  byte_size     INTEGER NOT NULL,
  sha256        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'pending',
  submitted_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rent_payment_proofs_invoice_owner_fk
    FOREIGN KEY (user_id, invoice_id)
    REFERENCES rent_invoices(user_id, id) ON DELETE CASCADE,
  CONSTRAINT rent_payment_proofs_link_owner_fk
    FOREIGN KEY (user_id, invoice_id, share_link_id)
    REFERENCES rent_invoice_share_links(user_id, invoice_id, id) ON DELETE CASCADE,
  CONSTRAINT rent_payment_proofs_mime_type_valid CHECK (mime_type='image/jpeg'),
  CONSTRAINT rent_payment_proofs_byte_size_valid CHECK (
    byte_size BETWEEN 100 AND 196608 AND octet_length(image_data)=byte_size
  ),
  CONSTRAINT rent_payment_proofs_sha256_valid CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT rent_payment_proofs_status_valid CHECK (status IN ('pending', 'accepted', 'rejected'))
);

CREATE INDEX IF NOT EXISTS idx_rent_payment_proofs_invoice
  ON rent_payment_proofs(user_id, invoice_id, submitted_at DESC, id DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime') THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rent_payment_proofs FROM tro_bill_runtime';
    EXECUTE 'GRANT SELECT, INSERT ON rent_payment_proofs TO tro_bill_runtime';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE rent_payment_proofs_id_seq TO tro_bill_runtime';
  END IF;
END $$;

COMMIT;

SELECT
  to_regclass('public.rent_payment_proofs') IS NOT NULL AS payment_proofs_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_payment_proofs_link_owner_fk'
  ) AS link_owner_fk_ready,
  has_table_privilege(
    'tro_bill_runtime', 'rent_payment_proofs', 'SELECT,INSERT'
  ) AS runtime_select_insert_ready,
  NOT has_table_privilege(
    'tro_bill_runtime', 'rent_payment_proofs', 'DELETE'
  ) AS runtime_delete_blocked;
