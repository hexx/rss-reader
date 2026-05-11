import { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../services/search.js', () => ({
  searchArticles: vi.fn(),
}));

vi.mock('../services/ai.js', () => ({
  generateRagAnswer: vi.fn(),
}));

vi.mock('../workflows/sync.js', () => ({
  syncAllSubscriptions: vi.fn(),
}));

import { articles, hatenaBookmarks, subscriptions } from '../db/schema.js';
import { generateRagAnswer } from '../services/ai.js';
import { searchArticles } from '../services/search.js';

const generateRagAnswerMock = vi.mocked(generateRagAnswer);
const searchArticlesMock = vi.mocked(searchArticles);

let server: Server | null = null;

async function setupDatabase() {
  const { sqlite } = await import('../db/index.js');

  sqlite.exec(`
    DROP TABLE IF EXISTS hatena_bookmarks;
    DROP TABLE IF EXISTS articles;
    DROP TABLE IF EXISTS subscriptions;
    CREATE TABLE articles (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL UNIQUE,
      site_url TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT,
      summary TEXT,
      hatena_summary TEXT,
      is_read INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE hatena_bookmarks (
      id TEXT PRIMARY KEY,
      article_id TEXT NOT NULL,
      user TEXT NOT NULL,
      comment TEXT,
      created_at INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE subscriptions (
      id TEXT PRIMARY KEY,
      site_url TEXT NOT NULL UNIQUE,
      title TEXT,
      added_at INTEGER NOT NULL DEFAULT 0
    );
  `);
}

