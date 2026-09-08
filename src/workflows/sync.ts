import { and, asc, eq, isNull, lt, or, sql } from 'drizzle-orm';

import type { RuntimeEnv } from '../env.js';
import { getDb } from '../db/index.js';
import { isSyncWriteError, runWrite } from '../db/writeError.js';
import { articles, hatenaBookmarks, subscriptions } from '../db/schema.js';
import {
  bucketKeyOf,
  coolingUntilMs,
  createEgressContext,
  isEgressUnavailableError,
  isThrottleError,
  type EgressContext,
} from '../services/egress.js';
import {
  generateArticleSummary,
  generateHatenaSummary,
  isAiError,
  toAiError,
  validateAiConfiguration,
} from '../services/ai.js';
import { fetchHatenaBookmarks } from '../services/hatena.js';
import type { HatenaBookmarkComment } from '../services/hatena.js';
import { fetchArticleContent, fetchRssOrFallback, isArticleMissingError } from '../services/scraper.js';
import type { ScrapedLink } from '../services/scraper.js';
import { toErrorMessage } from '../utils/errors.js';
import { logger } from '../utils/logger.js';

const bookmarkChunkSize = 20;

/** 1 run あたりの はてブ補完（Backfill）上限。補完カーソルで巡回する（ADR-0010）。 */
export const backfillBudgetPerRun = 60;

/** 1 run あたりに生成するはてブ要約の上限（AI 呼び出しのバースト防止、従来どおり）。 */
export const maxHatenaSummaryBackfillsPerRun = 20;

/** 1 run あたりの本文補完（Content Backfill）上限。cron の wall 上限 15 分（ADR-0002）を守るため
 * 最悪ケース（全記事がタイムアウト + Jina タイムアウト ≈ 60 秒/件）でも約 6 分に抑える（ADR-0014）。 */
export const contentBackfillBudgetPerRun = 6;
/** 同じ記事の本文補完を再試行する間隔（ミリ秒、ADR-0014）。 */
const contentBackfillRetryIntervalMs = 24 * 60 * 60 * 1_000;
/**
 * 「今 run で取り込んだ行を除外する」時刻比較の安全余白（ミリ秒）。
 * `articles.created_at` の既定式は julianday を integer に切り捨てるため、run 開始より
 * 後に INSERT した行の `created_at` が run 開始時刻より最大数 ms **古い**値になり得る。
 * 余白なしだと ADR-0016 の除外が壊れて取りたての行を同じ run で再取得する
 * （2026-09-08 にテストで顕在化）。1 秒前までを「今 run の行」とみなして見送る。
 */
const sameRunCreatedGraceMs = 1_000;

/** 本文補完の連続失敗による断念回数（ADR-0015）。404/410 では即座に断念する。 */
const CONTENT_BACKFILL_GIVE_UP_THRESHOLD = 5;

/** AI生成処理の失敗を同期全体へ伝播させる。 */
async function runAi<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toAiError(error);
  }
}

/** epoch ms を ISO 文字列にする（ログで人が読める次回再試行時刻）。 */
function toIso(ms: number): string {
  return new Date(ms).toISOString();
}

type AppDatabase = ReturnType<typeof getDb>;

/** 同期 run の進行カウンタ（run 完了サマリログに使う）。 */
interface RunCounters {
  /** パス1でフィード取得に成功した Source 数。 */
  fetched: number;
  /** クールダウン等で取得をスキップした Source 数。 */
  skipped: number;
  /** 一時同期障害（429 等）を記録した Source 数。 */
  throttled: number;
  /** 同期した新着記事数。 */
  synced: number;
  /** クールダウンで空保存し、次フル同期の早期再試行待ちにした新着記事数（ADR-0016）。 */
  contentCooldownDeferred: number;
}

/** 同期中断（Sync Abort）の理由分類（ADR-0017。障害の恒久/一時は判別しない）。 */
type SyncAbortReason = 'ai-generation' | 'write' | 'unknown';

/** 中断ログに出す同期の開始経路。 */
export type SyncTrigger = 'api' | 'cron';

/** run 中の進行位置（中断ログで「どこで死んだか」を 1 行で復元するための記録）。 */
type SyncStage = 'content-backfill' | 'feed-fetch' | 'bookmark-backfill' | 'ingest';

/** run 全体で共有する状態（補完予算・AI 縮退の集計・進行位置）。 */
interface RunState {
  /** run 全体の残り補完予算（ADR-0010）。0 のときは補完を行わない。 */
  budgetRemaining: number;
  /** この実行で generateHatenaSummary を試行した回数（AI バースト防止）。 */
  summaryCount: number;
  /** 上限到達のログを 1 回だけ出すためのフラグ。 */
  capNotified: boolean;
  /** クールダウンによる打ち切りを 1 回だけログに出すフラグ（warn 乱発を防ぐ）。 */
  coolingNotified: boolean;
  /** はてブ要約の生成に失敗した回数（warn 継続・次回フル同期で回収: ADR-0017）。 */
  hatenaSummaryFailed: number;
  /** はてブ要約の失敗 warn を run 内で 1 本に抑えるフラグ。 */
  hatenaSummaryNotified: boolean;
  /** 中断ログ用の進行位置。 */
  progress: {
    articleUrl?: string;
    siteUrl?: string;
    stage: SyncStage;
  };
}

/** 購読 Source の行（パス1の入力）。 */
interface SubscriptionRow {
  backfillCursor: number;
  id: string;
  siteUrl: string;
}

/** パス1で取得済みのフィード。 */
interface FetchedFeed extends SubscriptionRow {
  items: ScrapedLink[];
}

