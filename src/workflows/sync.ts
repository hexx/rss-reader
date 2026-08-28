import { and, eq, isNull, sql } from 'drizzle-orm';

import type { RuntimeEnv } from '../env.js';
import { getDb } from '../db/index.js';
import { articles, hatenaBookmarks, subscriptions } from '../db/schema.js';
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
import { logger } from '../utils/logger.js';

const bookmarkChunkSize = 20;

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
/** 1 回の syncSite 実行でバックフィル生成するはてブ要約の上限（AI 呼び出しのバースト防止）。 */
const maxHatenaSummaryBackfillsPerRun = 20;

/** syncSite 1 回の実行内で共有するバックフィル状態（並行実行間で共有しない）。 */
interface BackfillState {
  /** この実行で generateHatenaSummary を試行した回数（失敗も含む。AI バースト防止）。 */
  count: number;
  /** 上限到達のログを 1 回だけ出すためのフラグ。 */
  capNotified: boolean;
}

type AppDatabase = ReturnType<typeof getDb>;

/**
 * 1 記事分のはてなブックマークをチャンクで upsert する。
 * `(article_id, user)` の UNIQUE 制約で重複行の増殖を防ぎ、timestamp は
 * jsonlite が返す値（=ユーザーがブックマークした実時刻）をそのまま保存する。
 *
 * 競合時は `DO UPDATE` で `createdAt`（ブックマーク日時）と `comment` を
 * 最新化し、再取得で既存行が自然治癒するようにする（ADR-0003）。
 * `set` は `excluded.*` を参照し、複数行 INSERT でも行ごとに正しい値が入る。
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
 * 既存記事に対しはてなブックマークのみを冪等に再取得・保存する。
 * 主に 2 つの取りこぼしケースの補完を目的とする：
 *  - jsonlite の取得件数上限を超えた分の取りこぼし
 *  - 初回取得時の一時的なネットワーク失敗等で当該記事分のブックマークが
 *    まだ保存されていないケース
 * 取得失敗は best-effort で握り潰し、既存記事のメタデータ更新は阻害しない。
 * 同一ユーザー重複は schema の UNIQUE 制約 `hatena_bookmarks_article_id_user_unique`
 * によって DB レベルで除外される。
 *
 * 初回同期時にブックマーク取得が失敗して `hatena_summary` が NULL のままの記事は、
 * バックフィルが成功したタイミングで要約を生成して埋める（ADR 0002 のフル同期経由）。
 */
async function syncBookmarksForExistingArticle(
  database: AppDatabase,
  articleId: string,
  articleUrl: string,
  env: RuntimeEnv,
  nullSummaryArticleIds: Set<string>,
  backfillState: BackfillState,
): Promise<void> {
  let bookmarks: HatenaBookmarkComment[];
  try {
    bookmarks = await fetchHatenaBookmarks(articleUrl);
  } catch (error) {
    const message = toErrorMessage(error);
    logger.warn('既存記事のはてなブックマーク再取得に失敗したため、スキップします。', {
      articleId,
      articleUrl,
      error: message,
    });
    return;
  }
  await persistBookmarks(database, articleId, bookmarks);

  // 記事ごとの SELECT を避けるため、syncSite 冒頭で事前ロードした
  // hatena_summary が NULL の記事 ID セットで判定する。
  if (nullSummaryArticleIds.has(articleId) && bookmarks.length > 0) {
    if (backfillState.count >= maxHatenaSummaryBackfillsPerRun) {
      if (!backfillState.capNotified) {
        backfillState.capNotified = true;
        logger.info('はてブ要約のバックフィル上限に達したため、残りは次のフル同期に持ち越します。');
      }
      return;
    }
    backfillState.count += 1;
    const hatenaSummary = await runAi(() => generateHatenaSummary(bookmarks, env));
    await database
      .update(articles)
      .set({ hatenaSummary })
      .where(eq(articles.id, articleId))
      .run();
    nullSummaryArticleIds.delete(articleId);
    logger.info('取りこぼしていたはてブ要約をバックフィルで生成しました。', { articleId });
  }
}

/**
 * 1つの購読サイトを同期し、記事本文・要約・はてブコメントを保存します。
 * 既存記事は重複登録せず、新着記事を1回あたりの上限なく全件処理します。記事単位の逐次 INSERT で
 * 冪等なため、Worker の実行時間上限（Cron: wall 15分、手動: waitUntil 30秒）に達しても
 * 次回実行で再開されます。詳細: docs/adr/0002-split-sync-cadences.md。
 *
 * @param siteUrl 同期対象の購読サイトURL。
 * @param debug 失敗時に例外を再送出してデバッグしやすくするかどうか。
 * @param env DB、Vector、AI の各環境バインディング。
 * @param includeBookmarkBackfill 既存記事のはてなブックマーク再取得（バックフィル）を行うかどうか。
 *   新着記事の取り込みに専念したい高頻度 Cron では false を渡します。
 * @returns 今回処理できた記事数。
 */
