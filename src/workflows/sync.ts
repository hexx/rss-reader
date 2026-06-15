import { eq } from 'drizzle-orm';

import type { RuntimeEnv } from '../env.js';
import { getDb } from '../db/index.js';
import { articles, hatenaBookmarks, subscriptions } from '../db/schema.js';
import { generateArticleSummary, generateHatenaSummary } from '../services/ai.js';
import { fetchHatenaBookmarks } from '../services/hatena.js';
import { fetchArticleContent, fetchRssOrFallback } from '../services/scraper.js';
import { logger } from '../utils/logger.js';

const bookmarkChunkSize = 20;

function shouldFetchHatenaBookmarks(siteUrl: string): boolean {
  return siteUrl.includes('b.hatena.ne.jp');
}

/**
 * 1つの購読サイトを同期し、記事本文・要約・はてブコメントを保存します。
 * 既存記事は重複登録せず、手動実行では1回あたりの処理件数を抑えてタイムアウトを避けます。
 *
 * @param siteUrl 同期対象の購読サイトURL。
 * @param debug 失敗時に例外を再送出してデバッグしやすくするかどうか。
 * @param env DB、Vector、AI の各環境バインディング。
 * @param isCron Cron 実行かどうか。Cron の場合は1回あたりの処理上限が増えます。
 * @returns 今回処理できた記事数。
 */
export async function syncSite(
  siteUrl: string,
  debug = false,
  env: RuntimeEnv = process.env,
  isCron = false,
): Promise<number> {
  let processedCount = 0;
  const maxProcessPerSync = isCron ? 10 : 2;

  try {
    logger.info('サイト同期を開始します。', { siteUrl });
    const database = getDb(env);
    const siteArticles = await fetchRssOrFallback(siteUrl);

    for (const article of siteArticles) {
      try {
        const existingArticle = await database
          .select({ id: articles.id, hatenaSummary: articles.hatenaSummary })
          .from(articles)
          .where(eq(articles.url, article.url))
          .limit(1);

        if (existingArticle.length > 0) {
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
            siteUrl,
            title: article.title,
            error: message,
          });
        }
        const bookmarks = shouldFetchHatenaBookmarks(siteUrl) ? await fetchHatenaBookmarks(article.url) : [];
        const summary = await generateArticleSummary(article.title, content, env);
        const hatenaSummary =
          bookmarks.length > 0 ? await generateHatenaSummary(bookmarks, env) : null;
        const articleId = crypto.randomUUID();

        await database.insert(articles).values({
          id: articleId,
          siteUrl,
          url: article.url,
          title: article.title,
          content,
          summary,
          hatenaSummary,
          publishedAt: article.pubDate,
          isRead: false,
        }).run();

        if (bookmarks.length > 0) {
          for (let index = 0; index < bookmarks.length; index += bookmarkChunkSize) {
            const chunk = bookmarks.slice(index, index + bookmarkChunkSize);
            await database
              .insert(hatenaBookmarks)
              .values(
                chunk.map((bookmark) => ({
                  id: crypto.randomUUID(),
                  articleId,
                  user: bookmark.user,
                  comment: bookmark.comment,
                })),
              )
              .onConflictDoNothing()
              .run();
          }
        }

        processedCount += 1;
        if (processedCount >= maxProcessPerSync) {
          logger.info('タイムアウト防止のため、記事の同期を中断して次回に回します。');
          break;
        }
      } catch (error) {
        if (debug) {
          console.error(error instanceof Error ? error.stack || error : error);
          throw error;
        }

        const message = error instanceof Error ? error.message : String(error);
        logger.warn('記事の同期に失敗しました。', {
          articleUrl: article.url,
          siteUrl,
          title: article.title,
          error: message,
        });
      }
    }

    logger.info('サイト同期が完了しました。', { siteUrl, articles: processedCount });
    return processedCount;
  } catch (error) {
    if (debug) {
      console.error(error instanceof Error ? error.stack || error : error);
      throw error;
    }

    const message = error instanceof Error ? error.message : String(error);
    logger.warn('サイト同期に失敗しました。', {
      siteUrl,
      error: message,
    });
    return 0;
  }
}

/**
 * 購読済みサイトを順番に同期します。
 * 手動実行では全体の処理件数が2件に達したところで止め、Cron ではより多く処理します。
 *
 * @param debug 失敗時に例外を再送出してデバッグしやすくするかどうか。
 * @param env DB、Vector、AI の各環境バインディング。
 * @param isCron Cron 実行かどうか。Cron の場合は各サイトの処理上限も増えます。
 * @returns 何も返しません。
 */
export async function syncAllSubscriptions(
  debug = false,
  env: RuntimeEnv = process.env,
  isCron = false,
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

  let totalProcessedCount = 0;

  for (const subscription of subscribedSites) {
    totalProcessedCount += await syncSite(subscription.siteUrl, debug, env, isCron);
    if (!isCron && totalProcessedCount >= 2) {
      break;
    }
  }
}
