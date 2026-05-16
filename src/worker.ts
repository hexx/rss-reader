import { Hono } from 'hono';

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { articles, hatenaBookmarks, subscriptions } from './db/schema.js';
import { getDb } from './db/index.js';
import type { Bindings } from './env.js';
import { generateRagAnswer } from './services/ai.js';
import { searchArticles } from './services/search.js';
import { syncAllSubscriptions } from './workflows/sync.js';

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

type SourceAggregate = {
  articleCount: number;
  id: string;
  siteUrl: string;
  title: string | null;
  unreadCount: number;
};

type SourceResponse = {
  articleCount: number;
  displayTitle: string;
  id: string;
  siteUrl: string;
  title: string;
  unreadCount: number;
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

const app = new Hono<{ Bindings: Bindings }>();

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

function createArticleResponse(article: ArticleRow, bookmarks: BookmarkRow[]): ArticleResponse {
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

function buildRagContexts(results: Array<{ hatenaSummary: string; summary: string; title: string }>): string[] {
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

function buildRagReferences(results: Array<{ id: string; title: string; url: string }>): SearchReferenceResponse[] {
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

function sourceDisplayTitle(source: Pick<SourceRow, 'siteUrl' | 'title'>, titleCounts: Map<string, number>): string {
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

function createBasicAuthMiddleware(env: Bindings | undefined) {
  const username = env?.ADMIN_USERNAME?.trim();
  const password = env?.ADMIN_PASSWORD ?? '';

  if (!username || password.length === 0) {
    return undefined;
  }

  return async (c: any, next: any) => {
    const authorization = c.req.header('authorization');
    if (!authorization?.startsWith('Basic ')) {
      return c.text('Unauthorized', 401, {
        'WWW-Authenticate': 'Basic realm="RSS Reader"',
      });
    }

    const encoded = authorization.slice('Basic '.length);
    let decoded = '';
    try {
      decoded = atob(encoded);
    } catch {
      return c.text('Unauthorized', 401, {
        'WWW-Authenticate': 'Basic realm="RSS Reader"',
      });
    }

    const separatorIndex = decoded.indexOf(':');
    const providedUsername = separatorIndex >= 0 ? decoded.slice(0, separatorIndex) : decoded;
    const providedPassword = separatorIndex >= 0 ? decoded.slice(separatorIndex + 1) : '';

    if (providedUsername !== username || providedPassword !== password) {
      return c.text('Unauthorized', 401, {
        'WWW-Authenticate': 'Basic realm="RSS Reader"',
      });
    }

    await next();
  };
}

async function fetchArticles(
  database: ReturnType<typeof getDb>,
  sourceUrl?: string,
  unreadOnly = true,
): Promise<ArticleRow[]> {
  const query = database
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

async function fetchBookmarksByArticleIds(
  database: ReturnType<typeof getDb>,
  articleIds: string[],
): Promise<BookmarkRow[]> {
  if (articleIds.length === 0) {
    return [];
  }

  return database
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

app.use('*', async (c, next) => {
  if (c.req.path === '/health') {
    await next();
    return;
  }

  const basicAuthMiddleware = createBasicAuthMiddleware(c.env);
  if (!basicAuthMiddleware) {
    await next();
    return;
  }

  return basicAuthMiddleware(c, next);
});

app.get('/health', (c) => c.text('ok'));

app.get('/api/articles', async (c) => {
  const sourceUrl = c.req.query('source')?.trim() || undefined;
  const unreadOnly = c.req.query('unread_only') === undefined ? true : c.req.query('unread_only') === 'true';
  const database = getDb(c.env);

  const articleRows = await fetchArticles(database, sourceUrl, unreadOnly);
  const bookmarkRows = await fetchBookmarksByArticleIds(database, articleRows.map((article) => article.id));

  const bookmarksByArticleId = new Map<string, BookmarkRow[]>();
  for (const bookmark of bookmarkRows) {
    const items = bookmarksByArticleId.get(bookmark.articleId) ?? [];
    items.push(bookmark);
    bookmarksByArticleId.set(bookmark.articleId, items);
  }

  return c.json({
    articles: articleRows.map((article) => createArticleResponse(article, bookmarksByArticleId.get(article.id) ?? [])),
  });
});

app.get('/api/sources', async (c) => {
  const database = getDb(c.env);
  const sourceRows = (await database
    .select({
      id: subscriptions.id,
      articleId: articles.id,
      isRead: articles.isRead,
      siteUrl: subscriptions.siteUrl,
      title: subscriptions.title,
    })
    .from(subscriptions)
    .leftJoin(articles, eq(articles.siteUrl, subscriptions.siteUrl))
    .orderBy(desc(subscriptions.addedAt))) as SourceRow[];

  const sourcesById = new Map<string, SourceAggregate>();
  for (const source of sourceRows) {
    const current = sourcesById.get(source.id);
    if (current) {
      if (source.articleId !== null) {
        current.articleCount += 1;
      }

      if (source.articleId !== null && source.isRead === false) {
        current.unreadCount += 1;
      }
      continue;
    }

    sourcesById.set(source.id, {
      articleCount: source.articleId === null ? 0 : 1,
      id: source.id,
      siteUrl: source.siteUrl,
      title: source.title,
      unreadCount: source.articleId !== null && source.isRead === false ? 1 : 0,
    });
  }

  const groupedSources = Array.from(sourcesById.values());
  const titleCounts = new Map<string, number>();
  for (const source of groupedSources) {
    const base = sourceTitleBase(source);
    titleCounts.set(base, (titleCounts.get(base) ?? 0) + 1);
  }

  return c.json({
    sources: groupedSources.map((source): SourceResponse => ({
      articleCount: source.articleCount,
      displayTitle: sourceDisplayTitle(source, titleCounts),
      id: source.id,
      siteUrl: source.siteUrl,
      title: sourceTitleBase(source),
      unreadCount: source.unreadCount,
    })),
  });
});

app.delete('/api/subscriptions', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { siteUrl?: unknown };
  const siteUrl = typeof body.siteUrl === 'string' ? body.siteUrl : '';
  if (siteUrl.trim().length === 0) {
    return c.json({ error: 'siteUrl is required.' }, 400);
  }

  const normalizedSiteUrl = normalizeSiteUrl(siteUrl);
  const database = getDb(c.env);
  const existingSubscription = await database
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(eq(subscriptions.siteUrl, normalizedSiteUrl))
    .limit(1);

  if (existingSubscription.length === 0) {
    return c.json({ error: 'Subscription not found.' }, 404);
  }

  await database.delete(subscriptions).where(eq(subscriptions.siteUrl, normalizedSiteUrl)).run();

  return c.json({ siteUrl: normalizedSiteUrl });
});

app.post('/api/subscriptions', async (c) => {
  const body = (await c.req.json().catch(() => ({}))) as { siteUrl?: unknown };
  const siteUrl = typeof body.siteUrl === 'string' ? body.siteUrl : '';
  if (siteUrl.trim().length === 0) {
    return c.json({ error: 'siteUrl is required.' }, 400);
  }

  const normalizedSiteUrl = normalizeSiteUrl(siteUrl);
  const database = getDb(c.env);
  const existingSubscription = await database
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(eq(subscriptions.siteUrl, normalizedSiteUrl))
    .limit(1);

  if (existingSubscription.length > 0) {
    return c.json({ error: 'Subscription already exists.' }, 409);
  }

  const id = crypto.randomUUID();
  const title = sourceHostname(normalizedSiteUrl);
  await database.insert(subscriptions).values({
    id,
    siteUrl: normalizedSiteUrl,
    title,
  }).run();

  return c.json(
    {
      id,
      siteUrl: normalizedSiteUrl,
      title,
    },
    201,
  );
});

app.get('/api/search', async (c) => {
  const query = c.req.query('q')?.trim() || '';
  if (query.length === 0) {
    return c.json({ aiAnswer: '', results: [] });
  }

  if (c.env.OPENCODE_GO_BASE_URL === undefined || c.env.OPENCODE_GO_API_KEY === undefined) {
    return c.json(
      {
        error: 'Search requires OPENCODE_GO_BASE_URL and OPENCODE_GO_API_KEY.',
      },
      503,
    );
  }

  const results = await searchArticles(query, c.env);
  const references = buildRagReferences(results);
  const aiAnswer = await generateRagAnswer(query, buildRagContexts(results), results, c.env);

  return c.json({ aiAnswer, references, results });
});

app.patch('/api/articles/:id/read', async (c) => {
  const articleId = c.req.param('id');
  const database = getDb(c.env);
  const existingArticle = await database
    .select({ id: articles.id })
    .from(articles)
    .where(eq(articles.id, articleId))
    .limit(1);

  if (existingArticle.length === 0) {
    return c.json({ error: 'Article not found.' }, 404);
  }

  const body = (await c.req.json().catch(() => ({}))) as { isRead?: unknown };
  const isRead = typeof body.isRead === 'boolean' ? body.isRead : true;
  await database.update(articles).set({ isRead }).where(eq(articles.id, articleId)).run();

  return c.json({ id: articleId, isRead });
});

app.post('/api/sync', (c) => {
  const syncTask = syncAllSubscriptions(false, c.env, false).catch((error: unknown) => {
    console.error('同期APIの実行に失敗しました。', { error });
  });
  if (c.executionCtx) {
    c.executionCtx.waitUntil(syncTask);
  } else {
    void syncTask;
  }

  return c.json({ status: 'accepted' }, 202);
});

app.get('*', async (c) => {
  if (c.req.path.startsWith('/api/')) {
    return c.notFound();
  }

  const assets = c.env.ASSETS;
  if (assets) {
    return assets.fetch(c.req.raw);
  }

  return c.text('Cloudflare Worker scaffold is not fully wired yet.', 503);
});

function createScheduledHandler() {
  return async (_event: unknown, env: Bindings, ctx: any) => {
    ctx.waitUntil(
      syncAllSubscriptions(false, env, true).catch((error: unknown) => {
        console.error('定期同期に失敗しました。', { error });
      }),
    );
  };
}

export default {
  fetch: app.fetch,
  scheduled: createScheduledHandler(),
};

export { app };