/** パス2で Source ごとに持つ進行状態。 */
interface FeedWork {
  /** 記事 URL → 記事 ID。この run 開始時点で**既存だった**記事だけ（補完巡回の対象）。 */
  existingIds: Map<string, string>;
  feed: FetchedFeed;
  /** hatena_summary が未生成の記事 ID（補完成功時に要約を生成する対象）。 */
  nullSummaryArticleIds: Set<string>;
}

export interface SyncOptions {
  /** 律速層のコンテキスト。未指定なら env の D1 から作る（テストはメモリ枠を注入する）。 */
  egress?: EgressContext;
  /** クールダウンを無視して取得する（`POST /api/sync?force=true`）。枠内の間隔は守る。 */
  force?: boolean;
  /** 中断ログに出す開始経路（既定は api。cron は明示する）。 */
  trigger?: SyncTrigger;
}

/** AI 失敗と書き込み失敗を区別した中断理由（ADR-0017）。 */
function syncAbortReason(error: unknown): SyncAbortReason {
  if (isAiError(error)) {
    return 'ai-generation';
  }
  if (isSyncWriteError(error)) {
    return 'write';
  }
  return 'unknown';
}

/** 中断ログを記録済みのエラー（同じ障害で error を 2 本出さないため）。 */
const syncAbortLoggedErrors = new WeakSet<object>();

/** `runSync` が中断ログを出したエラーを覚える。エラー本体は書き換えない（凍結エラーで throw しないため）。 */
function markSyncAbortLogged(error: unknown): void {
  if (typeof error === 'object' && error !== null) {
    syncAbortLoggedErrors.add(error);
  }
}

/**
 * 同期中断が既に `同期を中断しました。` として記録済みかどうか。
 * cron / API の最終 catch はこれを見て、**検知の起点を `level: error` 1 本に絞る**（ADR-0017）。
 */
export function wasSyncAbortLogged(error: unknown): boolean {
  return typeof error === 'object' && error !== null && syncAbortLoggedErrors.has(error);
}

/**
 * はてブ要約の生成失敗を数え、run 内で 1 本だけ warn する（ADR-0017）。
 * Hatena Summary は `hatena_summary IS NULL` を補完巡回が拾うため、
 * 生成失敗は恒久欠損ではなく一時的遅延 — ここでは run を止めない。
 */
function recordHatenaSummaryFailure(
  state: RunState,
  error: unknown,
  context: { articleId?: string; articleUrl?: string; siteUrl: string },
): void {
  state.hatenaSummaryFailed += 1;
  if (state.hatenaSummaryNotified) {
    return;
  }
  state.hatenaSummaryNotified = true;
  logger.warn('はてブ要約の生成に失敗したため、未生成で保存します（次回フル同期の補完で回収）。', {
    ...context,
    error: toErrorMessage(error),
  });
}

/**
 * 1 記事分のはてなブックマークをチャンクで upsert する。
 * `(article_id, user)` の UNIQUE 制約で重複行の増殖を防ぎ、timestamp は
 * jsonlite が返す値（=ユーザーがブックマークした実時刻）をそのまま保存する。
 *
 * 競合時は `DO UPDATE` で `createdAt`（ブックマーク日時）と `comment` を
 * 最新化し、再取得で既存行が自然治癒するようにする（ADR-0003）。
 */
async function persistBookmarks(
  database: AppDatabase,
  articleId: string,
  bookmarks: readonly HatenaBookmarkComment[],
): Promise<void> {
  if (bookmarks.length === 0) {
    return;
  }
  for (let index = 0; index < bookmarks.length; index += bookmarkChunkSize) {
    const chunk = bookmarks.slice(index, index + bookmarkChunkSize);
    await runWrite(() =>
      database
        .insert(hatenaBookmarks)
        .values(
          chunk.map((bookmark) => ({
            articleId,
            comment: bookmark.comment,
            createdAt: bookmark.timestamp,
            id: crypto.randomUUID(),
            user: bookmark.user,
          })),
        )
        .onConflictDoUpdate({
          target: [hatenaBookmarks.articleId, hatenaBookmarks.user],
          set: {
            comment: sql`excluded.comment`,
            createdAt: sql`excluded.created_at`,
          },
        })
        .run(),
    );
  }
}

/**
 * 既存記事に対しはてなブックマークのみを冪等に再取得・保存する（はてブ補完）。
 *
 * 取得失敗は best-effort で握り潰し、同期全体を止めない（ADR-0009 の一時同期障害）。
 * 同一ユーザー重複は schema の UNIQUE 制約 `hatena_bookmarks_article_id_user_unique`
 * によって DB レベルで除外される。
 */
