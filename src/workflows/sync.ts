import { eq } from 'drizzle-orm';

import type { RuntimeEnv } from '../env.js';
import { getDb } from '../db/index.js';
import { articles, hatenaBookmarks, subscriptions } from '../db/schema.js';
import { getVectorCollection } from '../db/vector.js';
import { generateArticleSummary, generateEmbeddings, generateHatenaSummary } from '../services/ai.js';
import { fetchHatenaBookmarks } from '../services/hatena.js';
import { fetchArticleContent, fetchRssOrFallback } from '../services/scraper.js';
import { logger } from '../utils/logger.js';
import { chunkText } from '../utils/chunking.js';

const articleChunkSize = 1_500;
const bookmarkChunkSize = 20;
const maxProcessPerSync = 1;

function shouldFetchHatenaBookmarks(siteUrl: string): boolean {
  return siteUrl.includes('b.hatena.ne.jp');
}

function buildArticleChunkSource(title: string, content: string): string {
  const parts = [`タイトル: ${title}`];
  const body = content.trim();
  parts.push(body.length > 0 ? `本文: ${body}` : '本文:');

  return parts.join('\n\n');
}

function buildChunkRows(
  articleId: string,
  chunks: string[],
  embeddings: number[][],
): Array<{
  article_id: string;
  text: string;
  vector: number[];
}> {
  if (chunks.length !== embeddings.length) {
    throw new Error('Chunk and embedding counts do not match');
  }

  return chunks.map((chunk, index) => ({
    article_id: articleId,
    text: chunk,
    vector: embeddings[index]!,
  }));
}

function buildArticleChunks(
  title: string,
  content: string,
): string[] {
  return chunkText(buildArticleChunkSource(title, content), articleChunkSize);
}

async function measureAsync<T>(
  label: string,
  articleUrl: string,
  siteUrl: string,
  operation: () => Promise<T>,
): Promise<T> {
  const startedAt = performance.now();

  try {
    return await operation();
  } finally {
    logger.info(`[計測] ${label}: ${Math.round(performance.now() - startedAt)}ms`, {
      articleUrl,
      siteUrl,
    });
  }
}

export async function syncSite(
  siteUrl: string,
  debug = false,
  env: RuntimeEnv = process.env,
): Promise<number> {
  let processedCount = 0;

  try {
    logger.info('サイト同期を開始します。', { siteUrl });
    const database = getDb(env);
    const siteArticles = await fetchRssOrFallback(siteUrl);
    const vectorCollection = await getVectorCollection(env);

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
          content = await measureAsync('本文取得', article.url, siteUrl, () => fetchArticleContent(article.url));
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          logger.warn('本文の取得に失敗したため、本文なしで処理を継続します。', {
            articleUrl: article.url,
            siteUrl,
            title: article.title,
            error: message,
          });
        }
        const bookmarks = shouldFetchHatenaBookmarks(siteUrl)
          ? await measureAsync('はてなAPI', article.url, siteUrl, () => fetchHatenaBookmarks(article.url))
          : [];
        const summary = await measureAsync('記事要約AI', article.url, siteUrl, () =>
          generateArticleSummary(article.title, content, env),
        );
        const hatenaSummary =
          bookmarks.length > 0
            ? await measureAsync('コメント要約AI', article.url, siteUrl, () =>
                generateHatenaSummary(bookmarks, env),
              )
            : null;
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

        const chunks = buildArticleChunks(article.title, content);
        if (chunks.length > 0) {
          const embeddings = await measureAsync('ベクトル化AI', article.url, siteUrl, () =>
            generateEmbeddings(chunks, env),
          );
          await vectorCollection.add(buildChunkRows(articleId, chunks, embeddings));
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

export async function syncAllSubscriptions(
  debug = false,
  env: RuntimeEnv = process.env,
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
    totalProcessedCount += await syncSite(subscription.siteUrl, debug, env);
    if (totalProcessedCount >= 1) {
      break;
    }
  }
}
