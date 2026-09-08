'use strict';

const SCHEMA_MIGRATION_CHECKS = Object.freeze([
  ['rent_invoice_share_links', '20260825_rent_invoice_share_links.sql'],
  ['rent_invoice_schedules', '20260826_rent_invoice_schedules.sql'],
  ['rent_invoice_auto_reminders', '20260827_rent_invoice_auto_reminders.sql'],
  ['rental_contracts', '20260827_rental_contracts.sql'],
  ['contract_payment_cycles', '20260828_contract_payment_cycles.sql'],
  ['rental_contract_notifications', '20260828_rental_contract_expiry_notifications.sql'],
  ['rental_handovers', '20260829_rental_handover_records.sql'],
  ['rental_lifecycle', '20260829_rental_lifecycle.sql'],
  ['room_operational_statuses', '20260830_room_operational_statuses.sql'],
  ['rental_final_settlements', '20260830_rental_final_settlements.sql'],
  ['account_roles', '20260830_account_roles.sql'],
  ['member_access', '20260831_member_access_assignments.sql'],
  ['property_bank_accounts', '20260901_property_bank_accounts.sql'],
  ['room_assets', '20260901_room_assets.sql'],
  ['tenant_maintenance_requests', '20260901_tenant_maintenance_requests.sql'],
  ['tenant_maintenance_workflow', '20260905_tenant_maintenance_workflow.sql'],
  ['tenant_maintenance_expenses', '20260905_tenant_maintenance_expenses.sql'],
  ['electronic_invoice_profiles', '20260907_electronic_invoice_profiles.sql'],
  ['electronic_invoice_preflight', '20260907_electronic_invoice_preflight.sql'],
  ['electronic_invoice_records', '20260908_electronic_invoice_records.sql']
]);

const SCHEMA_DIAGNOSTICS_QUERY = `
  SELECT
    to_regclass('public.rent_invoice_share_links') IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='rent_invoice_share_links'
          AND column_name='tenancy_start_period' AND is_nullable='NO'
      ) AS rent_invoice_share_links,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='rent_invoice_deliveries'
        AND column_name='trigger_source'
    ) AS rent_invoice_schedules,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='settings'
        AND column_name='invoice_reminder_enabled'
    ) AS rent_invoice_auto_reminders,
    to_regclass('public.rental_contracts') IS NOT NULL
      AND to_regclass('public.rental_contract_amendments') IS NOT NULL
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rental_contract_amendments_contract_owner_fk')
      AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_rental_contracts_one_active_room')
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='rental_contracts'
          AND column_name='tenant_cccd_snapshot' AND is_nullable='NO'
      )
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rental_contracts_tenant_document_snapshot_valid')
      AS rental_contracts,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='rental_contracts'
        AND column_name='billing_cycle_months' AND is_nullable='NO'
    )
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='rental_contracts'
          AND column_name='payment_due_day' AND is_nullable='NO'
      )
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rental_contracts_payment_schedule_valid')
      AS contract_payment_cycles,
    to_regclass('public.rental_contract_notifications') IS NOT NULL
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rental_contract_notifications_owner_fk')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rental_contract_notifications_unique')
      AS rental_contract_notifications,
    to_regclass('public.rental_handover_records') IS NOT NULL
      AND to_regclass('public.rental_handover_items') IS NOT NULL
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rental_handover_records_contract_owner_fk')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rental_handover_records_deposit_owner_fk')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rental_handover_records_type_unique')
      AS rental_handovers,
    to_regclass('public.rental_reservations') IS NOT NULL
      AND to_regclass('public.rental_lifecycle_events') IS NOT NULL
      AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_rental_reservations_one_active_room')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rental_reservations_converted_contract_owner_fk')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rental_lifecycle_events_contract_owner_fk')
      AS rental_lifecycle,
    to_regclass('public.room_maintenance_periods') IS NOT NULL
      AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_room_maintenance_one_active_room')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rental_lifecycle_events_maintenance_owner_fk')
      AS room_operational_statuses,
    to_regclass('public.rental_final_settlements') IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='rent_invoices' AND column_name='final_total_vnd'
      )
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rental_final_settlements_contract_owner_fk')
      AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='rent_invoice_finalization_immutable_before_update')
      AS rental_final_settlements,
    to_regclass('public.account_memberships') IS NOT NULL
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='account_memberships_owner_shape_valid')
      AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='users_assign_owner_account_membership')
      AS account_roles,
    to_regclass('public.account_member_property_access') IS NOT NULL
      AND to_regclass('public.account_member_operation_access') IS NOT NULL
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='account_member_property_owner_fk')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='account_member_operation_valid')
      AS member_access,
    to_regclass('public.rent_bank_accounts') IS NOT NULL
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='properties_rent_bank_account_owner_fk')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rent_payment_channels_bank_account_owner_fk')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='rent_bank_transactions_bank_account_owner_fk')
      AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_rent_payment_channels_account_provider')
      AS property_bank_accounts,
    to_regclass('public.room_assets') IS NOT NULL
      AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_room_assets_user_room_status')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='room_assets_archive_valid')
      AS room_assets,
    to_regclass('public.tenant_maintenance_portal_links') IS NOT NULL
      AND to_regclass('public.tenant_maintenance_requests') IS NOT NULL
      AND EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_tenant_maintenance_requests_contract_status')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tenant_maintenance_requests_portal_fk')
      AS tenant_maintenance_requests,
    to_regclass('public.tenant_maintenance_request_assignments') IS NOT NULL
      AND to_regclass('public.tenant_maintenance_request_events') IS NOT NULL
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='tenant_maintenance_assignment_membership_fk')
      AS tenant_maintenance_workflow,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='expense_entries'
        AND column_name IN (
          'maintenance_request_user_id', 'maintenance_request_id',
          'maintenance_request_code_snapshot', 'maintenance_room_id_snapshot',
          'maintenance_room_name_snapshot'
        )
      GROUP BY table_schema, table_name HAVING count(*)=5
    )
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='expense_entries_maintenance_request_owner_fk')
      AS tenant_maintenance_expenses,
    to_regclass('public.electronic_invoice_profiles') IS NOT NULL
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='electronic_invoice_profiles_eligibility_valid')
      AS electronic_invoice_profiles,
    EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='electronic_invoice_profiles'
        AND column_name='seller_legal_name' AND is_nullable='NO'
    )
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='electronic_invoice_profiles_seller_name_length_valid')
      AS electronic_invoice_preflight,
    to_regclass('public.electronic_invoice_records') IS NOT NULL
      AND to_regclass('public.electronic_invoice_status_events') IS NOT NULL
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='electronic_invoice_records_source_owner_fk')
      AND EXISTS (SELECT 1 FROM pg_constraint WHERE conname='electronic_invoice_events_provider_event_unique')
      AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='electronic_invoice_record_identity_before_update')
      AND EXISTS (SELECT 1 FROM pg_trigger WHERE tgname='electronic_invoice_event_append_only_before_update')
      AS electronic_invoice_records`;

function missingSchemaMigrations(row = {}) {
  return SCHEMA_MIGRATION_CHECKS
    .filter(([key]) => row[key] !== true)
    .map(([, migration]) => migration);
}

module.exports = {
  SCHEMA_DIAGNOSTICS_QUERY,
  SCHEMA_MIGRATION_CHECKS,
  missingSchemaMigrations
};
