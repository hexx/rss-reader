import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '../test/setup.js';
import { createTestDatabase } from '../test-utils/sqljs-db.js';
import {
  createTestEgressContext,
  installVirtualEgressTime,
  resetEgressTestHooks,
  type VirtualClock,
} from '../test-utils/egress.js';
import {
  acquireEgressSlot,
  bucketKeyOf,
  coolingUntilMs,
  createD1BucketStore,
  EGRESS_POLICY,
  EgressUnavailableError,
  markThrottled,
  startEgressRequest,
  ThrottleError,
} from './egress.js';

const hatenaFeedUrl = 'https://konifar-zatsu.hatenadiary.jp/rss';
const defaultUrl = 'https://example.com/feed.xml';
const throttleProbeUrl = 'https://throttle.test/feed';

describe('bucketKeyOf (取得枠の解決)', () => {
  it('束ねた運用者群は 1 枠になる（はてな系 4 パターン）', () => {
    expect(bucketKeyOf('https://b.hatena.ne.jp/hotentry.rss')).toBe('hatena');
    expect(bucketKeyOf('https://b.hatena.ne.jp/entry/jsonlite/')).toBe('hatena');
    expect(bucketKeyOf(hatenaFeedUrl)).toBe('hatena');
    expect(bucketKeyOf('https://konifar.hatenablog.com/rss')).toBe('hatena');
    expect(bucketKeyOf('https://hatena.ne.jp/')).toBe('hatena');
  });

  it('群に属さない相手は登録可能ドメイン 1 つ = 1 枠', () => {
    expect(bucketKeyOf('https://www.qiita.com/popular-items/feed')).toBe('qiita.com');
    expect(bucketKeyOf('https://qiita.com/tags/ai/feed')).toBe('qiita.com');
    expect(bucketKeyOf('https://note.com/foo/bar')).toBe('note.com');
    expect(bucketKeyOf('https://sub.example.co.jp/feed')).toBe('example.co.jp');
    expect(bucketKeyOf('https://a.b.example.com/')).toBe('example.com');
  });

  it('IP リテラルと不正 URL は枠キーを壊さない', () => {
    expect(bucketKeyOf('http://169.254.169.254/')).toBe('169.254.169.254');
    expect(bucketKeyOf('not a url')).toBe('unknown');
  });
});

describe('acquireEgressSlot (枠の予約)', () => {
  let clock: VirtualClock;

  beforeEach(() => {
    clock = installVirtualEgressTime();
  });

  afterEach(() => {
    resetEgressTestHooks();
  });

  it('既定の枠は 1 秒（ジッター 0 で最小間隔）あけないと次の予約が取れない', async () => {
    const egress = createTestEgressContext();

    await expect(acquireEgressSlot(egress, defaultUrl)).resolves.toMatchObject({ acquired: true });
    await expect(acquireEgressSlot(egress, defaultUrl)).resolves.toMatchObject({
      acquired: false,
      reason: 'occupied',
    });

    clock.advance(EGRESS_POLICY.defaultMinimumDelayMs);
    await expect(acquireEgressSlot(egress, defaultUrl)).resolves.toMatchObject({ acquired: true });
  });

  it('はてな群は 3 秒の間隔を守る（defer は待たずに断る）', async () => {
    const egress = createTestEgressContext();

    // 合意どおり force はクールダウンだけを無視し、枠内の最小間隔は守る。
    await expect(acquireEgressSlot(egress, hatenaFeedUrl)).resolves.toMatchObject({ acquired: true });
    await expect(acquireEgressSlot(egress, hatenaFeedUrl)).resolves.toMatchObject({
      acquired: false,
      reason: 'occupied',
    });
    clock.advance(EGRESS_POLICY.defaultMinimumDelayMs);
    await expect(acquireEgressSlot(egress, 'https://konifar.hatenablog.com/rss')).resolves.toMatchObject({
      acquired: false,
      reason: 'occupied',
    });

    clock.advance(EGRESS_POLICY.hatenaMinimumDelayMs);
    await expect(acquireEgressSlot(egress, 'https://konifar.hatenablog.com/rss')).resolves.toMatchObject({
      acquired: true,
      bucket: 'hatena',
    });
  });

  it('wait モードは枠が空くまで（仮想時間で）待つ', async () => {
    const egress = createTestEgressContext();
    await acquireEgressSlot(egress, hatenaFeedUrl);

    const before = clock.now();
    const reservation = await acquireEgressSlot(egress, hatenaFeedUrl, { mode: 'wait' });

    expect(reservation.acquired).toBe(true);
    expect(clock.now() - before).toBeGreaterThanOrEqual(EGRESS_POLICY.hatenaMinimumDelayMs);
  });

  it('wait モードでもクールダウンが待機上限より遠ければ待たずに返す', async () => {
    const egress = createTestEgressContext();
    await markThrottled(egress, 'hatena', null);

    const reservation = await acquireEgressSlot(egress, hatenaFeedUrl, { mode: 'wait' });
    expect(reservation).toMatchObject({ acquired: false, reason: 'cooldown' });
  });

  it('wait モードは最大待機時間を超えて待たない（超えたら occupied）', async () => {
    const egress = createTestEgressContext();
    // 他の実行が遠くまで枠を進めておく（クールダウンなし＝ occupied のみ）。
    const far = clock.now() + EGRESS_POLICY.maximumSlotWaitMs + 60_000;
    await egress.store.spaceOut('example.com', far);
    const before = clock.now();

    const reservation = await acquireEgressSlot(egress, defaultUrl, { mode: 'wait' });

    expect(reservation).toMatchObject({ acquired: false, reason: 'occupied' });
    expect(clock.now() - before).toBeLessThanOrEqual(EGRESS_POLICY.maximumSlotWaitMs + 1);
  });

  it('force（ignoreCooldown）はクールダウンを無視して予約する', async () => {
    const egress = createTestEgressContext({ ignoreCooldown: true });
    await markThrottled(egress, 'hatena', null);

    // 合意どおり force はクールダウンだけを無視し、枠内の最小間隔は守る。
    await expect(acquireEgressSlot(egress, hatenaFeedUrl)).resolves.toMatchObject({ acquired: true });
    await expect(acquireEgressSlot(egress, hatenaFeedUrl)).resolves.toMatchObject({
      acquired: false,
      reason: 'occupied',
    });
  });

  it('force の wait はクールダウンを待たず、礼儀の間隔だけ待つ', async () => {
    const egress = createTestEgressContext({ ignoreCooldown: true });
    await markThrottled(egress, 'hatena', '86400'); // 1 日のクールダウン
    const before = clock.now();

    const reservation = await acquireEgressSlot(egress, hatenaFeedUrl, { mode: 'wait' });

    expect(reservation.acquired).toBe(true);
    // 1 日ではなく、はてな群の最小間隔ぶんだけ待って通る。
    expect(clock.now() - before).toBeLessThan(EGRESS_POLICY.maximumSlotWaitMs);
  });
});

