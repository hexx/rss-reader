import { randomUUID } from 'node:crypto';

import { eq } from 'drizzle-orm';

import { db } from '../db/index.js';
import { articles, hatenaBookmarks, subscriptions } from '../db/schema.js';
import { getVectorCollection } from '../db/vector.js';
import { generateArticleSummary, generateEmbedding, generateHatenaSummary } from '../services/ai.js';
import { fetchHatenaBookmarks } from '../services/hatena.js';
import { fetchArticleContent, fetchRssOrFallback } from '../services/scraper.js';
import { logger } from '../utils/logger.js';
import { sleep } from '../utils/sleep.js';

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

function buildEmbeddingTexts(
  title: string,
  content: string,
  summary: string,
  hatenaSummary: string | null,
): string[] {
  const texts = [
    `タイトル: ${title}\n要約: ${summary}`,
    `タイトル: ${title}\n本文: ${content}`,
  ];

  if (hatenaSummary && hatenaSummary.trim().length > 0) {
    texts.push(`タイトル: ${title}\nはてブの反応: ${hatenaSummary}`);
  }

  return texts;
}

export async function syncSite(siteUrl: string, debug = false): Promise<void> {
  logger.info('サイト同期を開始します。', { siteUrl });
  const siteArticles = await fetchRssOrFallback(siteUrl);
  const vectorCollection = await getVectorCollection();

  for (const article of siteArticles) {
    await sleep(randomArticleDelayMs());

    try {
      const existingArticle = await db
        .select({ id: articles.id })
        .from(articles)
        .where(eq(articles.url, article.url))
        .limit(1);

      if (existingArticle.length > 0) {
        continue;
      }

      const content = await fetchArticleContent(article.url);
      const bookmarks = await fetchHatenaBookmarks(article.url);
      const summary = await generateArticleSummary(article.title, content);
      const hatenaSummary = bookmarks.length > 0 ? await generateHatenaSummary(bookmarks) : null;
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

      const embeddingTexts = buildEmbeddingTexts(article.title, content, summary, hatenaSummary);
      for (const text of embeddingTexts) {
        const embedding = await generateEmbedding(text);

        await vectorCollection.add([
          {
            article_id: articleId,
            text,
            vector: embedding,
          },
        ]);
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

export async function syncAllSubscriptions(debug = false): Promise<void> {
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
    logger.info('購読サイトを同期します。', { siteUrl: subscription.siteUrl });
    await syncSite(subscription.siteUrl, debug);

    if (index < subscribedSites.length - 1) {
      await sleep(randomSubscriptionDelayMs());
    }
  }
}
