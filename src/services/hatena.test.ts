import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '../test/setup.js';
import {
  _getRateLimiterStateForTest,
  _resetRateLimiterForTest,
  _setRandomForTest,
  _setSleepForTest,
} from '../test-utils/hatena-rate-limiter.js';
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

    // 1 回目: 429 を受けたのでリミッター状態が更新されている。
    // Retry-After: 120 をジッター 50%–100% で適用するので 60_000–120_000 ms 先。
    // _getRateLimiterStateForTest() の前後で ms ドリフトが入らないよう、
    // state 取得直後に `now` を取ってそこを基準にする。
    const state1 = _getRateLimiterStateForTest();
    const now1 = Date.now();
    expect(state1.consecutiveBackoffs).toBe(1);
    expect(state1.nextAllowedAtMs).toBeGreaterThanOrEqual(now1 + 60_000);
    expect(state1.nextAllowedAtMs).toBeLessThanOrEqual(now1 + 120_000);

    // 2 回目: 同様に Retry-After: 120 を受ける。
    // consecutiveBackoffs は増えるが、Retry-After が同じなら
    // nextAllowedAtMs は max() で前値以上に保たれる。
    await expect(fetchHatenaBookmarks(articleUrl)).rejects.toThrow(/rate limited/i);
    const state2 = _getRateLimiterStateForTest();
    expect(state2.consecutiveBackoffs).toBe(2);
    expect(state2.nextAllowedAtMs).toBeGreaterThanOrEqual(state1.nextAllowedAtMs);

    expect(callCount).toBe(2);
  });

  it('rejects Retry-After values with non-numeric suffixes (parseInt partial-match guard)', async () => {
    server.use(
      http.get(hatenaApiBaseUrl, () =>
        new HttpResponse(JSON.stringify({ bookmarks: [] }), {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            // 数値 + 文字列の混合値。parseInt だと 120 が拾われてしまうが、
            // 厳密正規表現 /^\d+$/ では弾いて exponential backoff にフォールバックする。
            'Retry-After': '120abc',
          },
        }),
      ),
    );

    await expect(fetchHatenaBookmarks(articleUrl)).rejects.toThrow(/rate limited/i);

    const state = _getRateLimiterStateForTest();
    const now = Date.now();
    // 1 回目の exponential backoff は 1s (= 1000 ms) ベース × ジッター 50%
    // → randomFn = () => 0 のとき 500ms になる
    expect(state.consecutiveBackoffs).toBe(1);
    const wait = state.nextAllowedAtMs - now;
    expect(wait).toBeGreaterThan(0);
    expect(wait).toBeLessThan(1_000);
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

  it('falls back to exponential backoff with jitter when Retry-After is missing', async () => {
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
    const now1 = Date.now();
    expect(state1.consecutiveBackoffs).toBe(1);
    // exponential: 1 回目 = 2^0 * 1000 = 1000 ms ジッター 50%–100%
    // → randomFn = () => 0 のとき 500ms
    const wait1 = state1.nextAllowedAtMs - now1;
    expect(wait1).toBeGreaterThan(0);
    expect(wait1).toBeLessThanOrEqual(maximumBackoffAllowedForTest());

    await expect(fetchHatenaBookmarks(articleUrl)).rejects.toThrow(/rate limited/i);
    const state2 = _getRateLimiterStateForTest();
    const now2 = Date.now();
    // 2 回目: 2^1 * 1000 = 2000 ms ジッター 50%–100% → 1000–2000ms
    expect(state2.consecutiveBackoffs).toBe(2);
    const wait2 = state2.nextAllowedAtMs - now2;
    expect(state2.nextAllowedAtMs).toBeGreaterThanOrEqual(state1.nextAllowedAtMs);
    expect(wait2).toBeLessThanOrEqual(maximumBackoffAllowedForTest());
  });
});

function maximumBackoffAllowedForTest(): number {
  // 本番の maximumBackoffMs (5 分) と同じ値
  return 5 * 60 * 1000;
}