describe('markThrottled (クールダウン段階)', () => {
  let clock: VirtualClock;

  beforeEach(() => {
    clock = installVirtualEgressTime();
  });

  afterEach(() => {
    resetEgressTestHooks();
  });

  it('30分 → 60分 → 90分と段階を踏み、90分が cap', async () => {
    const egress = createTestEgressContext();
    const bucket = 'example.com';

    const first = await markThrottled(egress, bucket, null);
    expect(first - clock.now()).toBe(EGRESS_POLICY.cooldownStepsMs[0]);

    const second = await markThrottled(egress, bucket, null);
    expect(second - clock.now()).toBe(EGRESS_POLICY.cooldownStepsMs[1]);

    const third = await markThrottled(egress, bucket, null);
    expect(third - clock.now()).toBe(EGRESS_POLICY.cooldownStepsMs[2]);

    await markThrottled(egress, bucket, null);
    await expect(coolingUntilMs(egress, defaultUrl)).resolves.toBeGreaterThanOrEqual(third);

    // 90 分以上にはならない（cap）。
    const state = await egress.store.read(bucket);
    expect((state?.cooldownUntilMs ?? 0) - clock.now()).toBeLessThanOrEqual(EGRESS_POLICY.cooldownCapMs);
  });

  it('Retry-After は秒数でも HTTP date でも尊重し、cap 超でも従う', async () => {
    const egress = createTestEgressContext();

    const secondsUntil = await markThrottled(egress, 'a.test', '120');
    expect(secondsUntil - clock.now()).toBe(120_000);

    // cap（90分）を超える要求は丸めず従う。
    const egressCap = createTestEgressContext();
    const beyondCap = await markThrottled(egressCap, 'b.test', '86400');
    expect(beyondCap - clock.now()).toBe(86_400_000);

    const egressDate = createTestEgressContext();
    const target = new Date(clock.now() + 5 * 60 * 1000).toUTCString();
    const dateUntil = await markThrottled(egressDate, 'c.test', target);
    expect(dateUntil).toBeGreaterThanOrEqual(clock.now() + 4 * 60 * 1000);
  });

  it('成功で連続障害とクールダウンが戻る', async () => {
    const egress = createTestEgressContext();
    await markThrottled(egress, 'example.com', null);
    await egress.store.markOk('example.com');

    await expect(coolingUntilMs(egress, defaultUrl)).resolves.toBeNull();
    const state = await egress.store.read('example.com');
    expect(state?.consecutiveThrottles).toBe(0);
  });
});

