'use strict';

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', 'server', '.env') });
const { inspectRuntimeEnvironment } = require('../server/environment');

const expectedEnvironment = process.argv.find(argument => !argument.startsWith('-') && argument !== process.argv[0] && argument !== process.argv[1]);
const strict = process.argv.includes('--strict');
const report = inspectRuntimeEnvironment();

console.log(`APP_ENV=${report.appEnvironment}`);
report.issues.forEach(issue => console.error(`ERROR ${issue.code}: ${issue.message}`));
report.warnings.forEach(warning => console.warn(`WARN ${warning.code}: ${warning.message}`));

if (expectedEnvironment && report.appEnvironment !== expectedEnvironment) {
  console.error(`ERROR APP_ENV_MISMATCH: mong đợi ${expectedEnvironment}, nhận ${report.appEnvironment}.`);
  process.exitCode = 1;
}
if (!report.valid || (strict && report.warnings.length)) process.exitCode = 1;