async function syncBookmarksForExistingArticle(
  database: AppDatabase,
  egress: EgressContext,
  env: RuntimeEnv,
  articleId: string,
  articleUrl: string,
  work: FeedWork,
  state: RunState,
): Promise<'cooling' | 'ok'> {
  state.progress = { articleUrl, siteUrl: work.feed.siteUrl, stage: 'bookmark-backfill' };
  let bookmarks: HatenaBookmarkComment[];
  try {
    bookmarks = await fetchHatenaBookmarks(egress, articleUrl);
  } catch (error) {
    // 枠の書き込み失敗は一時同期障害ではない（ADR-0017）。
    if (isSyncWriteError(error)) {
      throw error;
    }
    // クールダウン中なら warn を増やさない。run 内で 1 本だけ info に出し、
    // 呼び出し側はその Source の巡回を打ち切る（同じ枠は当時空かないため）。
    if (isEgressUnavailableError(error) && error.reason === 'cooldown') {
      if (!state.coolingNotified) {
        state.coolingNotified = true;
        logger.info('はてブ補完は取得枠のクールダウン中のため、この Source を打ち切ります。', {
          bucket: error.bucket,
          nextRetryAt: toIso(error.cooldownUntilMs),
          siteUrl: work.feed.siteUrl,
        });
      }
      return 'cooling';
    }
    if (isThrottleError(error)) {
      logger.warn('既存記事のはてなブックマークが律速されたため、スキップします。', {
        articleId,
        articleUrl,
        bucket: error.bucket,
        error: toErrorMessage(error),
        nextRetryAt: toIso(error.nextRetryAtMs),
      });
    } else {
      logger.warn('既存記事のはてなブックマーク再取得に失敗したため、スキップします。', {
        articleId,
        articleUrl,
        error: toErrorMessage(error),
      });
    }
    return 'ok';
  }
  await persistBookmarks(database, articleId, bookmarks);

  // 記事ごとの SELECT を避けるため、Source ごとに一度だけ事前ロードした
  // hatena_summary が NULL の記事 ID セットで判定する。
  if (work.nullSummaryArticleIds.has(articleId) && bookmarks.length > 0) {
    if (state.summaryCount >= maxHatenaSummaryBackfillsPerRun) {
      if (!state.capNotified) {
        state.capNotified = true;
        logger.info('はてブ要約のバックフィル上限に達したため、残りは次のフル同期に持ち越します。');
      }
      return 'ok';
    }
    state.summaryCount += 1;
    let hatenaSummary: string;
    try {
      hatenaSummary = await runAi(() => generateHatenaSummary(bookmarks, env));
    } catch (error) {
      if (!isAiError(error)) {
        throw error;
      }
      // はてブ要約の失敗は run を止めない（ADR-0017）。NULL のまま残るので次回以降の
      // 補完巡回（loadNullSummaryIds）が拾う。
      recordHatenaSummaryFailure(state, error, { articleId, articleUrl, siteUrl: work.feed.siteUrl });
      return 'ok';
    }
    await runWrite(() =>
      database
        .update(articles)
        .set({ hatenaSummary })
        .where(eq(articles.id, articleId))
        .run(),
    );
    work.nullSummaryArticleIds.delete(articleId);
    logger.info('取りこぼしていたはてブ要約をバックフィルで生成しました。', { articleId });
  }
  return 'ok';
}

/**
 * 1つの購読 Source を同期する（パス1: フィード取得、パス2: 記事処理）。
 * 既存記事は重複登録せず、新着記事を1回あたりの上限なく全件処理する。記事単位の逐次 INSERT で
 * 冪等なため、Worker の実行時間上限（Cron: wall 15分、手動: waitUntil 30秒）に達しても
 * 次回実行で再開される。詳細: docs/specs/sync-egress-politeness.md。
 *
 * AI（記事要約）の生成失敗、および D1 への書き込み失敗は同期中断（Sync Abort）になる（ADR-0017）。
 *
 * @param siteUrl 同期対象の購読 Source URL。
 * @param debug 失敗時に例外を再送出してデバッグしやすくするかどうか。
 * @param env DB・AI の各環境バインディング。
 * @param includeBookmarkBackfill 既存記事のはてなブックマーク再取得（補完）を行うかどうか。
 *   新着記事の取り込みに専念したい高頻度 Cron では false を渡す。
 * @param options 律速層コンテキストなどの注入点。
 * @returns 今回処理できた新着記事数。
 */
export async function syncSite(
  siteUrl: string,
  debug: boolean,
  env: RuntimeEnv,
  includeBookmarkBackfill = true,
  options: SyncOptions = {},
): Promise<number> {
  // RSS・はてな取得を始める前にAI設定を検証する。
  validateAiConfiguration(env);
  const database = getDb(env);
  const egress = options.egress ?? createEgressContext(env, { ignoreCooldown: options.force ?? false });

  const rows = await database
    .select({
      backfillCursor: subscriptions.backfillCursor,
      id: subscriptions.id,
      siteUrl: subscriptions.siteUrl,
    })
    .from(subscriptions)
    .where(eq(subscriptions.siteUrl, siteUrl))
    .limit(1);

  const subscription: SubscriptionRow = rows[0] ?? { backfillCursor: 0, id: '', siteUrl };
  return runSync(database, egress, env, [subscription], debug, includeBookmarkBackfill, options.trigger ?? 'api');
}

/**
 * 購読済み Source を二段同期で同期する（docs/specs/sync-egress-politeness.md）。
 *
 * - **パス1**: 全 Source のフィード取得だけを先に行う。取得枠が空かない Source は待機せず
 *   後回しにし、末尾で 1 度だけ再試行する（はてブ補完の待機列に埋もれて新着が餓死するのを防ぐ）。
 * - **パス2**: 取得済みフィードの新着記事を取り込み、残予算で はてブ補完 をカーソル巡回で行う。
 *
 * AI（記事要約）の生成失敗、および D1 への書き込み失敗は同期中断（Sync Abort）になる（ADR-0017）。
 * はてブ要約の生成失敗だけは、未生成ぶんが補完巡回で回収されるため中断しない。
 *
 * @param debug 失敗時に例外を再送出してデバッグしやすくするかどうか。
 * @param env DB・AI の各環境バインディング。
 * @param includeBookmarkBackfill はてブ補完を行うかどうか（取り込み専用 cron では false）。
 * @param options force はクールダウンだけを無視する（枠内の間隔は守る）。
 */