describe('startEgressRequest (HTTP 取得との連携)', () => {
  let clock: VirtualClock;

  beforeEach(() => {
    clock = installVirtualEgressTime();
  });

  afterEach(() => {
    resetEgressTestHooks();
    server.resetHandlers();
  });

  it('429 は ThrottleError になり枠にクールダウンが残る', async () => {
    const egress = createTestEgressContext();
    server.use(
      http.get(throttleProbeUrl, () =>
        new HttpResponse(null, { status: 429, headers: { 'Retry-After': '60' } })),
    );

    await expect(startEgressRequest(egress, throttleProbeUrl, {})).rejects.toBeInstanceOf(ThrottleError);
    await expect(coolingUntilMs(egress, throttleProbeUrl)).resolves.not.toBeNull();

    const rejection = await startEgressRequest(egress, throttleProbeUrl, {}).catch((error: unknown) => error);
    expect(rejection).toBeInstanceOf(EgressUnavailableError);
  });

  it('503 も律速として扱う', async () => {
    const egress = createTestEgressContext();
    server.use(http.get(throttleProbeUrl, () => new HttpResponse(null, { status: 503 })));

    await expect(startEgressRequest(egress, throttleProbeUrl, {})).rejects.toThrow(/Rate limited/u);
  });

  it('成功応答は連続障害を解除する', async () => {
    const egress = createTestEgressContext();
    await markThrottled(egress, 'throttle.test', '1');
    // Retry-After: 1 のクールダウンを明けてから再試行する。
    clock.advance(1_000);
    server.use(http.get(throttleProbeUrl, () => HttpResponse.text('ok')));

    const { response } = await startEgressRequest(egress, throttleProbeUrl, {});
    expect(response.status).toBe(200);

    const state = await egress.store.read('throttle.test');
    expect(state?.consecutiveThrottles).toBe(0);
    expect(state?.cooldownUntilMs).toBe(0);
  });

  it('通信失敗でも予約は取り消さない（間隔を守って相手を守り続ける）', async () => {
    const egress = createTestEgressContext();
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('network down'));

    await expect(startEgressRequest(egress, defaultUrl, {})).rejects.toThrow('network down');
    vi.mocked(globalThis.fetch).mockRestore();

    await expect(acquireEgressSlot(egress, defaultUrl)).resolves.toMatchObject({
      acquired: false,
      reason: 'occupied',
    });
  });
});

describe('createD1BucketStore (枠状態は D1 が権威)', () => {
  it('別々の実装（=別 isolate 相当）が同じ枠を予約しても 1 本しか通らない', async () => {
    const db = (await createTestDatabase()).db;
    const storeA = createD1BucketStore(db as unknown as Parameters<typeof createD1BucketStore>[0]);
    const storeB = createD1BucketStore(db as unknown as Parameters<typeof createD1BucketStore>[0]);

    const next = Date.now() + EGRESS_POLICY.hatenaMinimumDelayMs;
    await expect(storeA.reserve('hatena', next)).resolves.toBe(next);
    // 同じ D1 行を読む別実行は枠を奪えない。
    await expect(storeB.reserve('hatena', next + 1000)).resolves.toBeNull();

    await storeA.applyThrottle('hatena', Date.now() + EGRESS_POLICY.cooldownStepsMs[0]!);
    const state = await storeB.read('hatena');
    // クールダウンは礼儀の間隔とは別時刻として保持される（force は間隔だけ守らせる）。
    expect(state?.cooldownUntilMs).toBeGreaterThan(Date.now());
    expect(state?.consecutiveThrottles).toBe(1);
    expect(state?.nextAllowedAtMs).toBe(next);

    // markOk で連続障害とクールダウンが晴れる。
    await storeB.markOk('hatena');
    await expect(storeA.read('hatena')).resolves.toMatchObject({
      consecutiveThrottles: 0,
      cooldownUntilMs: 0,
    });
  });

  it('spaceOut は次回可能時刻を前に進めるだけ進める（後退させない）', async () => {
    const db = (await createTestDatabase()).db;
    const store = createD1BucketStore(db as unknown as Parameters<typeof createD1BucketStore>[0]);
    const far = Date.now() + 10_000;
    await store.reserve('hatena', far);

    await store.spaceOut('hatena', Date.now() + 1_000);
    await expect(store.read('hatena')).resolves.toMatchObject({ nextAllowedAtMs: far });
  });
});

describe('並行実行下のバックオフ（取りこぼし防止）', () => {
  let clock: VirtualClock;

  beforeEach(() => {
    clock = installVirtualEgressTime();
  });

  afterEach(() => {
    resetEgressTestHooks();
  });

  it('短い Retry-After が後から来てもクールダウンは戻るだけ（max で保つ）', async () => {
    const egress = createTestEgressContext();

    const long = await markThrottled(egress, 'example.com', '3600');
    await markThrottled(egress, 'example.com', '5');

    const state = await egress.store.read('example.com');
    expect(state?.cooldownUntilMs).toBe(long);
    expect(state?.cooldownUntilMs).toBeGreaterThan(clock.now() + 3_000_000);
  });

  it('連続障害回数は段階テーブルの長さを超えて増えない', async () => {
    const egress = createTestEgressContext();

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await markThrottled(egress, 'example.com', null);
    }
    const state = await egress.store.read('example.com');
    expect(state?.consecutiveThrottles).toBe(EGRESS_POLICY.cooldownStepsMs.length);
    expect((state?.cooldownUntilMs ?? 0) - clock.now()).toBeLessThanOrEqual(EGRESS_POLICY.cooldownCapMs);
  });
});
