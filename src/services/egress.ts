import { sql } from 'drizzle-orm';

import { getDb } from '../db/index.js';
import { fetchBucket } from '../db/schema.js';

/**
 * 外部取得（フィード・記事本文・はてブ jsonlite）を律速する共通層（ADR-0009）。
 *
 * - 律速の単位は **取得枠（Fetch Bucket）**。既定は登録可能ドメイン（eTLD+1）。
 *   同一の相手が同一の制限を課していると扱う **運用者群（Operator Group）** は
 *   コード内設定で 1 枠に束ねる。
 * - 枠の状態は isolate メモリではなく **D1 に置く**（cron 実行は別 isolate で走るため、
 *   メモリ保持では実行をまたいだクールダウンが実現できない）。
 * - 枠の予約は CAS（`UPDATE ... WHERE bucket = ? AND cooldown_until <= now AND next_allowed_at <= now`）で
 *   行い、同期全体を止める排他ロックは使わない（ADR-0002 の方針を維持）。
 */

/** 律速の既定値。env ではなくこの 1 箇所に集約する（ADR-0009）。 */
export const EGRESS_POLICY = {
  /** 既定の枠内最小間隔（下限／ジッター加算幅）= 1〜2 秒。 */
  defaultMinimumDelayMs: 1_000,
  defaultJitterSpanMs: 1_000,
  /** はてな群の枠内最小間隔（下限／ジッター加算幅）= 3〜6 秒。 */
  hatenaMinimumDelayMs: 3_000,
  hatenaJitterSpanMs: 3_000,
  /** クールダウン段階（連続障害回数で index、末尾が cap）= 30分 → 60分 → 90分。 */
  cooldownStepsMs: [30 * 60 * 1_000, 60 * 60 * 1_000, 90 * 60 * 1_000],
  /** `Retry-After` がこれを超える場合は段階を打ち切って指示に優先服従する。 */
  cooldownCapMs: 90 * 60 * 1_000,
  /** パス2（記事処理）で枠の空きを待つ上限。超える項目はあきらめて次 run に回す。 */
  maximumSlotWaitMs: 60 * 1_000,
  /** 素直なリーダ UA（ADR-0011）。 */
  userAgent: 'rss-reader/1.0 (+https://github.com/hexx/rss-reader)',
} as const;

/** 運用者群（はてな群）。それ以外の相手は eTLD+1 を 1 枠とする。 */
const OPERATOR_GROUPS: readonly { key: string; test: (hostname: string) => boolean }[] = [
  {
    key: 'hatena',
    test: (hostname) =>
      matchesDomain(hostname, 'hatena.ne.jp')
      || matchesDomain(hostname, 'hatenablog.com')
      || matchesDomain(hostname, 'hatenadiary.jp'),
  },
];

function matchesDomain(hostname: string, domain: string): boolean {
  return hostname === domain || hostname.endsWith(`.${domain}`);
}

/**
 * 一般ドメインに対して登録可能ドメインとして扱う国別 2 段 TLD（日本中心）。
 *
 * 公開サフィックスリスト（PSL）の完全な写しではなく、購読先で現れうる範囲に絞った
 * 運用上の短縮リスト。失敗方向は安全側のみ：未収録の multi-label suffix（例 `co.za`）は
 * 末尾 2 ラベルを登録可能ドメインとして扱うため、本来より細かく割られるだけで、
 * 相手を叩く量は増えない（異なる運用者を同一枠に束ねる方向にしか狂わない）。
 * 逆方向（別々の相手を同一枠にして礼儀を緩める）ことは起こりえない。
 */
const TWO_LEVEL_PUBLIC_SUFFIXES = new Set([
  'co.jp',
  'ne.jp',
  'or.jp',
  'ac.jp',
  'go.jp',
  'com.jp',
  'co.uk',
  'org.uk',
  'ac.uk',
  'com.au',
  'net.au',
  'org.au',
  'co.kr',
  'or.kr',
  'com.br',
  'co.nz',
]);

