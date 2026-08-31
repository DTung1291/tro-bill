'use strict';

const db = require('./db');
const { inspectRuntimeEnvironment } = require('./environment');
const { reportOperationalError } = require('./observability');

const SCHEMA_READY_QUERY = `
  SELECT
    current_user AS runtime_role,
    pg_has_role(current_user, 'neon_superuser', 'member') AS inherits_neon_superuser,
    to_regclass('public.rent_invoice_share_links') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name='rent_invoice_share_links'
        AND column_name='tenancy_start_period'
        AND is_nullable='NO'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name='rent_invoice_deliveries'
        AND column_name='trigger_source'
    )
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public'
        AND table_name='settings'
        AND column_name='invoice_reminder_enabled'
    )
    AND to_regclass('public.rental_contracts') IS NOT NULL
    AND to_regclass('public.rental_contract_amendments') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname='rental_contract_amendments_contract_owner_fk'
    )
    AND EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname='public' AND indexname='idx_rental_contracts_one_active_room'
    )
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='rental_contracts'
        AND column_name='tenant_cccd_snapshot' AND is_nullable='NO'
    )
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname='rental_contracts_tenant_document_snapshot_valid'
    )
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='rental_contracts'
        AND column_name='billing_cycle_months' AND is_nullable='NO'
    )
    AND EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema='public' AND table_name='rental_contracts'
        AND column_name='payment_due_day' AND is_nullable='NO'
    )
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname='rental_contracts_payment_schedule_valid'
    )
    AND to_regclass('public.rental_contract_notifications') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname='rental_contract_notifications_owner_fk'
    )
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname='rental_contract_notifications_unique'
    )
    AND to_regclass('public.rental_handover_records') IS NOT NULL
    AND to_regclass('public.rental_handover_items') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname='rental_handover_records_contract_owner_fk'
    )
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname='rental_handover_records_deposit_owner_fk'
    )
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname='rental_handover_records_type_unique'
    )
    AND to_regclass('public.rental_reservations') IS NOT NULL
    AND to_regclass('public.rental_lifecycle_events') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname='public' AND indexname='idx_rental_reservations_one_active_room'
    )
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname='rental_reservations_converted_contract_owner_fk'
    )
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname='rental_lifecycle_events_contract_owner_fk'
    )
    AND to_regclass('public.room_maintenance_periods') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_indexes
      WHERE schemaname='public' AND indexname='idx_room_maintenance_one_active_room'
    )
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname='rental_lifecycle_events_maintenance_owner_fk'
    )
    AND to_regclass('public.rental_final_settlements') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema='public' AND table_name='rent_invoices'
        AND column_name='final_total_vnd'
    )
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname='rental_final_settlements_contract_owner_fk'
    )
    AND EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname='rent_invoice_finalization_immutable_before_update'
    )
    AND to_regclass('public.account_memberships') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname='account_memberships_owner_shape_valid'
    )
    AND EXISTS (
      SELECT 1 FROM pg_trigger
      WHERE tgname='users_assign_owner_account_membership'
    )
    AND to_regclass('public.account_member_property_access') IS NOT NULL
    AND to_regclass('public.account_member_operation_access') IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname='account_member_property_owner_fk'
    )
    AND EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname='account_member_operation_valid'
    ) AS schema_ready`;

function runtimeRoleReady(appEnvironment, row = {}) {
  if (!['production', 'staging'].includes(appEnvironment)) return true;
  return row.runtime_role === 'tro_bill_runtime_sql'
    && row.inherits_neon_superuser === false;
}

function baseHealth() {
  return {
    service: 'trobill-api',
    environment: inspectRuntimeEnvironment().appEnvironment,
    revision: String(process.env.VERCEL_GIT_COMMIT_SHA || process.env.GIT_COMMIT_SHA || 'local').slice(0, 12),
    timestamp: new Date().toISOString()
  };
}

function live(req, res) {
  res.set('Cache-Control', 'no-store');
  return res.json({ status: 'ok', ...baseHealth() });
}

async function ready(req, res) {
  res.set('Cache-Control', 'no-store');
  const configuration = inspectRuntimeEnvironment();
  if (!configuration.valid) {
    return res.status(503).json({
      status: 'not-ready',
      ...baseHealth(),
      checks: {
        configuration: configuration.issues.map(issue => issue.code),
        database: 'not-checked'
      }
    });
  }

  try {
    const schema = await db.query(SCHEMA_READY_QUERY);
    if (!runtimeRoleReady(configuration.appEnvironment, schema.rows[0])) {
      const error = new Error('Database runtime role còn quyền quản trị vượt mức cần thiết');
      error.code = 'DATABASE_RUNTIME_ROLE_NOT_READY';
      const incidentId = await reportOperationalError(error, {
        event: 'database_runtime_role_not_ready',
        requestId: req.requestId,
        method: req.method,
        route: '/api/health/ready',
        statusCode: 503,
        message: 'Database runtime role chưa đạt least privilege'
      });
      res.locals.incidentId = incidentId;
      return res.status(503).json({
        status: 'not-ready',
        incidentId,
        ...baseHealth(),
        checks: {
          configuration: 'ok',
          configurationWarnings: configuration.warnings.map(warning => warning.code),
          database: 'ok',
          runtimeRole: 'privileged'
        }
      });
    }
    if (schema.rows[0]?.schema_ready !== true) {
      const error = new Error('Database schema chưa áp dụng đủ migration bắt buộc');
      error.code = 'DATABASE_SCHEMA_NOT_READY';
      const incidentId = await reportOperationalError(error, {
        event: 'database_schema_not_ready',
        requestId: req.requestId,
        method: req.method,
        route: '/api/health/ready',
        statusCode: 503,
        message: 'Database schema thiếu migration bắt buộc'
      });
      res.locals.incidentId = incidentId;
      return res.status(503).json({
        status: 'not-ready',
        incidentId,
        ...baseHealth(),
        checks: {
          configuration: 'ok',
          configurationWarnings: configuration.warnings.map(warning => warning.code),
          database: 'ok',
          runtimeRole: 'restricted',
          schema: 'migration-required'
        }
      });
    }
    return res.json({
      status: 'ok',
      ...baseHealth(),
      checks: {
        configuration: 'ok',
        configurationWarnings: configuration.warnings.map(warning => warning.code),
        database: 'ok',
        runtimeRole: 'restricted',
        schema: 'ok'
      }
    });
  } catch (error) {
    const incidentId = await reportOperationalError(error, {
      event: 'database_health_check_failed',
      requestId: req.requestId,
      method: req.method,
      route: '/api/health/ready',
      statusCode: 503,
      message: 'Database health check thất bại'
    });
    res.locals.incidentId = incidentId;
    return res.status(503).json({
      status: 'not-ready',
      incidentId,
      ...baseHealth(),
      checks: {
        configuration: 'ok',
        configurationWarnings: configuration.warnings.map(warning => warning.code),
        database: 'failed',
        runtimeRole: 'not-checked',
        schema: 'not-checked'
      }
    });
  }
}

module.exports = { SCHEMA_READY_QUERY, live, ready, runtimeRoleReady };