export async function syncAllSubscriptions(
  debug: boolean,
  env: RuntimeEnv,
  includeBookmarkBackfill = true,
  options: SyncOptions = {},
): Promise<void> {
  // 外部のRSS・はてな取得より前に設定不備を検出する。
  validateAiConfiguration(env);
  const database = getDb(env);
  const egress = options.egress ?? createEgressContext(env, { ignoreCooldown: options.force ?? false });

  const subscribedSites = await database
    .select({
      backfillCursor: subscriptions.backfillCursor,
      id: subscriptions.id,
      siteUrl: subscriptions.siteUrl,
    })
    .from(subscriptions);

  if (subscribedSites.length === 0) {
    logger.info('購読されている Source がありません。');
    return;
  }

  await runSync(
    database,
    egress,
    env,
    subscribedSites,
    debug,
    includeBookmarkBackfill,
    options.trigger ?? 'api',
  );
}

/**
 * パス1 → パス3 の進行そのもの。`syncSite` と `syncAllSubscriptions` が共有する。
 *
 * ここに伝わったエラーはすべて**同期中断（Sync Abort）**として 1 行構造的に記録する（ADR-0017）。
 * 中断を引き起こすのは Article Summary の AI 生成失敗と D1 書き込み失敗（`UNIQUE(url)` 競合は除く）。
 * cron / API 側の最終 catch は設定不備などの受け皿で、情報を重複させない。
 */
async function runSync(
  database: AppDatabase,
  egress: EgressContext,
  env: RuntimeEnv,
  subscriptionRows: readonly SubscriptionRow[],
  debug: boolean,
  includeBookmarkBackfill: boolean,
  trigger: SyncTrigger,
): Promise<number> {
  const startedAtMs = Date.now();
  const counters: RunCounters = {
    contentCooldownDeferred: 0,
    fetched: 0,
    skipped: 0,
    synced: 0,
    throttled: 0,
  };
  const state: RunState = {
    budgetRemaining: includeBookmarkBackfill ? backfillBudgetPerRun : 0,
    capNotified: false,
    coolingNotified: false,
    hatenaSummaryFailed: 0,
    hatenaSummaryNotified: false,
    progress: { stage: 'feed-fetch' },
    summaryCount: 0,
  };

  try {
    return await performSync(
      database,
      egress,
      env,
      subscriptionRows,
      debug,
      includeBookmarkBackfill,
      state,
      counters,
      startedAtMs,
    );
  } catch (error) {
    // ここに至ったエラーは同期中断（Sync Abort）。原因を問わず 1 行で構造的に出す（ADR-0017）。
    // cron / API の最終 catch はこれを引き継ぐだけなので、情報を落とさない。
    logger.error('同期を中断しました。', {
      articleUrl: state.progress.articleUrl,
      elapsedMs: Date.now() - startedAtMs,
      error: toErrorMessage(error),
      hatenaSummaryFailed: state.hatenaSummaryFailed,
      mode: includeBookmarkBackfill ? 'full' : 'ingest-only',
      reason: syncAbortReason(error),
      siteUrl: state.progress.siteUrl,
      skipped: counters.skipped,
      sources: counters.fetched,
      stage: state.progress.stage,
      synced: counters.synced,
      throttled: counters.throttled,
      trigger,
    });
    markSyncAbortLogged(error);
    throw error;
  }
}

/** パス1〜3 の実際の進行。中断ログの責任は呼び出し側の runSync にある。 */
async function performSync(
  database: AppDatabase,
  egress: EgressContext,
  env: RuntimeEnv,
  subscriptionRows: readonly SubscriptionRow[],
  debug: boolean,
  includeBookmarkBackfill: boolean,
  state: RunState,
  counters: RunCounters,
  startedAtMs: number,
): Promise<number> {
  // ===== パス1: 全 Source のフィード取得（最優先） =====
  const feeds = await collectFeeds(egress, subscriptionRows, counters, debug, state);

  // ===== パス2: 記事処理（新着取り込み → はてブ補完） =====
  await processFeeds(database, egress, env, feeds, state, counters, debug);

  // ===== パス3: 本文補完（Content Backfill、ADR-0014） =====
  // フル同期でのみ実行する（取り込み専用 cron では新着の取り込みを優先）。
  // ADR-0016: 今 run で取り込んだ NULL 行は対象外にする（createdAt < run 開始で除外し、同一 run 内の二重取得を防ぐ）。
  const recovered = await backfillContents(
    database,
    egress,
    env,
    state,
    includeBookmarkBackfill ? contentBackfillBudgetPerRun : 0,
    startedAtMs,
  );
  if (recovered > 0) {
    logger.info('本文補完で本文を回復しました。', { recovered });
  }

  logger.info('同期が完了しました。', {
    contentCooldownDeferred: counters.contentCooldownDeferred,
    elapsedMs: Date.now() - startedAtMs,
    hatenaSummaryFailed: state.hatenaSummaryFailed,
    skipped: counters.skipped,
    sources: counters.fetched,
    synced: counters.synced,
    throttled: counters.throttled,
  });
  return counters.synced;
}

/**
 * パス1: 購読 Source のフィードを順に取得する。
 * 枠が空かない・一時同期障害の Source は末尾に集め、1 度だけ再試行する（待機はしない）。
 */