/** 枠状態の永続化先。本番は D1、テストはメモリ実装を注入する。 */
export interface BucketStore {
  /**
   * 枠が空いていれば予約し、進んだ次回可能時刻を返す。空いていなければ null。
   * `respectCooldown` は CAS 側でもクールダウンを認めるかどうか（force 手動同期のみ false）。
   */
  reserve(bucket: string, nextAllowedAtMs: number, respectCooldown?: boolean): Promise<number | null>;
  read(bucket: string): Promise<BucketState | null>;
  /** クールダウン（次回取得可能時刻）と連続障害回数を更新する。 */
  applyThrottle(bucket: string, cooldownUntilMs: number): Promise<void>;
  /** 成功で連続障害を解除し、クールダウンを晴らす。 */
  markOk(bucket: string): Promise<void>;
  /** 予約を取り直さずに次回可能時刻だけを前に進める（同一操作内の後続リクエスト用）。 */
  spaceOut(bucket: string, nextAllowedAtMs: number): Promise<void>;
}

export interface BucketState {
  cooldownUntilMs: number;
  consecutiveThrottles: number;
  nextAllowedAtMs: number;
}

/** 律速層の実行コンテキスト。 */
export interface EgressContext {
  ignoreCooldown: boolean;
  store: BucketStore;
}

type AppDatabase = ReturnType<typeof getDb>;

export type SlotUnavailableReason = 'cooldown' | 'occupied';

export interface SlotReservation {
  acquired: boolean;
  bucket: string;
  /** 取得できなかった理由。 */
  reason?: SlotUnavailableReason;
  /** クールダウン中の場合、次回取得可能時刻（ms）。 */
  cooldownUntilMs?: number;
}

export interface EgressOptions {
  /** 'defer' は待機せず失敗を返す（パス1 のフィード取得）。'wait' は枠の空きを待つ（パス2）。 */
  mode?: 'defer' | 'wait';
  /** 'wait' 時の最大待機時間。 */
  maximumWaitMs?: number;
}

type SleepFn = (ms: number) => Promise<void>;
type RandomFn = () => number;
type NowFn = () => number;

let sleepFn: SleepFn = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});
let randomFn: RandomFn = Math.random;
let nowFn: NowFn = () => Date.now();

/** テスト用 DI。本番コードから呼ばない（`src/test-utils/egress.ts` 経由でのみ使う）。 */
export function _setSleepForTest(fn: SleepFn | null): void {
  sleepFn = fn ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
}

/** テスト用 DI。 */
export function _setRandomForTest(fn: RandomFn | null): void {
  randomFn = fn ?? Math.random;
}

/** テスト用 DI（時刻の固定）。 */
export function _setNowForTest(fn: NowFn | null): void {
  nowFn = fn ?? Date.now;
}

/** 枠が確保できなかったこと（クールダウン中 / 他実行が予約中）。 */
export class EgressUnavailableError extends Error {
  readonly bucket: string;
  readonly cooldownUntilMs: number;
  readonly reason: SlotUnavailableReason;

  constructor(bucket: string, reason: SlotUnavailableReason, cooldownUntilMs: number) {
    super(
      reason === 'cooldown'
        ? `Rate limited by policy: bucket ${bucket} is cooling down until ${new Date(cooldownUntilMs).toISOString()}.`
        : `Bucket ${bucket} is reserved by a concurrent run.`,
    );
    this.name = 'EgressUnavailableError';
    this.bucket = bucket;
    this.cooldownUntilMs = cooldownUntilMs;
    this.reason = reason;
  }
}

/** 相手からの律速要求（429/503）や、それに準じる異常応答。 */
export class ThrottleError extends Error {
  readonly bucket: string;
  readonly nextRetryAtMs: number;
  readonly status: number | null;

