import { randomUUID } from 'node:crypto';

import { embed } from 'ai';
import { eq } from 'drizzle-orm';

import { db } from '../db/index.js';
import { articles, hatenaBookmarks, subscriptions } from '../db/schema.js';
import { getVectorCollection } from '../db/vector.js';
import { generateArticleSummary, getOpenCodeGoEmbeddingModel } from '../services/ai.js';
import { fetchHatenaBookmarks } from '../services/hatena.js';
import { getSiteArticles, type ScrapedArticle } from '../services/scraper.js';
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

function buildEmbeddingTexts(article: ScrapedArticle, summary: string): string[] {
  return [
    `タイトル: ${article.title}\n要約: ${summary}`,
    `タイトル: ${article.title}\n本文: ${article.content}`,
  ];
}

export async function syncSite(siteUrl: string): Promise<void> {
  const siteArticles = await getSiteArticles(siteUrl);
  const embeddingModel = getOpenCodeGoEmbeddingModel();
  const vectorCollection = await getVectorCollection();

  for (const article of siteArticles) {
    await sleep(randomArticleDelayMs());

    const existingArticle = await db
      .select({ id: articles.id })
      .from(articles)
      .where(eq(articles.url, article.url))
      .limit(1);

    if (existingArticle.length > 0) {
      continue;
    }

    const bookmarks = await fetchHatenaBookmarks(article.url);
    const summary = await generateArticleSummary(article.title, article.content, bookmarks);
    const articleId = randomUUID();

    db.transaction((transaction) => {
      transaction.insert(articles).values({
        id: articleId,
        url: article.url,
        title: article.title,
        content: article.content,
        summary,
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

    const embeddingTexts = buildEmbeddingTexts(article, summary);
    for (const text of embeddingTexts) {
      const { embedding } = await embed({
        model: embeddingModel,
        value: text,
      });

      await vectorCollection.add([
        {
          article_id: articleId,
          text,
          vector: embedding,
        },
      ]);
    }
  }
}

export async function syncAllSubscriptions(): Promise<void> {
  const subscribedSites = await db
    .select({
      siteUrl: subscriptions.siteUrl,
    })
    .from(subscriptions);

  if (subscribedSites.length === 0) {
    console.log('購読サイトがありません。');
    return;
  }

  for (const [index, subscription] of subscribedSites.entries()) {
    console.log(`同期中: ${subscription.siteUrl}`);
    await syncSite(subscription.siteUrl);

    if (index < subscribedSites.length - 1) {
      await sleep(randomSubscriptionDelayMs());
    }
  }
}
