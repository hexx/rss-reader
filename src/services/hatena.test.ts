import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { server } from '../test/setup.js';
import { fetchHatenaBookmarks } from './hatena.js';

const articleUrl = 'https://example.com/articles/1';
const hatenaApiBaseUrl = 'https://b.hatena.ne.jp/entry/jsonlite/';
const browserHeaders = {
  accept: 'application/json',
  'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
  'cache-control': 'no-cache',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

const hatenaResponse = {
  bookmarks: [
    {
      user: 'alice',
      comment: '  良記事  ',
      timestamp: '1704067200', // 2024-01-01T00:00:00Z
    },
    {
      // コメント空（タグだけ）のブックマークは保持する
      user: 'bob',
      comment: '',
      timestamp: '1704153600', // 2024-01-02T00:00:00Z
    },
    {
      user: 'carol',
      comment: '参考になる',
      timestamp: '1704240000', // 2024-01-03T00:00:00Z
    },
    {
      // user 欠落エントリは破棄する
      comment: 'no user here',
      timestamp: '1704326400',
    },
    {
      user: 'eve',
      // timestamp 欠落は fetch 時刻でフォールバック
      comment: 'no timestamp',
    },
  ],
};

describe('fetchHatenaBookmarks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps tag-only bookmarks and parses the bookmark timestamp', async () => {
    server.use(
      http.get(hatenaApiBaseUrl, ({ request }) => {
        const requestUrl = new URL(request.url);
        expect(request.headers.get('accept')).toBe(browserHeaders.accept);
        expect(request.headers.get('accept-language')).toBe(browserHeaders['accept-language']);
        expect(request.headers.get('cache-control')).toBe(browserHeaders['cache-control']);
        expect(request.headers.get('user-agent')).toBe('rss-reader/1.0');
        if (requestUrl.searchParams.get('url') !== articleUrl) {
          return HttpResponse.json(
            { bookmarks: [] },
            {
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }

        return HttpResponse.json(hatenaResponse, {
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.useFakeTimers();
    // フォールバックのタイムスタンプ基準を固定する
    // (sleep 1 秒の後に `new Date()` が評価されるため、1 秒後の時刻を期待値にする)
    const fallbackTime = new Date('2024-12-31T00:00:00.000Z');
    vi.setSystemTime(fallbackTime);

    const promise = fetchHatenaBookmarks(articleUrl);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(promise).resolves.toEqual([
      {
        user: 'alice',
        comment: '良記事',
        timestamp: new Date('2024-01-01T00:00:00.000Z'),
      },
      {
        user: 'bob',
        comment: '',
        timestamp: new Date('2024-01-02T00:00:00.000Z'),
      },
      {
        user: 'carol',
        comment: '参考になる',
        timestamp: new Date('2024-01-03T00:00:00.000Z'),
      },
      {
        user: 'eve',
        comment: 'no timestamp',
        timestamp: new Date('2024-12-31T00:00:01.000Z'),
      },
    ]);
  });

  it('returns an empty list when Hatena responds with null', async () => {
    server.use(
      http.get(hatenaApiBaseUrl, ({ request }) => {
        expect(request.headers.get('accept')).toBe(browserHeaders.accept);
        expect(request.headers.get('accept-language')).toBe(browserHeaders['accept-language']);
        expect(request.headers.get('cache-control')).toBe(browserHeaders['cache-control']);
        expect(request.headers.get('user-agent')).toBe('rss-reader/1.0');
        return HttpResponse.json(null, {
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.useFakeTimers();

    const promise = fetchHatenaBookmarks(articleUrl);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(promise).resolves.toEqual([]);
  });
});