  constructor(
    message: string,
    options: { bucket: string; cause?: unknown; nextRetryAtMs: number; status?: number | null },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ThrottleError';
    this.bucket = options.bucket;
    this.nextRetryAtMs = options.nextRetryAtMs;
    this.status = options.status ?? null;
  }
}

export function isThrottleError(error: unknown): error is ThrottleError {
  return error instanceof ThrottleError;
}

export function isEgressUnavailableError(error: unknown): error is EgressUnavailableError {
  return error instanceof EgressUnavailableError;
}

function hostnameOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname.toLowerCase().replace(/\.$/u, '');
  } catch {
    return '';
  }
}

/** 取得枠のキーを解決する（運用者群 → eTLD+1 の順）。 */
export function bucketKeyOf(rawUrl: string): string {
  const hostname = hostnameOf(rawUrl);
  if (hostname.length === 0) {
    return 'unknown';
  }

  for (const group of OPERATOR_GROUPS) {
    if (group.test(hostname)) {
      return group.key;
    }
  }

  // IPv4 / IPv6 リテラルはこれ以上分解できないためそのまま枠キーにする。
  if (/^[0-9.]+$/u.test(hostname) || hostname.includes(':')) {
    return hostname;
  }

  const labels = hostname.split('.');
  if (labels.length <= 2) {
    return hostname;
  }
  const lastTwo = `${labels[labels.length - 2]}.${labels[labels.length - 1]}`;
  if (TWO_LEVEL_PUBLIC_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join('.');
  }
  return lastTwo;
}

function delayForBucket(bucket: string): number {
  const hatena = bucket === 'hatena';
  const minimum = hatena ? EGRESS_POLICY.hatenaMinimumDelayMs : EGRESS_POLICY.defaultMinimumDelayMs;
  const span = hatena ? EGRESS_POLICY.hatenaJitterSpanMs : EGRESS_POLICY.defaultJitterSpanMs;
  return minimum + Math.floor(randomFn() * (span + 1));
}

/** `Retry-After`（秒数 / HTTP date）を次回取得可能時刻に変換する。読めなければ null。 */
function parseRetryAfterMs(value: string | null, nowMs: number): number | null {
  if (value === null) {
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  if (/^\d+$/u.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    return seconds > 0 ? nowMs + seconds * 1000 : null;
  }
  const asDate = new Date(trimmed);
  return Number.isNaN(asDate.getTime()) ? null : asDate.getTime();
}

/** 連続障害回数に応じたクールダウン段階（30分 → 60分 → 90分で打ち切り）。 */
function stepCooldownUntilMs(consecutiveThrottles: number, nowMs: number): number {
  const index = Math.min(
    Math.max(consecutiveThrottles, 1) - 1,
    EGRESS_POLICY.cooldownStepsMs.length - 1,
  );
  return nowMs + EGRESS_POLICY.cooldownStepsMs[index]!;
}

async function attemptReserve(
  store: BucketStore,
  bucket: string,
  ignoreCooldown: boolean,
): Promise<SlotReservation> {
  const now = nowFn();
  if (!ignoreCooldown) {
    const state = await store.read(bucket);
    if (state !== null && state.cooldownUntilMs > now) {
      return { acquired: false, bucket, cooldownUntilMs: state.cooldownUntilMs, reason: 'cooldown' };
    }
  }

  const reservedUntil = await store.reserve(bucket, now + delayForBucket(bucket), !ignoreCooldown);
  if (reservedUntil === null) {
    const state = await store.read(bucket);
    if (!ignoreCooldown && state !== null && state.cooldownUntilMs > now) {
      return { acquired: false, bucket, cooldownUntilMs: state.cooldownUntilMs, reason: 'cooldown' };
    }
    return { acquired: false, bucket, reason: 'occupied' };
  }
  return { acquired: true, bucket };
}

/**
 * 取得枠を 1 つ確保する。
 * `mode: 'defer'`（既定）は待機せずに取り可否だけを返し、
 * `mode: 'wait'` は最大 `maximumWaitMs` まで待って枠を待つ。
 * クールダウンが待機上限より遠い場合は待機せずに 'cooldown' を返す。
 */
export async function acquireEgressSlot(
  egress: EgressContext,
  rawUrl: string,
  options: EgressOptions = {},
): Promise<SlotReservation> {
  const bucket = bucketKeyOf(rawUrl);
  const ignoreCooldown = egress.ignoreCooldown;
  const first = await attemptReserve(egress.store, bucket, ignoreCooldown);
  if (first.acquired || first.reason === 'cooldown') {
    return first;
  }
  if ((options.mode ?? 'defer') === 'defer') {
    return first;
  }

  const maximumWaitMs = options.maximumWaitMs ?? EGRESS_POLICY.maximumSlotWaitMs;
  const deadline = nowFn() + maximumWaitMs;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const state = await egress.store.read(bucket);
    const now = nowFn();
    if (state === null) {
      return first;
    }
    if (state.cooldownUntilMs > deadline) {
      return { acquired: false, bucket, cooldownUntilMs: state.cooldownUntilMs, reason: 'cooldown' };
    }

    const waitUntilMs = Math.max(state.cooldownUntilMs, state.nextAllowedAtMs);
    if (waitUntilMs > now) {
      await sleepFn(Math.min(waitUntilMs - now, deadline - now));
    } else {
      await sleepFn(Math.min(100, Math.max(1, deadline - nowFn())));
    }

    const retry = await attemptReserve(egress.store, bucket, ignoreCooldown);
    if (retry.acquired || retry.reason === 'cooldown') {
      return retry;
    }
    if (nowFn() >= deadline) {
      return retry;
    }
  }

  return { acquired: false, bucket, reason: 'occupied' };
}