async function collectFeeds(
  egress: EgressContext,
  subscriptionRows: readonly SubscriptionRow[],
  counters: RunCounters,
  debug: boolean,
  state: RunState,
): Promise<FetchedFeed[]> {
  const feeds: FetchedFeed[] = [];
  const deferred: SubscriptionRow[] = [];
  // 持ち越しログに理由を含めるため、未取得に終わった Source の最後の結果を記録する。
  // carried には後回し列（defer/throttled）以外に skipped（クールダウン）・failed も含まれるため、
  // 誤った理由を付けないよう ok 以外の全 outcome を記録する。
  const carryReasons = new Map<string, CarryReason>();

  for (const subscription of subscriptionRows) {
    const outcome = await tryFetchFeed(egress, subscription, feeds, counters, debug, state);
    if (outcome === 'ok') {
      continue;
    }
    carryReasons.set(subscription.siteUrl, outcome);
    if (outcome === 'defer' || outcome === 'throttled') {
      deferred.push(subscription);
    }
  }

  // パス1末尾: 他の Source を回している間に枠が空いた可能性があるので 1 周だけ再試行する。
  for (const subscription of deferred) {
    const outcome = await tryFetchFeed(egress, subscription, feeds, counters, debug, state, { quiet: true });
    if (outcome !== 'ok') {
      carryReasons.set(subscription.siteUrl, outcome);
    }
  }

  // それでも取得できなかった Source（Carry-over）は、理由を 1 行にまとめて次 run に譲る
  // （warn を増やさない。律速 warn は初回失敗時に出済みであるため）。枠の空きは予約しないので
  // 次回可能時刻は持たず、次の cron run で再試行する。
  const fetchedUrls = new Set(feeds.map((feed) => feed.siteUrl));
  const carried: Array<{ reason: CarryReason; siteUrl: string }> = [];
  for (const subscription of subscriptionRows) {
    const reason = carryReasons.get(subscription.siteUrl);
    if (!fetchedUrls.has(subscription.siteUrl) && reason !== undefined) {
      carried.push({ reason, siteUrl: subscription.siteUrl });
    }
  }
  if (carried.length > 0) {
    logger.info('未取得の Source を次回の同期に持ち越します。', {
      carried: carried.length,
      sources: carried,
    });
  }

  return feeds;
}

type FeedFetchOutcome = 'defer' | 'failed' | 'ok' | 'skipped' | 'throttled';

/** 持ち越しログに出す最後の結果（ok 以外の outcome）。 */
type CarryReason = Exclude<FeedFetchOutcome, 'ok'>;

/**
 * 1 Source のフィードを取得して `feeds` に加える。
 * @param context.quiet すでに warn 済みの再試行回であるため、律速ログを出さない。
 */
async function tryFetchFeed(
  egress: EgressContext,
  subscription: SubscriptionRow,
  feeds: FetchedFeed[],
  counters: RunCounters,
  debug: boolean,
  state: RunState,
  context: { quiet?: boolean } = {},
): Promise<FeedFetchOutcome> {
  const { siteUrl } = subscription;
  const bucket = bucketKeyOf(siteUrl);
  state.progress = { siteUrl, stage: 'feed-fetch' };

  if (!egress.ignoreCooldown) {
    const coolingUntil = await coolingUntilMs(egress, siteUrl);
    if (coolingUntil !== null) {
      logger.info('Source はクールダウン中のため取得をスキップします。', {
        bucket,
        nextAllowedAt: toIso(coolingUntil),
        siteUrl,
      });
      counters.skipped += 1;
      return 'skipped';
    }
  }

  logger.info('Source 同期を開始します。', { siteUrl });
  try {
    const items = await fetchRssOrFallback(egress, siteUrl);
    feeds.push({ backfillCursor: subscription.backfillCursor, id: subscription.id, items, siteUrl });
    counters.fetched += 1;
    logger.info('Source のフィードを取得しました。', { articles: items.length, siteUrl });
    return 'ok';
  } catch (error) {
    // 枠の予約・障害記録は D1 への書き込み。D1 が書けない状態は
    // 一時同期障害ではなく同期中断（ADR-0017）。
    if (isSyncWriteError(error)) {
      throw error;
    }
    if (isEgressUnavailableError(error)) {
      if (error.reason === 'cooldown') {
        logger.info('Source はクールダウン中のため取得をスキップします。', {
          bucket: error.bucket,
          nextAllowedAt: toIso(error.cooldownUntilMs),
          siteUrl,
        });
        counters.skipped += 1;
        return 'skipped';
      }
      // 他実行が枠を予約しているだけ。待機せず後回し列に譲る。
      // 「開始します」で途切れる行を作らないよう、defer も info で 1 行出す（仕様 §7）。
      logger.info('Source は取得枠が空かないため、後回しにします。', {
        bucket: error.bucket,
        siteUrl,
      });
      return 'defer';
    }

    if (isThrottleError(error)) {
      counters.throttled += 1;
      if (!context.quiet) {
        logger.warn('Source 同期が律速されました。クールダウンを設定したため次周で再試行します。', {
          bucket: error.bucket,
          error: toErrorMessage(error),
          nextRetryAt: toIso(error.nextRetryAtMs),
          siteUrl,
        });
      }
      return 'throttled';
    }

    if (debug) {
      console.error(error instanceof Error ? error.stack || error : error);
      throw error;
    }
    logger.warn('Source 同期に失敗しました。', {
      error: toErrorMessage(error),
      siteUrl,
    });
    return 'failed';
  }
}

/**
 * パス2: 取得済みフィードに対し、新着記事の取り込みとはてブ補完を行う。
 *
 * 新着の取り込みを先に行い、補完は run 予算（ADR-0010）の範囲でカーソル巡回する。
 */
async function processFeeds(
  database: AppDatabase,
  egress: EgressContext,
  env: RuntimeEnv,
  feeds: readonly FetchedFeed[],
  state: RunState,
  counters: RunCounters,
  debug: boolean,
): Promise<void> {
  const works: FeedWork[] = [];

  for (const feed of feeds) {
    const work: FeedWork = {
      existingIds: new Map(),
      feed,
      nullSummaryArticleIds: new Set(),
    };
    works.push(work);

    for (const item of feed.items) {
      const existingId = await findExistingArticleId(database, item.url);
      if (existingId !== null) {
        work.existingIds.set(item.url, existingId);
        continue;
      }
      await ingestNewArticle(database, egress, env, work, item, counters, debug, state);
    }
  }

  if (state.budgetRemaining > 0) {
    await backfillBookmarks(database, egress, env, works, state);
  }
}

