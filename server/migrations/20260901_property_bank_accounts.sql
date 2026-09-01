BEGIN;

-- Danh mục tài khoản nhận tiền thuộc chủ trọ. Một tài khoản có thể được nhiều
-- khu dùng chung; khu để NULL sẽ kế thừa tài khoản mặc định của chủ trọ.
CREATE TABLE IF NOT EXISTS rent_bank_accounts (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  label          TEXT NOT NULL,
  bank_id        TEXT NOT NULL,
  account_number TEXT NOT NULL,
  owner_name     TEXT NOT NULL,
  is_default     BOOLEAN NOT NULL DEFAULT false,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rent_bank_accounts_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT rent_bank_accounts_identity_unique UNIQUE (user_id, bank_id, account_number),
  CONSTRAINT rent_bank_accounts_content_valid CHECK (
    char_length(label) BETWEEN 1 AND 100
    AND bank_id ~ '^[A-Z0-9]{2,20}$'
    AND account_number ~ '^[0-9]{4,30}$'
    AND char_length(owner_name) BETWEEN 2 AND 100
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rent_bank_accounts_one_default
  ON rent_bank_accounts(user_id) WHERE is_default;
CREATE INDEX IF NOT EXISTS idx_rent_bank_accounts_user
  ON rent_bank_accounts(user_id, is_default DESC, id);

-- Cấu hình VietQR cũ trở thành tài khoản mặc định. Không tạo dòng từ cấu hình
-- thiếu/sai để tránh hợp thức hóa dữ liệu không thể tạo QR.
INSERT INTO rent_bank_accounts
  (user_id, label, bank_id, account_number, owner_name, is_default)
SELECT user_id, 'Tài khoản mặc định', upper(trim(bank_id)),
       regexp_replace(bank_account, '[^0-9]', '', 'g'),
       upper(trim(bank_owner_name)), true
FROM settings
WHERE upper(trim(bank_id)) ~ '^[A-Z0-9]{2,20}$'
  AND regexp_replace(bank_account, '[^0-9]', '', 'g') ~ '^[0-9]{4,30}$'
  AND char_length(trim(bank_owner_name)) BETWEEN 2 AND 100
  AND NOT EXISTS (
    SELECT 1 FROM rent_bank_accounts account
    WHERE account.user_id=settings.user_id AND account.is_default
  )
ON CONFLICT DO NOTHING;

ALTER TABLE properties ADD COLUMN IF NOT EXISTS rent_bank_account_id BIGINT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='properties_rent_bank_account_owner_fk'
  ) THEN
    ALTER TABLE properties ADD CONSTRAINT properties_rent_bank_account_owner_fk
      FOREIGN KEY (user_id, rent_bank_account_id)
      REFERENCES rent_bank_accounts(user_id, id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_properties_rent_bank_account
  ON properties(user_id, rent_bank_account_id)
  WHERE rent_bank_account_id IS NOT NULL;

ALTER TABLE rent_payment_channels ADD COLUMN IF NOT EXISTS bank_account_id BIGINT;
UPDATE rent_payment_channels channel
SET bank_account_id=account.id
FROM rent_bank_accounts account
WHERE channel.bank_account_id IS NULL
  AND account.user_id=channel.user_id
  AND account.is_default
  AND account.account_number=channel.expected_account_number;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_payment_channels_bank_account_owner_fk'
  ) THEN
    ALTER TABLE rent_payment_channels
      ADD CONSTRAINT rent_payment_channels_bank_account_owner_fk
      FOREIGN KEY (user_id, bank_account_id)
      REFERENCES rent_bank_accounts(user_id, id) ON DELETE RESTRICT;
  END IF;
END $$;
ALTER TABLE rent_payment_channels
  DROP CONSTRAINT IF EXISTS rent_payment_channels_user_provider_unique;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rent_payment_channels_legacy_provider
  ON rent_payment_channels(user_id, provider)
  WHERE bank_account_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rent_payment_channels_account_provider
  ON rent_payment_channels(user_id, provider, bank_account_id)
  WHERE bank_account_id IS NOT NULL;

ALTER TABLE rent_bank_transactions ADD COLUMN IF NOT EXISTS bank_account_id BIGINT;
UPDATE rent_bank_transactions bank_transaction
SET bank_account_id=channel.bank_account_id
FROM rent_payment_channels channel
WHERE bank_transaction.bank_account_id IS NULL
  AND channel.user_id=bank_transaction.user_id
  AND channel.id=bank_transaction.channel_id
  AND channel.bank_account_id IS NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_bank_transactions_bank_account_owner_fk'
  ) THEN
    ALTER TABLE rent_bank_transactions
      ADD CONSTRAINT rent_bank_transactions_bank_account_owner_fk
      FOREIGN KEY (user_id, bank_account_id)
      REFERENCES rent_bank_accounts(user_id, id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_rent_bank_transactions_account
  ON rent_bank_transactions(user_id, bank_account_id, occurred_at DESC, id DESC)
  WHERE bank_account_id IS NOT NULL;

DO $$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'tro_bill_runtime', 'tro_bill_runtime_sql', 'tro_bill_app'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON rent_bank_accounts TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE rent_bank_accounts_id_seq TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE ON rent_payment_channels TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT SELECT, INSERT ON rent_bank_transactions TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;

COMMIT;

SELECT
  to_regclass('public.rent_bank_accounts') IS NOT NULL
    AS bank_accounts_table_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='properties_rent_bank_account_owner_fk'
  ) AS property_bank_account_owner_ready,
  NOT EXISTS (
    SELECT 1 FROM settings setting
    WHERE upper(trim(setting.bank_id)) ~ '^[A-Z0-9]{2,20}$'
      AND regexp_replace(setting.bank_account, '[^0-9]', '', 'g') ~ '^[0-9]{4,30}$'
      AND char_length(trim(setting.bank_owner_name)) BETWEEN 2 AND 100
      AND NOT EXISTS (
        SELECT 1 FROM rent_bank_accounts account
        WHERE account.user_id=setting.user_id AND account.is_default
      )
  ) AS legacy_default_backfill_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_payment_channels_bank_account_owner_fk'
  )
  AND to_regclass('public.idx_rent_payment_channels_account_provider') IS NOT NULL
    AS payment_channel_account_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_bank_transactions_bank_account_owner_fk'
  ) AS bank_transaction_account_ready,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime_sql') THEN
    has_table_privilege('tro_bill_runtime_sql', 'rent_bank_accounts', 'SELECT')
    AND has_table_privilege('tro_bill_runtime_sql', 'rent_bank_accounts', 'INSERT')
    AND has_table_privilege('tro_bill_runtime_sql', 'rent_bank_accounts', 'UPDATE')
    AND has_table_privilege('tro_bill_runtime_sql', 'rent_bank_accounts', 'DELETE')
  ELSE TRUE END AS bank_account_runtime_ready,
  NOT EXISTS (
    SELECT 1 FROM properties property
    LEFT JOIN rent_bank_accounts account
      ON account.user_id=property.user_id AND account.id=property.rent_bank_account_id
    WHERE property.rent_bank_account_id IS NOT NULL AND account.id IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM rent_payment_channels channel
    LEFT JOIN rent_bank_accounts account
      ON account.user_id=channel.user_id AND account.id=channel.bank_account_id
    WHERE channel.bank_account_id IS NOT NULL AND account.id IS NULL
  ) AS bank_account_ownership_ready;