async function startServer() {
  const { createApp } = await import('./index.js');
  const app = createApp();
  await new Promise<void>((resolve, reject) => {
    server = app.listen(0, (error?: Error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });

  const currentServer = server;
  if (!currentServer) {
    throw new Error('Failed to start test server');
  }

  const address = currentServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to start test server');
  }

  return `http://127.0.0.1:${(address as AddressInfo).port}`;
}

describe('server api', () => {
  beforeEach(async () => {
    vi.stubEnv('DATABASE_URL', ':memory:');
    vi.stubEnv('OPENCODE_GO_BASE_URL', 'https://opencode.example/v1');
    vi.stubEnv('OPENCODE_GO_API_KEY', 'test-api-key');
    generateRagAnswerMock.mockReset();
    searchArticlesMock.mockReset();
    await setupDatabase();
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (server) {
      const currentServer = server;
      await new Promise<void>((resolve, reject) => {
        currentServer.close((error?: Error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
      server = null;
    }
  });

  it('returns enriched articles and filters by source', async () => {
    const { db } = await import('../db/index.js');

    await db.insert(subscriptions).values([
      {
        id: 'subscription-1',
        siteUrl: 'https://example.com/',
        title: 'Example Feed',
      },
      {
        id: 'subscription-2',
        siteUrl: 'https://another.example/',
        title: null,
      },
    ]);

    await db.insert(articles).values([
      {
        id: 'article-1',
        siteUrl: 'https://example.com/',
        url: 'https://example.com/articles/1',
        title: '最初の記事',
        content: '本文',
        summary: '本文要約',
        hatenaSummary: '反応要約',
        isRead: false,
      },
      {
        id: 'article-2',
        siteUrl: 'https://another.example/',
        url: 'https://another.example/posts/2',
        title: '別の記事',
        content: '本文2',
        summary: '別の要約',
        hatenaSummary: null,
        isRead: true,
      },
    ]);

    await db.insert(hatenaBookmarks).values({
      id: 'bookmark-1',
      articleId: 'article-1',
      user: 'alice',
      comment: '参考になる',
    });

    const baseUrl = await startServer();

    const allResponse = await fetch(`${baseUrl}/api/articles`);
    const allPayload = await allResponse.json();
    expect(allResponse.ok).toBe(true);
    expect(allPayload.articles).toHaveLength(2);
    expect(allPayload.articles.find((article: { title: string }) => article.title === '別の記事')).toMatchObject({
      hatenaSummary: '',
      isRead: true,
      siteUrl: 'https://another.example/',
      title: '別の記事',
      url: 'https://another.example/posts/2',
    });
      expect(allPayload.articles.find((article: { title: string }) => article.title === '最初の記事')).toMatchObject({
        bookmarks: [
          {
            comment: '参考になる',
            id: 'bookmark-1',
            user: 'alice',
          },
        ],
        hatenaSummary: '反応要約',
        isRead: false,
        siteUrl: 'https://example.com/',
        title: '最初の記事',
        url: 'https://example.com/articles/1',
      });

    const unreadResponse = await fetch(`${baseUrl}/api/articles?unread_only=true`);
    const unreadPayload = await unreadResponse.json();
    expect(unreadResponse.ok).toBe(true);
    expect(unreadPayload.articles).toHaveLength(1);
    expect(unreadPayload.articles[0]).toMatchObject({
      id: 'article-1',
      isRead: false,
      title: '最初の記事',
    });

    const sourceResponse = await fetch(`${baseUrl}/api/articles?source=${encodeURIComponent('https://example.com/')}`);
    const sourcePayload = await sourceResponse.json();
    expect(sourceResponse.ok).toBe(true);
    expect(sourcePayload.articles).toHaveLength(1);
    expect(sourcePayload.articles[0]).toMatchObject({
      siteUrl: 'https://example.com/',
      title: '最初の記事',
    });
  });

  it('returns AI answers for search results', async () => {
    searchArticlesMock.mockResolvedValue([
      {
        bookmarks: [],
        createdAt: '1970-01-01T00:00:00.000Z',
        id: 'article-1',
        hatenaSummary: 'はてブ要約',
        isRead: false,
        siteUrl: 'https://example.com/',
        summary: '記事の要約',
        title: '検索対象の記事',
        url: 'https://example.com/articles/1',
      },
    ]);
    generateRagAnswerMock.mockResolvedValue('AIの回答');

    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/api/search?q=${encodeURIComponent('検索語')}`);
    const payload = await response.json();

    expect(response.ok).toBe(true);
    expect(payload).toEqual({
      results: [
        {
          bookmarks: [],
          createdAt: '1970-01-01T00:00:00.000Z',
          id: 'article-1',
          hatenaSummary: 'はてブ要約',
          isRead: false,
          siteUrl: 'https://example.com/',
          summary: '記事の要約',
          title: '検索対象の記事',
          url: 'https://example.com/articles/1',
        },
      ],
      references: [
        {
          id: 'article-1',
          title: '検索対象の記事',
          url: 'https://example.com/articles/1',
        },
      ],
      aiAnswer: 'AIの回答',
    });
    expect(generateRagAnswerMock).toHaveBeenCalledWith('検索語', [
      'タイトル: 検索対象の記事\n記事要約: 記事の要約\nはてブ要約: はてブ要約',
    ], [
      {
        bookmarks: [],
        createdAt: '1970-01-01T00:00:00.000Z',
        id: 'article-1',
        hatenaSummary: 'はてブ要約',
        isRead: false,
        siteUrl: 'https://example.com/',
        summary: '記事の要約',
        title: '検索対象の記事',
        url: 'https://example.com/articles/1',
      },
    ]);
  });

  it('updates read state through the API', async () => {
    const { db } = await import('../db/index.js');

    await db.insert(articles).values({
      id: 'article-1',
      siteUrl: 'https://example.com/',
      url: 'https://example.com/articles/1',
      title: '最初の記事',
      content: '本文',
      summary: '本文要約',
      hatenaSummary: null,
      isRead: false,
    });

    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/api/articles/article-1/read`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ isRead: true }),
    });

    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toEqual({
      id: 'article-1',
      isRead: true,
    });

    const rows = await db.select().from(articles);
    expect(rows[0]?.isRead).toBe(true);
  });

  it('returns source counts for the sidebar', async () => {
    const { db } = await import('../db/index.js');

    await db.insert(subscriptions).values([
      {
        id: 'subscription-1',
        siteUrl: 'https://example.com/',
        title: 'Example Feed',
      },
      {
        id: 'subscription-2',
        siteUrl: 'https://another.example/',
        title: 'Another Feed',
      },
    ]);

    await db.insert(articles).values([
      {
        id: 'article-1',
        siteUrl: 'https://example.com/',
        url: 'https://example.com/articles/1',
        title: '最初の記事',
        content: '本文',
        summary: '本文要約',
        hatenaSummary: null,
        isRead: false,
      },
      {
        id: 'article-2',
        siteUrl: 'https://example.com/',
        url: 'https://example.com/articles/2',
        title: '次の記事',
        content: '本文2',
        summary: '要約2',
        hatenaSummary: null,
        isRead: false,
      },
    ]);

    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/api/sources`);
    const payload = await response.json();

    expect(response.ok).toBe(true);
    expect(payload.sources).toHaveLength(2);
    expect(payload.sources).toEqual(
      expect.arrayContaining([
        {
          articleCount: 0,
          displayTitle: 'Another Feed',
          id: 'subscription-2',
          title: 'Another Feed',
          siteUrl: 'https://another.example/',
        },
        {
          articleCount: 2,
          displayTitle: 'Example Feed',
          id: 'subscription-1',
          title: 'Example Feed',
          siteUrl: 'https://example.com/',
        },
      ]),
    );
  });

  it('disambiguates duplicate and Hatena source labels', async () => {
    const { db } = await import('../db/index.js');

    await db.insert(subscriptions).values([
      {
        id: 'subscription-1',
        siteUrl: 'https://example.com/daily.rss',
        title: 'Example Feed',
      },
      {
        id: 'subscription-2',
        siteUrl: 'https://another.example/weekly.rss',
        title: 'Example Feed',
      },
      {
        id: 'subscription-3',
        siteUrl: 'https://b.hatena.ne.jp/hotentry/it.rss',
        title: 'はてなブックマーク - 人気エントリー',
      },
    ]);

    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/api/sources`);
    const payload = await response.json();

    expect(response.ok).toBe(true);
    expect(payload.sources).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          displayTitle: 'Example Feed (DAILY)',
          id: 'subscription-1',
          siteUrl: 'https://example.com/daily.rss',
        }),
        expect.objectContaining({
          displayTitle: 'Example Feed (WEEKLY)',
          id: 'subscription-2',
          siteUrl: 'https://another.example/weekly.rss',
        }),
        expect.objectContaining({
          displayTitle: 'はてなブックマーク - 人気エントリー (IT)',
          id: 'subscription-3',
          siteUrl: 'https://b.hatena.ne.jp/hotentry/it.rss',
        }),
      ]),
    );
  });

  it('deletes subscriptions through the API', async () => {
    const { db } = await import('../db/index.js');

    await db.insert(subscriptions).values([
      {
        id: 'subscription-1',
        siteUrl: 'https://example.com/',
        title: 'Example Feed',
      },
      {
        id: 'subscription-2',
        siteUrl: 'https://another.example/',
        title: 'Another Feed',
      },
    ]);

    const baseUrl = await startServer();
    const response = await fetch(`${baseUrl}/api/subscriptions`, {
      method: 'DELETE',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ siteUrl: 'https://example.com/' }),
    });

    expect(response.ok).toBe(true);
    await expect(response.json()).resolves.toEqual({
      siteUrl: 'https://example.com/',
    });

    const rows = await db.select().from(subscriptions);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      siteUrl: 'https://another.example/',
      title: 'Another Feed',
    });
  });
});
