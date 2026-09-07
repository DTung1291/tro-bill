BEGIN;

CREATE TABLE IF NOT EXISTS electronic_invoice_profiles (
  user_id                         BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  legal_entity_type               TEXT NOT NULL DEFAULT 'unknown',
  business_activity_type          TEXT NOT NULL DEFAULT 'unknown',
  annual_revenue_band             TEXT NOT NULL DEFAULT 'unknown',
  tax_code                        TEXT NOT NULL DEFAULT '',
  business_address                TEXT NOT NULL DEFAULT '',
  registration_status             TEXT NOT NULL DEFAULT 'not_registered',
  provider                        TEXT NOT NULL DEFAULT '',
  provider_account_ref            TEXT NOT NULL DEFAULT '',
  invoice_type                    TEXT NOT NULL DEFAULT '',
  invoice_template_code           TEXT NOT NULL DEFAULT '',
  invoice_series                  TEXT NOT NULL DEFAULT '',
  signing_method                  TEXT NOT NULL DEFAULT 'unknown',
  legal_basis_reference           TEXT NOT NULL DEFAULT '',
  effective_from                  DATE,
  expires_on                      DATE,
  eligibility_status              TEXT NOT NULL DEFAULT 'review_required',
  owner_attested_at               TIMESTAMPTZ,
  provider_credential_ref         TEXT NOT NULL DEFAULT '',
  provider_credential_verified_at TIMESTAMPTZ,
  reviewed_by_user_id             BIGINT REFERENCES users(id) ON DELETE SET NULL,
  reviewed_at                     TIMESTAMPTZ,
  created_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT electronic_invoice_profiles_legal_entity_valid CHECK (
    legal_entity_type IN (
      'unknown', 'individual_real_estate_lessor', 'household_business',
      'enterprise', 'other'
    )
  ),
  CONSTRAINT electronic_invoice_profiles_activity_valid CHECK (
    business_activity_type IN (
      'unknown', 'long_term_real_estate_rental', 'accommodation_service',
      'mixed', 'other'
    )
  ),
  CONSTRAINT electronic_invoice_profiles_revenue_band_valid CHECK (
    annual_revenue_band IN ('unknown', 'lte_500m', 'gt_500m_lte_1b', 'gt_1b')
  ),
  CONSTRAINT electronic_invoice_profiles_registration_valid CHECK (
    registration_status IN (
      'not_registered', 'registered_code', 'registered_non_code',
      'per_occurrence', 'suspended'
    )
  ),
  CONSTRAINT electronic_invoice_profiles_provider_valid CHECK (
    provider IN ('', 'misa_meinvoice', 'vnpt_invoice', 'viettel_sinvoice', 'other')
  ),
  CONSTRAINT electronic_invoice_profiles_invoice_type_valid CHECK (
    invoice_type IN ('', 'sales', 'vat', 'other')
  ),
  CONSTRAINT electronic_invoice_profiles_signing_method_valid CHECK (
    signing_method IN ('unknown', 'usb_token', 'remote_signing', 'hsm', 'other')
  ),
  CONSTRAINT electronic_invoice_profiles_eligibility_valid CHECK (
    eligibility_status IN (
      'review_required', 'not_required', 'voluntary_not_ready',
      'voluntary_ready', 'required_not_ready', 'required_ready', 'suspended'
    )
  ),
  CONSTRAINT electronic_invoice_profiles_dates_valid CHECK (
    expires_on IS NULL OR effective_from IS NULL OR expires_on >= effective_from
  ),
  CONSTRAINT electronic_invoice_profiles_text_lengths_valid CHECK (
    char_length(tax_code) <= 20
    AND char_length(business_address) <= 1000
    AND char_length(provider_account_ref) <= 200
    AND char_length(invoice_template_code) <= 100
    AND char_length(invoice_series) <= 100
    AND char_length(legal_basis_reference) <= 500
    AND char_length(provider_credential_ref) <= 500
  )
);

DO $$
DECLARE
  runtime_role TEXT;
BEGIN
  FOREACH runtime_role IN ARRAY ARRAY[
    'tro_bill_runtime', 'tro_bill_runtime_sql', 'tro_bill_app'
  ] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname=runtime_role) THEN
      EXECUTE format(
        'GRANT SELECT, INSERT, UPDATE ON electronic_invoice_profiles TO %I',
        runtime_role
      );
    END IF;
  END LOOP;
END $$;

COMMIT;

SELECT
  to_regclass('public.electronic_invoice_profiles') IS NOT NULL
    AS electronic_invoice_profile_table_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='electronic_invoice_profiles_legal_entity_valid'
  ) AS electronic_invoice_profile_entity_check_ready,
  EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname='electronic_invoice_profiles_eligibility_valid'
  ) AS electronic_invoice_profile_status_check_ready,
  CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname='tro_bill_runtime_sql') THEN
    has_table_privilege('tro_bill_runtime_sql', 'electronic_invoice_profiles', 'SELECT')
    AND has_table_privilege('tro_bill_runtime_sql', 'electronic_invoice_profiles', 'INSERT')
    AND has_table_privilege('tro_bill_runtime_sql', 'electronic_invoice_profiles', 'UPDATE')
    AND NOT has_table_privilege('tro_bill_runtime_sql', 'electronic_invoice_profiles', 'DELETE')
  ELSE TRUE END AS electronic_invoice_profile_runtime_ready,
  NOT EXISTS (
    SELECT 1
    FROM electronic_invoice_profiles profile
    LEFT JOIN users owner ON owner.id=profile.user_id
    WHERE owner.id IS NULL
  ) AS electronic_invoice_profile_ownership_ready;
