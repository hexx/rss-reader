import { sleep } from './utils/sleep.js';
import { logger } from './utils/logger.js';

async function main(): Promise<void> {
  await sleep(0);
  logger.info('RSS reader scaffold ready.');
}

void main();