/**
 * 論理操作（フィード取得 1 件・記事本文 1 件・はてブ 1 件）の最初の HTTP リクエストを行う。
 * 枠を 1 つ確保し、429/503 は ThrottleError（枠にクールダウンを設定済み）にする。
 *
 * リダイレクト追随など同一操作内の後続リクエストは `continueEgressRequest` を使うこと
 * （1 リクエストごとに枠を消費すると、多重リダイレクトで自分自身の枠に詰まる）。
 */
export async function startEgressRequest(
  egress: EgressContext,
  rawUrl: string,
  init: RequestInit,
  options: EgressOptions = {},
): Promise<{ bucket: string; response: Response }> {
  const reservation = await acquireEgressSlot(egress, rawUrl, options);
  if (!reservation.acquired) {
    throw new EgressUnavailableError(
      reservation.bucket,
      reservation.reason ?? 'occupied',
      reservation.cooldownUntilMs ?? 0,
    );
  }

  // 失敗しても予約は取り消さない。予約済み間隔（1〜3 秒）をそのまま守らせるほうが
  // 通信断の連続リトライで相手を叩かない（ADR-0009 の礼儀）。
  const response = await performRequest(egress, reservation.bucket, rawUrl, init);
  return { bucket: reservation.bucket, response };
}

/** 確保済みの枠を使い、同一操作内の後続リクエスト（リダイレクト追随・UA 退避）を行う。 */
export async function continueEgressRequest(
  egress: EgressContext,
  bucket: string,
  rawUrl: string,
  init: RequestInit,
): Promise<Response> {
  await spaceOutEgressSlot(egress, bucket);
  return performRequest(egress, bucket, rawUrl, init);
}

async function performRequest(
  egress: EgressContext,
  bucket: string,
  rawUrl: string,
  init: RequestInit,
): Promise<Response> {
  const response = await fetch(rawUrl, init);
  if (response.status === 429 || response.status === 503) {
    const nextRetryAtMs = await markThrottled(egress, bucket, response.headers.get('Retry-After'));
    throw new ThrottleError(`Rate limited by ${bucket}: ${response.status} ${response.statusText}`, {
      bucket,
      nextRetryAtMs,
      status: response.status,
    });
  }
  if (response.ok) {
    await egress.store.markOk(bucket);
  }
  return response;
}

