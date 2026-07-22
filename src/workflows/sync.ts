import { eq, sql } from 'drizzle-orm';

import type { RuntimeEnv } from '../env.js';
import { getDb } from '../db/index.js';
import { articles, hatenaBookmarks, subscriptions } from '../db/schema.js';
import { generateArticleSummary, generateHatenaSummary } from '../services/ai.js';
import { fetchHatenaBookmarks } from '../services/hatena.js';
import type { HatenaBookmarkComment } from '../services/hatena.js';
import { fetchArticleContent, fetchRssOrFallback } from '../services/scraper.js';
import { logger } from '../utils/logger.js';

const bookmarkChunkSize = 20;

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
 */
async function syncBookmarksForExistingArticle(
  database: AppDatabase,
  articleId: string,
  articleUrl: string,
): Promise<void> {
  let bookmarks: HatenaBookmarkComment[];
  try {
    bookmarks = await fetchHatenaBookmarks(articleUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn('既存記事のはてなブックマーク再取得に失敗したため、スキップします。', {
      articleId,
      articleUrl,
      error: message,
    });
    return;
  }
  await persistBookmarks(database, articleId, bookmarks);
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
  let processedCount = 0;

  try {
    logger.info('サイト同期を開始します。', { siteUrl });
    const database = getDb(env);
    const siteArticles = await fetchRssOrFallback(siteUrl);

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
          await syncBookmarksForExistingArticle(database, existing.id, article.url);
        }
        if (existing) {
          continue;
        }

        logger.info('記事の同期処理を実行します。', { title: article.title, url: article.url });

        let content = '';
        try {
          content = await fetchArticleContent(article.url);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn('本文の取得に失敗したため、本文なしで処理を継続します。', {
            articleUrl: article.url,
            error: message,
            siteUrl,
            title: article.title,
          });
        }
        const bookmarks = await fetchHatenaBookmarks(article.url);
        const summary = await generateArticleSummary(article.title, content, env);
        const hatenaSummary =
          bookmarks.length > 0 ? await generateHatenaSummary(bookmarks, env) : null;
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

        processedCount += 1;
      } catch (error) {
        if (debug) {
          console.error(error instanceof Error ? error.stack || error : error);
          throw error;
        }

        const message = error instanceof Error ? error.message : String(error);
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
    if (debug) {
      console.error(error instanceof Error ? error.stack || error : error);
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
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
