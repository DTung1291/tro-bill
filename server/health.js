'use strict';

const db = require('./db');
const { inspectRuntimeEnvironment } = require('./environment');
const { reportOperationalError } = require('./observability');

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
    await db.query('SELECT 1 AS ready');
    return res.json({
      status: 'ok',
      ...baseHealth(),
      checks: {
        configuration: 'ok',
        configurationWarnings: configuration.warnings.map(warning => warning.code),
        database: 'ok'
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
        database: 'failed'
      }
    });
  }
}

module.exports = { live, ready };
