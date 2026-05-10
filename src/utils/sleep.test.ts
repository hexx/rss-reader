import { afterEach, describe, expect, it, vi } from 'vitest';

import { sleep } from './sleep.js';

describe('sleep', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('resolves after the requested delay', async () => {
    vi.useFakeTimers();

    const promise = sleep(1_500);

    await vi.advanceTimersByTimeAsync(1_500);

    await expect(promise).resolves.toBeUndefined();
  });

  it('rejects negative durations', () => {
    expect(() => sleep(-1)).toThrow(RangeError);
  });
});