/**
 * 異常応答（429/503、200 だが HTML エラーページ、不正 JSON、本文サイズ超過、タイムアウト）を
 * 枠に記録してクールダウンを設定する。
 * @returns 次回取得可能時刻（ms）
 */
export async function markThrottled(
  egress: EgressContext,
  bucket: string,
  retryAfter: string | null = null,
): Promise<number> {
  const now = nowFn();
  const state = await egress.store.read(bucket);
  const consecutiveThrottles = (state?.consecutiveThrottles ?? 0) + 1;

  const retryAfterMs = parseRetryAfterMs(retryAfter, now);
  const stepMs = stepCooldownUntilMs(consecutiveThrottles, now);
  const targetMs = retryAfterMs ?? Math.min(stepMs, now + EGRESS_POLICY.cooldownCapMs);
  const cooldownUntilMs = Math.max(state?.cooldownUntilMs ?? 0, targetMs);

  await egress.store.applyThrottle(bucket, cooldownUntilMs);
  return cooldownUntilMs;
}

/** 同一操作内の後続リクエストを使ったぶん、枠の次回可能時刻を前に進める。 */
async function spaceOutEgressSlot(egress: EgressContext, bucket: string): Promise<void> {
  await egress.store.spaceOut(bucket, nowFn() + delayForBucket(bucket));
}

/** クールダウン中なら次回取得可能時刻（ms）、でなければ null。 */
export async function coolingUntilMs(egress: EgressContext, rawUrl: string): Promise<number | null> {
  const state = await egress.store.read(bucketKeyOf(rawUrl));
  if (state === null) {
    return null;
  }
  return state.cooldownUntilMs > nowFn() ? state.cooldownUntilMs : null;
}

/** D1 を権威とする枠ストア（本番用）。 */
export function createD1BucketStore(database: AppDatabase): BucketStore {
  const ensureRow = async (bucket: string): Promise<void> => {
    await database
      .insert(fetchBucket)
      .values({ bucket, consecutiveThrottles: 0, cooldownUntil: 0, nextAllowedAt: 0 })
      .onConflictDoNothing()
      .run();
  };

  return {
    async reserve(bucket, nextAllowedAtMs, respectCooldown = true) {
      const now = nowFn();
      await ensureRow(bucket);

      const rows = await database
        .update(fetchBucket)
        .set({ nextAllowedAt: nextAllowedAtMs })
        .where(
          respectCooldown
            ? sql`${fetchBucket.bucket} = ${bucket}
                AND ${fetchBucket.cooldownUntil} <= ${now}
                AND ${fetchBucket.nextAllowedAt} <= ${now}`
            : sql`${fetchBucket.bucket} = ${bucket} AND ${fetchBucket.nextAllowedAt} <= ${now}`,
        )
        .returning({ bucket: fetchBucket.bucket });

      return rows.length > 0 ? nextAllowedAtMs : null;
    },
    async read(bucket) {
      const rows = await database
        .select({
          consecutiveThrottles: fetchBucket.consecutiveThrottles,
          cooldownUntil: fetchBucket.cooldownUntil,
          nextAllowedAt: fetchBucket.nextAllowedAt,
        })
        .from(fetchBucket)
        .where(sql`${fetchBucket.bucket} = ${bucket}`)
        .limit(1);
      const row = rows[0];
      if (!row) {
        return null;
      }
      return {
        consecutiveThrottles: Number(row.consecutiveThrottles ?? 0),
        cooldownUntilMs: Number(row.cooldownUntil ?? 0),
        nextAllowedAtMs: Number(row.nextAllowedAt ?? 0),
      };
    },
    async applyThrottle(bucket, cooldownUntilMs) {
      const until = Math.max(cooldownUntilMs, nowFn());
      await ensureRow(bucket);
      // next_allowed_at（礼儀の間隔）は触らない。force はクールダウンだけを無視する
      // という合意（docs/specs/sync-egress-politeness.md）は、2 つの時刻を
      // 分けて持つことで成立する。
      await database
        .update(fetchBucket)
        .set({
          // 連続障害回数とクールダウンは、読み直した値ではなく DB 側の現在値を
          // 基準に更新する。並行実行が同時に 429 を記録しても、バックオフが
          // 一段戻ったり短い値で上書きされたりしない（ADR-0009）。
          consecutiveThrottles: sql`min(${fetchBucket.consecutiveThrottles} + 1, ${EGRESS_POLICY.cooldownStepsMs.length})`,
          cooldownUntil: sql`max(${fetchBucket.cooldownUntil}, ${until})`,
        })
        .where(sql`${fetchBucket.bucket} = ${bucket}`)
        .run();
    },
    async markOk(bucket) {
      await database
        .update(fetchBucket)
        .set({ consecutiveThrottles: 0, cooldownUntil: 0 })
        .where(sql`${fetchBucket.bucket} = ${bucket}`)
        .run();
    },
    async spaceOut(bucket, nextAllowedAtMs) {
      await database
        .update(fetchBucket)
        .set({ nextAllowedAt: sql`max(${fetchBucket.nextAllowedAt}, ${nextAllowedAtMs})` })
        .where(sql`${fetchBucket.bucket} = ${bucket}`)
        .run();
    },
  };
}

