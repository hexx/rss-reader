import { describe, expect, it, vi } from 'vitest';

import { createSyncCronRunner } from './cron.js';

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });

  return {
    promise,
    resolve,
    reject,
  };
}

describe('createSyncCronRunner', () => {
  it('skips overlapping cron runs', async () => {
    const deferred = createDeferred<void>();
    const runSync = vi.fn().mockReturnValue(deferred.promise);
    const log = {
      error: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };

    const runner = createSyncCronRunner({
      log,
      runSync,
      scheduleJob: vi.fn() as never,
    });

    const firstRun = runner.runOnce();
    await Promise.resolve();

    await expect(runner.runOnce()).resolves.toBe(false);
    expect(log.warn).toHaveBeenCalledWith(
      '定期同期をスキップしました。前回の処理がまだ完了していません。',
    );

    deferred.resolve();
    await expect(firstRun).resolves.toBe(true);
    expect(runSync).toHaveBeenCalledTimes(1);
  });
});