/** 1 件の新着記事を取り込む（本文・はてブ・要約を保存）。 */
async function ingestNewArticle(
  database: AppDatabase,
  egress: EgressContext,
  env: RuntimeEnv,
  work: FeedWork,
  article: ScrapedLink,
  counters: RunCounters,
  debug: boolean,
  state: RunState,
): Promise<void> {
  const { siteUrl } = work.feed;
  try {
    state.progress = { articleUrl: article.url, siteUrl, stage: 'ingest' };
    logger.info('記事の同期処理を実行します。', { title: article.title, url: article.url });

    // 本文取得とはてブ取得は独立したネットワーク呼び出しなので並列化する。
    // どちらかが失敗しても記事の同期自体は継続する（本文失敗 → 本文なしで保存、
    // はてブ失敗 → コメントなしで保存。取りこぼしたはてブは補完巡回で埋める）。
    const [contentResult, bookmarksResult] = await Promise.allSettled([
      fetchArticleContent(egress, article.url, { jinaApiKey: env.JINA_API_KEY }),
      fetchHatenaBookmarks(egress, article.url),
    ]);

    // ADR-0016: クールダウン起因の本文見送りは info＋早期再試行待ちにする。
    // 枠に触れていないので試行時刻は進めない（contentBackfillAt=NULL のまま次フル同期で拾う）。
    const contentCooldown =
      contentResult.status === 'rejected'
      && isEgressUnavailableError(contentResult.reason)
      && contentResult.reason.reason === 'cooldown'
        ? contentResult.reason
        : null;
    if (contentCooldown !== null) {
      logger.info('本文は取得枠のクールダウン中のため、空保存して次フル同期で再試行します。', {
        articleUrl: article.url,
        bucket: contentCooldown.bucket,
        nextRetryAt: toIso(contentCooldown.cooldownUntilMs),
        siteUrl,
        title: article.title,
      });
      counters.contentCooldownDeferred += 1;
    } else if (contentResult.status === 'rejected') {
      logger.warn('本文の取得に失敗したため、本文なしで処理を継続します。', {
        articleUrl: article.url,
        error: toErrorMessage(contentResult.reason),
        siteUrl,
        title: article.title,
      });
    }
    if (bookmarksResult.status === 'rejected') {
      const reason = bookmarksResult.reason;
      if (isEgressUnavailableError(reason) && reason.reason === 'cooldown') {
        // クールダウン中は記事ごとに warn を出さない（コメントなしで保存し、補完巡回で埋める）。
        logger.info('はてなブックマークはクールダウン中のため、コメントなしで保存します。', {
          articleUrl: article.url,
          bucket: reason.bucket,
          nextRetryAt: toIso(reason.cooldownUntilMs),
          siteUrl,
          title: article.title,
        });
      } else {
        logger.warn('はてなブックマークの取得に失敗したため、コメントなしで処理を継続します。', {
          articleUrl: article.url,
          error: toErrorMessage(reason),
          siteUrl,
          title: article.title,
        });
      }
    }

    const content = contentResult.status === 'fulfilled' ? contentResult.value : '';
    const bookmarks = bookmarksResult.status === 'fulfilled' ? bookmarksResult.value : [];
    // 空本文（Content Gap の「欠損」）では要約を生成しない。タイトルだけの要約は情報を増やさず
    // 表示品質を下げるため。summary は NULL のまま残し、本文が回復した際に生成する
    // （summary IS NULL が対象抽出条件。本文の再取得は欠損本文の Backfill 課題に譲る）。
    const summary =
      content === '' ? null : await runAi(() => generateArticleSummary(article.title, content, env));
    let hatenaSummary: string | null = null;
    if (bookmarks.length > 0) {
      try {
        hatenaSummary = await runAi(() => generateHatenaSummary(bookmarks, env));
      } catch (error) {
        if (!isAiError(error)) {
          throw error;
        }
        // はてブ要約の失敗は記事を保存して回収に譲る（ADR-0017）。
        // Article Summary と違い、hatena_summary IS NULL は補完巡回が拾う。
        recordHatenaSummaryFailure(state, error, { articleUrl: article.url, siteUrl });
      }
    }
    const articleId = crypto.randomUUID();

    // 空本文で保存するときは、取り込み時の本文取得も「試行」として記録する（ADR-0014）。
    // これにより本文補完の初回再試行は 24 時間後になり、同一 run 内の二重取得を防ぐ。
    // ただしクールダウン起因は枠に触れていないので試行に数えず NULL のまま残し、
    // 次フル同期で早期再試行する（ADR-0016）。
    await runWrite(() =>
      database.insert(articles).values({
        content,
        contentBackfillAt: content === '' && contentCooldown === null ? new Date() : null,
        hatenaSummary,
        id: articleId,
        isRead: false,
        publishedAt: article.pubDate,
        siteUrl,
        summary,
        title: article.title,
        url: article.url,
      }).run(),
    );

    await persistBookmarks(database, articleId, bookmarks);
    // 注: ここでは `work.existingIds` に登録しない。今この run で取り込んだ記事は
    // はてブ補完の巡回対象から外す（取得済みのぶんを二重に消費しないため）。

    // 要約なし（はてブ取得失敗等）で保存された新着記事は補完対象に加える。
    if (hatenaSummary === null) {
      work.nullSummaryArticleIds.add(articleId);
    }

    counters.synced += 1;
  } catch (error) {
    // ADR-0017: AI（記事要約）の失敗と D1 書き込み失敗は同期中断。例外の順序が仕様そのもの。
    if (isAiError(error)) {
      throw error;
    }
    const message = toErrorMessage(error);
    if (isUniqueUrlConflict(message)) {
      // 同時実行の重なりで、他の run が同じ記事を先に保存した場合（ADR-0002 が
      // 受容する競合）。記事は勝者の run が保存済みのため、warn ではなく info で
      // 1 行だけ残す（docs/specs/ingest-failure.md §4）。書き込み失敗の唯一の例外。
      logger.info('記事は同時実行で保存済みのため、スキップします。', {
        articleUrl: article.url,
        siteUrl,
        title: article.title,
      });
      return;
    }
    if (isSyncWriteError(error)) {
      throw error;
    }
    if (debug) {
      console.error(error instanceof Error ? error.stack || error : error);
      throw error;
    }
    logger.warn('記事の同期に失敗しました。', {
      articleUrl: article.url,
      error: message,
      siteUrl,
      title: article.title,
    });
  }
}

