'use strict';

const db = require('./db');
const { inspectRuntimeEnvironment } = require('./environment');
const { reportOperationalError } = require('./observability');

const SCHEMA_READY_QUERY = `
  SELECT
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
    ) AS schema_ready`;

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
        schema: 'not-checked'
      }
    });
  }
}

module.exports = { SCHEMA_READY_QUERY, live, ready };
