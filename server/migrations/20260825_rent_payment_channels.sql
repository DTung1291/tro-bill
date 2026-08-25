BEGIN;

-- Mỗi chủ trọ sở hữu một kênh SePay độc lập. API key chỉ được lưu dưới dạng
-- SHA-256 vì key ngẫu nhiên có entropy cao và chỉ cần dùng để xác minh webhook.
CREATE TABLE IF NOT EXISTS rent_payment_channels (
  id                      BIGSERIAL PRIMARY KEY,
  user_id                 BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider                TEXT NOT NULL DEFAULT 'sepay',
  public_id               UUID NOT NULL,
  secret_hash             TEXT NOT NULL,
  secret_last4            TEXT NOT NULL,
  expected_account_number TEXT NOT NULL,
  status                  TEXT NOT NULL DEFAULT 'active',
  last_received_at        TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rent_payment_channels_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT rent_payment_channels_user_provider_unique UNIQUE (user_id, provider),
  CONSTRAINT rent_payment_channels_public_id_unique UNIQUE (public_id),
  CONSTRAINT rent_payment_channels_provider_valid CHECK (provider IN ('sepay')),
  CONSTRAINT rent_payment_channels_status_valid CHECK (status IN ('active', 'disabled')),
  CONSTRAINT rent_payment_channels_secret_hash_valid CHECK (secret_hash ~ '^[a-f0-9]{64}$'),
  CONSTRAINT rent_payment_channels_secret_last4_valid CHECK (secret_last4 ~ '^[A-Za-z0-9_-]{4}$'),
  CONSTRAINT rent_payment_channels_account_valid CHECK (expected_account_number ~ '^[0-9]{4,30}$')
);

CREATE INDEX IF NOT EXISTS idx_rent_payment_channels_user
  ON rent_payment_channels(user_id, provider);

-- Payload thô và API key không được lưu. Chỉ giữ các trường đã chuẩn hóa cần
-- cho đối soát, ghép hóa đơn và điều tra giao dịch trùng ở các bước sau.
CREATE TABLE IF NOT EXISTS rent_bank_transactions (
  id                      BIGSERIAL PRIMARY KEY,
  user_id                 BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  channel_id              BIGINT NOT NULL,
  provider                TEXT NOT NULL DEFAULT 'sepay',
  provider_transaction_id TEXT NOT NULL,
  gateway                 TEXT NOT NULL DEFAULT '',
  account_number          TEXT NOT NULL,
  transfer_type           TEXT NOT NULL,
  amount_vnd              NUMERIC(12, 0) NOT NULL,
  transaction_content     TEXT NOT NULL DEFAULT '',
  transaction_code        TEXT NOT NULL DEFAULT '',
  provider_reference      TEXT NOT NULL DEFAULT '',
  occurred_at             TIMESTAMPTZ NOT NULL,
  received_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  match_status            TEXT NOT NULL DEFAULT 'pending',
  matched_invoice_id      BIGINT,
  matched_at              TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rent_bank_transactions_channel_owner_fk
    FOREIGN KEY (user_id, channel_id)
    REFERENCES rent_payment_channels(user_id, id) ON DELETE CASCADE,
  CONSTRAINT rent_bank_transactions_invoice_owner_fk
    FOREIGN KEY (user_id, matched_invoice_id)
    REFERENCES rent_invoices(user_id, id) ON DELETE RESTRICT,
  CONSTRAINT rent_bank_transactions_provider_id_unique
    UNIQUE (channel_id, provider_transaction_id),
  CONSTRAINT rent_bank_transactions_provider_valid CHECK (provider IN ('sepay')),
  CONSTRAINT rent_bank_transactions_transfer_type_valid CHECK (transfer_type='in'),
  CONSTRAINT rent_bank_transactions_amount_positive CHECK (amount_vnd > 0),
  CONSTRAINT rent_bank_transactions_account_valid CHECK (account_number ~ '^[0-9]{4,30}$'),
  CONSTRAINT rent_bank_transactions_match_status_valid
    CHECK (match_status IN ('pending', 'matched', 'ignored')),
  CONSTRAINT rent_bank_transactions_match_consistent CHECK (
    (match_status='matched' AND matched_invoice_id IS NOT NULL AND matched_at IS NOT NULL)
    OR (match_status<>'matched' AND matched_invoice_id IS NULL AND matched_at IS NULL)
  ),
  CONSTRAINT rent_bank_transactions_lengths_valid CHECK (
    char_length(provider_transaction_id) BETWEEN 1 AND 128
    AND char_length(gateway) <= 100
    AND char_length(transaction_content) <= 500
    AND char_length(transaction_code) <= 200
    AND char_length(provider_reference) <= 255
  )
);

CREATE INDEX IF NOT EXISTS idx_rent_bank_transactions_pending
  ON rent_bank_transactions(user_id, match_status, occurred_at DESC, id DESC);

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime') THEN
    EXECUTE 'REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON rent_payment_channels FROM tro_bill_runtime';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON rent_payment_channels TO tro_bill_runtime';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE rent_payment_channels_id_seq TO tro_bill_runtime';

    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rent_bank_transactions FROM tro_bill_runtime';
    EXECUTE 'GRANT SELECT, INSERT ON rent_bank_transactions TO tro_bill_runtime';
    EXECUTE 'GRANT UPDATE (match_status, matched_invoice_id, matched_at, updated_at) ON rent_bank_transactions TO tro_bill_runtime';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE rent_bank_transactions_id_seq TO tro_bill_runtime';
  END IF;
END $$;

COMMIT;

SELECT
  to_regclass('public.rent_payment_channels') IS NOT NULL AS channels_ready,
  to_regclass('public.rent_bank_transactions') IS NOT NULL AS transactions_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_bank_transactions_provider_id_unique'
  ) AS replay_protection_ready,
  has_table_privilege('tro_bill_runtime', 'rent_payment_channels', 'SELECT,INSERT,UPDATE')
    AS channels_runtime_ready,
  has_table_privilege('tro_bill_runtime', 'rent_bank_transactions', 'SELECT,INSERT')
    AND NOT has_table_privilege('tro_bill_runtime', 'rent_bank_transactions', 'DELETE')
    AS transactions_runtime_ready;
