import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '../test/setup.js';
import {
  createTestEgressContext,
  installVirtualEgressTime,
  resetEgressTestHooks,
  type VirtualClock,
} from '../test-utils/egress.js';
import { EGRESS_POLICY, isThrottleError } from './egress.js';
import { fetchRssOrFallback } from './scraper.js';
import { fetchHatenaBookmarks } from './hatena.js';

const articleUrl = 'https://example.com/articles/1';
const hatenaApiBaseUrl = 'https://b.hatena.ne.jp/entry/jsonlite/';
const hatenaFeedUrl = 'https://konifar.hatenablog.com/rss';
const jsonHeaders = { 'Content-Type': 'application/json' };
const readerHeaders = {
  accept: 'application/json',
  'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
  'cache-control': 'no-cache',
  'user-agent': EGRESS_POLICY.userAgent,
};

const hatenaResponse = {
  bookmarks: [
    {
      comment: '  良記事  ',
      timestamp: '2024/01/01 09:00', // JST → 2024-01-01T00:00:00Z
      user: 'alice',
    },
    {
      // コメント空（タグだけ）のブックマークは保持する
      user: 'bob',
      comment: '',
      timestamp: '2024/01/02 09:00', // JST → 2024-01-02T00:00:00Z
    },
    {
      comment: '参考になる',
      timestamp: '2024/01/03 09:00', // JST → 2024-01-03T00:00:00Z
      user: 'carol',
    },
    {
      // User 欠落エントリは破棄する
      comment: 'no user here',
      timestamp: '2024/01/04 09:00',
    },
    {
      user: 'dave',
      // 旧形式（epoch 秒）は現行 jsonlite が返さないため不正値としてフォールバック
      comment: 'legacy epoch format',
      timestamp: '1704067200',
    },
    {
      user: 'eve',
      // Timestamp 欠落は fetch 時刻でフォールバック
      comment: 'no timestamp',
    },
  ],
};

