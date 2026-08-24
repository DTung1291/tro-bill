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
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Bổ sung cột cho DB đã tạo trước đó (idempotent)
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE users ADD COLUMN IF NOT EXISTS token_version INTEGER NOT NULL DEFAULT 0;

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
  theme                 TEXT     NOT NULL DEFAULT 'system'
);

-- Cấu hình toàn cục của app (do admin thiết lập). Chỉ 1 dòng (id=1).
-- Thông tin ủng hộ nhà phát triển (VietQR) dùng chung cho mọi người dùng.
CREATE TABLE IF NOT EXISTS app_config (
  id                INTEGER PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  donate_bank_id    TEXT NOT NULL DEFAULT '',
  donate_account    TEXT NOT NULL DEFAULT '',
  donate_owner_name TEXT NOT NULL DEFAULT '',
  donate_message    TEXT NOT NULL DEFAULT 'Ung ho'
);
INSERT INTO app_config (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

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
  cccd       TEXT NOT NULL DEFAULT '',
  issue_date TEXT NOT NULL DEFAULT '',
  dob        TEXT NOT NULL DEFAULT '',
  gender     TEXT NOT NULL DEFAULT 'Nam',
  address    TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_tenants_room ON tenants(room_id);
CREATE INDEX IF NOT EXISTS idx_tenants_user ON tenants(user_id);

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
  paid                  BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY (user_id, period, room_id)
);
ALTER TABLE billing_entries ADD COLUMN IF NOT EXISTS utility_only BOOLEAN NOT NULL DEFAULT false;
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
UPDATE history_bills
SET rent_base_price = rent_price
WHERE rent_base_price = 0 AND rent_price <> 0;
CREATE INDEX IF NOT EXISTS idx_history_bills_snapshot ON history_bills(snapshot_id);
