import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '../test/setup.js';
import {
  _getRateLimiterStateForTest,
  _resetRateLimiterForTest,
  _setRandomForTest,
  _setSleepForTest,
  fetchHatenaBookmarks,
} from './hatena.js';

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
  beforeEach(() => {
    _resetRateLimiterForTest();
    _setRandomForTest(() => 0); // ジッターを最小値 (1 秒) に固定
    // テストでは sleep を即完了させて時間計測を単純化
    _setSleepForTest(() => new Promise<void>((resolve) => {
      // microtask 的に即座に解決
      resolve();
    }));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    _setSleepForTest(null);
    _setRandomForTest(null);
    _resetRateLimiterForTest();
  });

  it('keeps tag-only bookmarks and parses the bookmark timestamp', async () => {
    server.use(
      http.get(hatenaApiBaseUrl, ({ request }) => {
        const requestUrl = new URL(request.url);
        expect(request.headers.get('accept')).toBe(browserHeaders.accept);
        expect(request.headers.get('accept-language')).toBe(browserHeaders['accept-language']);
        expect(request.headers.get('cache-control')).toBe(browserHeaders['cache-control']);
        // UA は scraper.ts の browserRequestHeaders と一致する (統一)
        expect(request.headers.get('user-agent')).toBe(browserHeaders['user-agent']);
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

    await expect(fetchHatenaBookmarks(articleUrl)).resolves.toEqual([
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
        timestamp: expect.any(Date),
      },
    ]);
  });

  it('returns an empty list when Hatena responds with null', async () => {
    server.use(
      http.get(hatenaApiBaseUrl, () =>
        HttpResponse.json(null, {
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(fetchHatenaBookmarks(articleUrl)).resolves.toEqual([]);
  });

  it('honors Retry-After (seconds) on 429 and backs off subsequent requests', async () => {
    let callCount = 0;
    server.use(
      http.get(hatenaApiBaseUrl, () => {
        callCount += 1;
        return new HttpResponse(JSON.stringify({ bookmarks: [] }), {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '120', // 120 秒待つべき
          },
        });
      }),
    );

    await expect(fetchHatenaBookmarks(articleUrl)).rejects.toThrow(/rate limited/i);

    // 1 回目: 429 を受けたのでリミッター状態が更新されている
    const state1 = _getRateLimiterStateForTest();
    expect(state1.consecutiveBackoffs).toBe(1);
    expect(state1.nextAllowedAtMs).toBeGreaterThan(Date.now() + 60_000); // 最低 120 秒先

    // 2 回目: 1 回目より長い backoff (exponential)
    await expect(fetchHatenaBookmarks(articleUrl)).rejects.toThrow(/rate limited/i);
    const state2 = _getRateLimiterStateForTest();
    expect(state2.consecutiveBackoffs).toBe(2);
    // Retry-After: 120 が指定されているので、120 秒 backoff が max(前値, 新値) で反映される
    expect(state2.nextAllowedAtMs).toBeGreaterThanOrEqual(state1.nextAllowedAtMs);

    expect(callCount).toBe(2);
  });

  it('resets backoff counter on successful response', async () => {
    let callCount = 0;
    server.use(
      http.get(hatenaApiBaseUrl, () => {
        callCount += 1;
        if (callCount === 1) {
          return new HttpResponse(JSON.stringify({ bookmarks: [] }), {
            status: 429,
            headers: { 'Retry-After': '10' },
          });
        }
        return HttpResponse.json({ bookmarks: [] }, {
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    await expect(fetchHatenaBookmarks(articleUrl)).rejects.toThrow(/rate limited/i);
    expect(_getRateLimiterStateForTest().consecutiveBackoffs).toBe(1);

    // 2 回目は 200 → バックオフ累積がリセット
    await expect(fetchHatenaBookmarks(articleUrl)).resolves.toEqual([]);
    expect(_getRateLimiterStateForTest().consecutiveBackoffs).toBe(0);
  });

  it('falls back to exponential backoff when Retry-After is missing or unparseable', async () => {
    _setSleepForTest(() => new Promise<void>((resolve) => { resolve(); }));

    // Retry-After 無し
    server.use(
      http.get(hatenaApiBaseUrl, () =>
        new HttpResponse(null, {
          status: 503,
        }),
      ),
    );

    await expect(fetchHatenaBookmarks(articleUrl)).rejects.toThrow(/rate limited/i);
    const state1 = _getRateLimiterStateForTest();
    expect(state1.consecutiveBackoffs).toBe(1);
    // exponential: 1 回目 = 2^1 * 1000 = 2000 ms
    expect(state1.nextAllowedAtMs - Date.now()).toBeGreaterThan(0);
    expect(state1.nextAllowedAtMs - Date.now()).toBeLessThanOrEqual(maximumBackoffAllowedForTest());

    await expect(fetchHatenaBookmarks(articleUrl)).rejects.toThrow(/rate limited/i);
    const state2 = _getRateLimiterStateForTest();
    // 2 回目: 2^2 * 1000 = 4000 ms (or 上限)
    expect(state2.consecutiveBackoffs).toBe(2);
  });
});

function maximumBackoffAllowedForTest(): number {
  // 本番の maximumBackoffMs (5 分) と同じ値
  return 5 * 60 * 1000;
}
