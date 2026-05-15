import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import type { RuntimeEnv } from '../env.js';
import { db } from '../db/index.js';
import { articles, hatenaBookmarks, subscriptions } from '../db/schema.js';
import { getVectorCollection } from '../db/vector.js';
import { generateArticleSummary, generateEmbeddings, generateHatenaSummary } from '../services/ai.js';
import { fetchHatenaBookmarks } from '../services/hatena.js';
import { fetchArticleContent, fetchRssOrFallback } from '../services/scraper.js';
import { logger } from '../utils/logger.js';
import { chunkText } from '../utils/chunking.js';
import { sleep } from '../utils/sleep.js';

const articleChunkSize = 1_500;
const minimumArticleDelayMs = 1_000;
const maximumArticleDelayMs = 3_000;
const minimumSubscriptionDelayMs = 1_000;
const maximumSubscriptionDelayMs = 3_000;

function randomArticleDelayMs(): number {
  return Math.floor(Math.random() * (maximumArticleDelayMs - minimumArticleDelayMs + 1)) + minimumArticleDelayMs;
}

function randomSubscriptionDelayMs(): number {
  return Math.floor(
    Math.random() * (maximumSubscriptionDelayMs - minimumSubscriptionDelayMs + 1),
  ) + minimumSubscriptionDelayMs;
}

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

export async function syncSite(
  siteUrl: string,
  debug = false,
  env: RuntimeEnv = process.env,
): Promise<void> {
  logger.info('サイト同期を開始します。', { siteUrl });
  const siteArticles = await fetchRssOrFallback(siteUrl);
  const vectorCollection = await getVectorCollection(env);

  for (const article of siteArticles) {
    logger.info('記事の同期処理を実行します。', { title: article.title, url: article.url });
    await sleep(randomArticleDelayMs());

    try {
      const existingArticle = await db
        .select({ id: articles.id, hatenaSummary: articles.hatenaSummary })
        .from(articles)
        .where(eq(articles.url, article.url))
        .limit(1);

      if (existingArticle.length > 0) {
        continue;
      }

      const content = await fetchArticleContent(article.url);
      const bookmarks = shouldFetchHatenaBookmarks(siteUrl) ? await fetchHatenaBookmarks(article.url) : [];
      const summary = await generateArticleSummary(article.title, content, env);
      const hatenaSummary = bookmarks.length > 0 ? await generateHatenaSummary(bookmarks, env) : null;
      const articleId = randomUUID();

      db.transaction((transaction) => {
        transaction.insert(articles).values({
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
          transaction.insert(hatenaBookmarks).values(
            bookmarks.map((bookmark) => ({
              id: randomUUID(),
              articleId,
              user: bookmark.user,
              comment: bookmark.comment,
            })),
          ).run();
        }
      });

      const chunks = buildArticleChunks(article.title, content);
      if (chunks.length > 0) {
        const embeddings = await generateEmbeddings(chunks, env);
        await vectorCollection.add(buildChunkRows(articleId, chunks, embeddings));
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

  logger.info('サイト同期が完了しました。', { siteUrl, articles: siteArticles.length });
}

export async function syncAllSubscriptions(
  debug = false,
  env: RuntimeEnv = process.env,
): Promise<void> {
  const subscribedSites = await db
    .select({
      siteUrl: subscriptions.siteUrl,
    })
    .from(subscriptions);

  if (subscribedSites.length === 0) {
    logger.info('購読サイトがありません。');
    return;
  }

  for (const [index, subscription] of subscribedSites.entries()) {
    await syncSite(subscription.siteUrl, debug, env);

    if (index < subscribedSites.length - 1) {
      await sleep(randomSubscriptionDelayMs());
    }
  }
}