interface MemoryBucketState {
  consecutiveThrottles: number;
  cooldownUntil: number;
  nextAllowedAt: number;
}

function emptyBucketState(): MemoryBucketState {
  return { consecutiveThrottles: 0, cooldownUntil: 0, nextAllowedAt: 0 };
}

/** メモリ枠ストア（テスト専用。本番では isolate を跨げないため使わない）。 */
export function createMemoryBucketStore(): BucketStore & { buckets: Map<string, MemoryBucketState> } {
  const buckets = new Map<string, MemoryBucketState>();
  const empty = emptyBucketState;

  return {
    buckets,
    async reserve(bucket, nextAllowedAtMs, respectCooldown = true) {
      const now = nowFn();
      const state = buckets.get(bucket) ?? empty();
      if ((respectCooldown && state.cooldownUntil > now) || state.nextAllowedAt > now) {
        return null;
      }
      buckets.set(bucket, { ...state, nextAllowedAt: nextAllowedAtMs });
      return nextAllowedAtMs;
    },
    async read(bucket) {
      const state = buckets.get(bucket);
      if (!state) {
        return null;
      }
      return {
        consecutiveThrottles: state.consecutiveThrottles,
        cooldownUntilMs: state.cooldownUntil,
        nextAllowedAtMs: state.nextAllowedAt,
      };
    },
    async applyThrottle(bucket, cooldownUntilMs) {
      const state = buckets.get(bucket) ?? empty();
      buckets.set(bucket, {
        ...state,
        consecutiveThrottles: Math.min(state.consecutiveThrottles + 1, EGRESS_POLICY.cooldownStepsMs.length),
        cooldownUntil: Math.max(state.cooldownUntil, cooldownUntilMs, nowFn()),
      });
    },
    async markOk(bucket) {
      const state = buckets.get(bucket);
      if (!state) {
        return;
      }
      buckets.set(bucket, { ...state, consecutiveThrottles: 0, cooldownUntil: 0 });
    },
    async spaceOut(bucket, nextAllowedAtMs) {
      const state = buckets.get(bucket) ?? empty();
      buckets.set(bucket, { ...state, nextAllowedAt: Math.max(state.nextAllowedAt, nextAllowedAtMs) });
    },
  };
}

/** 本番用コンテキスト（D1 が権威）。 */
export function createEgressContext(
  env: Parameters<typeof getDb>[0],
  options: { ignoreCooldown?: boolean } = {},
): EgressContext {
  return { ignoreCooldown: options.ignoreCooldown ?? false, store: createD1BucketStore(getDb(env)) };
}
