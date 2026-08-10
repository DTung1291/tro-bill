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
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Bổ sung cột cho DB đã tạo trước đó (idempotent)
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT false;

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
CREATE INDEX IF NOT EXISTS idx_rooms_user ON rooms(user_id);

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
CREATE INDEX IF NOT EXISTS idx_history_bills_snapshot ON history_bills(snapshot_id);
