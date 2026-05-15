import basicAuth from 'express-basic-auth';
import express from 'express';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { db } from '../db/index.js';
import { articles, hatenaBookmarks, subscriptions } from '../db/schema.js';
import type { RuntimeEnv } from '../env.js';
import { generateRagAnswer } from '../services/ai.js';
import { searchArticles } from '../services/search.js';
import { syncAllSubscriptions } from '../workflows/sync.js';
import { logger } from '../utils/logger.js';
import type { SearchArticleResult } from '../services/search.js';

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
  publishedAt: string;
  siteUrl: string;
  summary: string;
  title: string;
  url: string;
};

type SearchReferenceResponse = {
  id: string;
  title: string;
  url: string;
};

type SourceRow = {
  articleId: string | null;
  id: string;
  isRead: boolean | number | null;
  siteUrl: string;
  title: string | null;
};

type ArticleRow = {
  content: string | null;
  createdAt: Date | string | number | null;
  id: string;
  hatenaSummary: string | null;
  isRead: boolean | number | null;
  publishedAt: Date | string | number | null;
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
const defaultPort = 3000;

type ServerEnv = RuntimeEnv & {
  ADMIN_PASSWORD?: string;
  ADMIN_USERNAME?: string;
  PORT?: string;
};

function getPort(env: ServerEnv = process.env): number {
  return Number(env.PORT ?? defaultPort);
}

function createBasicAuthMiddleware(env: ServerEnv) {
  const username = env.ADMIN_USERNAME?.trim();
  const password = env.ADMIN_PASSWORD ?? '';

  if (!username || password.length === 0) {
    return null;
  }

  return basicAuth({
    challenge: true,
    realm: 'RSS Reader',
    users: {
      [username]: password,
    },
  });
}

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
    publishedAt: formatDate(article.publishedAt ?? article.createdAt),
    siteUrl: article.siteUrl,
    summary: article.summary ?? '',
    title: article.title,
    url: article.url,
  };
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function buildRagContexts(results: SearchArticleResult[]): string[] {
  return results.map((result) =>
    [
      `タイトル: ${result.title}`,
      stripHtml(result.summary).length > 0 ? `記事要約: ${stripHtml(result.summary)}` : null,
      stripHtml(result.hatenaSummary).length > 0 ? `はてブ要約: ${stripHtml(result.hatenaSummary)}` : null,
    ]
      .filter((line): line is string => line !== null)
      .join('\n'),
  );
}

function buildRagReferences(results: SearchArticleResult[]): SearchReferenceResponse[] {
  return results.map((result) => ({
    id: result.id,
    title: result.title,
    url: result.url,
  }));
}

function sourceHostname(siteUrl: string): string {
  try {
    return new URL(siteUrl).hostname;
  } catch {
    return siteUrl;
  }
}

function sourceTitleBase(source: Pick<SourceRow, 'siteUrl' | 'title'>): string {
  const title = source.title?.trim();
  return title && title.length > 0 ? title : sourceHostname(source.siteUrl);
}

function sourceSuffix(siteUrl: string): string {
  try {
    const url = new URL(siteUrl);
    const segments = url.pathname.split('/').filter(Boolean);
    if (segments.length === 0) {
      return '';
    }

    return segments[segments.length - 1]!.replace(/\.[^.]+$/, '').trim().toUpperCase();
  } catch {
    return '';
  }
}

function isHatenaSource(siteUrl: string): boolean {
  try {
    return new URL(siteUrl).hostname === 'b.hatena.ne.jp';
  } catch {
    return false;
  }
}

function sourceDisplayTitle(
  source: Pick<SourceRow, 'siteUrl' | 'title'>,
  titleCounts: Map<string, number>,
): string {
  const base = sourceTitleBase(source);
  const suffix = sourceSuffix(source.siteUrl);
  const shouldDisambiguate = (titleCounts.get(base) ?? 0) > 1 || isHatenaSource(source.siteUrl);

  if (!shouldDisambiguate || suffix.length === 0) {
    return base;
  }

  return `${base} (${suffix})`;
}

function normalizeSiteUrl(siteUrl: string): string {
  return new URL(siteUrl).toString();
}

