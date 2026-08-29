/**
 * 律速層（egress）をテスト用に操作するユーティリティ。
 *
 * 本番コードからは import しない（テストファイルのみが使う）ことで、
 * `_set*ForTest` 系の関数が production bundle に混入するのを防ぐ。
 */

import {
  createMemoryBucketStore,
  type BucketStore,
  type EgressContext,
  _setNowForTest,
  _setRandomForTest,
  _setSleepForTest,
} from '../services/egress.js';

export type TestBucketStore = BucketStore & ReturnType<typeof createMemoryBucketStore>;

export interface VirtualClock {
  advance(ms: number): void;
  now(): number;
  set(ms: number): void;
}

export function createVirtualClock(startMs = 1_750_000_000_000): VirtualClock {
  let current = startMs;
  return {
    advance(ms: number) {
      current += ms;
    },
    now() {
      return current;
    },
    set(ms: number) {
      current = ms;
    },
  };
}

/**
 * 律速層の時刻・ジッター・sleep を仮想時間に差し替える。
 * sleep が仮想時計を進めるので、待機を一切実在待ちせずに間隔の約束を検証できる。
 */
export function installVirtualEgressTime(clock = createVirtualClock()): VirtualClock {
  _setNowForTest(() => clock.now());
  // ジッターを 0 に固定し、最小間隔ぴったりで動くようにする。
  _setRandomForTest(() => 0);
  _setSleepForTest(async (ms: number) => {
    clock.advance(ms);
  });
  return clock;
}

export function resetEgressTestHooks(): void {
  _setNowForTest(null);
  _setRandomForTest(null);
  _setSleepForTest(null);
}

/** メモリ枠のテスト用コンテキスト（本番は D1 が権威。isolate を跨ぐ検証は D1 側で行う）。 */
export function createTestEgressContext(options: { ignoreCooldown?: boolean } = {}): EgressContext & {
  store: TestBucketStore;
} {
  return {
    ignoreCooldown: options.ignoreCooldown ?? false,
    store: createMemoryBucketStore(),
  };
}
