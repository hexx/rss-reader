import { schedule, type ScheduledTask } from 'node-cron';

import type { RuntimeEnv } from './env.js';
import { logger } from './utils/logger.js';
import { syncAllSubscriptions } from './workflows/sync.js';

const defaultCronExpression = '0 */3 * * *';
type CronEnv = RuntimeEnv & {
  CRON_TIMEZONE?: string;
};

export interface CronLogger {
  error(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface SyncCronDependencies {
  expression?: string;
  log?: CronLogger;
  runSync?: () => Promise<void>;
  scheduleJob?: typeof schedule;
  timezone?: string;
}

export interface SyncCronRunner {
  start: () => ScheduledTask;
  isRunning: () => boolean;
  runOnce: () => Promise<boolean>;
}

export function createSyncCronRunner(
  dependencies: SyncCronDependencies = {},
  env: CronEnv = process.env,
): SyncCronRunner {
  const expression = dependencies.expression ?? defaultCronExpression;
  const log = dependencies.log ?? logger;
  const runSync = dependencies.runSync ?? (() => syncAllSubscriptions(false, env));
  const scheduleJob = dependencies.scheduleJob ?? schedule;
  const timezone = dependencies.timezone ?? env.CRON_TIMEZONE;

  let running = false;

  async function runOnce(): Promise<boolean> {
    if (running) {
      log.warn('定期同期をスキップしました。前回の処理がまだ完了していません。');
      return false;
    }

    running = true;
    log.info('定期同期を開始します。');

    try {
      await runSync();
      log.info('定期同期が完了しました。');
      return true;
    } catch (error) {
      log.error('定期同期に失敗しました。', { error });
      return false;
    } finally {
      running = false;
    }
  }

  function start(): ScheduledTask {
    const task = scheduleJob(
      expression,
      () => {
        void runOnce();
      },
      timezone === undefined ? undefined : { timezone },
    );

    log.info('定期同期ジョブを登録しました。', { expression, timezone: timezone ?? 'default' });
    return task;
  }

  return {
    start,
    isRunning: () => running,
    runOnce,
  };
}

export function startCron(env: CronEnv = process.env): ScheduledTask {
  return createSyncCronRunner({}, env).start();
}

if (process.argv[1]?.includes('src/cron.ts')) {
  startCron();
}
