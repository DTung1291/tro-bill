BEGIN;

-- Hóa đơn gốc vẫn là snapshot lúc phát hành. Bản final chỉ được ghi một lần
-- khi trả phòng; các luồng đọc dùng COALESCE(final_total, issued_total).
ALTER TABLE rent_invoices
  ADD COLUMN IF NOT EXISTS final_total_vnd NUMERIC(12, 0),
  ADD COLUMN IF NOT EXISTS final_detail_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS finalization_contract_id BIGINT,
  ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_invoices_finalization_consistent'
  ) THEN
    ALTER TABLE rent_invoices
      ADD CONSTRAINT rent_invoices_finalization_consistent CHECK (
        (final_total_vnd IS NULL AND final_detail_snapshot IS NULL
          AND finalization_contract_id IS NULL AND finalized_at IS NULL)
        OR (final_total_vnd IS NOT NULL AND final_total_vnd >= 0
          AND final_detail_snapshot IS NOT NULL
          AND jsonb_typeof(final_detail_snapshot)='object'
          AND octet_length(final_detail_snapshot::text) <= 8192
          AND finalization_contract_id IS NOT NULL AND finalized_at IS NOT NULL)
      );
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rent_invoices_finalization_contract_owner_fk'
  ) THEN
    ALTER TABLE rent_invoices
      ADD CONSTRAINT rent_invoices_finalization_contract_owner_fk
      FOREIGN KEY (user_id, finalization_contract_id)
      REFERENCES rental_contracts(user_id, id) ON DELETE RESTRICT;
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS idx_rent_invoices_one_final_per_contract
  ON rent_invoices(user_id, finalization_contract_id)
  WHERE finalization_contract_id IS NOT NULL;

CREATE OR REPLACE FUNCTION protect_finalized_rent_invoice()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD.finalized_at IS NOT NULL AND (
    NEW.room_name_snapshot IS DISTINCT FROM OLD.room_name_snapshot
    OR NEW.issued_total_vnd IS DISTINCT FROM OLD.issued_total_vnd
    OR NEW.detail_snapshot IS DISTINCT FROM OLD.detail_snapshot
    OR NEW.final_total_vnd IS DISTINCT FROM OLD.final_total_vnd
    OR NEW.final_detail_snapshot IS DISTINCT FROM OLD.final_detail_snapshot
    OR NEW.finalization_contract_id IS DISTINCT FROM OLD.finalization_contract_id
    OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at
  ) THEN
    RAISE EXCEPTION 'finalized rent invoice is immutable'
      USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END;
