import express from 'express';
import { count, desc, eq, inArray } from 'drizzle-orm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { db } from '../db/index.js';
import { articles, hatenaBookmarks, subscriptions } from '../db/schema.js';
import { searchArticles } from '../services/search.js';
import { syncAllSubscriptions } from '../workflows/sync.js';
import { logger } from '../utils/logger.js';

type ArticleResponse = {
  bookmarks: Array<{
    comment: string;
    createdAt: string;
    id: string;
    user: string;
  }>;
  createdAt: string;
  content: string;
  id: string;
  hatenaSummary: string;
  isRead: boolean;
  siteUrl: string;
  summary: string;
  title: string;
  url: string;
};

type ArticleRow = {
  content: string | null;
  createdAt: Date | string | number | null;
  id: string;
  hatenaSummary: string | null;
  isRead: boolean | number | null;
  siteUrl: string;
  summary: string | null;
  title: string;
  url: string;
};

type BookmarkRow = {
  articleId: string;
  comment: string | null;
  createdAt: Date | string | null;
  id: string;
  user: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.resolve(__dirname, '../../public');
const port = Number(process.env.PORT ?? 3000);

function formatDate(value: Date | string | number | null | undefined): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'number') {
    return new Date(value).toISOString();
  }

  if (typeof value === 'string') {
    return new Date(value).toISOString();
  }

  return new Date().toISOString();
}

function createArticleResponse(
  article: ArticleRow,
  bookmarks: BookmarkRow[],
): ArticleResponse {
  return {
    bookmarks: bookmarks.map((bookmark) => ({
      comment: bookmark.comment ?? '',
      createdAt: formatDate(bookmark.createdAt),
      id: bookmark.id,
      user: bookmark.user,
    })),
    createdAt: formatDate(article.createdAt),
    content: article.content ?? '',
    id: article.id,
    hatenaSummary: article.hatenaSummary?.trim() ?? '',
    isRead: Boolean(article.isRead),
    siteUrl: article.siteUrl,
    summary: article.summary ?? '',
    title: article.title,
    url: article.url,
  };
}

async function fetchArticles(sourceUrl?: string): Promise<ArticleRow[]> {
  const query = db
    .select({
      content: articles.content,
      createdAt: articles.createdAt,
      hatenaSummary: articles.hatenaSummary,
      id: articles.id,
      isRead: articles.isRead,
      siteUrl: articles.siteUrl,
      summary: articles.summary,
      title: articles.title,
      url: articles.url,
    })
    .from(articles);

  return sourceUrl
    ? await query.where(eq(articles.siteUrl, sourceUrl)).orderBy(desc(articles.createdAt))
    : await query.orderBy(desc(articles.createdAt));
}

async function fetchBookmarksByArticleIds(articleIds: string[]): Promise<BookmarkRow[]> {
  if (articleIds.length === 0) {
    return [];
  }

  return db
    .select({
      articleId: hatenaBookmarks.articleId,
      comment: hatenaBookmarks.comment,
      createdAt: hatenaBookmarks.createdAt,
      id: hatenaBookmarks.id,
      user: hatenaBookmarks.user,
    })
    .from(hatenaBookmarks)
    .where(inArray(hatenaBookmarks.articleId, articleIds));
}

export function createApp() {
  const app = express();

  app.use(express.json());
  app.use(express.static(publicDir));

  app.get('/api/articles', async (request, response, next) => {
    try {
      const sourceUrl =
        typeof request.query.source === 'string' && request.query.source.trim().length > 0
          ? request.query.source.trim()
          : undefined;

      const articleRows = await fetchArticles(sourceUrl);
      const bookmarkRows = await fetchBookmarksByArticleIds(articleRows.map((article) => article.id));

      const bookmarksByArticleId = new Map<string, BookmarkRow[]>();
      for (const bookmark of bookmarkRows) {
        const items = bookmarksByArticleId.get(bookmark.articleId) ?? [];
        items.push(bookmark);
        bookmarksByArticleId.set(bookmark.articleId, items);
      }

      response.json({
        articles: articleRows.map((article) =>
          createArticleResponse(article, bookmarksByArticleId.get(article.id) ?? []),
        ),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/sources', async (_request, response, next) => {
    try {
      const sourceRows = await db
        .select({
          id: subscriptions.id,
          siteUrl: subscriptions.siteUrl,
          articleCount: count(articles.id),
        })
        .from(subscriptions)
        .leftJoin(articles, eq(articles.siteUrl, subscriptions.siteUrl))
        .groupBy(subscriptions.id, subscriptions.siteUrl)
        .orderBy(desc(subscriptions.addedAt));

      response.json({
        sources: sourceRows.map((source) => ({
          articleCount: Number(source.articleCount ?? 0),
          id: source.id,
          siteUrl: source.siteUrl,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/search', async (request, response, next) => {
    try {
      const query = typeof request.query.q === 'string' ? request.query.q : '';
      if (
        query.trim().length > 0 &&
        (process.env.OPENCODE_GO_BASE_URL === undefined || process.env.OPENCODE_GO_API_KEY === undefined)
      ) {
        response.status(503).json({
          error: 'Search requires OPENCODE_GO_BASE_URL and OPENCODE_GO_API_KEY.',
        });
        return;
      }

      const results = await searchArticles(query);
      response.json({ results });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/articles/:id/read', async (request, response, next) => {
    try {
      const articleId = request.params.id;
      const existingArticle = await db
        .select({ id: articles.id })
        .from(articles)
        .where(eq(articles.id, articleId))
        .limit(1);

      if (existingArticle.length === 0) {
        response.status(404).json({ error: 'Article not found.' });
        return;
      }

      const isRead = typeof request.body?.isRead === 'boolean' ? request.body.isRead : true;
      await db.update(articles).set({ isRead }).where(eq(articles.id, articleId)).run();

      response.json({ id: articleId, isRead });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/sync', (_request, response) => {
    void syncAllSubscriptions().catch((error: unknown) => {
      logger.error('同期APIの実行に失敗しました。', { error });
    });

    response.status(202).json({ status: 'accepted' });
  });

  app.use((request, response, next) => {
    if (request.method !== 'GET' || request.path.startsWith('/api/')) {
      next();
      return;
    }

    response.sendFile(path.join(publicDir, 'index.html'));
  });

  app.use((error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => {
    logger.error('Web サーバーで予期しないエラーが発生しました。', { error });
    response.status(500).json({ error: 'Internal Server Error' });
  });

  return app;
}

export function startServer() {
  const app = createApp();
  return app.listen(port, () => {
    logger.info(`Web server listening on http://localhost:${port}`);
  });
}

if (process.argv[1]?.includes('src/server/index.ts')) {
  startServer();
}
