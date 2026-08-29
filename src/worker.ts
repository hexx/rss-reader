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
import { createEgressContext } from './services/egress.js';
import { discoverRssFeedUrl } from './services/scraper.js';
import type { DiscoveredFeed } from './services/scraper.js';

interface SourceRow {
  articleId: string | null;
  id: string;
  isRead: boolean | null;
  siteUrl: string;
  title: string | null;
}

interface SourceAggregate {
  articleCount: number;
  id: string;
  siteUrl: string;
  title: string | null;
  unreadCount: number;
}

interface ArticleRow {
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
}

interface BookmarkRow {
  articleId: string;
  comment: string | null;
  createdAt: Date | string | null;
  id: string;
  user: string;
}

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
    content: article.content ?? '',
    createdAt: formatDate(article.createdAt),
    hatenaSummary: article.hatenaSummary?.trim() ?? '',
    id: article.id,
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

    return segments.at(-1)!.replace(/\.[^.]+$/, '').trim().toUpperCase();
  } catch {
    return '';
  }
}

/**
 * ブックマーク掲載元（Bookmark Host）の判定。
 * はてなブックマーク由来の Source の表示名を紛れ解消するためだけで、
 * 律速が束ねる運用者群（はてな群）より範囲の狭い別概念である（CONTEXT.md 参照）。
 */
function isHatenaBookmarkHost(siteUrl: string): boolean {
  try {
    return new URL(siteUrl).hostname === 'b.hatena.ne.jp';
  } catch {
    return false;
  }
}

function sourceDisplayTitle(source: Pick<SourceRow, 'siteUrl' | 'title'>, titleCounts: Map<string, number>): string {
  const base = sourceTitleBase(source);
  const suffix = sourceSuffix(source.siteUrl);
  const shouldDisambiguate = (titleCounts.get(base) ?? 0) > 1 || isHatenaBookmarkHost(source.siteUrl);

  if (!shouldDisambiguate || suffix.length === 0) {
    return base;
  }

  return `${base} (${suffix})`;
}

/**
 * ユーザー入力の URL を正規化する。不正な URL や http(s) 以外のスキームは null を返す。
 * ルートハンドラでは例外を 500 にせず、400 で返すために使う。
 * ユーザー情報（user:pass@）とフラグメントは購読キーや fetch ターゲットに
 * 残すと漏洩・不一致の原因になるため除去する。
 */
function tryNormalizeSiteUrl(siteUrl: string): string | null {
  try {
    const url = new URL(siteUrl);
    if (!['http:', 'https:'].includes(url.protocol)) {
      return null;
    }
    url.username = '';
    url.password = '';
    url.hash = '';
    return url.toString();
  } catch {
    return null;
  }
}

/** ページネーションの limit 上限（過剰な応答サイズによる DoS を防ぐ）。 */
const maxArticlePageSize = 200;
/** ページネーションの offset 上限（過剰な行スキップによる DoS を防ぐ）。 */
const maxArticleOffset = 10_000;

function parsePaginationParam(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum?: number,
): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || Number.isNaN(parsed) || parsed < minimum) {
    return maximum === undefined ? fallback : Math.min(fallback, maximum);
  }

  return maximum === undefined ? parsed : Math.min(parsed, maximum);
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

  // 並び順の式は schema.ts の式インデックス articles_sort_idx と同一に保つこと
  // （ずれると SQLite がインデックスを使えなくなる）。
  const orderDirection = sortDirection === 'asc'
    ? asc(sql`coalesce(${articles.publishedAt}, ${articles.createdAt})`)
    : desc(sql`coalesce(${articles.publishedAt}, ${articles.createdAt})`);

  return await filteredQuery
    .orderBy(orderDirection, asc(sql`rowid`))
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
      .where(inArray(hatenaBookmarks.articleId, chunk))
      // 時系列・新しい順（本家「新着順」と同じ）。timestamp は分精度なので
      // 同一分内は SQLite の暗黙 rowid 昇順（＝jsonlite 生順序＝挿入順）で
      // tiebreak し、決定的な並びにする。ADR-0003 参照。
      .orderBy(desc(hatenaBookmarks.createdAt), asc(sql`rowid`));

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
  const limit = parsePaginationParam(c.req.query('limit'), articlePageSize, 1, maxArticlePageSize);
  const offset = parsePaginationParam(c.req.query('offset'), 0, 0, maxArticleOffset);
  const sortParam = c.req.query('sort');
  const sortDirection: ArticleSortDirection = sortParam === 'desc' ? 'desc' : 'asc';
  const database = getDb(c.env);

  const articleRows = await fetchArticles(database, sourceUrl, unreadOnly, limit, offset, sortDirection);
  const bookmarksByArticleId = await fetchBookmarksByArticleIds(
    database,
    articleRows.map((article) => article.id),
  );

  const articleList: Article[] = articleRows.map((article) =>
    createArticleResponse(article, bookmarksByArticleId.get(article.id) ?? []),
  );

  return c.json({ articles: articleList });
});

