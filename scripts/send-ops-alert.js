'use strict';

const { sendOpsAlert } = require('../server/observability');

async function main() {
  const message = String(process.env.ALERT_MESSAGE || 'TrọBill operational workflow failed').slice(0, 1000);
  const result = await sendOpsAlert({ event: 'operations_workflow_failed', message });
  if (!result.delivered) console.log(`Không gửi cảnh báo: ${result.reason}`);
}

main().catch((error) => {
  console.error(`Không gửi được cảnh báo vận hành: ${error.code || error.name || 'ERROR'}`);
  process.exitCode = 1;
});