describe('fetchHatenaBookmarks', () => {
  let egress = createTestEgressContext();
  let clock: VirtualClock;

  beforeEach(() => {
    clock = installVirtualEgressTime();
    egress = createTestEgressContext();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    resetEgressTestHooks();
  });

  it('keeps tag-only bookmarks and parses the bookmark timestamp', async () => {
    server.use(
      http.get(hatenaApiBaseUrl, ({ request }) => {
        const requestUrl = new URL(request.url);
        expect(request.headers.get('accept')).toBe(readerHeaders.accept);
        expect(request.headers.get('accept-language')).toBe(readerHeaders['accept-language']);
        expect(request.headers.get('cache-control')).toBe(readerHeaders['cache-control']);
        // 律速層のリーダ UA を使う（ADR-0011）。
        expect(request.headers.get('user-agent')).toBe(readerHeaders['user-agent']);
        if (requestUrl.searchParams.get('url') !== articleUrl) {
          return HttpResponse.json({ bookmarks: [] }, { headers: jsonHeaders });
        }

        return HttpResponse.json(hatenaResponse, { headers: jsonHeaders });
      }),
    );

    await expect(fetchHatenaBookmarks(egress, articleUrl)).resolves.toEqual([
      {
        comment: '良記事',
        timestamp: new Date('2024-01-01T00:00:00.000Z'),
        user: 'alice',
      },
      {
        comment: '',
        timestamp: new Date('2024-01-02T00:00:00.000Z'),
        user: 'bob',
      },
      {
        comment: '参考になる',
        timestamp: new Date('2024-01-03T00:00:00.000Z'),
        user: 'carol',
      },
      {
        comment: 'legacy epoch format',
        timestamp: expect.any(Date),
        user: 'dave',
      },
      {
        comment: 'no timestamp',
        timestamp: expect.any(Date),
        user: 'eve',
      },
    ]);
  });

  it('parses the JST timestamp with an explicit +09:00 offset', async () => {
    server.use(
      http.get(hatenaApiBaseUrl, () =>
        HttpResponse.json(
          { bookmarks: [{ comment: 'c', timestamp: '2025/07/21 09:41', user: 'u' }] },
          { headers: jsonHeaders },
        )),
    );

    await expect(fetchHatenaBookmarks(egress, articleUrl)).resolves.toEqual([
      {
        comment: 'c',
        // JST 09:41 = UTC 00:41。環境のローカルタイムゾーンに依存しないこと。
        timestamp: new Date('2025-07-21T00:41:00.000Z'),
        user: 'u',
      },
    ]);
  });

  it('returns an empty list when Hatena responds with null', async () => {
    server.use(http.get(hatenaApiBaseUrl, () => HttpResponse.json(null, { headers: jsonHeaders })));

    await expect(fetchHatenaBookmarks(egress, articleUrl)).resolves.toEqual([]);
  });

  it('rejects HTML error pages served with a 200 status', async () => {
    server.use(
      http.get(
        hatenaApiBaseUrl,
        () =>
          new HttpResponse('<html><body>bot check</body></html>', {
            headers: { 'Content-Type': 'text/html' },
            status: 200,
          }),
      ),
    );

    await expect(fetchHatenaBookmarks(egress, articleUrl)).rejects.toThrow(/HTML instead of JSON/i);
  });

  it('rejects invalid JSON bodies with a descriptive error', async () => {
    server.use(
      http.get(
        hatenaApiBaseUrl,
        () => new HttpResponse('<not-json>', { headers: jsonHeaders, status: 200 }),
      ),
    );

    await expect(fetchHatenaBookmarks(egress, articleUrl)).rejects.toThrow(/Invalid JSON response/i);
  });

  it('translates a request timeout into a descriptive error', async () => {
    vi.useFakeTimers();
    // fetch が解決せず、abort シグナルで reject するスタブに差し替える
    const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      })) as typeof fetch;
    vi.stubGlobal('fetch', hangingFetch);

    try {
      const promise = fetchHatenaBookmarks(egress, articleUrl);
      // rejection ハンドラを先にアタッチしてから 15s のタイムアウトを経過させる
      // （先に進めると unhandled rejection になるため）
      const assertion = expect(promise).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(15_000 + 10);
      await assertion;
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  describe('律速層との連携（ADR-0009）', () => {
    it('429 ではてな群にクールダウンが設定され、続く取得は枠に弾かれる', async () => {
      server.use(
        http.get(hatenaApiBaseUrl, () =>
          new HttpResponse(JSON.stringify({ bookmarks: [] }), {
            headers: { ...jsonHeaders, 'Retry-After': '120' },
            status: 429,
          })),
      );

      const rejection = await fetchHatenaBookmarks(egress, articleUrl).catch((error: unknown) => error);
      expect(isThrottleError(rejection)).toBe(true);
      if (!isThrottleError(rejection)) {
        return;
      }
      expect(rejection.bucket).toBe('hatena');
      expect(rejection.nextRetryAtMs - clock.now()).toBe(120_000);

      // クールダウン中は同じ枠（=はてな系の全ホスト）が使えない。
      await expect(fetchHatenaBookmarks(egress, articleUrl)).rejects.toThrow(/cooling down/i);

      clock.advance(120_000);
      server.use(http.get(hatenaApiBaseUrl, () => HttpResponse.json({ bookmarks: [] }, { headers: jsonHeaders })));
      await expect(fetchHatenaBookmarks(egress, articleUrl)).resolves.toEqual([]);
    });

    it('はてな群ではフィード取得とはてブ取得が同じ枠を共有する', async () => {
      server.use(
        http.get(hatenaApiBaseUrl, () => HttpResponse.json({ bookmarks: [] }, { headers: jsonHeaders })),
        http.get(hatenaFeedUrl, () =>
          HttpResponse.text('<rss><channel><item><title>t</title></item></channel></rss>', {
            headers: { 'Content-Type': 'application/rss+xml' },
          })),
      );

      await fetchHatenaBookmarks(egress, articleUrl);

      // jsonlite が枠を予約した直後は、パスクールダウン前でもフィード取得は弾かれる。
      await expect(fetchRssOrFallback(egress, hatenaFeedUrl)).rejects.toThrow(/reserved by a concurrent run/u);

      clock.advance(EGRESS_POLICY.hatenaMinimumDelayMs);
      await expect(fetchRssOrFallback(egress, hatenaFeedUrl)).resolves.toEqual([]);
    });
  });
});
