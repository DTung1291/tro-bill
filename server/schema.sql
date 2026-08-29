-- ============================================================
--  TrọBill — schema chuẩn hóa cho Neon Postgres
--  Chạy: npm run init-db  (hoặc dán vào Neon SQL Editor)
-- ============================================================

-- Người dùng (chủ trọ)
CREATE TABLE IF NOT EXISTS users (
  id            BIGSERIAL PRIMARY KEY,
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  is_admin      BOOLEAN NOT NULL DEFAULT false,
  email_verified_at TIMESTAMPTZ,
  token_version INTEGER NOT NULL DEFAULT 0,
  privacy_policy_version TEXT NOT NULL DEFAULT '',
  privacy_accepted_at TIMESTAMPTZ,
  terms_version TEXT NOT NULL DEFAULT '',
  terms_accepted_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Bổ sung cột cho DB đã tạo trước đó (idempotent)
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_policy_version TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS privacy_accepted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_version TEXT NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS terms_accepted_at TIMESTAMPTZ;

-- Khi nâng cấp DB cũ, các tài khoản đã tồn tại được xem là đã xác minh để
-- không khóa người dùng đang hoạt động. DB mới đã có cột ngay từ CREATE TABLE.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'users'
      AND column_name = 'email_verified_at'
  ) THEN
    ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;
    UPDATE users SET email_verified_at = COALESCE(created_at, now());
  END IF;
END $$;

-- Chỉ lưu SHA-256 của token; liên kết email chứa token gốc và hết hạn sau 24h.
CREATE TABLE IF NOT EXISTS email_verification_tokens (
  user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_email_verification_expires
  ON email_verification_tokens(expires_at);

-- Token đặt lại mật khẩu có hiệu lực 30 phút. Chỉ lưu SHA-256 của token
-- để liên kết gốc không thể bị khôi phục nếu database bị lộ.
CREATE TABLE IF NOT EXISTS password_reset_tokens (
  user_id    BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_password_reset_expires
  ON password_reset_tokens(expires_at);

-- Bộ đếm chống brute-force/spam đăng ký. key_hash là HMAC của IP/email nên
-- không lưu trực tiếp định danh người dùng trong bảng này.
CREATE TABLE IF NOT EXISTS auth_rate_limits (
  key_hash          TEXT PRIMARY KEY,
  action            TEXT NOT NULL,
  scope             TEXT NOT NULL,
  attempts          INTEGER NOT NULL DEFAULT 0,
  window_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_rate_limits_updated
  ON auth_rate_limits(updated_at);

-- Cài đặt: mỗi user đúng 1 dòng
CREATE TABLE IF NOT EXISTS settings (
  user_id               BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  deduction             NUMERIC  NOT NULL DEFAULT 450000,
  bank_id               TEXT     NOT NULL DEFAULT '',
  bank_account          TEXT     NOT NULL DEFAULT '',
  bank_owner_name       TEXT     NOT NULL DEFAULT '',
  bank_transfer_pattern TEXT     NOT NULL DEFAULT '',
  reminder_enabled      BOOLEAN  NOT NULL DEFAULT false,
  reminder_day          INTEGER  NOT NULL DEFAULT 30,
  reminder_time         TEXT     NOT NULL DEFAULT '20:00',
  invoice_reminder_enabled     BOOLEAN   NOT NULL DEFAULT false,
  invoice_reminder_before_days INTEGER[] NOT NULL DEFAULT ARRAY[3,1],
  invoice_reminder_after_days  INTEGER[] NOT NULL DEFAULT ARRAY[1,3,7],
  theme                 TEXT     NOT NULL DEFAULT 'system'
);
ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS invoice_reminder_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS invoice_reminder_before_days INTEGER[] NOT NULL DEFAULT ARRAY[3,1];
ALTER TABLE settings
  ADD COLUMN IF NOT EXISTS invoice_reminder_after_days INTEGER[] NOT NULL DEFAULT ARRAY[1,3,7];
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='settings_invoice_reminder_before_valid'
  ) THEN
    ALTER TABLE settings ADD CONSTRAINT settings_invoice_reminder_before_valid CHECK (
      cardinality(invoice_reminder_before_days) <= 6
      AND invoice_reminder_before_days <@ ARRAY[1,2,3,5,7,14]
    );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='settings_invoice_reminder_after_valid'
  ) THEN
    ALTER TABLE settings ADD CONSTRAINT settings_invoice_reminder_after_valid CHECK (
      cardinality(invoice_reminder_after_days) <= 7
      AND invoice_reminder_after_days <@ ARRAY[1,2,3,5,7,14,30]
    );
  END IF;
END $$;

-- Cấu hình toàn cục của app (do admin thiết lập). Chỉ 1 dòng (id=1).
-- Thông tin ủng hộ nhà phát triển (VietQR) dùng chung cho mọi người dùng.
CREATE TABLE IF NOT EXISTS app_config (
  id                INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  donate_bank_id    TEXT NOT NULL DEFAULT '',
  donate_account    TEXT NOT NULL DEFAULT '',
  donate_owner_name TEXT NOT NULL DEFAULT '',
  donate_message    TEXT NOT NULL DEFAULT 'Ung ho',
  subscription_bank_id    TEXT NOT NULL DEFAULT '',
  subscription_account    TEXT NOT NULL DEFAULT '',
  subscription_owner_name TEXT NOT NULL DEFAULT ''
);
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS subscription_bank_id TEXT NOT NULL DEFAULT '';
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS subscription_account TEXT NOT NULL DEFAULT '';
ALTER TABLE app_config ADD COLUMN IF NOT EXISTS subscription_owner_name TEXT NOT NULL DEFAULT '';
INSERT INTO app_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- Danh mục gói dịch vụ của TrọBill. Giá dùng đơn vị VND và có thể để NULL
-- cho gói chưa chốt giá. Chỉ server/database quyết định giới hạn sử dụng;
-- client không được tự gán trạng thái Premium.
CREATE TABLE IF NOT EXISTS plans (
  id                BIGSERIAL PRIMARY KEY,
  code              TEXT NOT NULL UNIQUE,
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  monthly_price_vnd NUMERIC(12, 0),
  yearly_price_vnd  NUMERIC(12, 0),
  room_limit        INTEGER NOT NULL,
  staff_limit       INTEGER NOT NULL DEFAULT 0,
  trial_days        INTEGER NOT NULL DEFAULT 0,
  is_active         BOOLEAN NOT NULL DEFAULT false,
  is_public         BOOLEAN NOT NULL DEFAULT false,
  sort_order        INTEGER NOT NULL DEFAULT 0,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT plans_code_format
    CHECK (code ~ '^[a-z][a-z0-9_-]{1,31}$'),
  CONSTRAINT plans_monthly_price_nonnegative
    CHECK (monthly_price_vnd IS NULL OR monthly_price_vnd >= 0),
  CONSTRAINT plans_yearly_price_nonnegative
    CHECK (yearly_price_vnd IS NULL OR yearly_price_vnd >= 0),
  CONSTRAINT plans_room_limit_positive CHECK (room_limit > 0),
  CONSTRAINT plans_staff_limit_nonnegative CHECK (staff_limit >= 0),
  CONSTRAINT plans_trial_days_valid
    CHECK (trial_days = 0 OR trial_days BETWEEN 14 AND 30)
);
CREATE INDEX IF NOT EXISTS idx_plans_visibility_sort
  ON plans(is_active, is_public, sort_order);

-- DB cũ được thêm cấu hình trial đúng một lần. Những lần chạy schema sau không
-- ghi đè nếu admin chủ động đổi trial_days về 0 hoặc giá trị khác.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'plans'
      AND column_name = 'trial_days'
  ) THEN
    ALTER TABLE plans ADD COLUMN trial_days INTEGER NOT NULL DEFAULT 0;
    UPDATE plans
    SET trial_days = 14
    WHERE code IN ('standard', 'pro', 'business');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'plans_trial_days_valid'
      AND conrelid = 'public.plans'::regclass
  ) THEN
    ALTER TABLE plans ADD CONSTRAINT plans_trial_days_valid
      CHECK (trial_days = 0 OR trial_days BETWEEN 14 AND 30);
  END IF;
END $$;

-- Giai đoạn pilot chỉ mở Free. Các gói trả phí được tạo sẵn theo giới hạn đang
-- giả định trong checklist nhưng chưa mở bán và chưa có giá cho tới khi khảo sát.
-- DO NOTHING bảo vệ giá/giới hạn đã được admin chỉnh ở những lần chạy schema sau.
INSERT INTO plans
  (code, name, description, monthly_price_vnd, yearly_price_vnd, room_limit,
   staff_limit, trial_days, is_active, is_public, sort_order)
VALUES
  ('free', 'Free', 'Dùng thử TrọBill với tối đa 10 phòng', 0, 0, 10, 0, 0, true, true, 10),
  ('standard', 'Standard', 'Quản lý tối đa 25 phòng', NULL, NULL, 25, 0, 14, false, false, 20),
  ('pro', 'Pro', 'Quản lý tối đa 50 phòng', NULL, NULL, 50, 0, 14, false, false, 30),
  ('business', 'Business', 'Quản lý tối đa 100 phòng và có nhân viên', NULL, NULL, 100, 1, 14, false, false, 40)
ON CONFLICT (code) DO NOTHING;

-- Mỗi tài khoản có đúng một subscription hiện tại. Lịch sử thanh toán và
-- webhook sẽ được lưu ở các bảng riêng, không dùng client để quyết định gói.
CREATE TABLE IF NOT EXISTS subscriptions (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  plan_id    BIGINT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  status     TEXT NOT NULL DEFAULT 'active',
  starts_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  ends_at    TIMESTAMPTZ,
  billing_cycle TEXT,
  trial_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT subscriptions_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT subscriptions_status_valid
    CHECK (status IN ('trialing', 'active', 'grace_period', 'expired', 'canceled')),
  CONSTRAINT subscriptions_date_order
    CHECK (ends_at IS NULL OR ends_at > starts_at),
  CONSTRAINT subscriptions_billing_cycle_valid
    CHECK (billing_cycle IS NULL OR billing_cycle IN ('monthly', 'yearly')),
  CONSTRAINT subscriptions_trial_fields_required
    CHECK (status <> 'trialing' OR (ends_at IS NOT NULL AND trial_used_at IS NOT NULL))
);
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS trial_used_at TIMESTAMPTZ;
ALTER TABLE subscriptions ADD COLUMN IF NOT EXISTS billing_cycle TEXT;
CREATE INDEX IF NOT EXISTS idx_subscriptions_status_ends
  ON subscriptions(status, ends_at);