/** UNIQUE(url) 制約違反（同時実行の競合、ADR-0002）かどうか。 */
function isUniqueUrlConflict(message: string): boolean {
  return message.includes('UNIQUE constraint failed: articles.url');
}

/**
 * はてブ補完（Backfill）: カーソル起点のラウンドロビンで、run 予算の範囲内だけ
 * 既存記事のブックマークを再取得し、各 Source のカーソルを進める（ADR-0010）。
 */
async function backfillBookmarks(
  database: AppDatabase,
  egress: EgressContext,
  env: RuntimeEnv,
  works: readonly FeedWork[],
  state: RunState,
): Promise<void> {
  interface Queue {
    consumed: number;
    remaining: ScrapedLink[];
    work: FeedWork;
  }

  const queues: Queue[] = works
    .filter((work) => work.feed.items.length > 0)
    .map((work) => ({
      consumed: 0,
      remaining: rotateFrom(work.feed.items, work.feed.backfillCursor),
      work,
    }));

  // hatena_summary が NULL の記事は Source ごとに 1 回だけ読み込む（記事ごとの SELECT を避ける）。
  const loadedSummarySites = new Set<string>();
  const ensureNullSummaryLoaded = async (work: FeedWork): Promise<void> => {
    if (loadedSummarySites.has(work.feed.siteUrl)) {
      return;
    }
    loadedSummarySites.add(work.feed.siteUrl);
    for (const id of await loadNullSummaryIds(database, work.feed.siteUrl)) {
      work.nullSummaryArticleIds.add(id);
    }
  };

  const hasRemaining = (): boolean => queues.some((queue) => queue.remaining.length > 0);

  while (state.budgetRemaining > 0 && hasRemaining()) {
    for (const queue of queues) {
      if (queue.remaining.length === 0) {
        continue;
      }
      const item = queue.remaining.shift()!;
      queue.consumed += 1;

      const articleId = queue.work.existingIds.get(item.url) ?? null;
      if (articleId === null) {
        // 新着はパス2a で処理済み（取得失敗で未保存の記事）。補完予算を消費させない。
        continue;
      }

      state.budgetRemaining -= 1;
      await ensureNullSummaryLoaded(queue.work);
      const outcome = await syncBookmarksForExistingArticle(
        database,
        egress,
        env,
        articleId,
        item.url,
        queue.work,
        state,
      );
      if (outcome === 'cooling') {
        // 枠がクールダウンしている限りこの Source の残りは埋まらない。
        // 巡回を打ち切って他 Source に譲り、カーソルは進んだ分だけ保存する。
        queue.remaining.length = 0;
      }
    }
  }

  for (const queue of queues) {
    if (queue.consumed === 0 || queue.work.feed.id.length === 0) {
      continue;
    }
    const itemsLength = queue.work.feed.items.length;
    const next = ((queue.work.feed.backfillCursor + queue.consumed) % itemsLength + itemsLength) % itemsLength;
    await runWrite(() =>
      database
        .update(subscriptions)
        .set({ backfillCursor: next })
        .where(eq(subscriptions.id, queue.work.feed.id))
        .run(),
    );
  }
}

/** カーソル位置を先頭にした巡回順のリストを作る（末尾に達したら先頭へ折り返す）。 */
function rotateFrom(items: readonly ScrapedLink[], cursor: number): ScrapedLink[] {
  if (items.length === 0) {
    return [];
  }
  const start = ((cursor % items.length) + items.length) % items.length;
  return [...items.slice(start), ...items.slice(0, start)];
}

/** その Source で hatena_summary が未生成の記事 ID セット。 */
async function loadNullSummaryIds(database: AppDatabase, siteUrl: string): Promise<Set<string>> {
  const rows = await database
    .select({ id: articles.id })
    .from(articles)
    .where(and(eq(articles.siteUrl, siteUrl), isNull(articles.hatenaSummary)));
  return new Set(rows.map((row) => row.id));
}

/** 本文補完（Content Backfill、ADR-0014）: 本文が空の既存記事を古い順に再取得する。
 * 取得できた記事の summary が NULL のときは要約も生成する（空本文時要約スキップの回復）。
 * 失敗は warn のうえ次の巡回に譲り、成功した記事は対象から外れる。
 * 巡回はカーソルではなく試行時刻（`content_backfill_at` + 24 時間間隔）で制御する —
 * 欠損集合はフィードから落ちた古い記事を含むため変動し、フィード掲載順のカーソルでは網羅できない。 */
