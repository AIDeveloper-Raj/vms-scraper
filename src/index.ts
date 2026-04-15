// ─────────────────────────────────────────────────────────────────────────────
// index.ts — Entry point
// Modes:
//   node dist/index.js --server          → start dashboard only
//   node dist/index.js --account abtl    → run one account (CLI/PM2)
//   node dist/index.js                   → start dashboard + scheduler
// ─────────────────────────────────────────────────────────────────────────────

import 'dotenv/config';
import { logger } from './utils/logger';
import { startServer } from './server/app';
import { runAccount } from './runner';

const args = process.argv.slice(2);
const accountIdx = args.indexOf('--account');
const account = accountIdx >= 0 ? args[accountIdx + 1] : undefined;
const serverOnly = args.includes('--server');

process.on('SIGINT', async () => { logger.info('Shutting down…'); process.exit(0); });
process.on('unhandledRejection', (r) => logger.error('Unhandled', { r }));

async function main() {
  if (account) {
    // PM2 cron mode — run one account and exit
    logger.info(`CLI mode — running account: ${account}`);
    await runAccount(account);
    process.exit(0);
  }

  // Start the dashboard server always
  startServer();

  if (!serverOnly) {
    logger.info('Server started. Use the dashboard to trigger runs or set up PM2 cron.');
  }
}

main();