-- DB đã tạo subscriptions từ phiên bản trước chưa có khóa duy nhất kép cần
-- cho ownership FK của payment. Bổ sung idempotent trước khi tạo bảng payment.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'subscriptions_user_id_id_unique'
      AND conrelid = 'public.subscriptions'::regclass
  ) THEN
    ALTER TABLE subscriptions
      ADD CONSTRAINT subscriptions_user_id_id_unique UNIQUE (user_id, id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'subscriptions_trial_fields_required'
      AND conrelid = 'public.subscriptions'::regclass
  ) THEN
    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_trial_fields_required
      CHECK (status <> 'trialing' OR (ends_at IS NOT NULL AND trial_used_at IS NOT NULL));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'subscriptions_billing_cycle_valid'
      AND conrelid = 'public.subscriptions'::regclass
  ) THEN
    ALTER TABLE subscriptions ADD CONSTRAINT subscriptions_billing_cycle_valid
      CHECK (billing_cycle IS NULL OR billing_cycle IN ('monthly', 'yearly'));
  END IF;
END $$;

-- Tài khoản cũ chưa có subscription được gắn Free mà không làm thay đổi những
-- tài khoản đã được cấp gói khác.
INSERT INTO subscriptions (user_id, plan_id, status, starts_at)
SELECT u.id, p.id, 'active', u.created_at
FROM users u
JOIN plans p ON p.code = 'free'
ON CONFLICT (user_id) DO NOTHING;

