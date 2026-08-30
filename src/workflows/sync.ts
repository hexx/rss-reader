import { and, eq, isNull, sql } from 'drizzle-orm';

import type { RuntimeEnv } from '../env.js';
import { getDb } from '../db/index.js';
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
import { fetchArticleContent, fetchRssOrFallback } from '../services/scraper.js';
import type { ScrapedLink } from '../services/scraper.js';
import { logger } from '../utils/logger.js';

const bookmarkChunkSize = 20;

/** 1 run あたりの はてブ補完（Backfill）上限。補完カーソルで巡回する（ADR-0010）。 */
export const backfillBudgetPerRun = 60;

/** 1 run あたりに生成するはてブ要約の上限（AI 呼び出しのバースト防止、従来どおり）。 */
export const maxHatenaSummaryBackfillsPerRun = 20;

/** AI生成処理の失敗を同期全体へ伝播させる。 */
async function runAi<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toAiError(error);
  }
}

/** 任意のエラーをログ用メッセージに正規化する。 */
function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
}

/** run 全体で共有する補完状態。 */
interface BackfillState {
  /** run 全体の残り補完予算（ADR-0010）。0 のときは補完を行わない。 */
  budgetRemaining: number;
  /** この実行で generateHatenaSummary を試行した回数（AI バースト防止）。 */
  summaryCount: number;
  /** 上限到達のログを 1 回だけ出すためのフラグ。 */
  capNotified: boolean;
  /** クールダウンによる打ち切りを 1 回だけログに出すフラグ（warn 乱発を防ぐ）。 */
  coolingNotified: boolean;
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
    await database
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
      .run();
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
  backfillState: BackfillState,
): Promise<'cooling' | 'ok'> {
  let bookmarks: HatenaBookmarkComment[];
  try {
    bookmarks = await fetchHatenaBookmarks(egress, articleUrl);
  } catch (error) {
    // クールダウン中なら warn を増やさない。run 内で 1 本だけ info に出し、
    // 呼び出し側はその Source の巡回を打ち切る（同じ枠は当時空かないため）。
    if (isEgressUnavailableError(error) && error.reason === 'cooldown') {
      if (!backfillState.coolingNotified) {
        backfillState.coolingNotified = true;
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
    if (backfillState.summaryCount >= maxHatenaSummaryBackfillsPerRun) {
      if (!backfillState.capNotified) {
        backfillState.capNotified = true;
        logger.info('はてブ要約のバックフィル上限に達したため、残りは次のフル同期に持ち越します。');
      }
      return 'ok';
    }
    backfillState.summaryCount += 1;
    const hatenaSummary = await runAi(() => generateHatenaSummary(bookmarks, env));
    await database
      .update(articles)
      .set({ hatenaSummary })
      .where(eq(articles.id, articleId))
      .run();
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
  return runSync(database, egress, env, [subscription], debug, includeBookmarkBackfill);
}

/**
 * 購読済み Source を二段同期で同期する（docs/specs/sync-egress-politeness.md）。
 *
 * - **パス1**: 全 Source のフィード取得だけを先に行う。取得枠が空かない Source は待機せず
 *   後回しにし、末尾で 1 度だけ再試行する（はてブ補完の待機列に埋もれて新着が餓死するのを防ぐ）。
 * - **パス2**: 取得済みフィードの新着記事を取り込み、残予算で はてブ補完 をカーソル巡回で行う。
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

  await runSync(database, egress, env, subscribedSites, debug, includeBookmarkBackfill);
}

/** パス1 → パス2 の進行そのもの。`syncSite` と `syncAllSubscriptions` が共有する。 */
async function runSync(
  database: AppDatabase,
  egress: EgressContext,
  env: RuntimeEnv,
  subscriptionRows: readonly SubscriptionRow[],
  debug: boolean,
  includeBookmarkBackfill: boolean,
): Promise<number> {
  const startedAtMs = Date.now();
  const counters: RunCounters = { fetched: 0, skipped: 0, throttled: 0, synced: 0 };
  const backfillState: BackfillState = {
    budgetRemaining: includeBookmarkBackfill ? backfillBudgetPerRun : 0,
    capNotified: false,
    coolingNotified: false,
    summaryCount: 0,
  };

  // ===== パス1: 全 Source のフィード取得（最優先） =====
  const feeds = await collectFeeds(egress, subscriptionRows, counters, debug);

  // ===== パス2: 記事処理（新着取り込み → はてブ補完） =====
  await processFeeds(database, egress, env, feeds, backfillState, counters, debug);

  logger.info('同期が完了しました。', {
    elapsedMs: Date.now() - startedAtMs,
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
): Promise<FetchedFeed[]> {
  const feeds: FetchedFeed[] = [];
  const deferred: SubscriptionRow[] = [];
  // 持ち越しログに理由を含めるため、後回し Source の最後の失敗理由を記録する。
  const carryReasons = new Map<string, 'defer' | 'throttled'>();

  for (const subscription of subscriptionRows) {
    const outcome = await tryFetchFeed(egress, subscription, feeds, counters, debug);
    if (outcome === 'defer' || outcome === 'throttled') {
      deferred.push(subscription);
      carryReasons.set(subscription.siteUrl, outcome);
    }
  }

  // パス1末尾: 他の Source を回している間に枠が空いた可能性があるので 1 周だけ再試行する。
  for (const subscription of deferred) {
    const outcome = await tryFetchFeed(egress, subscription, feeds, counters, debug, { quiet: true });
    if (outcome === 'defer' || outcome === 'throttled') {
      carryReasons.set(subscription.siteUrl, outcome);
    }
  }

  // それでも取得できなかった Source（Carry-over）は、理由を 1 行にまとめて次 run に譲る
  // （warn を増やさない。律速 warn は初回失敗時に出済みであるため）。枠の空きは予約しないので
  // 次回可能時刻は持たず、次の cron run で再試行する。
  const fetchedUrls = new Set(feeds.map((feed) => feed.siteUrl));
  const carried = subscriptionRows
    .filter((subscription) => !fetchedUrls.has(subscription.siteUrl))
    .map((subscription) => ({
      reason: carryReasons.get(subscription.siteUrl) ?? 'defer',
      siteUrl: subscription.siteUrl,
    }));
  if (carried.length > 0) {
    logger.info('未取得の Source を次回の同期に持ち越します。', {
      carried: carried.length,
      sources: carried,
    });
  }

  return feeds;
}

type FeedFetchOutcome = 'defer' | 'failed' | 'ok' | 'skipped' | 'throttled';

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
  context: { quiet?: boolean } = {},
): Promise<FeedFetchOutcome> {
  const { siteUrl } = subscription;
  const bucket = bucketKeyOf(siteUrl);

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
  backfillState: BackfillState,
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
      await ingestNewArticle(database, egress, env, work, item, counters, debug);
    }
  }

  if (backfillState.budgetRemaining > 0) {
    await backfillBookmarks(database, egress, env, works, backfillState);
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
): Promise<void> {
  const { siteUrl } = work.feed;
  try {
    logger.info('記事の同期処理を実行します。', { title: article.title, url: article.url });

    // 本文取得とはてブ取得は独立したネットワーク呼び出しなので並列化する。
    // どちらかが失敗しても記事の同期自体は継続する（本文失敗 → 本文なしで保存、
    // はてブ失敗 → コメントなしで保存。取りこぼしたはてブは補完巡回で埋める）。
    const [contentResult, bookmarksResult] = await Promise.allSettled([
      fetchArticleContent(egress, article.url, { jinaApiKey: env.JINA_API_KEY }),
      fetchHatenaBookmarks(egress, article.url),
    ]);

    if (contentResult.status === 'rejected') {
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
    const summary = await runAi(() => generateArticleSummary(article.title, content, env));
    let hatenaSummary: string | null = null;
    if (bookmarks.length > 0) {
      hatenaSummary = await runAi(() => generateHatenaSummary(bookmarks, env));
    }
    const articleId = crypto.randomUUID();

    await database.insert(articles).values({
      content,
      hatenaSummary,
      id: articleId,
      isRead: false,
      publishedAt: article.pubDate,
      siteUrl,
      summary,
      title: article.title,
      url: article.url,
    }).run();

    await persistBookmarks(database, articleId, bookmarks);
    // 注: ここでは `work.existingIds` に登録しない。今この run で取り込んだ記事は
    // はてブ補完の巡回対象から外す（取得済みのぶんを二重に消費しないため）。

    // 要約なし（はてブ取得失敗等）で保存された新着記事は補完対象に加える。
    if (hatenaSummary === null) {
      work.nullSummaryArticleIds.add(articleId);
    }

    counters.synced += 1;
  } catch (error) {
    if (isAiError(error)) {
      throw error;
    }
    if (debug) {
      console.error(error instanceof Error ? error.stack || error : error);
      throw error;
    }
    logger.warn('記事の同期に失敗しました。', {
      articleUrl: article.url,
      error: toErrorMessage(error),
      siteUrl,
      title: article.title,
    });
  }
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
  backfillState: BackfillState,
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

  while (backfillState.budgetRemaining > 0 && hasRemaining()) {
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

      backfillState.budgetRemaining -= 1;
      await ensureNullSummaryLoaded(queue.work);
      const outcome = await syncBookmarksForExistingArticle(
        database,
        egress,
        env,
        articleId,
        item.url,
        queue.work,
        backfillState,
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
    await database
      .update(subscriptions)
      .set({ backfillCursor: next })
      .where(eq(subscriptions.id, queue.work.feed.id))
      .run();
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

async function findExistingArticleId(database: AppDatabase, url: string): Promise<string | null> {
  const rows = await database
    .select({ id: articles.id })
    .from(articles)
    .where(eq(articles.url, url))
    .limit(1);
  return rows[0]?.id ?? null;
}
