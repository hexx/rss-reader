import { Hono } from 'hono';
import type { Context } from 'hono';

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';

import { articles, hatenaBookmarks, subscriptions } from './db/schema.js';
import { getDb } from './db/index.js';
import type { Bindings } from './env.js';
import type {
  Article,
  ArticleReadStateResponse,
  ArticleSortDirection,
  Bookmark,
  Source,
  SubscriptionMutationResponse,
  SyncAcceptedResponse,
} from './shared/types.js';
import { syncAllSubscriptions } from './workflows/sync.js';
import { discoverRssFeedUrl } from './services/scraper.js';

type SourceRow = {
  articleId: string | null;
  id: string;
  isRead: boolean | null;
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

type ArticleRow = {
  content: string | null;
  createdAt: Date | string | null;
  id: string;
  hatenaSummary: string | null;
  isRead: boolean | null;
  publishedAt: Date | string | null;
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
const bookmarkArticleIdChunkSize = 50;
const articlePageSize = 50;

function formatDate(value: Date | string | null | undefined): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === 'string') {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
    console.warn('formatDate: invalid date string encountered', value);
  }

  return '';
}

function createArticleResponse(article: ArticleRow, bookmarks: Bookmark[]): Article {
  return {
    bookmarks: bookmarks.map((bookmark) => ({
      comment: bookmark.comment ?? '',
      // fetchBookmarksByArticleIds で既に ISO 文字列にフォーマット済みのため、
      // ここではそのまま使う（二重フォーマットを避ける）。
      createdAt: bookmark.createdAt,
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

function parsePaginationParam(value: string | undefined, fallback: number, minimum: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < minimum) {
    return fallback;
  }

  return parsed;
}

type AppDatabase = ReturnType<typeof getDb>;

async function fetchArticles(
  database: AppDatabase,
  sourceUrl?: string,
  unreadOnly = true,
  limit = articlePageSize,
  offset = 0,
  sortDirection: ArticleSortDirection = 'asc',
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

  const orderDirection = sortDirection === 'asc'
    ? asc(sql`coalesce(${articles.publishedAt}, ${articles.createdAt})`)
    : desc(sql`coalesce(${articles.publishedAt}, ${articles.createdAt})`);

  return await filteredQuery
    .orderBy(orderDirection)
    .limit(limit)
    .offset(offset);
}

export async function fetchBookmarksByArticleIds(
  database: AppDatabase,
  articleIds: string[],
): Promise<Map<string, Bookmark[]>> {
  const result = new Map<string, Bookmark[]>();
  if (articleIds.length === 0) {
    return result;
  }

  for (let index = 0; index < articleIds.length; index += bookmarkArticleIdChunkSize) {
    const chunk = articleIds.slice(index, index + bookmarkArticleIdChunkSize);
    const rows: BookmarkRow[] = await database
      .select({
        articleId: hatenaBookmarks.articleId,
        comment: hatenaBookmarks.comment,
        createdAt: hatenaBookmarks.createdAt,
        id: hatenaBookmarks.id,
        user: hatenaBookmarks.user,
      })
      .from(hatenaBookmarks)
      .where(inArray(hatenaBookmarks.articleId, chunk));

    for (const row of rows) {
      const bookmark: Bookmark = {
        comment: row.comment ?? '',
        createdAt: formatDate(row.createdAt),
        id: row.id,
        user: row.user,
      };
      const items = result.get(row.articleId) ?? [];
      items.push(bookmark);
      result.set(row.articleId, items);
    }
  }

  return result;
}

app.get('/health', (c) => c.text('ok'));

app.get('/api/articles', async (c) => {
  const sourceUrl = c.req.query('source')?.trim() || undefined;
  const unreadOnly = c.req.query('unread_only') === undefined ? true : c.req.query('unread_only') === 'true';
  const limit = parsePaginationParam(c.req.query('limit'), articlePageSize, 1);
  const offset = parsePaginationParam(c.req.query('offset'), 0, 0);
  const sortParam = c.req.query('sort');
  const sortDirection: ArticleSortDirection = sortParam === 'desc' ? 'desc' : 'asc';
  const database = getDb(c.env);

  const articleRows = await fetchArticles(database, sourceUrl, unreadOnly, limit, offset, sortDirection);
  const bookmarksByArticleId = await fetchBookmarksByArticleIds(
    database,
    articleRows.map((article) => article.id),
  );

  const articles: Article[] = articleRows.map((article) =>
    createArticleResponse(article, bookmarksByArticleId.get(article.id) ?? []),
  );

  return c.json({ articles });
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

  const sources: Source[] = groupedSources.map((source) => ({
    articleCount: source.articleCount,
    displayTitle: sourceDisplayTitle(source, titleCounts),
    id: source.id,
    siteUrl: source.siteUrl,
    title: sourceTitleBase(source),
    unreadCount: source.unreadCount,
  }));

  return c.json({ sources });
});

app.delete('/api/subscriptions', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON in request body.' }, 400);
  }
  if (body === null || typeof body !== 'object') {
    return c.json({ error: 'Request body must be a JSON object.' }, 400);
  }
  const parsed = body as { siteUrl?: unknown };
  const siteUrl = typeof parsed.siteUrl === 'string' ? parsed.siteUrl : '';
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
  let requestBody: unknown;
  try {
    requestBody = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON in request body.' }, 400);
  }
  if (requestBody === null || typeof requestBody !== 'object') {
    return c.json({ error: 'Request body must be a JSON object.' }, 400);
  }
  const parsed = requestBody as { siteUrl?: unknown };
  const siteUrl = typeof parsed.siteUrl === 'string' ? parsed.siteUrl : '';
  if (siteUrl.trim().length === 0) {
    return c.json({ error: 'siteUrl is required.' }, 400);
  }

  const normalizedSiteUrl = normalizeSiteUrl(siteUrl);

  // 入力 URL から実際の RSS/Atom フィード URL を自動検出する。
  // 入力が既にフィード URL の場合はそのまま、そうでない場合は HTML 内の
  // <link rel="alternate"> タグを探索してフィード URL を特定する。
  let discoveredFeed: Awaited<ReturnType<typeof discoverRssFeedUrl>>;
  try {
    discoveredFeed = await discoverRssFeedUrl(normalizedSiteUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('RSS フィードの自動検出に失敗しました。', { siteUrl: normalizedSiteUrl, error: message });
    return c.json(
      { error: '指定されたURLからRSSフィードを検出できませんでした。URLを確認してください。' },
      400,
    );
  }

  if (discoveredFeed === null) {
    return c.json(
      { error: '指定されたURLからRSSフィードを検出できませんでした。URLを確認してください。' },
      400,
    );
  }

  const feedSiteUrl = discoveredFeed.feedUrl;
  const database = getDb(c.env);
  const existingSubscription = await database
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(eq(subscriptions.siteUrl, feedSiteUrl))
    .limit(1);

  if (existingSubscription.length > 0) {
    return c.json({ error: 'Subscription already exists.' }, 409);
  }

  const id = crypto.randomUUID();
  const title = sourceHostname(feedSiteUrl);
  await database.insert(subscriptions).values({
    id,
    siteUrl: feedSiteUrl,
    title,
  }).run();

  const response: SubscriptionMutationResponse = {
    alreadyAFeed: discoveredFeed.alreadyAFeed,
    detectedFeed: !discoveredFeed.alreadyAFeed,
    feedType: discoveredFeed.type,
    id,
    siteUrl: feedSiteUrl,
    title,
  };

  return c.json(response, 201);
});

type ArticleContext = Context<{ Bindings: Bindings }>;

async function updateArticleReadState(c: ArticleContext) {
  const articleId = c.req.param('id');
  if (typeof articleId !== 'string' || articleId.length === 0) {
    return c.json({ error: 'articleId is required.' }, 400);
  }
  const database = getDb(c.env);
  const existingArticle = await database
    .select({ id: articles.id })
    .from(articles)
    .where(eq(articles.id, articleId))
    .limit(1);

  if (existingArticle.length === 0) {
    return c.json({ error: 'Article not found.' }, 404);
  }

  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON in request body.' }, 400);
  }
  if (body === null || typeof body !== 'object') {
    return c.json({ error: 'Request body must be a JSON object.' }, 400);
  }
  const parsed = body as { isRead?: unknown };
  const isRead = typeof parsed.isRead === 'boolean' ? parsed.isRead : true;
  await database.update(articles).set({ isRead }).where(eq(articles.id, articleId)).run();

  const response: ArticleReadStateResponse = { id: articleId, isRead };
  return c.json(response);
}

app.patch('/api/articles/:id', updateArticleReadState);
app.patch('/api/articles/:id/read', updateArticleReadState);

app.post('/api/sync', (c) => {
  const syncTask = syncAllSubscriptions(false, c.env, false).catch((error: unknown) => {
    console.error('同期APIの実行に失敗しました。', { error });
  });
  if (c.executionCtx) {
    c.executionCtx.waitUntil(syncTask);
  } else {
    // syncTask は定義時に .catch() 済みのため、ここでは追加のエラーハンドリングは不要。
    void syncTask;
  }

  const response: SyncAcceptedResponse = { status: 'accepted' };
  return c.json(response, 202);
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

type ScheduledContext = {
  waitUntil: (promise: Promise<unknown>) => void;
};

function createScheduledHandler() {
  return async (_event: unknown, env: Bindings, ctx: ScheduledContext) => {
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