-- Mỗi lần thanh toán subscription là một dòng riêng. user_id đi cùng
-- subscription_id trong khóa ngoại kép để chặn gắn giao dịch sang tài khoản khác.
CREATE TABLE IF NOT EXISTS subscription_payments (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subscription_id    BIGINT NOT NULL,
  plan_id            BIGINT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
  amount_vnd         NUMERIC(12, 0) NOT NULL,
  currency           TEXT NOT NULL DEFAULT 'VND',
  billing_cycle      TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'pending',
  provider           TEXT NOT NULL DEFAULT 'manual',
  provider_reference TEXT,
  subscription_action TEXT,
  transfer_content    TEXT,
  bank_id_snapshot    TEXT,
  bank_account_snapshot TEXT,
  bank_owner_snapshot TEXT,
  settlement_provider TEXT,
  settlement_reference TEXT,
  expires_at          TIMESTAMPTZ,
  paid_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT subscription_payments_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT subscription_payments_owner_fk
    FOREIGN KEY (user_id, subscription_id)
    REFERENCES subscriptions(user_id, id) ON DELETE CASCADE,
  CONSTRAINT subscription_payments_amount_positive CHECK (amount_vnd > 0),
  CONSTRAINT subscription_payments_currency_vnd CHECK (currency = 'VND'),
  CONSTRAINT subscription_payments_cycle_valid CHECK (billing_cycle IN ('monthly', 'yearly')),
  CONSTRAINT subscription_payments_status_valid
    CHECK (status IN ('pending', 'paid', 'failed', 'refunded', 'canceled')),
  CONSTRAINT subscription_payments_provider_format
    CHECK (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  CONSTRAINT subscription_payments_action_valid
    CHECK (subscription_action IS NULL OR subscription_action IN ('upgrade', 'renew')),
  CONSTRAINT subscription_payments_transfer_format
    CHECK (transfer_content IS NULL OR transfer_content ~ '^[A-Z0-9]{6,25}$'),
  CONSTRAINT subscription_payments_expiry_order
    CHECK (expires_at IS NULL OR expires_at > created_at),
  CONSTRAINT subscription_payments_settlement_link_complete
    CHECK ((settlement_provider IS NULL) = (settlement_reference IS NULL)),
  CONSTRAINT subscription_payments_settlement_provider_format
    CHECK (settlement_provider IS NULL OR settlement_provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  CONSTRAINT subscription_payments_vietqr_fields_required
    CHECK (provider <> 'vietqr' OR (
      subscription_action IS NOT NULL AND transfer_content IS NOT NULL
      AND NULLIF(bank_id_snapshot, '') IS NOT NULL
      AND NULLIF(bank_account_snapshot, '') IS NOT NULL
      AND NULLIF(bank_owner_snapshot, '') IS NOT NULL
      AND expires_at IS NOT NULL
    )),
  CONSTRAINT subscription_payments_paid_at_required
    CHECK (status <> 'paid' OR paid_at IS NOT NULL)
);
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS subscription_action TEXT;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS transfer_content TEXT;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS bank_id_snapshot TEXT;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS bank_account_snapshot TEXT;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS bank_owner_snapshot TEXT;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS settlement_provider TEXT;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS settlement_reference TEXT;
ALTER TABLE subscription_payments ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;
CREATE INDEX IF NOT EXISTS idx_subscription_payments_user_created
  ON subscription_payments(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscription_payments_status_created
  ON subscription_payments(status, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_payments_provider_reference
  ON subscription_payments(provider, provider_reference)
  WHERE provider_reference IS NOT NULL AND provider_reference <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_payments_transfer_content
  ON subscription_payments(transfer_content)
  WHERE transfer_content IS NOT NULL AND transfer_content <> '';
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_payments_settlement_reference
  ON subscription_payments(settlement_provider, settlement_reference)
  WHERE settlement_provider IS NOT NULL AND settlement_reference IS NOT NULL;

-- Yêu cầu hoàn tiền/thanh toán nhầm chỉ là workflow hỗ trợ và đối soát.
-- TrọBill không tự động chuyển tiền; admin phải xác nhận mã giao dịch hoàn tiền.
-- DB cũ phải có khóa duy nhất kép trước khi tạo ownership FK bên dưới.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'subscription_payments_user_id_id_unique'
      AND conrelid = 'public.subscription_payments'::regclass
  ) THEN
    ALTER TABLE subscription_payments
      ADD CONSTRAINT subscription_payments_user_id_id_unique UNIQUE (user_id, id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS subscription_refund_requests (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  payment_id            BIGINT NOT NULL,
  request_type          TEXT NOT NULL,
  requested_amount_vnd  NUMERIC(12, 0) NOT NULL,
  reason                TEXT NOT NULL,
  status                TEXT NOT NULL DEFAULT 'pending',
  admin_user_id         BIGINT REFERENCES users(id) ON DELETE SET NULL,
  admin_email_snapshot  TEXT NOT NULL DEFAULT '',
  admin_note            TEXT,
  refund_reference      TEXT,
  reviewed_at           TIMESTAMPTZ,
  resolved_at           TIMESTAMPTZ,
  refunded_at           TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT subscription_refund_payment_owner_fk
    FOREIGN KEY (user_id, payment_id)
    REFERENCES subscription_payments(user_id, id) ON DELETE CASCADE,
  CONSTRAINT subscription_refund_type_valid
    CHECK (request_type IN ('refund', 'mistaken_transfer')),
  CONSTRAINT subscription_refund_amount_positive
    CHECK (requested_amount_vnd > 0),
  CONSTRAINT subscription_refund_reason_length
    CHECK (char_length(reason) BETWEEN 10 AND 500),
  CONSTRAINT subscription_refund_status_valid
    CHECK (status IN ('pending', 'reviewing', 'approved', 'rejected', 'refunded', 'canceled')),
  CONSTRAINT subscription_refund_admin_note_length
    CHECK (admin_note IS NULL OR char_length(admin_note) BETWEEN 10 AND 500),
  CONSTRAINT subscription_refund_reference_length
    CHECK (refund_reference IS NULL OR char_length(refund_reference) BETWEEN 3 AND 100),
  CONSTRAINT subscription_refund_resolution_required
    CHECK (status NOT IN ('rejected', 'refunded', 'canceled') OR resolved_at IS NOT NULL),
  CONSTRAINT subscription_refund_completion_required
    CHECK (status <> 'refunded' OR (refunded_at IS NOT NULL AND refund_reference IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_subscription_refund_user_created
  ON subscription_refund_requests(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscription_refund_status_created
  ON subscription_refund_requests(status, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_refund_one_active_per_payment
  ON subscription_refund_requests(user_id, payment_id)
  WHERE status IN ('pending', 'reviewing', 'approved');
CREATE UNIQUE INDEX IF NOT EXISTS idx_subscription_refund_one_completed_per_payment
  ON subscription_refund_requests(user_id, payment_id)
  WHERE status = 'refunded';
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tro_bill_runtime') THEN
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON subscription_refund_requests TO tro_bill_runtime';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE subscription_refund_requests_id_seq TO tro_bill_runtime';
  END IF;
END $$;

-- DB đã có subscription_payments cần khóa kép để payment_events không thể
-- liên kết một payment sang user khác.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'subscription_payments_user_id_id_unique'
      AND conrelid = 'public.subscription_payments'::regclass
  ) THEN
    ALTER TABLE subscription_payments
      ADD CONSTRAINT subscription_payments_user_id_id_unique UNIQUE (user_id, id);
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'subscription_payments_action_valid'
      AND conrelid = 'public.subscription_payments'::regclass
  ) THEN
    ALTER TABLE subscription_payments ADD CONSTRAINT subscription_payments_action_valid
      CHECK (subscription_action IS NULL OR subscription_action IN ('upgrade', 'renew'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'subscription_payments_transfer_format'
      AND conrelid = 'public.subscription_payments'::regclass
  ) THEN
    ALTER TABLE subscription_payments ADD CONSTRAINT subscription_payments_transfer_format
      CHECK (transfer_content IS NULL OR transfer_content ~ '^[A-Z0-9]{6,25}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'subscription_payments_expiry_order'
      AND conrelid = 'public.subscription_payments'::regclass
  ) THEN
    ALTER TABLE subscription_payments ADD CONSTRAINT subscription_payments_expiry_order
      CHECK (expires_at IS NULL OR expires_at > created_at);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'subscription_payments_settlement_link_complete'
      AND conrelid = 'public.subscription_payments'::regclass
  ) THEN
    ALTER TABLE subscription_payments ADD CONSTRAINT subscription_payments_settlement_link_complete
      CHECK ((settlement_provider IS NULL) = (settlement_reference IS NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'subscription_payments_settlement_provider_format'
      AND conrelid = 'public.subscription_payments'::regclass
  ) THEN
    ALTER TABLE subscription_payments ADD CONSTRAINT subscription_payments_settlement_provider_format
      CHECK (settlement_provider IS NULL OR settlement_provider ~ '^[a-z][a-z0-9_-]{1,31}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'subscription_payments_vietqr_fields_required'
      AND conrelid = 'public.subscription_payments'::regclass
  ) THEN
    ALTER TABLE subscription_payments ADD CONSTRAINT subscription_payments_vietqr_fields_required
      CHECK (provider <> 'vietqr' OR (
        subscription_action IS NOT NULL AND transfer_content IS NOT NULL
        AND NULLIF(bank_id_snapshot, '') IS NOT NULL
        AND NULLIF(bank_account_snapshot, '') IS NOT NULL
        AND NULLIF(bank_owner_snapshot, '') IS NOT NULL
        AND expires_at IS NOT NULL
      ));
  END IF;
END $$;

-- Nhật ký webhook thanh toán. Cặp provider/event_id chống xử lý trùng; payload
-- hash giúp đối chiếu dữ liệu nhận được mà không dựa vào trạng thái phía client.
CREATE TABLE IF NOT EXISTS payment_events (
  id                    BIGSERIAL PRIMARY KEY,
  provider              TEXT NOT NULL,
  event_id              TEXT NOT NULL,
  event_type            TEXT NOT NULL,
  user_id               BIGINT,
  payment_id            BIGINT,
  payload               JSONB NOT NULL DEFAULT '{}'::jsonb,
  payload_sha256        TEXT NOT NULL,
  signature_valid       BOOLEAN NOT NULL DEFAULT false,
  status                TEXT NOT NULL DEFAULT 'received',
  attempt_count         INTEGER NOT NULL DEFAULT 0,
  error_code            TEXT,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  processing_started_at TIMESTAMPTZ,
  processed_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT payment_events_provider_event_unique UNIQUE (provider, event_id),
  CONSTRAINT payment_events_payment_owner_fk
    FOREIGN KEY (user_id, payment_id)
    REFERENCES subscription_payments(user_id, id) ON DELETE SET NULL,
  CONSTRAINT payment_events_payment_link_complete
    CHECK ((user_id IS NULL) = (payment_id IS NULL)),
  CONSTRAINT payment_events_provider_format
    CHECK (provider ~ '^[a-z][a-z0-9_-]{1,31}$'),
  CONSTRAINT payment_events_event_id_length
    CHECK (char_length(event_id) BETWEEN 1 AND 255),
  CONSTRAINT payment_events_event_type_length
    CHECK (char_length(event_type) BETWEEN 1 AND 100),
  CONSTRAINT payment_events_payload_hash_format
    CHECK (payload_sha256 ~ '^[a-f0-9]{64}$'),
  CONSTRAINT payment_events_status_valid
    CHECK (status IN ('received', 'processing', 'processed', 'failed', 'ignored')),
  CONSTRAINT payment_events_attempt_nonnegative CHECK (attempt_count >= 0),
  CONSTRAINT payment_events_processed_at_required
    CHECK (status <> 'processed' OR processed_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_payment_events_status_received
  ON payment_events(status, received_at);
CREATE INDEX IF NOT EXISTS idx_payment_events_user_received
  ON payment_events(user_id, received_at DESC)
  WHERE user_id IS NOT NULL;

-- Mọi thay đổi vòng đời subscription do admin hoặc webhook đều có audit riêng.
CREATE TABLE IF NOT EXISTS subscription_change_logs (
  id                      BIGSERIAL PRIMARY KEY,
  actor_user_id           BIGINT REFERENCES users(id) ON DELETE SET NULL,
  actor_email_snapshot    TEXT NOT NULL DEFAULT '',
  target_user_id          BIGINT REFERENCES users(id) ON DELETE SET NULL,
  target_email_snapshot   TEXT NOT NULL DEFAULT '',
  action                  TEXT NOT NULL,
  previous_plan_code      TEXT,
  new_plan_code           TEXT,
  previous_status         TEXT,
  new_status              TEXT,
  reason                  TEXT NOT NULL,
  metadata                JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT subscription_change_action_format
    CHECK (action ~ '^[a-z][a-z0-9_]{2,63}$'),
  CONSTRAINT subscription_change_reason_length
    CHECK (char_length(reason) BETWEEN 10 AND 500)
);
CREATE INDEX IF NOT EXISTS idx_subscription_change_target_created
  ON subscription_change_logs(target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_subscription_change_action_created
  ON subscription_change_logs(action, created_at DESC);

-- Hàng đợi email nhắc hết hạn. Khóa duy nhất theo subscription, mốc nhắc và
-- ngày hết hạn giúp cron chạy lặp vẫn không gửi trùng; ngày hết hạn mới sẽ tạo
-- một chuỗi nhắc mới sau khi gia hạn.
CREATE TABLE IF NOT EXISTS subscription_notifications (
  id                       BIGSERIAL PRIMARY KEY,
  user_id                  BIGINT NOT NULL,
  subscription_id          BIGINT NOT NULL,
  notification_type        TEXT NOT NULL,
  scheduled_for            DATE NOT NULL,
  recipient_email_snapshot TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'sending',
  attempt_count            INTEGER NOT NULL DEFAULT 1,
  provider_message_id      TEXT,
  last_error_code          TEXT,
  sent_at                  TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT subscription_notifications_owner_fk
    FOREIGN KEY (user_id, subscription_id)
    REFERENCES subscriptions(user_id, id) ON DELETE CASCADE,
  CONSTRAINT subscription_notifications_unique
    UNIQUE (subscription_id, notification_type, scheduled_for),
  CONSTRAINT subscription_notifications_type_valid
    CHECK (notification_type IN ('expiry_7d', 'expiry_3d', 'expiry_1d')),
  CONSTRAINT subscription_notifications_status_valid
    CHECK (status IN ('sending', 'sent', 'failed')),
  CONSTRAINT subscription_notifications_attempt_positive CHECK (attempt_count > 0),
  CONSTRAINT subscription_notifications_sent_at_required
    CHECK (status <> 'sent' OR sent_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_subscription_notifications_status_updated
  ON subscription_notifications(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_subscription_notifications_user_created
  ON subscription_notifications(user_id, created_at DESC);

-- Phòng — id giữ nguyên uuid do client sinh (TEXT)
CREATE TABLE IF NOT EXISTS rooms (
  id            TEXT PRIMARY KEY,
  user_id       BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name          TEXT    NOT NULL DEFAULT 'Phòng không tên',
  rent_start_date TEXT  NOT NULL DEFAULT '',
  rent_price    NUMERIC NOT NULL DEFAULT 0,
  electric_rate NUMERIC NOT NULL DEFAULT 3200,
  water_rate    NUMERIC NOT NULL DEFAULT 50000,
  water_type    TEXT    NOT NULL DEFAULT 'người',
  people_count  NUMERIC NOT NULL DEFAULT 1,
  trash_fee     NUMERIC NOT NULL DEFAULT 50000,
  wifi_fee      NUMERIC NOT NULL DEFAULT 0,
  manage_fee    NUMERIC NOT NULL DEFAULT 0,
  electric_prev NUMERIC NOT NULL DEFAULT 0,
  water_prev    NUMERIC NOT NULL DEFAULT 0,
  notes         TEXT    NOT NULL DEFAULT '',
  sort_order    INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE rooms ADD COLUMN IF NOT EXISTS rent_start_date TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS idx_rooms_user ON rooms(user_id);

-- Lịch sử biểu phí của phòng. Mỗi dòng bắt đầu có hiệu lực từ một tháng
-- (YYYY-MM) và tiếp tục được dùng cho tới mốc thay đổi kế tiếp.
CREATE TABLE IF NOT EXISTS room_rate_history (
  user_id        BIGINT  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id        TEXT    NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  effective_from TEXT    NOT NULL,
  rent_price     NUMERIC NOT NULL DEFAULT 0,
  electric_rate  NUMERIC NOT NULL DEFAULT 3200,
  water_rate     NUMERIC NOT NULL DEFAULT 50000,
  trash_fee      NUMERIC NOT NULL DEFAULT 50000,
  wifi_fee       NUMERIC NOT NULL DEFAULT 0,
  manage_fee     NUMERIC NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, room_id, effective_from)
);
CREATE INDEX IF NOT EXISTS idx_room_rates_user_room_period
  ON room_rate_history(user_id, room_id, effective_from);

-- Dữ liệu cũ chỉ có một biểu phí trong rooms: tạo mốc nền để các hóa đơn cũ
-- vẫn dùng đúng cấu hình hiện có sau khi nâng cấp schema.
INSERT INTO room_rate_history
  (user_id, room_id, effective_from, rent_price, electric_rate, water_rate,
   trash_fee, wifi_fee, manage_fee)
SELECT
  r.user_id, r.id, '1970-01', r.rent_price, r.electric_rate, r.water_rate,
  r.trash_fee, r.wifi_fee, r.manage_fee
FROM rooms r
WHERE NOT EXISTS (
  SELECT 1 FROM room_rate_history rr WHERE rr.room_id = r.id
);

-- Người thuê — thuộc về 1 phòng
CREATE TABLE IF NOT EXISTS tenants (
  id         TEXT PRIMARY KEY,
  room_id    TEXT   NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  full_name  TEXT NOT NULL DEFAULT '',
  phone      TEXT NOT NULL DEFAULT '',
  email      TEXT NOT NULL DEFAULT '',
  cccd       TEXT NOT NULL DEFAULT '',
  issue_date TEXT NOT NULL DEFAULT '',
  dob        TEXT NOT NULL DEFAULT '',
  gender     TEXT NOT NULL DEFAULT 'Nam',
  address    TEXT NOT NULL DEFAULT '',
  data_notice_version TEXT NOT NULL DEFAULT '',
  data_notice_acknowledged_at TIMESTAMPTZ,
  sort_order INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT tenants_email_valid CHECK (
    email = '' OR (
      char_length(email) <= 254
      AND email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
    )
  )
);
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS email TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS data_notice_version TEXT NOT NULL DEFAULT '';
ALTER TABLE tenants ADD COLUMN IF NOT EXISTS data_notice_acknowledged_at TIMESTAMPTZ;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='tenants_email_valid'
  ) THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_email_valid CHECK (
      email = '' OR (
        char_length(email) <= 254
        AND email ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
      )
    );
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_tenants_room ON tenants(room_id);
CREATE INDEX IF NOT EXISTS idx_tenants_user ON tenants(user_id);

-- Hợp đồng giữ snapshot phòng/khách để không mất hồ sơ lịch sử khi autosave
-- thay thế lại rooms/tenants. Không FK trực tiếp tới hai bảng snapshot này;
-- mọi API vẫn khóa quyền sở hữu bằng user_id trước khi ghi.
CREATE TABLE IF NOT EXISTS rental_contracts (
  id                    BIGSERIAL PRIMARY KEY,
  user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contract_code         TEXT NOT NULL,
  room_id               TEXT NOT NULL,
  room_name_snapshot    TEXT NOT NULL,
  tenant_id             TEXT NOT NULL,
  tenant_name_snapshot  TEXT NOT NULL,
  tenant_phone_snapshot TEXT NOT NULL DEFAULT '',
  tenant_cccd_snapshot  TEXT NOT NULL DEFAULT '',
  tenant_issue_date_snapshot TEXT NOT NULL DEFAULT '',
  tenant_dob_snapshot   TEXT NOT NULL DEFAULT '',
  tenant_gender_snapshot TEXT NOT NULL DEFAULT '',
  tenant_address_snapshot TEXT NOT NULL DEFAULT '',
  status                TEXT NOT NULL DEFAULT 'draft',
  starts_on             DATE NOT NULL,
  ends_on               DATE,
  billing_cycle_months  SMALLINT NOT NULL DEFAULT 1,
  payment_due_day       SMALLINT NOT NULL DEFAULT 5,
  monthly_rent_vnd      BIGINT NOT NULL,
  deposit_vnd           BIGINT NOT NULL DEFAULT 0,
  terms                 TEXT NOT NULL DEFAULT '',
  status_reason         TEXT NOT NULL DEFAULT '',
  activated_at          TIMESTAMPTZ,
  ended_at              TIMESTAMPTZ,
  cancelled_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rental_contracts_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT rental_contracts_code_unique UNIQUE (user_id, contract_code),
  CONSTRAINT rental_contracts_code_valid
    CHECK (contract_code ~ '^HD-[0-9]{4}-[A-Z0-9]{6}$'),
  CONSTRAINT rental_contracts_status_valid
    CHECK (status IN ('draft','active','ended','cancelled')),
  CONSTRAINT rental_contracts_dates_valid CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT rental_contracts_payment_schedule_valid CHECK (
    billing_cycle_months IN (1, 3, 6, 12)
    AND payment_due_day BETWEEN 1 AND 28
  ),
  CONSTRAINT rental_contracts_amounts_valid CHECK (
    monthly_rent_vnd BETWEEN 0 AND 999999999999
    AND deposit_vnd BETWEEN 0 AND 999999999999
  ),
  CONSTRAINT rental_contracts_snapshot_valid CHECK (
    room_id <> '' AND char_length(room_id) <= 200
    AND tenant_id <> '' AND char_length(tenant_id) <= 200
    AND room_name_snapshot <> '' AND char_length(room_name_snapshot) <= 200
    AND tenant_name_snapshot <> '' AND char_length(tenant_name_snapshot) <= 200
    AND char_length(terms) <= 5000
    AND char_length(status_reason) <= 500
  ),
  CONSTRAINT rental_contracts_status_time_valid CHECK (
    (status='draft' AND activated_at IS NULL AND ended_at IS NULL AND cancelled_at IS NULL)
    OR (status='active' AND activated_at IS NOT NULL AND ended_at IS NULL AND cancelled_at IS NULL)
    OR (status='ended' AND activated_at IS NOT NULL AND ended_at IS NOT NULL AND cancelled_at IS NULL)
    OR (status='cancelled' AND cancelled_at IS NOT NULL AND ended_at IS NULL)
  )
);
ALTER TABLE rental_contracts
  ADD COLUMN IF NOT EXISTS tenant_phone_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE rental_contracts
  ADD COLUMN IF NOT EXISTS tenant_cccd_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE rental_contracts
  ADD COLUMN IF NOT EXISTS tenant_issue_date_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE rental_contracts
  ADD COLUMN IF NOT EXISTS tenant_dob_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE rental_contracts
  ADD COLUMN IF NOT EXISTS tenant_gender_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE rental_contracts
  ADD COLUMN IF NOT EXISTS tenant_address_snapshot TEXT NOT NULL DEFAULT '';
ALTER TABLE rental_contracts
  ADD COLUMN IF NOT EXISTS billing_cycle_months SMALLINT NOT NULL DEFAULT 1;
ALTER TABLE rental_contracts
  ADD COLUMN IF NOT EXISTS payment_due_day SMALLINT NOT NULL DEFAULT 5;
UPDATE rental_contracts contract
SET tenant_phone_snapshot=CASE
      WHEN contract.tenant_phone_snapshot='' THEN tenant.phone ELSE contract.tenant_phone_snapshot END,
    tenant_cccd_snapshot=CASE
      WHEN contract.tenant_cccd_snapshot='' THEN tenant.cccd ELSE contract.tenant_cccd_snapshot END,
    tenant_issue_date_snapshot=CASE
      WHEN contract.tenant_issue_date_snapshot='' THEN tenant.issue_date ELSE contract.tenant_issue_date_snapshot END,
    tenant_dob_snapshot=CASE
      WHEN contract.tenant_dob_snapshot='' THEN tenant.dob ELSE contract.tenant_dob_snapshot END,
    tenant_gender_snapshot=CASE
      WHEN contract.tenant_gender_snapshot='' THEN tenant.gender ELSE contract.tenant_gender_snapshot END,
    tenant_address_snapshot=CASE
      WHEN contract.tenant_address_snapshot='' THEN tenant.address ELSE contract.tenant_address_snapshot END
FROM tenants tenant
WHERE tenant.user_id=contract.user_id AND tenant.id=contract.tenant_id;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rental_contracts_tenant_document_snapshot_valid'
  ) THEN
    ALTER TABLE rental_contracts
      ADD CONSTRAINT rental_contracts_tenant_document_snapshot_valid CHECK (
        char_length(tenant_phone_snapshot) <= 50
        AND char_length(tenant_cccd_snapshot) <= 50
        AND char_length(tenant_issue_date_snapshot) <= 20
        AND char_length(tenant_dob_snapshot) <= 20
        AND char_length(tenant_gender_snapshot) <= 20
        AND char_length(tenant_address_snapshot) <= 1000
      );
  END IF;
END $$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rental_contracts_payment_schedule_valid'
  ) THEN
    ALTER TABLE rental_contracts
      ADD CONSTRAINT rental_contracts_payment_schedule_valid CHECK (
        billing_cycle_months IN (1, 3, 6, 12)
        AND payment_due_day BETWEEN 1 AND 28
      );
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rental_contracts_one_active_room
  ON rental_contracts(user_id, room_id) WHERE status='active';
CREATE INDEX IF NOT EXISTS idx_rental_contracts_user_room
  ON rental_contracts(user_id, room_id, created_at DESC);

-- Phụ lục thay đổi giá là append-only. Mỗi phụ lục đồng thời tạo đúng một mốc
-- room_rate_history để công thức hóa đơn tiếp tục dùng một nguồn giá duy nhất.
CREATE TABLE IF NOT EXISTS rental_contract_amendments (
  id                         BIGSERIAL PRIMARY KEY,
  user_id                    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contract_id                BIGINT NOT NULL,
  amendment_code             TEXT NOT NULL,
  effective_from             TEXT NOT NULL,
  previous_monthly_rent_vnd  BIGINT NOT NULL,
  new_monthly_rent_vnd       BIGINT NOT NULL,
  reason                     TEXT NOT NULL,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rental_contract_amendments_contract_owner_fk
    FOREIGN KEY (user_id, contract_id)
    REFERENCES rental_contracts(user_id, id) ON DELETE CASCADE,
  CONSTRAINT rental_contract_amendments_period_unique
    UNIQUE (user_id, contract_id, effective_from),
  CONSTRAINT rental_contract_amendments_code_unique UNIQUE (user_id, amendment_code),
  CONSTRAINT rental_contract_amendments_code_valid
    CHECK (amendment_code ~ '^PL-[0-9]{6}-[A-Z0-9]{6}$'),
  CONSTRAINT rental_contract_amendments_period_valid
    CHECK (effective_from ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT rental_contract_amendments_amounts_valid CHECK (
    previous_monthly_rent_vnd BETWEEN 0 AND 999999999999
    AND new_monthly_rent_vnd BETWEEN 0 AND 999999999999
    AND previous_monthly_rent_vnd <> new_monthly_rent_vnd
  ),
  CONSTRAINT rental_contract_amendments_reason_valid
    CHECK (char_length(reason) BETWEEN 10 AND 500)
);
CREATE INDEX IF NOT EXISTS idx_rental_contract_amendments_contract
  ON rental_contract_amendments(user_id, contract_id, effective_from, id);

DO $$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['tro_bill_runtime', 'tro_bill_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format(
        'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rental_contracts FROM %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT SELECT, INSERT ON rental_contracts TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT UPDATE (status, status_reason, activated_at, ended_at, cancelled_at, updated_at) ON rental_contracts TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE rental_contracts_id_seq TO %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rental_contract_amendments FROM %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT SELECT, INSERT ON rental_contract_amendments TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE rental_contract_amendments_id_seq TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;

-- Email nhắc chủ trọ khi hợp đồng đang hoạt động còn 30/14/7/3/1 ngày.
-- Khóa duy nhất theo hợp đồng, mốc nhắc và ngày kết thúc chống gửi trùng; nếu
-- sau này có hợp đồng mới hoặc ngày kết thúc mới thì một chuỗi nhắc mới được tạo.
CREATE TABLE IF NOT EXISTS rental_contract_notifications (
  id                       BIGSERIAL PRIMARY KEY,
  user_id                  BIGINT NOT NULL,
  contract_id              BIGINT NOT NULL,
  notification_type        TEXT NOT NULL,
  scheduled_for            DATE NOT NULL,
  recipient_email_snapshot TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'sending',
  attempt_count            INTEGER NOT NULL DEFAULT 1,
  provider_message_id      TEXT,
  last_error_code          TEXT,
  sent_at                  TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rental_contract_notifications_owner_fk
    FOREIGN KEY (user_id, contract_id)
    REFERENCES rental_contracts(user_id, id) ON DELETE CASCADE,
  CONSTRAINT rental_contract_notifications_unique
    UNIQUE (contract_id, notification_type, scheduled_for),
  CONSTRAINT rental_contract_notifications_type_valid
    CHECK (notification_type IN ('expiry_30d','expiry_14d','expiry_7d','expiry_3d','expiry_1d')),
  CONSTRAINT rental_contract_notifications_status_valid
    CHECK (status IN ('sending','sent','failed')),
  CONSTRAINT rental_contract_notifications_attempt_positive CHECK (attempt_count > 0),
  CONSTRAINT rental_contract_notifications_email_valid
    CHECK (char_length(recipient_email_snapshot) BETWEEN 3 AND 254),
  CONSTRAINT rental_contract_notifications_error_code_valid
    CHECK (last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{3,64}$'),
  CONSTRAINT rental_contract_notifications_sent_at_required
    CHECK (status <> 'sent' OR sent_at IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_rental_contract_notifications_status_updated
  ON rental_contract_notifications(status, updated_at);
CREATE INDEX IF NOT EXISTS idx_rental_contract_notifications_user_created
  ON rental_contract_notifications(user_id, created_at DESC);

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
        'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rental_contract_notifications FROM %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT SELECT, INSERT ON rental_contract_notifications TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT UPDATE (status, recipient_email_snapshot, attempt_count, provider_message_id, last_error_code, sent_at, updated_at) ON rental_contract_notifications TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE rental_contract_notifications_id_seq TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;

-- Biên bản nhận/trả phòng là snapshot bất biến. Số dư cọc chỉ được chụp từ
-- tenant_deposit_transactions; bảng này không tạo một nguồn số dư mới.
CREATE TABLE IF NOT EXISTS rental_handover_records (
  id                           BIGSERIAL PRIMARY KEY,
  user_id                      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  contract_id                  BIGINT NOT NULL,
  handover_code                TEXT NOT NULL,
  handover_type                TEXT NOT NULL,
  occurred_on                  DATE NOT NULL,
  contract_code_snapshot       TEXT NOT NULL,
  room_id_snapshot             TEXT NOT NULL,
  room_name_snapshot           TEXT NOT NULL,
  tenant_id_snapshot           TEXT NOT NULL,
  tenant_name_snapshot         TEXT NOT NULL,
  lessor_name_snapshot         TEXT NOT NULL,
  property_address_snapshot    TEXT NOT NULL,
  deposit_account_id           BIGINT,
  expected_deposit_vnd         BIGINT NOT NULL DEFAULT 0,
  deposit_balance_snapshot_vnd BIGINT NOT NULL DEFAULT 0,
  electricity_reading          NUMERIC(15, 3),
  water_reading                NUMERIC(15, 3),
  key_count                    SMALLINT NOT NULL DEFAULT 0,
  general_condition            TEXT NOT NULL,
  notes                        TEXT NOT NULL DEFAULT '',
  confirmed_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rental_handover_records_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT rental_handover_records_contract_owner_fk
    FOREIGN KEY (user_id, contract_id)
    REFERENCES rental_contracts(user_id, id) ON DELETE CASCADE,
  CONSTRAINT rental_handover_records_type_unique UNIQUE (user_id, contract_id, handover_type),
  CONSTRAINT rental_handover_records_code_unique UNIQUE (user_id, handover_code),
  CONSTRAINT rental_handover_records_code_valid
    CHECK (handover_code ~ '^BBBG-[0-9]{4}-(IN|OUT)-[A-Z0-9]{6}$'),
  CONSTRAINT rental_handover_records_type_valid
    CHECK (handover_type IN ('check_in', 'check_out')),
  CONSTRAINT rental_handover_records_amounts_valid CHECK (
    expected_deposit_vnd BETWEEN 0 AND 999999999999
    AND deposit_balance_snapshot_vnd BETWEEN 0 AND 999999999999
  ),
  CONSTRAINT rental_handover_records_readings_valid CHECK (
    (electricity_reading IS NULL OR electricity_reading BETWEEN 0 AND 999999999999)
    AND (water_reading IS NULL OR water_reading BETWEEN 0 AND 999999999999)
  ),
  CONSTRAINT rental_handover_records_content_valid CHECK (
    char_length(contract_code_snapshot) BETWEEN 1 AND 50
    AND char_length(room_id_snapshot) BETWEEN 1 AND 200
    AND char_length(room_name_snapshot) BETWEEN 1 AND 200
    AND char_length(tenant_id_snapshot) BETWEEN 1 AND 200
    AND char_length(tenant_name_snapshot) BETWEEN 1 AND 200
    AND char_length(lessor_name_snapshot) BETWEEN 1 AND 200
    AND char_length(property_address_snapshot) BETWEEN 1 AND 1000
    AND key_count BETWEEN 0 AND 1000
    AND char_length(general_condition) BETWEEN 3 AND 2000
    AND char_length(notes) <= 3000
  )
);
CREATE INDEX IF NOT EXISTS idx_rental_handover_records_contract
  ON rental_handover_records(user_id, contract_id, occurred_on, id);

CREATE TABLE IF NOT EXISTS rental_handover_items (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  handover_id    BIGINT NOT NULL,
  item_order     SMALLINT NOT NULL,
  item_name      TEXT NOT NULL,
  quantity       NUMERIC(10, 2) NOT NULL,
  unit           TEXT NOT NULL DEFAULT 'cái',
  item_condition TEXT NOT NULL,
  note           TEXT NOT NULL DEFAULT '',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rental_handover_items_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT rental_handover_items_record_owner_fk
    FOREIGN KEY (user_id, handover_id)
    REFERENCES rental_handover_records(user_id, id) ON DELETE CASCADE,
  CONSTRAINT rental_handover_items_order_unique UNIQUE (user_id, handover_id, item_order),
  CONSTRAINT rental_handover_items_content_valid CHECK (
    item_order BETWEEN 1 AND 50
    AND char_length(item_name) BETWEEN 1 AND 200
    AND quantity > 0 AND quantity <= 99999999
    AND char_length(unit) BETWEEN 1 AND 50
    AND char_length(item_condition) BETWEEN 1 AND 500
    AND char_length(note) <= 500
  )
);
CREATE INDEX IF NOT EXISTS idx_rental_handover_items_record
  ON rental_handover_items(user_id, handover_id, item_order, id);

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
        'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rental_handover_records FROM %I',
        runtime_role
      );
      EXECUTE format('GRANT SELECT, INSERT ON rental_handover_records TO %I', runtime_role);
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE rental_handover_records_id_seq TO %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rental_handover_items FROM %I',
        runtime_role
      );
      EXECUTE format('GRANT SELECT, INSERT ON rental_handover_items TO %I', runtime_role);
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE rental_handover_items_id_seq TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;

-- Số điện/nước nhập theo tháng cho từng phòng
-- electric_new / water_new / water_units: NULL = chưa nhập ('' phía client)
CREATE TABLE IF NOT EXISTS billing_entries (
  user_id               BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period                TEXT   NOT NULL,           -- 'YYYY-MM'
  room_id               TEXT   NOT NULL REFERENCES rooms(id) ON DELETE CASCADE,
  electric_new          NUMERIC,
  water_units           NUMERIC,
  water_new             NUMERIC,
  electric_old_override NUMERIC,
  water_old_override    NUMERIC,
  note                  TEXT,
  utility_only          BOOLEAN NOT NULL DEFAULT false,
  discount_amount       NUMERIC(12, 0) NOT NULL DEFAULT 0,
  surcharge_amount      NUMERIC(12, 0) NOT NULL DEFAULT 0,
  late_fee_amount       NUMERIC(12, 0) NOT NULL DEFAULT 0,
  paid                  BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, period, room_id)
);
ALTER TABLE billing_entries ADD COLUMN IF NOT EXISTS utility_only BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE billing_entries ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12, 0) NOT NULL DEFAULT 0;
ALTER TABLE billing_entries ADD COLUMN IF NOT EXISTS surcharge_amount NUMERIC(12, 0) NOT NULL DEFAULT 0;
ALTER TABLE billing_entries ADD COLUMN IF NOT EXISTS late_fee_amount NUMERIC(12, 0) NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='billing_entries_adjustments_nonnegative'
  ) THEN
    ALTER TABLE billing_entries
      ADD CONSTRAINT billing_entries_adjustments_nonnegative
      CHECK (discount_amount >= 0 AND surcharge_amount >= 0 AND late_fee_amount >= 0);
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_billing_user_period ON billing_entries(user_id, period);

-- Chi phí chủ trọ đã thanh toán thực tế theo tháng (tách khỏi hóa đơn khách)
CREATE TABLE IF NOT EXISTS expense_entries (
  id        TEXT PRIMARY KEY,
  user_id   BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period    TEXT NOT NULL,
  category  TEXT NOT NULL DEFAULT 'other',
  name      TEXT NOT NULL DEFAULT '',
  amount    NUMERIC NOT NULL DEFAULT 0,
  paid_date TEXT NOT NULL DEFAULT '',
  note      TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_expenses_user_period ON expense_entries(user_id, period);

-- Ảnh chụp tháng đã lưu (snapshot) + các bill trong đó
CREATE TABLE IF NOT EXISTS history_snapshots (
  id         BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  period     TEXT    NOT NULL,
  deduction  NUMERIC NOT NULL DEFAULT 450000,
  created_at BIGINT  NOT NULL,                     -- timestamp ms (giữ đúng client)
  UNIQUE (user_id, period)
);
CREATE INDEX IF NOT EXISTS idx_history_user ON history_snapshots(user_id);

CREATE TABLE IF NOT EXISTS history_bills (
  id           BIGSERIAL PRIMARY KEY,
  snapshot_id  BIGINT NOT NULL REFERENCES history_snapshots(id) ON DELETE CASCADE,
  room_id      TEXT,
  room_name    TEXT,
  rent_price   NUMERIC DEFAULT 0,
  rent_base_price NUMERIC DEFAULT 0,
  rent_days INTEGER,
  rent_days_in_month INTEGER,
  rent_prorated BOOLEAN NOT NULL DEFAULT false,
  rent_starts_after_period BOOLEAN NOT NULL DEFAULT false,
  electric_old NUMERIC DEFAULT 0,
  electric_new NUMERIC,                            -- NULL = chưa nhập
  electric_rate NUMERIC DEFAULT 0,
  kwh          NUMERIC DEFAULT 0,
  electric_amt NUMERIC DEFAULT 0,
  water_type   TEXT DEFAULT 'người',
  water_rate   NUMERIC DEFAULT 0,
  water_units  NUMERIC DEFAULT 0,
  water_amt    NUMERIC DEFAULT 0,
  water_prev   NUMERIC,                            -- NULL nếu không phải khối
  water_new    NUMERIC,
  trash_fee    NUMERIC DEFAULT 0,
  wifi_fee     NUMERIC DEFAULT 0,
  manage_fee   NUMERIC DEFAULT 0,
  utility_only BOOLEAN NOT NULL DEFAULT false,
  discount_amount  NUMERIC(12, 0) NOT NULL DEFAULT 0,
  surcharge_amount NUMERIC(12, 0) NOT NULL DEFAULT 0,
  late_fee_amount  NUMERIC(12, 0) NOT NULL DEFAULT 0,
  total        NUMERIC DEFAULT 0,
  paid         BOOLEAN NOT NULL DEFAULT false,
  sort_order   INTEGER NOT NULL DEFAULT 0
);
ALTER TABLE history_bills ADD COLUMN IF NOT EXISTS utility_only BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE history_bills ADD COLUMN IF NOT EXISTS rent_base_price NUMERIC DEFAULT 0;
ALTER TABLE history_bills ADD COLUMN IF NOT EXISTS rent_days INTEGER;
ALTER TABLE history_bills ADD COLUMN IF NOT EXISTS rent_days_in_month INTEGER;
ALTER TABLE history_bills ADD COLUMN IF NOT EXISTS rent_prorated BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE history_bills ADD COLUMN IF NOT EXISTS rent_starts_after_period BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE history_bills ADD COLUMN IF NOT EXISTS discount_amount NUMERIC(12, 0) NOT NULL DEFAULT 0;
ALTER TABLE history_bills ADD COLUMN IF NOT EXISTS surcharge_amount NUMERIC(12, 0) NOT NULL DEFAULT 0;
ALTER TABLE history_bills ADD COLUMN IF NOT EXISTS late_fee_amount NUMERIC(12, 0) NOT NULL DEFAULT 0;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname='history_bills_adjustments_nonnegative'
  ) THEN
    ALTER TABLE history_bills
      ADD CONSTRAINT history_bills_adjustments_nonnegative
      CHECK (discount_amount >= 0 AND surcharge_amount >= 0 AND late_fee_amount >= 0);
  END IF;
END $$;
UPDATE history_bills
SET rent_base_price = rent_price
WHERE rent_base_price = 0 AND rent_price <> 0;
CREATE INDEX IF NOT EXISTS idx_history_bills_snapshot ON history_bills(snapshot_id);

-- Hóa đơn tiền trọ được định danh độc lập với bảng rooms vì putState hiện thay
-- toàn bộ danh sách phòng trong một transaction. Ảnh chụp này giữ được lịch sử
-- thu tiền kể cả khi phòng hoặc snapshot tháng đã bị xóa về sau.
CREATE TABLE IF NOT EXISTS rent_invoices (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id            TEXT NOT NULL,
  room_name_snapshot TEXT NOT NULL DEFAULT '',
  period             TEXT NOT NULL,
  issued_total_vnd   NUMERIC(12, 0) NOT NULL,
  detail_snapshot    JSONB NOT NULL DEFAULT '{}'::jsonb,
  issued_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rent_invoices_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT rent_invoices_room_period_unique UNIQUE (user_id, room_id, period),
  CONSTRAINT rent_invoices_period_format CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT rent_invoices_total_nonnegative CHECK (issued_total_vnd >= 0),
  CONSTRAINT rent_invoices_detail_snapshot_valid CHECK (
    jsonb_typeof(detail_snapshot)='object'
    AND octet_length(detail_snapshot::text) <= 8192
  ),
  CONSTRAINT rent_invoices_room_id_length CHECK (char_length(room_id) BETWEEN 1 AND 200)
);
ALTER TABLE rent_invoices
  ADD COLUMN IF NOT EXISTS detail_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_invoices_detail_snapshot_valid'
  ) THEN
    ALTER TABLE rent_invoices
      ADD CONSTRAINT rent_invoices_detail_snapshot_valid CHECK (
        jsonb_typeof(detail_snapshot)='object'
        AND octet_length(detail_snapshot::text) <= 8192
      );
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_rent_invoices_user_period
  ON rent_invoices(user_id, period DESC, room_id);

-- Token liên kết hóa đơn chỉ được lưu dưới dạng SHA-256. Dạng rõ chỉ trả một
-- lần cho chủ trọ và được đặt trong URL fragment để không lọt vào referrer.
CREATE TABLE IF NOT EXISTS rent_invoice_share_links (
  id             BIGSERIAL PRIMARY KEY,
  user_id        BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_id     BIGINT NOT NULL,
  tenancy_start_period TEXT NOT NULL,
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
  CONSTRAINT rent_invoice_share_links_user_invoice_id_unique
    UNIQUE (user_id, invoice_id, id),
  CONSTRAINT rent_invoice_share_links_tenancy_period_valid
    CHECK (tenancy_start_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
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

ALTER TABLE rent_invoice_share_links
  ADD COLUMN IF NOT EXISTS tenancy_start_period TEXT;
UPDATE rent_invoice_share_links link
SET tenancy_start_period=invoice.period
FROM rent_invoices invoice
WHERE invoice.user_id=link.user_id
  AND invoice.id=link.invoice_id
  AND link.tenancy_start_period IS NULL;
ALTER TABLE rent_invoice_share_links
  ALTER COLUMN tenancy_start_period SET NOT NULL;

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

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_invoice_share_links_tenancy_period_valid'
  ) THEN
    ALTER TABLE rent_invoice_share_links
      ADD CONSTRAINT rent_invoice_share_links_tenancy_period_valid
      CHECK (tenancy_start_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime') THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rent_invoice_share_links FROM tro_bill_runtime';
    EXECUTE 'GRANT SELECT, INSERT ON rent_invoice_share_links TO tro_bill_runtime';
    EXECUTE 'GRANT UPDATE (revoked_at, view_count, last_viewed_at) ON rent_invoice_share_links TO tro_bill_runtime';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE rent_invoice_share_links_id_seq TO tro_bill_runtime';
  END IF;
END $$;

-- Lịch gửi email hóa đơn. Mỗi lịch khóa theo user + hóa đơn + khách thuê;
-- worker claim bằng SKIP LOCKED để cron chạy lặp hoặc song song không gửi trùng.
CREATE TABLE IF NOT EXISTS rent_invoice_deliveries (
  id                       BIGSERIAL PRIMARY KEY,
  user_id                  BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_id               BIGINT NOT NULL,
  tenant_id                TEXT NOT NULL,
  channel                  TEXT NOT NULL DEFAULT 'email',
  template_type            TEXT NOT NULL DEFAULT 'invoice',
  scheduled_for            DATE NOT NULL,
  recipient_email_snapshot TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'scheduled',
  attempt_count            INTEGER NOT NULL DEFAULT 0,
  provider_message_id      TEXT,
  last_error_code          TEXT,
  trigger_source           TEXT NOT NULL DEFAULT 'manual',
  reminder_offset_days     INTEGER,
  sent_at                  TIMESTAMPTZ,
  cancelled_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rent_invoice_deliveries_invoice_owner_fk
    FOREIGN KEY (user_id, invoice_id)
    REFERENCES rent_invoices(user_id, id) ON DELETE CASCADE,
  CONSTRAINT rent_invoice_deliveries_unique
    UNIQUE (user_id, invoice_id, tenant_id, channel, template_type, scheduled_for),
  CONSTRAINT rent_invoice_deliveries_channel_valid CHECK (channel='email'),
  CONSTRAINT rent_invoice_deliveries_template_valid
    CHECK (template_type IN ('invoice','reminder')),
  CONSTRAINT rent_invoice_deliveries_status_valid
    CHECK (status IN ('scheduled','sending','sent','failed','skipped','cancelled')),
  CONSTRAINT rent_invoice_deliveries_attempt_valid CHECK (attempt_count BETWEEN 0 AND 5),
  CONSTRAINT rent_invoice_deliveries_email_valid CHECK (
    char_length(recipient_email_snapshot) <= 254
    AND recipient_email_snapshot ~* '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$'
  ),
  CONSTRAINT rent_invoice_deliveries_error_code_valid CHECK (
    last_error_code IS NULL OR last_error_code ~ '^[A-Z0-9_]{3,64}$'
  ),
  CONSTRAINT rent_invoice_deliveries_trigger_source_valid
    CHECK (trigger_source IN ('manual','automatic')),
  CONSTRAINT rent_invoice_deliveries_reminder_offset_valid CHECK (
    (trigger_source='manual' AND reminder_offset_days IS NULL)
    OR (
      trigger_source='automatic' AND template_type='reminder'
      AND reminder_offset_days BETWEEN -30 AND 14
      AND reminder_offset_days <> 0
    )
  ),
  CONSTRAINT rent_invoice_deliveries_sent_consistent CHECK (
    (status='sent' AND sent_at IS NOT NULL) OR (status<>'sent' AND sent_at IS NULL)
  ),
  CONSTRAINT rent_invoice_deliveries_cancel_consistent CHECK (
    (status='cancelled' AND cancelled_at IS NOT NULL)
    OR (status<>'cancelled' AND cancelled_at IS NULL)
  )
);
ALTER TABLE rent_invoice_deliveries
  ADD COLUMN IF NOT EXISTS trigger_source TEXT NOT NULL DEFAULT 'manual';
ALTER TABLE rent_invoice_deliveries
  ADD COLUMN IF NOT EXISTS reminder_offset_days INTEGER;
ALTER TABLE rent_invoice_deliveries
  DROP CONSTRAINT IF EXISTS rent_invoice_deliveries_tenant_id_fkey;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_invoice_deliveries_trigger_source_valid'
  ) THEN
    ALTER TABLE rent_invoice_deliveries
      ADD CONSTRAINT rent_invoice_deliveries_trigger_source_valid
      CHECK (trigger_source IN ('manual','automatic'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_invoice_deliveries_reminder_offset_valid'
  ) THEN
    ALTER TABLE rent_invoice_deliveries
      ADD CONSTRAINT rent_invoice_deliveries_reminder_offset_valid CHECK (
        (trigger_source='manual' AND reminder_offset_days IS NULL)
        OR (
          trigger_source='automatic' AND template_type='reminder'
          AND reminder_offset_days BETWEEN -30 AND 14
          AND reminder_offset_days <> 0
        )
      );
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS idx_rent_invoice_deliveries_due
  ON rent_invoice_deliveries(status, scheduled_for, updated_at, id);
CREATE INDEX IF NOT EXISTS idx_rent_invoice_deliveries_invoice
  ON rent_invoice_deliveries(user_id, invoice_id, scheduled_for DESC, id DESC);

DO $$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY['tro_bill_runtime', 'tro_bill_app'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format(
        'REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON rent_invoice_deliveries FROM %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE ON rent_invoice_deliveries TO %I',
        runtime_role
      );
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE rent_invoice_deliveries_id_seq TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;

-- Minh chứng chuyển khoản do khách gửi qua liên kết hóa đơn. Ảnh được client
-- tái mã hóa JPEG để bỏ EXIF, bị giới hạn dung lượng và không tự ghi nhận thu.
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

-- Ảnh khung chỉ số đã được client thu nhỏ/tái mã hóa JPEG. Không lưu ảnh gốc
-- hoặc EXIF; giới hạn chặt dung lượng để dùng an toàn trên Neon Free.
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

-- Mỗi lần chủ trọ nhận tiền tạo một phiếu thu. Một phiếu có thể phân bổ cho
-- nhiều hóa đơn của cùng phòng, từ nợ cũ nhất đến kỳ hiện tại.
CREATE TABLE IF NOT EXISTS rent_payment_receipts (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  room_id            TEXT NOT NULL,
  target_period      TEXT NOT NULL,
  receipt_code       TEXT NOT NULL,
  amount_vnd         NUMERIC(12, 0) NOT NULL,
  payment_method     TEXT NOT NULL DEFAULT 'manual',
  note               TEXT NOT NULL DEFAULT '',
  source             TEXT NOT NULL DEFAULT 'manual_current',
  idempotency_key    TEXT NOT NULL,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rent_payment_receipts_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT rent_payment_receipts_idempotency_unique UNIQUE (user_id, idempotency_key),
  CONSTRAINT rent_payment_receipts_code_unique UNIQUE (user_id, receipt_code),
  CONSTRAINT rent_payment_receipts_period_format
    CHECK (target_period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT rent_payment_receipts_amount_positive CHECK (amount_vnd > 0),
  CONSTRAINT rent_payment_receipts_room_id_length CHECK (char_length(room_id) BETWEEN 1 AND 200),
  CONSTRAINT rent_payment_receipts_method_format
    CHECK (payment_method ~ '^[a-z][a-z0-9_]{1,31}$'),
  CONSTRAINT rent_payment_receipts_source_format
    CHECK (source ~ '^[a-z][a-z0-9_]{2,63}$'),
  CONSTRAINT rent_payment_receipts_note_length CHECK (char_length(note) <= 500),
  CONSTRAINT rent_payment_receipts_idempotency_length
    CHECK (char_length(idempotency_key) BETWEEN 8 AND 300)
);
CREATE INDEX IF NOT EXISTS idx_rent_payment_receipts_room_period
  ON rent_payment_receipts(user_id, room_id, target_period DESC, occurred_at DESC);

-- Sổ giao dịch append-only. Hoàn tác tạo một dòng âm tham chiếu giao dịch gốc;
-- runtime role không được UPDATE/DELETE bảng này nên không thể xóa dấu vết.
CREATE TABLE IF NOT EXISTS rent_payment_transactions (
  id                      BIGSERIAL PRIMARY KEY,
  user_id                 BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  invoice_id              BIGINT NOT NULL,
  receipt_id              BIGINT,
  entry_type              TEXT NOT NULL,
  amount_vnd              NUMERIC(12, 0) NOT NULL,
  payment_method          TEXT NOT NULL DEFAULT 'manual',
  external_reference      TEXT,
  note                    TEXT NOT NULL DEFAULT '',
  source                  TEXT NOT NULL DEFAULT 'manual_full',
  idempotency_key         TEXT,
  reverses_transaction_id BIGINT,
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rent_payment_transactions_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT rent_payment_transactions_invoice_owner_fk
    FOREIGN KEY (user_id, invoice_id)
    REFERENCES rent_invoices(user_id, id) ON DELETE CASCADE,
  CONSTRAINT rent_payment_transactions_receipt_owner_fk
    FOREIGN KEY (user_id, receipt_id)
    REFERENCES rent_payment_receipts(user_id, id) ON DELETE RESTRICT,
  CONSTRAINT rent_payment_transactions_reversal_owner_fk
    FOREIGN KEY (user_id, reverses_transaction_id)
    REFERENCES rent_payment_transactions(user_id, id) ON DELETE RESTRICT,
  CONSTRAINT rent_payment_transactions_type_valid
    CHECK (entry_type IN ('payment', 'reversal', 'adjustment')),
  CONSTRAINT rent_payment_transactions_amount_valid CHECK (
    (entry_type = 'payment' AND amount_vnd > 0)
    OR (entry_type = 'reversal' AND amount_vnd < 0)
    OR (entry_type = 'adjustment' AND amount_vnd <> 0)
  ),
  CONSTRAINT rent_payment_transactions_method_format
    CHECK (payment_method ~ '^[a-z][a-z0-9_]{1,31}$'),
  CONSTRAINT rent_payment_transactions_source_format
    CHECK (source ~ '^[a-z][a-z0-9_]{2,63}$'),
  CONSTRAINT rent_payment_transactions_note_length CHECK (char_length(note) <= 500),
  CONSTRAINT rent_payment_transactions_reference_length
    CHECK (external_reference IS NULL OR char_length(external_reference) BETWEEN 1 AND 200),
  CONSTRAINT rent_payment_transactions_idempotency_length
    CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 300),
  CONSTRAINT rent_payment_transactions_reversal_target CHECK (
    (entry_type = 'reversal' AND reverses_transaction_id IS NOT NULL)
    OR (entry_type <> 'reversal' AND reverses_transaction_id IS NULL)
  )
);
ALTER TABLE rent_payment_transactions
  ADD COLUMN IF NOT EXISTS receipt_id BIGINT;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_payment_transactions_receipt_owner_fk'
  ) THEN
    ALTER TABLE rent_payment_transactions
      ADD CONSTRAINT rent_payment_transactions_receipt_owner_fk
      FOREIGN KEY (user_id, receipt_id)
      REFERENCES rent_payment_receipts(user_id, id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rent_payment_idempotency
  ON rent_payment_transactions(user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_rent_payment_one_reversal
  ON rent_payment_transactions(user_id, reverses_transaction_id)
  WHERE reverses_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_rent_payment_invoice_occurred
  ON rent_payment_transactions(user_id, invoice_id, occurred_at DESC, id DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_rent_payment_receipt_invoice
  ON rent_payment_transactions(user_id, receipt_id, invoice_id)
  WHERE receipt_id IS NOT NULL;

-- Chuyển các snapshot cũ sang hóa đơn và một giao dịch đủ tiền. Cả hai câu
-- lệnh đều idempotent để schema có thể chạy lại an toàn.
INSERT INTO rent_invoices
  (user_id, room_id, room_name_snapshot, period, issued_total_vnd, issued_at)
SELECT hs.user_id, hb.room_id, COALESCE(hb.room_name, ''), hs.period,
       GREATEST(0, ROUND(COALESCE(hb.total, 0))),
       to_timestamp(GREATEST(0, hs.created_at) / 1000.0)
FROM history_bills hb
JOIN history_snapshots hs ON hs.id=hb.snapshot_id
WHERE hb.room_id IS NOT NULL AND hb.room_id <> ''
ON CONFLICT (user_id, room_id, period) DO NOTHING;

INSERT INTO rent_payment_transactions
  (user_id, invoice_id, entry_type, amount_vnd, payment_method, note, source,
   idempotency_key, occurred_at)
SELECT ri.user_id, ri.id, 'payment', ri.issued_total_vnd, 'manual',
       'Chuyển từ trạng thái đã thu của dữ liệu cũ', 'legacy_paid',
       'legacy:' || ri.period || ':' || ri.room_id, ri.issued_at
FROM rent_invoices ri
JOIN history_snapshots hs
  ON hs.user_id=ri.user_id AND hs.period=ri.period
JOIN history_bills hb
  ON hb.snapshot_id=hs.id AND hb.room_id=ri.room_id
WHERE hb.paid=true AND ri.issued_total_vnd > 0
ON CONFLICT (user_id, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tro_bill_runtime') THEN
    -- Role runtime được tạo trực tiếp bằng SQL để không kế thừa neon_superuser.
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON rent_invoices TO tro_bill_runtime';
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rent_payment_receipts FROM tro_bill_runtime';
    EXECUTE 'GRANT SELECT, INSERT ON rent_payment_receipts TO tro_bill_runtime';
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rent_payment_transactions FROM tro_bill_runtime';
    EXECUTE 'GRANT SELECT, INSERT ON rent_payment_transactions TO tro_bill_runtime';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE rent_invoices_id_seq TO tro_bill_runtime';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE rent_payment_receipts_id_seq TO tro_bill_runtime';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE rent_payment_transactions_id_seq TO tro_bill_runtime';
  END IF;
END $$;

-- Kênh webhook nhận giao dịch tiền trọ riêng cho từng chủ trọ. API key có
-- entropy cao chỉ được lưu dưới dạng SHA-256 và chỉ trả dạng rõ đúng một lần.
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

-- Chỉ giữ payload đã chuẩn hóa cần cho đối soát; không lưu API key hay payload
-- thô. UNIQUE theo giao dịch nhà cung cấp chống replay và retry ghi trùng.
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
  match_reason            TEXT NOT NULL DEFAULT '',
  matched_invoice_id      BIGINT,
  matched_receipt_id      BIGINT,
  matched_at              TIMESTAMPTZ,
  review_note             TEXT NOT NULL DEFAULT '',
  reviewed_by_user_id     BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at             TIMESTAMPTZ,
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rent_bank_transactions_channel_owner_fk
    FOREIGN KEY (user_id, channel_id)
    REFERENCES rent_payment_channels(user_id, id) ON DELETE CASCADE,
  CONSTRAINT rent_bank_transactions_invoice_owner_fk
    FOREIGN KEY (user_id, matched_invoice_id)
    REFERENCES rent_invoices(user_id, id) ON DELETE RESTRICT,
  CONSTRAINT rent_bank_transactions_receipt_owner_fk
    FOREIGN KEY (user_id, matched_receipt_id)
    REFERENCES rent_payment_receipts(user_id, id) ON DELETE RESTRICT,
  CONSTRAINT rent_bank_transactions_provider_id_unique
    UNIQUE (channel_id, provider_transaction_id),
  CONSTRAINT rent_bank_transactions_provider_valid CHECK (provider IN ('sepay')),
  CONSTRAINT rent_bank_transactions_transfer_type_valid CHECK (transfer_type='in'),
  CONSTRAINT rent_bank_transactions_amount_positive CHECK (amount_vnd > 0),
  CONSTRAINT rent_bank_transactions_account_valid CHECK (account_number ~ '^[0-9]{4,30}$'),
  CONSTRAINT rent_bank_transactions_match_status_valid
    CHECK (match_status IN ('pending', 'matched', 'ignored')),
  CONSTRAINT rent_bank_transactions_match_consistent CHECK (
    (match_status='matched'
      AND matched_invoice_id IS NOT NULL
      AND matched_receipt_id IS NOT NULL
      AND matched_at IS NOT NULL)
    OR (match_status<>'matched'
      AND matched_invoice_id IS NULL
      AND matched_receipt_id IS NULL
      AND matched_at IS NULL)
  ),
  CONSTRAINT rent_bank_transactions_match_reason_valid
    CHECK (match_reason ~ '^[a-z0-9_]{0,100}$'),
  CONSTRAINT rent_bank_transactions_review_note_length
    CHECK (char_length(review_note) <= 500),
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
CREATE INDEX IF NOT EXISTS idx_rent_bank_transactions_reviewed_by
  ON rent_bank_transactions(reviewed_by_user_id, reviewed_at DESC)
  WHERE reviewed_by_user_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime') THEN
    EXECUTE 'REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON rent_payment_channels FROM tro_bill_runtime';
    EXECUTE 'GRANT SELECT, INSERT, UPDATE ON rent_payment_channels TO tro_bill_runtime';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE rent_payment_channels_id_seq TO tro_bill_runtime';
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rent_bank_transactions FROM tro_bill_runtime';
    EXECUTE 'GRANT SELECT, INSERT ON rent_bank_transactions TO tro_bill_runtime';
    EXECUTE 'GRANT UPDATE (match_status, match_reason, matched_invoice_id, matched_receipt_id, matched_at, review_note, reviewed_by_user_id, reviewed_at, updated_at) ON rent_bank_transactions TO tro_bill_runtime';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE rent_bank_transactions_id_seq TO tro_bill_runtime';
  END IF;
END $$;

-- Sổ tiền cọc độc lập với rooms/tenants vì PUT /api/state thay toàn bộ hai
-- bảng đó khi đồng bộ. Snapshot giúp giữ đúng lịch sử sau khi khách rời đi.
CREATE TABLE IF NOT EXISTS tenant_deposit_accounts (
  id                   BIGSERIAL PRIMARY KEY,
  user_id              BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id            TEXT NOT NULL,
  tenant_name_snapshot TEXT NOT NULL DEFAULT '',
  room_id              TEXT NOT NULL,
  room_name_snapshot   TEXT NOT NULL DEFAULT '',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tenant_deposit_accounts_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT tenant_deposit_accounts_tenant_unique UNIQUE (user_id, tenant_id),
  CONSTRAINT tenant_deposit_accounts_tenant_id_length
    CHECK (char_length(tenant_id) BETWEEN 1 AND 200),
  CONSTRAINT tenant_deposit_accounts_room_id_length
    CHECK (char_length(room_id) BETWEEN 1 AND 200)
);
CREATE INDEX IF NOT EXISTS idx_tenant_deposit_accounts_room
  ON tenant_deposit_accounts(user_id, room_id, id);

-- Append-only: thu cọc là số dương; khấu trừ/hoàn cọc là số âm; sửa sai bằng
-- một bút toán đảo chiều tham chiếu giao dịch gốc.
CREATE TABLE IF NOT EXISTS tenant_deposit_transactions (
  id                      BIGSERIAL PRIMARY KEY,
  user_id                 BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  account_id              BIGINT NOT NULL,
  transaction_code        TEXT NOT NULL,
  entry_type              TEXT NOT NULL,
  amount_vnd              NUMERIC(12, 0) NOT NULL,
  payment_method          TEXT NOT NULL DEFAULT 'manual',
  note                    TEXT NOT NULL DEFAULT '',
  source                  TEXT NOT NULL DEFAULT 'manual',
  idempotency_key         TEXT,
  reverses_transaction_id BIGINT,
  occurred_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT tenant_deposit_transactions_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT tenant_deposit_transactions_code_unique UNIQUE (user_id, transaction_code),
  CONSTRAINT tenant_deposit_transactions_account_owner_fk
    FOREIGN KEY (user_id, account_id)
    REFERENCES tenant_deposit_accounts(user_id, id) ON DELETE CASCADE,
  CONSTRAINT tenant_deposit_transactions_reversal_owner_fk
    FOREIGN KEY (user_id, reverses_transaction_id)
    REFERENCES tenant_deposit_transactions(user_id, id) ON DELETE RESTRICT,
  CONSTRAINT tenant_deposit_transactions_type_valid
    CHECK (entry_type IN ('collection', 'deduction', 'refund', 'reversal')),
  CONSTRAINT tenant_deposit_transactions_amount_valid CHECK (
    (entry_type = 'collection' AND amount_vnd > 0)
    OR (entry_type IN ('deduction', 'refund') AND amount_vnd < 0)
    OR (entry_type = 'reversal' AND amount_vnd <> 0)
  ),
  CONSTRAINT tenant_deposit_transactions_reversal_target CHECK (
    (entry_type = 'reversal' AND reverses_transaction_id IS NOT NULL)
    OR (entry_type <> 'reversal' AND reverses_transaction_id IS NULL)
  ),
  CONSTRAINT tenant_deposit_transactions_method_format
    CHECK (payment_method ~ '^[a-z][a-z0-9_]{1,31}$'),
  CONSTRAINT tenant_deposit_transactions_source_format
    CHECK (source ~ '^[a-z][a-z0-9_]{2,63}$'),
  CONSTRAINT tenant_deposit_transactions_note_length CHECK (char_length(note) <= 500),
  CONSTRAINT tenant_deposit_transactions_idempotency_length
    CHECK (idempotency_key IS NULL OR char_length(idempotency_key) BETWEEN 8 AND 300)
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_deposit_transactions_idempotency
  ON tenant_deposit_transactions(user_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS idx_tenant_deposit_transactions_reversal_once
  ON tenant_deposit_transactions(user_id, reverses_transaction_id)
  WHERE reverses_transaction_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tenant_deposit_transactions_account_time
  ON tenant_deposit_transactions(user_id, account_id, occurred_at DESC, id DESC);

-- Lớp bảo vệ cuối ở database: kể cả khi một đường ghi mới quên kiểm tra ở API,
-- tổng tiền cọc của tài khoản vẫn không thể xuống dưới 0.
CREATE OR REPLACE FUNCTION enforce_tenant_deposit_nonnegative()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  current_balance NUMERIC(12, 0);
BEGIN
  PERFORM 1
  FROM tenant_deposit_accounts
  WHERE user_id=NEW.user_id AND id=NEW.account_id
  FOR UPDATE;

  SELECT COALESCE(SUM(amount_vnd), 0)
  INTO current_balance
  FROM tenant_deposit_transactions
  WHERE user_id=NEW.user_id AND account_id=NEW.account_id;

  IF current_balance + NEW.amount_vnd < 0 THEN
    RAISE EXCEPTION 'tenant deposit balance cannot be negative'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='tenant_deposit_nonnegative_before_insert'
      AND tgrelid='public.tenant_deposit_transactions'::regclass
  ) THEN
    CREATE TRIGGER tenant_deposit_nonnegative_before_insert
      BEFORE INSERT ON tenant_deposit_transactions
      FOR EACH ROW EXECUTE FUNCTION enforce_tenant_deposit_nonnegative();
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'tro_bill_runtime') THEN
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON tenant_deposit_accounts FROM tro_bill_runtime';
    EXECUTE 'GRANT SELECT, INSERT ON tenant_deposit_accounts TO tro_bill_runtime';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE tenant_deposit_accounts_id_seq TO tro_bill_runtime';
    EXECUTE 'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON tenant_deposit_transactions FROM tro_bill_runtime';
    EXECUTE 'GRANT SELECT, INSERT ON tenant_deposit_transactions TO tro_bill_runtime';
    EXECUTE 'GRANT USAGE, SELECT ON SEQUENCE tenant_deposit_transactions_id_seq TO tro_bill_runtime';
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rental_handover_records_deposit_owner_fk'
  ) THEN
    ALTER TABLE rental_handover_records
      ADD CONSTRAINT rental_handover_records_deposit_owner_fk
      FOREIGN KEY (user_id, deposit_account_id)
      REFERENCES tenant_deposit_accounts(user_id, id) ON DELETE RESTRICT;
  END IF;
END $$;

-- Ràng buộc ownership ở tầng database: các dòng con chỉ được tham chiếu tới
-- phòng có cùng user_id, kể cả khi client cố gửi ID phòng của tài khoản khác.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rooms_user_id_id_key') THEN
    ALTER TABLE rooms ADD CONSTRAINT rooms_user_id_id_key UNIQUE (user_id, id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tenants_room_owner_fk') THEN
    ALTER TABLE tenants ADD CONSTRAINT tenants_room_owner_fk
      FOREIGN KEY (user_id, room_id) REFERENCES rooms(user_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='room_rates_room_owner_fk') THEN
    ALTER TABLE room_rate_history ADD CONSTRAINT room_rates_room_owner_fk
      FOREIGN KEY (user_id, room_id) REFERENCES rooms(user_id, id) ON DELETE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname='billing_room_owner_fk') THEN
    ALTER TABLE billing_entries ADD CONSTRAINT billing_room_owner_fk
      FOREIGN KEY (user_id, room_id) REFERENCES rooms(user_id, id) ON DELETE CASCADE;
  END IF;
END $$;

-- Mỗi lần admin xem CCCD đầy đủ đều phải có lý do và được lưu để rà soát.
-- Không lưu CCCD trong log.
CREATE TABLE IF NOT EXISTS admin_sensitive_access_logs (
  id                    BIGSERIAL PRIMARY KEY,
  admin_user_id         BIGINT REFERENCES users(id) ON DELETE SET NULL,
  admin_email_snapshot  TEXT NOT NULL,
  target_user_id        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  target_email_snapshot TEXT NOT NULL,
  tenant_id             TEXT NOT NULL,
  tenant_name_snapshot  TEXT NOT NULL DEFAULT '',
  action                TEXT NOT NULL DEFAULT 'reveal_cccd',
  reason                TEXT NOT NULL,
  request_ip_hash       TEXT NOT NULL DEFAULT '',
  user_agent            TEXT NOT NULL DEFAULT '',
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_sensitive_access_created
  ON admin_sensitive_access_logs(created_at DESC);

-- Nhật ký hoạt động dữ liệu của chính chủ tài khoản. Không lưu giá trị CCCD,
-- số điện thoại, địa chỉ hay dữ liệu trước/sau thay đổi trong bảng này.
CREATE TABLE IF NOT EXISTS data_audit_logs (
  id                   BIGSERIAL PRIMARY KEY,
  actor_user_id        BIGINT REFERENCES users(id) ON DELETE SET NULL,
  actor_email_snapshot TEXT NOT NULL,
  subject_user_id      BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action               TEXT NOT NULL,
  resource_type        TEXT NOT NULL,
  resource_id          TEXT NOT NULL DEFAULT '',
  changed_fields       TEXT[] NOT NULL DEFAULT '{}',
  purpose              TEXT NOT NULL DEFAULT '',
  request_ip_hash      TEXT NOT NULL DEFAULT '',
  user_agent           TEXT NOT NULL DEFAULT '',
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_data_audit_subject_created
  ON data_audit_logs(subject_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_data_audit_created
  ON data_audit_logs(created_at DESC);

-- Đồng bộ quyền trực tiếp từ role chuẩn cũ sang login runtime SQL. Role đích
-- không kế thừa role quản trị; mỗi lần init-db sẽ thu hồi quyền dư trước khi
-- cấp lại đúng quyền bảng/cột/sequence đang có ở tro_bill_runtime.
DO $$
DECLARE
  source_role CONSTANT text := 'tro_bill_runtime';
  target_role CONSTANT text := 'tro_bill_runtime_sql';
  object_row record;
  column_row record;
  sequence_row record;
  privilege_name text;
  privileges text[];
  qualified_name text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=source_role)
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname=target_role) THEN
    RETURN;
  END IF;

  EXECUTE format('REVOKE ALL PRIVILEGES ON DATABASE %I FROM %I', current_database(), target_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON SCHEMA public FROM %I', target_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM %I', target_role);
  EXECUTE format('REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM %I', target_role);

  FOR column_row IN
    SELECT table_schema, table_name, column_name
    FROM information_schema.columns
    WHERE table_schema='public'
  LOOP
    EXECUTE format(
      'REVOKE ALL PRIVILEGES (%I) ON TABLE %I.%I FROM %I',
      column_row.column_name,
      column_row.table_schema,
      column_row.table_name,
      target_role
    );
  END LOOP;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO %I', current_database(), target_role);
  EXECUTE format('GRANT USAGE ON SCHEMA public TO %I', target_role);

  FOR object_row IN
    SELECT table_schema, table_name
    FROM information_schema.tables
    WHERE table_schema='public' AND table_type='BASE TABLE'
    ORDER BY table_name
  LOOP
    qualified_name := format('%I.%I', object_row.table_schema, object_row.table_name);
    privileges := ARRAY[]::text[];
    FOREACH privilege_name IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
      IF has_table_privilege(source_role, qualified_name, privilege_name) THEN
        privileges := array_append(privileges, privilege_name);
      END IF;
    END LOOP;
    IF cardinality(privileges) > 0 THEN
      EXECUTE format(
        'GRANT %s ON TABLE %s TO %I',
        array_to_string(privileges, ', '),
        qualified_name,
        target_role
      );
    END IF;
  END LOOP;

  FOR column_row IN
    SELECT table_schema, table_name, column_name
    FROM information_schema.columns
    WHERE table_schema='public'
  LOOP
    qualified_name := format('%I.%I', column_row.table_schema, column_row.table_name);
    privileges := ARRAY[]::text[];
    FOREACH privilege_name IN ARRAY ARRAY['SELECT','INSERT','UPDATE','REFERENCES'] LOOP
      IF has_column_privilege(source_role, qualified_name, column_row.column_name, privilege_name)
         AND NOT has_table_privilege(source_role, qualified_name, privilege_name) THEN
        privileges := array_append(
          privileges,
          format('%s (%I)', privilege_name, column_row.column_name)
        );
      END IF;
    END LOOP;
    IF cardinality(privileges) > 0 THEN
      EXECUTE format(
        'GRANT %s ON TABLE %s TO %I',
        array_to_string(privileges, ', '),
        qualified_name,
        target_role
      );
    END IF;
  END LOOP;

  FOR sequence_row IN
    SELECT class.oid, namespace.nspname AS schema_name, class.relname AS sequence_name
    FROM pg_class class
    JOIN pg_namespace namespace ON namespace.oid=class.relnamespace
    WHERE namespace.nspname='public' AND class.relkind='S'
  LOOP
    privileges := ARRAY[]::text[];
    FOREACH privilege_name IN ARRAY ARRAY['USAGE','SELECT','UPDATE'] LOOP
      IF has_sequence_privilege(source_role, sequence_row.oid, privilege_name) THEN
        privileges := array_append(privileges, privilege_name);
      END IF;
    END LOOP;
    IF cardinality(privileges) > 0 THEN
      EXECUTE format(
        'GRANT %s ON SEQUENCE %I.%I TO %I',
        array_to_string(privileges, ', '),
        sequence_row.schema_name,
        sequence_row.sequence_name,
        target_role
      );
    END IF;
  END LOOP;
END $$;
