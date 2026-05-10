export function sleep(ms: number): Promise<void> {
  if (!Number.isFinite(ms) || ms < 0) {
    throw new RangeError('sleep(ms) expects a non-negative finite number');
  }

  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

