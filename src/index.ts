import { sleep } from './utils/sleep.js';

async function main(): Promise<void> {
  await sleep(0);
  console.log('RSS reader scaffold ready.');
}

void main();