async function fetchArticles(sourceUrl?: string, unreadOnly = true): Promise<ArticleRow[]> {
  const query = db
    .select({
      content: articles.content,
      createdAt: articles.createdAt,
      hatenaSummary: articles.hatenaSummary,
      id: articles.id,
      isRead: articles.isRead,
      publishedAt: articles.publishedAt,
      siteUrl: articles.siteUrl,
      summary: articles.summary,
      title: articles.title,
      url: articles.url,
    })
    .from(articles);

  const filters = [];
  if (sourceUrl) {
    filters.push(eq(articles.siteUrl, sourceUrl));
  }

  if (unreadOnly) {
    filters.push(eq(articles.isRead, false));
  }

  const filteredQuery = filters.length > 0 ? query.where(and(...filters)) : query;

  return await filteredQuery.orderBy(asc(sql`coalesce(${articles.publishedAt}, ${articles.createdAt})`));
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

export function createApp(env: ServerEnv = process.env) {
  const app = express();

  const basicAuthMiddleware = createBasicAuthMiddleware(env);
  if (basicAuthMiddleware) {
    app.use(basicAuthMiddleware);
  }

  app.use(express.json());
  app.use(express.static(publicDir));

  app.get('/api/articles', async (request, response, next) => {
    try {
      const sourceUrl =
        typeof request.query.source === 'string' && request.query.source.trim().length > 0
          ? request.query.source.trim()
          : undefined;
      const unreadOnly = request.query.unread_only === undefined ? true : request.query.unread_only === 'true';

      const articleRows = await fetchArticles(sourceUrl, unreadOnly);
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
          articleId: articles.id,
          isRead: articles.isRead,
          siteUrl: subscriptions.siteUrl,
          title: subscriptions.title,
        })
        .from(subscriptions)
        .leftJoin(articles, eq(articles.siteUrl, subscriptions.siteUrl))
        .orderBy(desc(subscriptions.addedAt));

      const titleCounts = new Map<string, number>();
      const sourceMap = new Map<
        string,
        {
          articleCount: number;
          displayTitle: string;
          id: string;
          unreadCount: number;
          siteUrl: string;
          title: string | null;
        }
      >();

      for (const source of sourceRows) {
        const existingSource =
          sourceMap.get(source.id) ??
          (() => {
            const baseSource = {
              articleCount: 0,
              displayTitle: '',
              id: source.id,
              unreadCount: 0,
              siteUrl: source.siteUrl,
              title: source.title,
            };
            sourceMap.set(source.id, baseSource);
            return baseSource;
          })();

        if (source.articleId) {
          existingSource.articleCount += 1;
          if (!source.isRead) {
            existingSource.unreadCount += 1;
          }
        }
      }

      for (const source of sourceRows) {
        const baseTitle = sourceTitleBase(source);
        titleCounts.set(baseTitle, (titleCounts.get(baseTitle) ?? 0) + 1);
      }

      for (const source of sourceMap.values()) {
        source.displayTitle = sourceDisplayTitle(source, titleCounts);
      }

      response.json({
        sources: Array.from(sourceMap.values()),
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/subscriptions', async (request, response, next) => {
    try {
      const siteUrl = typeof request.body?.siteUrl === 'string' ? request.body.siteUrl : '';
      if (siteUrl.trim().length === 0) {
        response.status(400).json({ error: 'siteUrl is required.' });
        return;
      }

      const normalizedSiteUrl = normalizeSiteUrl(siteUrl);
      const existingSubscription = await db
        .select({ id: subscriptions.id })
        .from(subscriptions)
        .where(eq(subscriptions.siteUrl, normalizedSiteUrl))
        .limit(1);

      if (existingSubscription.length === 0) {
        response.status(404).json({ error: 'Subscription not found.' });
        return;
      }

      await db.delete(subscriptions).where(eq(subscriptions.siteUrl, normalizedSiteUrl)).run();

      response.json({ siteUrl: normalizedSiteUrl });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/search', async (request, response, next) => {
    try {
      const query = typeof request.query.q === 'string' ? request.query.q : '';
      if (query.trim().length === 0) {
        response.json({ results: [], aiAnswer: '' });
        return;
      }

      if (
        query.trim().length > 0 &&
        (env.OPENCODE_GO_BASE_URL === undefined || env.OPENCODE_GO_API_KEY === undefined)
      ) {
        response.status(503).json({
          error: 'Search requires OPENCODE_GO_BASE_URL and OPENCODE_GO_API_KEY.',
        });
        return;
      }

      const results = await searchArticles(query, env);
      const references = buildRagReferences(results);
      const aiAnswer = await generateRagAnswer(query, buildRagContexts(results), results, env);
      response.json({ results, references, aiAnswer });
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
    void syncAllSubscriptions(false, env).catch((error: unknown) => {
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

export function startServer(env: ServerEnv = process.env) {
  const app = createApp(env);
  const port = getPort(env);
  return app.listen(port, '0.0.0.0', () => {
    logger.info(`Web server listening on http://localhost:${port}`);
  });
}

if (process.argv[1]?.includes('src/server/index.ts')) {
  startServer();
}