$$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='rent_invoice_finalization_immutable_before_update'
      AND tgrelid='public.rent_invoices'::regclass
  ) THEN
    CREATE TRIGGER rent_invoice_finalization_immutable_before_update
      BEFORE UPDATE ON rent_invoices
      FOR EACH ROW EXECUTE FUNCTION protect_finalized_rent_invoice();
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS rental_final_settlements (
  id                           BIGSERIAL PRIMARY KEY,
  user_id                      BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  settlement_code              TEXT NOT NULL,
  contract_id                  BIGINT NOT NULL,
  checkout_event_id            BIGINT NOT NULL,
  handover_id                  BIGINT NOT NULL,
  invoice_id                   BIGINT NOT NULL,
  deposit_account_id           BIGINT,
  rent_payment_receipt_id      BIGINT,
  deposit_apply_transaction_id BIGINT,
  deposit_refund_transaction_id BIGINT,
  period                       TEXT NOT NULL,
  occurred_on                  DATE NOT NULL,
  invoice_original_total_vnd   BIGINT NOT NULL,
  invoice_final_total_vnd      BIGINT NOT NULL,
  prior_debt_vnd               BIGINT NOT NULL DEFAULT 0,
  paid_before_vnd              BIGINT NOT NULL DEFAULT 0,
  deposit_balance_before_vnd   BIGINT NOT NULL DEFAULT 0,
  deposit_applied_vnd          BIGINT NOT NULL DEFAULT 0,
  deposit_refunded_vnd         BIGINT NOT NULL DEFAULT 0,
  rent_overpayment_vnd         BIGINT NOT NULL DEFAULT 0,
  remaining_due_vnd            BIGINT NOT NULL DEFAULT 0,
  refund_method                TEXT NOT NULL DEFAULT 'manual',
  detail_snapshot              JSONB NOT NULL,
  reason                       TEXT NOT NULL,
  created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT rental_final_settlements_user_id_id_unique UNIQUE (user_id, id),
  CONSTRAINT rental_final_settlements_code_unique UNIQUE (user_id, settlement_code),
  CONSTRAINT rental_final_settlements_contract_unique UNIQUE (user_id, contract_id),
  CONSTRAINT rental_final_settlements_event_unique UNIQUE (user_id, checkout_event_id),
  CONSTRAINT rental_final_settlements_handover_unique UNIQUE (user_id, handover_id),
  CONSTRAINT rental_final_settlements_invoice_unique UNIQUE (user_id, invoice_id),
  CONSTRAINT rental_final_settlements_code_valid
    CHECK (settlement_code ~ '^QTT-[0-9]{4}-[A-Z0-9]{6}$'),
  CONSTRAINT rental_final_settlements_period_valid
    CHECK (period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT rental_final_settlements_amounts_valid CHECK (
    invoice_original_total_vnd BETWEEN 0 AND 999999999999
    AND invoice_final_total_vnd BETWEEN 0 AND 999999999999
    AND prior_debt_vnd BETWEEN 0 AND 999999999999
    AND paid_before_vnd BETWEEN 0 AND 999999999999
    AND deposit_balance_before_vnd BETWEEN 0 AND 999999999999
    AND deposit_applied_vnd BETWEEN 0 AND 999999999999
    AND deposit_refunded_vnd BETWEEN 0 AND 999999999999
    AND rent_overpayment_vnd BETWEEN 0 AND 999999999999
    AND remaining_due_vnd BETWEEN 0 AND 999999999999
    AND deposit_applied_vnd + deposit_refunded_vnd=deposit_balance_before_vnd
  ),
  CONSTRAINT rental_final_settlements_refund_method_valid
    CHECK (refund_method ~ '^[a-z][a-z0-9_]{1,31}$'),
  CONSTRAINT rental_final_settlements_detail_valid CHECK (
    jsonb_typeof(detail_snapshot)='object'
    AND octet_length(detail_snapshot::text) <= 16384
  ),
  CONSTRAINT rental_final_settlements_reason_valid
    CHECK (char_length(reason) BETWEEN 10 AND 500),
  CONSTRAINT rental_final_settlements_deposit_links_valid CHECK (
    (deposit_applied_vnd=0 AND rent_payment_receipt_id IS NULL
      AND deposit_apply_transaction_id IS NULL)
    OR (deposit_applied_vnd>0 AND rent_payment_receipt_id IS NOT NULL
      AND deposit_apply_transaction_id IS NOT NULL)
  ),
  CONSTRAINT rental_final_settlements_refund_link_valid CHECK (
    (deposit_refunded_vnd=0 AND deposit_refund_transaction_id IS NULL)
    OR (deposit_refunded_vnd>0 AND deposit_refund_transaction_id IS NOT NULL)
  ),
  CONSTRAINT rental_final_settlements_contract_owner_fk
    FOREIGN KEY (user_id, contract_id)
    REFERENCES rental_contracts(user_id, id) ON DELETE RESTRICT,
  CONSTRAINT rental_final_settlements_event_owner_fk
    FOREIGN KEY (user_id, checkout_event_id)
    REFERENCES rental_lifecycle_events(user_id, id) ON DELETE RESTRICT,
  CONSTRAINT rental_final_settlements_handover_owner_fk
    FOREIGN KEY (user_id, handover_id)
    REFERENCES rental_handover_records(user_id, id) ON DELETE RESTRICT,
  CONSTRAINT rental_final_settlements_invoice_owner_fk
    FOREIGN KEY (user_id, invoice_id)
    REFERENCES rent_invoices(user_id, id) ON DELETE RESTRICT,
  CONSTRAINT rental_final_settlements_deposit_account_owner_fk
    FOREIGN KEY (user_id, deposit_account_id)
    REFERENCES tenant_deposit_accounts(user_id, id) ON DELETE RESTRICT,
  CONSTRAINT rental_final_settlements_receipt_owner_fk
    FOREIGN KEY (user_id, rent_payment_receipt_id)
    REFERENCES rent_payment_receipts(user_id, id) ON DELETE RESTRICT,
  CONSTRAINT rental_final_settlements_deposit_apply_owner_fk
    FOREIGN KEY (user_id, deposit_apply_transaction_id)
    REFERENCES tenant_deposit_transactions(user_id, id) ON DELETE RESTRICT,
  CONSTRAINT rental_final_settlements_deposit_refund_owner_fk
    FOREIGN KEY (user_id, deposit_refund_transaction_id)
    REFERENCES tenant_deposit_transactions(user_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_rental_final_settlements_user_date
  ON rental_final_settlements(user_id, occurred_on DESC, id DESC);

-- Trigger cọc cũ khóa dòng account bằng FOR UPDATE trong khi runtime role được
-- thiết kế append-only và không có UPDATE. Advisory lock vẫn tuần tự hóa mọi
-- INSERT (kể cả đường ghi mới) mà không phải nới quyền dữ liệu.
CREATE OR REPLACE FUNCTION enforce_tenant_deposit_nonnegative()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  current_balance NUMERIC(12, 0);
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'deposit-balance:' || NEW.user_id::text || ':' || NEW.account_id::text,
    0
  ));

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
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'tro_bill_runtime', 'tro_bill_runtime_sql', 'tro_bill_app'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format('REVOKE UPDATE ON rent_invoices FROM %I', runtime_role);
      EXECUTE format('GRANT SELECT, INSERT ON rent_invoices TO %I', runtime_role);
      EXECUTE format(
        'GRANT UPDATE (room_name_snapshot, issued_total_vnd, detail_snapshot, final_total_vnd, final_detail_snapshot, finalization_contract_id, finalized_at, updated_at) ON rent_invoices TO %I',
        runtime_role
      );
      EXECUTE format(
        'REVOKE UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER ON rental_final_settlements FROM %I',
        runtime_role
      );
      EXECUTE format('GRANT SELECT, INSERT ON rental_final_settlements TO %I', runtime_role);
      EXECUTE format(
        'GRANT USAGE, SELECT ON SEQUENCE rental_final_settlements_id_seq TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;

COMMIT;

SELECT
  EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema='public' AND table_name='rent_invoices'
      AND column_name='final_total_vnd'
  ) AS invoice_final_snapshot_ready,
  to_regclass('public.rental_final_settlements') IS NOT NULL AS settlements_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rental_final_settlements_contract_owner_fk'
  ) AS settlement_contract_owner_ready,
  EXISTS (
    SELECT 1 FROM pg_trigger
    WHERE tgname='rent_invoice_finalization_immutable_before_update'
  ) AS invoice_final_immutable_ready,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime_sql') THEN
    has_table_privilege('tro_bill_runtime_sql', 'rental_final_settlements', 'INSERT')
    AND NOT has_table_privilege('tro_bill_runtime_sql', 'rental_final_settlements', 'UPDATE')
    AND NOT has_table_privilege('tro_bill_runtime_sql', 'rental_final_settlements', 'DELETE')
  ELSE TRUE END AS settlement_append_only_ready;