async function backfillContents(
  database: AppDatabase,
  egress: EgressContext,
  env: RuntimeEnv,
  state: RunState,
  budget: number,
  runStartedAtMs: number,
): Promise<number> {
  if (budget <= 0) {
    return 0;
  }
  const cutoffMs = Date.now() - contentBackfillRetryIntervalMs;
  // 今 run で取り込んだ行は対象外（ADR-0016 の同一 run 二重取得防止）。
  // `created_at < run 開始時刻` だけの時間比較では、`created_at` が julianday 既定式の
  // 切り捨てで run 開始と同じ ms に丸められ、取りたての行を区別できない
  // （2026-09-08 のテストで顕在化：created_at が run 開始より 1ms 古い行が補完対象になった）。
  // そのため run 内で生成した ID を SQL 側でも除外する（時間条件は従来のまま絞り込み用に保持）。
  const targets = await database
    .select({
      id: articles.id,
      siteUrl: articles.siteUrl,
      title: articles.title,
      url: articles.url,
      summaryIsNull: isNull(articles.summary),
      failures: articles.contentBackfillFailures,
    })
    .from(articles)
    .where(
      and(
        or(isNull(articles.content), eq(articles.content, '')),
        or(
          // ADR-0016: 今 run で取り込んだ NULL 行は次フル同期に譲る（同一 run 内の二重取得防止）。
          and(isNull(articles.contentBackfillAt), lt(articles.createdAt, new Date(runStartedAtMs - sameRunCreatedGraceMs))),
          lt(articles.contentBackfillAt, new Date(cutoffMs)),
        ),
        isNull(articles.contentBackfillGaveUpAt),
      ),
    )
    .orderBy(asc(articles.createdAt))
    .limit(budget);

  let recovered = 0;
  for (const target of targets) {
    state.progress = { articleUrl: target.url, siteUrl: target.siteUrl, stage: 'content-backfill' };
    // 試行の事実を先に記録する。run 中断でも再試行は 24 時間後になる（同一 run 内の二重取得防止）。
    await runWrite(() =>
      database
        .update(articles)
        .set({ contentBackfillAt: new Date() })
        .where(eq(articles.id, target.id))
        .run(),
    );

    let content: string;
    try {
      content = await fetchArticleContent(egress, target.url, { jinaApiKey: env.JINA_API_KEY });
    } catch (error) {
      if (isEgressUnavailableError(error)) {
        // 枠が空かない・クールダウン中は同じ相手の残りも埋まらない。巡回を打ち切る。
        // 枠の問題は記事の失敗ではないため、失敗回数にはカウントしない（ADR-0015）。
        // 試行時刻も進めない（先行記録した now を NULL に戻す）。次フル同期で早期再試行する（ADR-0016）。
        await runWrite(() =>
          database
            .update(articles)
            .set({ contentBackfillAt: null })
            .where(eq(articles.id, target.id))
            .run(),
        );
        logger.info('本文補完は取得枠のクールダウン中のため打ち切ります。', {
          articleUrl: target.url,
          bucket: error.bucket,
        });
        return recovered;
      }
      if (isArticleMissingError(error)) {
        // 404/410 は「記事が消えた」ことの強いシグナル。即座に断念する（ADR-0015）。
        await runWrite(() =>
          database
            .update(articles)
            .set({
              contentBackfillFailures: CONTENT_BACKFILL_GIVE_UP_THRESHOLD,
              contentBackfillGaveUpAt: new Date(),
            })
            .where(eq(articles.id, target.id))
            .run(),
        );
        logger.info('本文補完を断念しました（記事が存在しません）。', {
          articleUrl: target.url,
        });
        continue;
      }
      const failures = target.failures + 1;
      if (failures >= CONTENT_BACKFILL_GIVE_UP_THRESHOLD) {
        // 5 回連続で失敗する記事は恒久欠損の可能性が高い。断念する（ADR-0015）。
        await runWrite(() =>
          database
            .update(articles)
            .set({ contentBackfillFailures: failures, contentBackfillGaveUpAt: new Date() })
            .where(eq(articles.id, target.id))
            .run(),
        );
        logger.info('本文補完を断念しました（連続 5 回失敗）。', { articleUrl: target.url });
        continue;
      }
      await runWrite(() =>
        database
          .update(articles)
          .set({ contentBackfillFailures: failures })
          .where(eq(articles.id, target.id))
          .run(),
      );
      logger.warn('本文補完の再取得に失敗したため、次の巡回で再試行します。', {
        articleUrl: target.url,
        error: toErrorMessage(error),
      });
      continue;
    }
    if (content === '') {
      logger.info('本文補完の再取得でも本文が空でした。', { articleUrl: target.url });
      continue;
    }

    // 本文を先に保存する（要約の AI 生成に失敗しても回復済みの本文は失われない）。
    await runWrite(() =>
      database.update(articles).set({ content }).where(eq(articles.id, target.id)).run(),
    );
    recovered += 1;
    if (target.summaryIsNull) {
      // 空本文時要約スキップで要約が未生成の記事。本文回復に合わせて生成する
      // （ADR-0017: Article Summary の失敗は巡回中でも同期中断）。
      const summary = await runAi(() => generateArticleSummary(target.title, content, env));
      await runWrite(() =>
        database.update(articles).set({ summary }).where(eq(articles.id, target.id)).run(),
      );
    }
  }
  return recovered;
}

async function findExistingArticleId(database: AppDatabase, url: string): Promise<string | null> {
  const rows = await database
    .select({ id: articles.id })
    .from(articles)
    .where(eq(articles.url, url))
    .limit(1);
  return rows[0]?.id ?? null;
}
