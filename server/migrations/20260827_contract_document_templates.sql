BEGIN;

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

COMMIT;

SELECT
  COUNT(*) FILTER (WHERE column_name LIKE 'tenant_%_snapshot')::int AS tenant_snapshot_columns,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='rental_contracts_tenant_document_snapshot_valid'
  ) AS tenant_snapshot_constraint_ready
FROM information_schema.columns
WHERE table_schema='public' AND table_name='rental_contracts';