app.get('/api/sources', async (c) => {
  const database = getDb(c.env);
  const sourceRows = (await database
    .select({
      articleId: articles.id,
      id: subscriptions.id,
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

  const groupedSources = [...sourcesById.values()];
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

  const normalizedSiteUrl = tryNormalizeSiteUrl(siteUrl);
  if (normalizedSiteUrl === null) {
    return c.json({ error: 'siteUrl が不正です。' }, 400);
  }
  const database = getDb(c.env);
  const existingSubscription = await database
    .select({ id: subscriptions.id })
    .from(subscriptions)
    .where(eq(subscriptions.siteUrl, normalizedSiteUrl))
    .limit(1);

  if (existingSubscription.length === 0) {
    return c.json({ error: 'Subscription not found.' }, 404);
  }

  // 購読解除に伴い、そのサイトの記事とはてブコメントも削除する（孤児データを残さない）。
  // はてブコメントは記事の FK で CASCADE されるが、D1 の FK 有効化状況に依存しないよう
  // 明示的に削除する（サブクエリで ID 列挙も不要）。
  // 並行同期（cron / POST /api/sync）との競合で途中状態が残らないよう、
  // D1 では batch（トランザクション）で一括実行する。テスト用 sql.js には batch が
  // 無いため、その場合は子 → 親の順（はてブ → 記事 → 購読）で逐次実行し、
  // 途中失敗でも購読行が残って再実行で追完できるようにする。
  const siteArticleIds = database
    .select({ id: articles.id })
    .from(articles)
    .where(eq(articles.siteUrl, normalizedSiteUrl));
  const deleteStatements = [
    database.delete(hatenaBookmarks).where(inArray(hatenaBookmarks.articleId, siteArticleIds)),
    database.delete(articles).where(eq(articles.siteUrl, normalizedSiteUrl)),
    database.delete(subscriptions).where(eq(subscriptions.siteUrl, normalizedSiteUrl)),
  ];
  const batchable = database as { batch?: (items: unknown[]) => Promise<unknown> };
  if (typeof batchable.batch === 'function') {
    await batchable.batch(deleteStatements);
  } else {
    for (const statement of deleteStatements) {
      await statement.run();
    }
  }

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

  const normalizedSiteUrl = tryNormalizeSiteUrl(siteUrl);
  if (normalizedSiteUrl === null) {
    return c.json({ error: 'siteUrl が不正です。' }, 400);
  }

  // 入力 URL から実際の RSS/Atom フィード URL を自動検出する。
  // 入力が既にフィード URL の場合はそのまま、そうでない場合は HTML 内の
  // <link rel="alternate"> タグを探索してフィード URL を特定する。
  let discoveredFeed: DiscoveredFeed | null;
  try {
    discoveredFeed = await discoverRssFeedUrl(createEgressContext(c.env), normalizedSiteUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn('RSS フィードの自動検出に失敗しました。', { error: message, siteUrl: normalizedSiteUrl });
    discoveredFeed = null;
  }

  if (!discoveredFeed) {
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
  if (typeof parsed.isRead !== 'boolean') {
    return c.json({ error: 'isRead must be a boolean.' }, 400);
  }
  const isRead = parsed.isRead;
  await database.update(articles).set({ isRead }).where(eq(articles.id, articleId)).run();

  const response: ArticleReadStateResponse = { id: articleId, isRead };
  return c.json(response);
}

app.patch('/api/articles/:id', updateArticleReadState);
app.patch('/api/articles/:id/read', updateArticleReadState);

app.post('/api/sync', (c) => {
  // `?force=true` はクールダウンだけを無視して取得する（枠内の最小間隔は守る）。
  // UI からは使わず、運用上の手動リカバリ専用の引数（docs/specs/sync-egress-politeness.md）。
  const force = c.req.query('force') === 'true';
  const syncTask = syncAllSubscriptions(false, c.env, true, { force }).catch((error: unknown) => {
    console.error('同期APIの実行に失敗しました。', { error });
  });
  if (c.executionCtx) {
    c.executionCtx.waitUntil(syncTask);
  } else {
    // SyncTask は定義時に .catch() 済みのため、ここでは追加のエラーハンドリングは不要。
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

interface ScheduledContext {
  waitUntil: (promise: Promise<unknown>) => void;
}

interface ScheduledEvent {
  cron: string;
}

/** フル同期（新着取り込み＋全フィード記事のはてブバックフィル）を起動する cron 式。 */
const FULL_SYNC_CRON = '0 */3 * * *';

function createScheduledHandler() {
  return async (event: ScheduledEvent, env: Bindings, ctx: ScheduledContext) => {
    // 3時間おきのフル同期のみ、既存記事のはてブバックフィルを行う。
    // 30分おきの取り込み専用 cron ではバックフィルをスキップし、はてなへの負荷を抑える。
    // 詳細: docs/adr/0002-split-sync-cadences.md
    const includeBookmarkBackfill = event.cron === FULL_SYNC_CRON;
    ctx.waitUntil(
      syncAllSubscriptions(false, env, includeBookmarkBackfill).catch((error: unknown) => {
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

// テスト用エクスポート（テストコードからのみ参照）
export {
  formatDate,
  isHatenaBookmarkHost,
  parsePaginationParam,
  sourceDisplayTitle,
  sourceHostname,
  sourceSuffix,
  sourceTitleBase,
};
