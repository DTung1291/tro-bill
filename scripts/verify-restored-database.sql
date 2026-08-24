\set ON_ERROR_STOP on

DO $$
DECLARE
  required_table text;
BEGIN
  FOREACH required_table IN ARRAY ARRAY[
    'users',
    'settings',
    'rooms',
    'room_rate_history',
    'tenants',
    'billing_entries',
    'expense_entries',
    'history_snapshots',
    'history_bills',
    'auth_rate_limits',
    'admin_sensitive_access_logs'
  ]
  LOOP
    IF to_regclass('public.' || required_table) IS NULL THEN
      RAISE EXCEPTION 'Thiếu bảng bắt buộc: %', required_table;
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM tenants t
    LEFT JOIN rooms r ON r.id=t.room_id AND r.user_id=t.user_id
    WHERE r.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Có tenant không thuộc phòng của cùng tài khoản';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM room_rate_history rrh
    LEFT JOIN rooms r ON r.id=rrh.room_id AND r.user_id=rrh.user_id
    WHERE r.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Có biểu phí không thuộc phòng của cùng tài khoản';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM billing_entries be
    LEFT JOIN rooms r ON r.id=be.room_id AND r.user_id=be.user_id
    WHERE r.id IS NULL
  ) THEN
    RAISE EXCEPTION 'Có bill không thuộc phòng của cùng tài khoản';
  END IF;
END $$;

SELECT 'restore-verification-ok' AS result;