export async function syncSite(
  siteUrl: string,
  debug: boolean,
  env: RuntimeEnv,
  includeBookmarkBackfill = true,
): Promise<number> {
  // RSS・はてな取得を始める前にAI設定を検証する。
  validateAiConfiguration(env);
  let processedCount = 0;

  // この実行内で共有するバックフィル状態（並行実行と干渉しないよう引数で受け渡す）。
  const backfillState: BackfillState = { capNotified: false, count: 0 };

  try {
    logger.info('サイト同期を開始します。', { siteUrl });
    const database = getDb(env);
    const siteArticles = await fetchRssOrFallback(siteUrl);

    // バックフィル対象（hatena_summary が NULL）の記事 ID を事前に 1 回だけ読み込む。
    // 記事ごとの追加 SELECT を避けるためのもの。対象はこのサイトの記事に絞る
    // （site_url インデックスを使用）。取り込み専用 cron では不要なのでスキップする。
    const nullSummaryArticleIds = includeBookmarkBackfill
      ? new Set(
          (
            await database
              .select({ id: articles.id })
              .from(articles)
              .where(and(eq(articles.siteUrl, siteUrl), isNull(articles.hatenaSummary)))
          ).map((row) => row.id),
        )
      : new Set<string>();

    for (const article of siteArticles) {
      try {
        const existingArticle = await database
          .select({ id: articles.id })
          .from(articles)
          .where(eq(articles.url, article.url))
          .limit(1);

        // 既存記事でも、はてなブックマークは冪等に再取得する。
        // Jsonlite の件数上限や、一時的なネットワーク失敗で取りこぼした分を
        // 後の同期で埋められるようにする。
        // 購読元が b.hatena.ne.jp かどうかは関係なく、常に試みる
        // (レート制御は hatena モジュール内のリミッターが行う)。
        const existing = existingArticle[0];
        if (existing && includeBookmarkBackfill) {
          await syncBookmarksForExistingArticle(
            database,
            existing.id,
            article.url,
            env,
            nullSummaryArticleIds,
            backfillState,
          );
        }
        if (existing) {
          continue;
        }

        logger.info('記事の同期処理を実行します。', { title: article.title, url: article.url });

        // 本文取得とはてブ取得は独立したネットワーク呼び出しなので並列化する。
        // はてブ側のレート制御は hatena モジュール内のリミッターが担当する。
        // どちらかが失敗しても記事の同期自体は継続する（本文失敗 → 本文なしで保存、
        // はてブ失敗 → コメントなしで保存。取りこぼしたはてブは 3 時間おきのフル同期の
        // バックフィルで補完される）。
        const [contentResult, bookmarksResult] = await Promise.allSettled([
          fetchArticleContent(article.url),
          fetchHatenaBookmarks(article.url),
        ]);

        if (contentResult.status === 'rejected') {
          const message = toErrorMessage(contentResult.reason);
          logger.warn('本文の取得に失敗したため、本文なしで処理を継続します。', {
            articleUrl: article.url,
            error: message,
            siteUrl,
            title: article.title,
          });
        }
        if (bookmarksResult.status === 'rejected') {
          const message = toErrorMessage(bookmarksResult.reason);
          logger.warn('はてなブックマークの取得に失敗したため、コメントなしで処理を継続します。', {
            articleUrl: article.url,
            error: message,
            siteUrl,
            title: article.title,
          });
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

        // 要約なし（はてブ取得失敗等）で保存された新着記事は、バックフィル対象に加える。
        // 通常は次のフル同期の事前ロードで拾われるが、同一実行内に同じ URL の項目が
        // 重複して現れた場合に備えて、実行中に挿入した記事もセットへ追加しておく。
        if (hatenaSummary === null) {
          nullSummaryArticleIds.add(articleId);
        }

        await persistBookmarks(database, articleId, bookmarks);

        processedCount += 1;
      } catch (error) {
        if (isAiError(error)) {
          throw error;
        }
        if (debug) {
          console.error(error instanceof Error ? error.stack || error : error);
          throw error;
        }

        const message = toErrorMessage(error);
        logger.warn('記事の同期に失敗しました。', {
          articleUrl: article.url,
          error: message,
          siteUrl,
          title: article.title,
        });
      }
    }

    logger.info('サイト同期が完了しました。', { articles: processedCount, siteUrl });
    return processedCount;
  } catch (error) {
    if (isAiError(error)) {
      throw error;
    }
    if (debug) {
      console.error(error instanceof Error ? error.stack || error : error);
      throw error;
    }

    const message = toErrorMessage(error);
    logger.warn('サイト同期に失敗しました。', {
      error: message,
      siteUrl,
    });
    return 0;
  }
}

/**
 * 購読済みサイトを順番に同期します。各サイトの新着記事を1回あたりの上限なく処理します
 * （上限撤廃の詳細は docs/adr/0002-split-sync-cadences.md）。
 *
 * @param debug 失敗時に例外を再送出してデバッグしやすくするかどうか。
 * @param env DB、Vector、AI の各環境バインディング。
 * @param includeBookmarkBackfill 既存記事のはてなブックマーク再取得（バックフィル）を行うかどうか。
 * @returns 何も返しません。
 */
export async function syncAllSubscriptions(
  debug: boolean,
  env: RuntimeEnv,
  includeBookmarkBackfill = true,
): Promise<void> {
  // 外部のRSS・はてな取得より前に設定不備を検出する。
  validateAiConfiguration(env);
  const database = getDb(env);
  const subscribedSites = await database
    .select({
      siteUrl: subscriptions.siteUrl,
    })
    .from(subscriptions);

  if (subscribedSites.length === 0) {
    logger.info('購読サイトがありません。');
    return;
  }

  for (const subscription of subscribedSites) {
    await syncSite(subscription.siteUrl, debug, env, includeBookmarkBackfill);
  }
}
