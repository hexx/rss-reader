import { HttpResponse, http } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { server } from '../test/setup.js';
import {
  createTestEgressContext,
  createVirtualClock,
  installVirtualEgressTime,
  resetEgressTestHooks,
} from '../test-utils/egress.js';

const { parseStringMock, parseURLMock } = vi.hoisted(() => ({
  parseStringMock: vi.fn(),
  parseURLMock: vi.fn(),
}));

vi.mock('rss-parser', () => ({
  default: class ParserMock {
    parseString = parseStringMock;
    parseURL = parseURLMock;
  },
}));

import { bucketKeyOf, EGRESS_POLICY } from './egress.js';
import { fetchArticleContent, fetchRssOrFallback, discoverRssFeedUrl, readBoundedText } from './scraper.js';

const feedUrl = 'https://example.com/feed.xml';
const fallbackUrl = 'https://example.com/';
const articleOneUrl = 'https://example.com/posts/one';
const articleTwoUrl = 'https://example.com/posts/two';
const pdfUrl = 'https://example.com/files/report.pdf';
const imageUrl = 'https://example.com/images/photo.png';
const readerHeaders = {
  'user-agent': EGRESS_POLICY.userAgent,
};
const browserHeaders = {
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
  'cache-control': 'no-cache',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

const feedXml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Example Feed</title>
    <item>
      <title>First article</title>
      <link>${articleOneUrl}</link>
      <pubDate>Tue, 02 Jan 2024 03:04:05 GMT</pubDate>
    </item>
  </channel>
</rss>`;

const articleHtml = `<!doctype html>
<html>
  <body>
    <nav>Navigation</nav>
    <main>
      <article>
        <h1>First article</h1>
        <p>Article body text.</p>
        <script>ignored</script>
        <footer>ignored footer</footer>
      </article>
    </main>
  </body>
</html>`;

const fallbackHtml = `<!doctype html>
<html>
  <body>
    <nav>
      <a href="/about">About</a>
    </nav>
    <main>
      <article>
        <a href="/posts/one">First article</a>
        <a href="/posts/two" title="Second article title"></a>
      </article>
    </main>
    <footer>
      <a href="/privacy">Privacy</a>
    </footer>
  </body>
</html>`;

const assetFallbackHtml = `<!doctype html>
<html>
  <body>
    <main>
      <article>
        <a href="${pdfUrl}">PDF</a>
        <a href="${imageUrl}" title="Image"></a>
        <a href="/posts/one">First article</a>
      </article>
    </main>
  </body>
</html>`;

describe('scraper service', () => {
  let egress = createTestEgressContext();
  let clock = createVirtualClock();

  beforeEach(() => {
    clock = installVirtualEgressTime();
    egress = createTestEgressContext();
  });

  afterEach(() => {
    resetEgressTestHooks();
    vi.useRealTimers();
    vi.restoreAllMocks();
    parseStringMock.mockReset();
    parseURLMock.mockReset();
  });

  it('extracts article content while dropping boilerplate markup', async () => {
    server.use(
      http.get(articleOneUrl, ({ request }) => {
        expect(request.headers.get('accept')).toBe(browserHeaders.accept);
        expect(request.headers.get('accept-language')).toBe(browserHeaders['accept-language']);
        expect(request.headers.get('cache-control')).toBe(browserHeaders['cache-control']);
        expect(request.headers.get('user-agent')).toBe(readerHeaders['user-agent']);

        return HttpResponse.text(articleHtml, { headers: { 'Content-Type': 'text/html' } });
      }),
    );

    await expect(fetchArticleContent(egress, articleOneUrl)).resolves.toBe('First article Article body text.');
  });

  it('rejects internal article URLs to prevent SSRF', async () => {
    await expect(fetchArticleContent(egress, 'http://127.0.0.1/')).rejects.toThrow(/internal/iu);
    await expect(fetchArticleContent(egress, 'http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/internal/iu);
    await expect(fetchArticleContent(egress, 'http://[::ffff:127.0.0.1]/')).rejects.toThrow(/internal/iu);
  });

  it('rejects redirects to internal addresses when fetching article content', async () => {
    server.use(
      http.get('https://public.example.com/article', () =>
        HttpResponse.text('', { headers: { Location: 'http://127.0.0.1/private' }, status: 302 }),
      ),
    );

    await expect(fetchArticleContent(egress, 'https://public.example.com/article')).rejects.toThrow(/internal/iu);
  });

  it('returns empty content when no article body can be extracted', async () => {
    server.use(
      http.get(
        articleTwoUrl,
        () => HttpResponse.text('<!doctype html><html><body><script>ignored</script></body></html>', { headers: { 'Content-Type': 'text/html' } }),
      ),
    );

    await expect(fetchArticleContent(egress, articleTwoUrl)).resolves.toBe('');
  });

  it('drops feed items with non-http(s) URLs (javascript: etc.)', async () => {
    server.use(
      http.get(feedUrl, () =>
        HttpResponse.text(feedXml, { headers: { 'Content-Type': 'application/rss+xml' } }),
      ),
    );

    parseStringMock.mockResolvedValueOnce({
      items: [
        { link: 'javascript:alert(1)', title: 'evil' },
        { link: 'data:text/html,<h1>x</h1>', title: 'data url' },
        { link: articleOneUrl, title: 'First article' },
      ],
    });

    await expect(fetchRssOrFallback(egress, feedUrl)).resolves.toEqual([
      {
        pubDate: null,
        title: 'First article',
        url: articleOneUrl,
      },
    ]);
  });

  it('parses RSS feeds before falling back to HTML link discovery', async () => {
    server.use(
      http.get(feedUrl, ({ request }) => {
        expect(request.headers.get('accept')).toBe(browserHeaders.accept);
        expect(request.headers.get('accept-language')).toBe(browserHeaders['accept-language']);
        expect(request.headers.get('cache-control')).toBe(browserHeaders['cache-control']);
        expect(request.headers.get('user-agent')).toBe(readerHeaders['user-agent']);

        return HttpResponse.text(feedXml, { headers: { 'Content-Type': 'application/rss+xml' } });
      }),
      http.get(fallbackUrl, ({ request }) => {
        expect(request.headers.get('accept')).toBe(browserHeaders.accept);
        expect(request.headers.get('accept-language')).toBe(browserHeaders['accept-language']);
        expect(request.headers.get('cache-control')).toBe(browserHeaders['cache-control']);
        expect(request.headers.get('user-agent')).toBe(readerHeaders['user-agent']);

        return HttpResponse.text(fallbackHtml, { headers: { 'Content-Type': 'text/html' } });
      }),
    );

    parseStringMock.mockResolvedValueOnce({
      items: [
        {
          isoDate: '2024-01-02T03:04:05.000Z',
          link: articleOneUrl,
          title: 'First article',
        },
      ],
    });
    parseStringMock.mockResolvedValueOnce({
      items: [],
    });

    await expect(fetchRssOrFallback(egress, feedUrl)).resolves.toEqual([
      {
        pubDate: new Date('2024-01-02T03:04:05.000Z'),
        title: 'First article',
        url: articleOneUrl,
      },
    ]);

    // 同一 Source を続けて取得すると枠の間隔で弾かれるため、この節では枠を新しく作る
    // （間隔そのものは egress.test.ts で検証する）。
    egress = createTestEgressContext();
    await expect(fetchRssOrFallback(egress, fallbackUrl)).resolves.toEqual([
      {
        pubDate: null,
        title: 'First article',
        url: articleOneUrl,
      },
      {
        pubDate: null,
        title: 'Second article title',
        url: articleTwoUrl,
      },
    ]);

    expect(parseURLMock).not.toHaveBeenCalled();
  });

  it('skips non-HTML asset links from RSS and fallback HTML', async () => {
    server.use(
      http.get(feedUrl, ({ request }) => {
        expect(request.headers.get('accept')).toBe(browserHeaders.accept);
        return HttpResponse.text(feedXml, { headers: { 'Content-Type': 'application/rss+xml' } });
      }),
      http.get(fallbackUrl, ({ request }) => {
        expect(request.headers.get('accept')).toBe(browserHeaders.accept);
        return HttpResponse.text(assetFallbackHtml, { headers: { 'Content-Type': 'text/html' } });
      }),
    );

    parseStringMock.mockResolvedValueOnce({
      items: [
        {
          link: pdfUrl,
          title: 'PDF article',
        },
        {
          link: articleOneUrl,
          title: 'First article',
        },
      ],
    });
    parseStringMock.mockResolvedValueOnce({
      items: [],
    });

    await expect(fetchRssOrFallback(egress, feedUrl)).resolves.toEqual([
      {
        pubDate: null,
        title: 'First article',
        url: articleOneUrl,
      },
    ]);

    // 同一 Source を続けて取得すると枠の間隔で弾かれるため、この節では枠を新しく作る
    // （間隔そのものは egress.test.ts で検証する）。
    egress = createTestEgressContext();
    await expect(fetchRssOrFallback(egress, fallbackUrl)).resolves.toEqual([
      {
        pubDate: null,
        title: 'First article',
        url: articleOneUrl,
      },
    ]);
  });

  describe('律速と User-Agent（ADR-0009 / ADR-0011）', () => {
    it('429 を ThrottleError として返し、枠にクールダウンを設定する', async () => {
      server.use(
        http.get(feedUrl, () =>
          new HttpResponse(null, { status: 429, headers: { 'Retry-After': '45' } })),
      );

      await expect(fetchRssOrFallback(egress, feedUrl)).rejects.toThrow(/Rate limited by example\.com/u);
      // クールダウン中（=仮想時間 45 秒以内）は同じ枠の取得は断られる。
      await expect(fetchRssOrFallback(egress, feedUrl)).rejects.toThrow(/cooling down/u);
    });

    it('本文取得が 403 のときだけブラウザ UA で 1 回取り直す', async () => {
      const seenUserAgents: string[] = [];
      server.use(
        http.get(articleOneUrl, ({ request }) => {
          seenUserAgents.push(request.headers.get('user-agent') ?? '');
          if (seenUserAgents.length === 1) {
            return new HttpResponse(null, { status: 403 });
          }
          return HttpResponse.text(articleHtml, { headers: { 'Content-Type': 'text/html' } });
        }),
      );

      await expect(fetchArticleContent(egress, articleOneUrl)).resolves.toBe(
        'First article Article body text.',
      );
      expect(seenUserAgents).toEqual([
        EGRESS_POLICY.userAgent,
        browserHeaders['user-agent'],
      ]);
    });

    it('403 が続くと退避は 1 回までで、本文なしの失敗を返す（退避先は Jina Fallback）', async () => {
      server.use(http.get(articleOneUrl, () => new HttpResponse(null, { status: 403 })));

      // ブラウザ UA での退避は 1 回限り。それでも 403 なら Jina Fallback（ADR-0012）に委ねる。
      const seenUserAgents: string[] = [];
      server.use(
        http.get(articleOneUrl, ({ request }) => {
          seenUserAgents.push(request.headers.get('user-agent') ?? '');
          return new HttpResponse(null, { status: 403 });
        }),
        http.get('https://r.jina.ai/*', () => HttpResponse.text('Title: x\n\nMarkdown Content:\n\nbody')),
      );

      await expect(fetchArticleContent(egress, articleOneUrl)).resolves.toBe(
        'Title: x Markdown Content: body',
      );
      expect(seenUserAgents).toEqual([EGRESS_POLICY.userAgent, browserHeaders['user-agent']]);
    });

    it('退避でブラウザ UA を使ったあとも枠の間隔は守られる', async () => {
      let calls = 0;
      server.use(
        http.get(articleOneUrl, ({ request }) => {
          calls += 1;
          if (request.headers.get('user-agent') === EGRESS_POLICY.userAgent) {
            return new HttpResponse(null, { status: 403 });
          }
          return HttpResponse.text(articleHtml, { headers: { 'Content-Type': 'text/html' } });
        }),
      );

      const before = clock.now();
      await fetchArticleContent(egress, articleOneUrl);
      expect(calls).toBe(2);
      // 退避のリクエストぶん枠が前に進んでいるので、次の取得は待機させられる。
      await fetchArticleContent(egress, articleOneUrl);
      expect(clock.now() - before).toBeGreaterThanOrEqual(EGRESS_POLICY.defaultMinimumDelayMs);
    });
  });

  describe('Jina Fallback（ADR-0012）', () => {
    const jinaMarkdown = [
      'Title: First article',
      '',
      `URL Source: ${articleOneUrl}`,
      '',
      'Markdown Content:',
      '',
      '# First article',
      '',
      'Article body text.',
    ].join('\n');
    const jinaMarkdownNormalized =
      `Title: First article URL Source: ${articleOneUrl} Markdown Content: # First article Article body text.`;

    it('ブラウザ UA でも 403 のときだけ Jina Reader へ退避し、markdown をそのまま本文にする', async () => {
      let jinaCalled = false;
      server.use(
        http.get(articleOneUrl, () => new HttpResponse(null, { status: 403 })),
        http.get('https://r.jina.ai/*', ({ request }) => {
          jinaCalled = true;
          expect(request.url).toBe(`https://r.jina.ai/${articleOneUrl}`);
          // UA は素直なリーダ UA のまま（ADR-0011）。
          expect(request.headers.get('user-agent')).toBe(EGRESS_POLICY.userAgent);
          return HttpResponse.text(jinaMarkdown, {
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }),
      );

      // cheerio 抽出を経ないため、Jina 応答が正規化されてそのまま本文になる。
      await expect(fetchArticleContent(egress, articleOneUrl)).resolves.toBe(jinaMarkdownNormalized);
      expect(jinaCalled).toBe(true);
    });

    it('429 では退避しない（相手の不調は律速・クールダウンの領域）', async () => {
      let jinaCalled = false;
      server.use(
        http.get(articleOneUrl, () => new HttpResponse(null, { status: 429 })),
        http.get('https://r.jina.ai/*', () => {
          jinaCalled = true;
          return HttpResponse.text(jinaMarkdown);
        }),
      );

      await expect(fetchArticleContent(egress, articleOneUrl)).rejects.toThrow(
        /Rate limited by example\.com/u,
      );
      expect(jinaCalled).toBe(false);
    });

    it('リダイレクトループでも Jina Reader へ退避する（ADR-0013）', async () => {
      let jinaCalled = false;
      server.use(
        http.get(articleOneUrl, () =>
          new HttpResponse(null, { status: 302, headers: { location: articleOneUrl } }),
        ),
        http.get('https://r.jina.ai/*', () => {
          jinaCalled = true;
          return HttpResponse.text(jinaMarkdown, {
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }),
      );

      // エグレス IP に対してのみ 5 超のリダイレクト（bot 対策ループ）を返すサイトの再現。
      await expect(fetchArticleContent(egress, articleOneUrl)).resolves.toBe(jinaMarkdownNormalized);
      expect(jinaCalled).toBe(true);
    });

    it('ボディ超過でも Jina Reader へ退避する（ADR-0013）', async () => {
      let jinaCalled = false;
      // 2MB+1 を 1 チャンクで流すカスタムストリーム（cancel が即座に解決するように cancel ハンドラなし）。
      const oversizedBody = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('a'.repeat(2 * 1024 * 1024 + 1)));
          controller.close();
        },
      });
      server.use(
        http.get(articleOneUrl, () =>
          new HttpResponse(oversizedBody, { headers: { 'Content-Type': 'text/html' } }),
        ),
        http.get('https://r.jina.ai/*', () => {
          jinaCalled = true;
          return HttpResponse.text(jinaMarkdown, {
            headers: { 'Content-Type': 'text/plain; charset=utf-8' },
          });
        }),
      );

      await expect(fetchArticleContent(egress, articleOneUrl)).resolves.toBe(jinaMarkdownNormalized);
      expect(jinaCalled).toBe(true);
    });

    it('タイムアウトでも Jina Reader へ退避する（ADR-0013）', async () => {
      // 記事 URL への直接取得だけをハングさせ、Jina へのリクエストは即座に応答させる。
      const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) => {
        const target = String(_input instanceof Request ? _input.url : _input);
        if (target.startsWith('https://r.jina.ai/')) {
          return Promise.resolve(
            new Response(jinaMarkdown, {
              headers: { 'Content-Type': 'text/plain; charset=utf-8' },
            }),
          );
        }
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        });
      }) as typeof fetch;
      vi.stubGlobal('fetch', hangingFetch);
      vi.useFakeTimers();

      try {
        const promise = fetchArticleContent(egress, articleOneUrl);
        await vi.advanceTimersByTimeAsync(15_000 + 10);
        await expect(promise).resolves.toBe(jinaMarkdownNormalized);
      } finally {
        vi.unstubAllGlobals();
        vi.useRealTimers();
      }
    });

    it('Jina も 403 を返したら失敗として返す（呼び出し側は本文なしで保存する）', async () => {
      server.use(
        http.get(articleOneUrl, () => new HttpResponse(null, { status: 403 })),
        http.get('https://r.jina.ai/*', () => new HttpResponse(null, { status: 403 })),
      );

      await expect(fetchArticleContent(egress, articleOneUrl)).rejects.toThrow(/403/u);
    });

    it('Jina が 429 を返すと jina.ai 枠にクールダウンが入り、次の退避は待たずに断られる', async () => {
      server.use(
        http.get(articleOneUrl, () => new HttpResponse(null, { status: 403 })),
        http.get(articleTwoUrl, () => new HttpResponse(null, { status: 403 })),
        http.get('https://r.jina.ai/*', () =>
          new HttpResponse(null, { status: 429, headers: { 'Retry-After': '45' } })),
      );

      const before = clock.now();
      await expect(fetchArticleContent(egress, articleOneUrl)).rejects.toThrow(
        /Rate limited by jina\.ai/u,
      );

      // クールダウン中（45 秒後まで）の退避は 60 秒の枠待ちをせず即座に断られる。
      await expect(fetchArticleContent(egress, articleTwoUrl)).rejects.toThrow(/cooling down/u);
      expect(clock.now() - before).toBeLessThan(EGRESS_POLICY.maximumSlotWaitMs);

      const state = await egress.store.read('jina.ai');
      expect(state?.consecutiveThrottles).toBe(1);
      expect(state?.cooldownUntilMs).toBeGreaterThan(clock.now());
    });

    it('JINA_API_KEY があれば Bearer ヘッダーを添付し、なければ添付しない', async () => {
      const authHeaders: (string | null)[] = [];
      server.use(
        http.get(articleOneUrl, () => new HttpResponse(null, { status: 403 })),
        http.get('https://r.jina.ai/*', ({ request }) => {
          authHeaders.push(request.headers.get('authorization'));
          return HttpResponse.text(jinaMarkdown);
        }),
      );

      await fetchArticleContent(egress, articleOneUrl, { jinaApiKey: 'test-key' });
      // 同一 jina.ai 枠の間隔の検証は egress.test.ts に譲るため、ここでは枠を作り直す。
      egress = createTestEgressContext();
      await fetchArticleContent(egress, articleOneUrl);
      expect(authHeaders).toEqual(['Bearer test-key', null]);
    });

    it('認証情報（userinfo）付きの URL は退避しない（Jina への漏出を防ぐ）', async () => {
      let jinaCalled = false;
      server.use(
        http.get('https://example.com/secret', () => new HttpResponse(null, { status: 403 })),
        http.get('https://r.jina.ai/*', () => {
          jinaCalled = true;
          return HttpResponse.text(jinaMarkdown);
        }),
      );

      await expect(
        fetchArticleContent(egress, 'https://user:pass@example.com/secret'),
      ).rejects.toThrow(/credentials/iu);
      expect(jinaCalled).toBe(false);
    });

    it('リダイレクト先が他オリジンになると Bearer ヘッダーを落とし、同一オリジンなら維持する', async () => {
      let jinaRedirects = 0;
      const authOnSameOrigin: (string | null)[] = [];
      const authOnCrossOrigin: (string | null)[] = [];
      server.use(
        http.get(articleOneUrl, () => new HttpResponse(null, { status: 403 })),
        http.get('https://r.jina.ai/*', ({ request }) => {
          jinaRedirects += 1;
          authOnSameOrigin.push(request.headers.get('authorization'));
          if (jinaRedirects === 1) {
            return HttpResponse.text('', { headers: { Location: 'https://r.jina.ai/next' }, status: 302 });
          }
          return HttpResponse.text('', { headers: { Location: 'https://elsewhere.example.net/landing' }, status: 302 });
        }),
        http.get('https://elsewhere.example.net/landing', ({ request }) => {
          authOnCrossOrigin.push(request.headers.get('authorization'));
          return HttpResponse.text(jinaMarkdown);
        }),
      );

      await expect(
        fetchArticleContent(egress, articleOneUrl, { jinaApiKey: 'test-key' }),
      ).resolves.toBe(jinaMarkdownNormalized);
      expect(jinaRedirects).toBe(2);
      expect(authOnSameOrigin).toEqual(['Bearer test-key', 'Bearer test-key']);
      expect(authOnCrossOrigin).toEqual([null]);
    });

    it('非HTML拡張子の URL は退避しない', async () => {
      let jinaCalled = false;
      server.use(
        http.get(pdfUrl, () => new HttpResponse(null, { status: 403 })),
        http.get('https://r.jina.ai/*', () => {
          jinaCalled = true;
          return HttpResponse.text(jinaMarkdown);
        }),
      );

      await expect(fetchArticleContent(egress, pdfUrl)).rejects.toThrow(/non-HTML/u);
      expect(jinaCalled).toBe(false);
    });

    it('内部アドレス宛の URL は退避しない', async () => {
      let jinaCalled = false;
      server.use(
        http.get('https://r.jina.ai/*', () => {
          jinaCalled = true;
          return HttpResponse.text(jinaMarkdown);
        }),
      );

      await expect(fetchArticleContent(egress, 'http://127.0.0.1/')).rejects.toThrow(/internal/iu);
      expect(jinaCalled).toBe(false);
    });
  });

  describe('discoverRssFeedUrl', () => {
    it('returns the input URL when its Content-Type is already RSS', async () => {
      server.use(
        http.get('https://example.com/feed.xml', () =>
          HttpResponse.text('<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>', {
            headers: { 'Content-Type': 'application/rss+xml' },
          }),
        ),
      );

      await expect(discoverRssFeedUrl(egress, 'https://example.com/feed.xml')).resolves.toEqual({
        alreadyAFeed: true,
        feedUrl: 'https://example.com/feed.xml',
        type: 'rss',
      });
    });

    it('returns the input URL when its Content-Type is Atom', async () => {
      server.use(
        http.get('https://example.com/atom.xml', () =>
          HttpResponse.text('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>', {
            headers: { 'Content-Type': 'application/atom+xml' },
          }),
        ),
      );

      await expect(discoverRssFeedUrl(egress, 'https://example.com/atom.xml')).resolves.toEqual({
        alreadyAFeed: true,
        feedUrl: 'https://example.com/atom.xml',
        type: 'atom',
      });
    });

    it('treats generic XML with an <rss> root as an already-a-feed', async () => {
      server.use(
        http.get('https://example.com/generic-feed', () =>
          HttpResponse.text('<?xml version="1.0"?><rss version="2.0"><channel></channel></rss>', {
            headers: { 'Content-Type': 'application/xml' },
          }),
        ),
      );

      await expect(discoverRssFeedUrl(egress, 'https://example.com/generic-feed')).resolves.toEqual({
        alreadyAFeed: true,
        feedUrl: 'https://example.com/generic-feed',
        type: 'rss',
      });
    });

    it('treats generic XML with an <feed> root as an Atom feed', async () => {
      server.use(
        http.get('https://example.com/generic-atom', () =>
          HttpResponse.text('<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>', {
            headers: { 'Content-Type': 'text/xml' },
          }),
        ),
      );

      await expect(discoverRssFeedUrl(egress, 'https://example.com/generic-atom')).resolves.toEqual({
        alreadyAFeed: true,
        feedUrl: 'https://example.com/generic-atom',
        type: 'atom',
      });
    });

    it('treats generic XML with an <rdf:RDF> root (RSS 1.0) as a feed', async () => {
      server.use(
        http.get('https://example.com/rss10', () =>
          HttpResponse.text(
            '<?xml version="1.0"?><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"><channel><title>RSS 1.0</title></channel></rdf:RDF>',
            { headers: { 'Content-Type': 'application/xml' } },
          ),
        ),
      );

      await expect(discoverRssFeedUrl(egress, 'https://example.com/rss10')).resolves.toEqual({
        alreadyAFeed: true,
        feedUrl: 'https://example.com/rss10',
        type: 'rss',
      });
    });

    it('falls back to link discovery for generic XML that is not a feed (sitemap)', async () => {
      // sitemap.xml 等の非フィード XML はフィードとして登録せず、
      // 後段の <link rel=alternate> 探索へフォールバックする
      server.use(
        http.get('https://example.com/sitemap.xml', () =>
          HttpResponse.text('<?xml version="1.0"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>', {
            headers: { 'Content-Type': 'application/xml' },
          }),
        ),
      );

      await expect(discoverRssFeedUrl(egress, 'https://example.com/sitemap.xml')).resolves.toBeNull();
    });

    it('discovers an RSS feed URL from a normal HTML page', async () => {
      const blogHtml = `<!doctype html>
<html>
  <head>
    <link rel="alternate" type="application/rss+xml" title="Feed" href="/feed.xml" />
  </head>
  <body></body>
</html>`;

      server.use(
        http.get('https://blog.example.com/', () =>
          HttpResponse.text(blogHtml, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }),
        ),
      );

      await expect(discoverRssFeedUrl(egress, 'https://blog.example.com/')).resolves.toEqual({
        alreadyAFeed: false,
        feedUrl: 'https://blog.example.com/feed.xml',
        type: 'rss',
      });
    });

    it('resolves relative hrefs against the page URL', async () => {
      const blogHtml = `<!doctype html>
<html>
  <head>
    <link rel="alternate" type="application/atom+xml" href="../atom.xml" />
  </head>
  <body></body>
</html>`;

      server.use(
        http.get('https://example.com/blog/', () =>
          HttpResponse.text(blogHtml, { headers: { 'Content-Type': 'text/html' } }),
        ),
      );

      await expect(discoverRssFeedUrl(egress, 'https://example.com/blog/')).resolves.toEqual({
        alreadyAFeed: false,
        feedUrl: 'https://example.com/atom.xml',
        type: 'atom',
      });
    });

    it('prefers RSS over Atom when both are advertised', async () => {
      const blogHtml = `<!doctype html>
<html>
  <head>
    <link rel="alternate" type="application/atom+xml" href="/atom.xml" />
    <link rel="alternate" type="application/rss+xml" href="/rss.xml" />
  </head>
  <body></body>
</html>`;

      server.use(
        http.get('https://example.com/', () =>
          HttpResponse.text(blogHtml, { headers: { 'Content-Type': 'text/html' } }),
        ),
      );

      await expect(discoverRssFeedUrl(egress, 'https://example.com/')).resolves.toEqual({
        alreadyAFeed: false,
        feedUrl: 'https://example.com/rss.xml',
        type: 'rss',
      });
    });

    it('returns null when no feed link is present', async () => {
      const html = `<!doctype html>
<html>
  <head><link rel="stylesheet" href="/style.css"></head>
  <body></body>
</html>`;

      server.use(
        http.get('https://nofeed.example.com/', () =>
          HttpResponse.text(html, { headers: { 'Content-Type': 'text/html' } }),
        ),
      );

      await expect(discoverRssFeedUrl(egress, 'https://nofeed.example.com/')).resolves.toBeNull();
    });

    it('returns null for non-HTML responses that are not feeds', async () => {
      server.use(
        http.get('https://json.example.com/data', () =>
          HttpResponse.json({ ok: true }, { headers: { 'Content-Type': 'application/json' } }),
        ),
      );

      await expect(discoverRssFeedUrl(egress, 'https://json.example.com/data')).resolves.toBeNull();
    });

    it('rejects unsupported protocols', async () => {
      await expect(discoverRssFeedUrl(egress, 'ftp://example.com/feed')).rejects.toThrow(/protocol/i);
    });

    it('rejects localhost to prevent SSRF', async () => {
      await expect(discoverRssFeedUrl(egress, 'http://localhost/')).rejects.toThrow(/internal/iu);
    });

    it('rejects 127.0.0.1 to prevent SSRF', async () => {
      await expect(discoverRssFeedUrl(egress, 'http://127.0.0.1/')).rejects.toThrow(/internal/iu);
    });

    it('rejects private IPv4 ranges to prevent SSRF', async () => {
      await expect(discoverRssFeedUrl(egress, 'http://10.0.0.1/')).rejects.toThrow(/internal/iu);
      await expect(discoverRssFeedUrl(egress, 'http://192.168.1.1/')).rejects.toThrow(/internal/iu);
      await expect(discoverRssFeedUrl(egress, 'http://172.16.0.1/')).rejects.toThrow(/internal/iu);
    });

    it('rejects the cloud metadata endpoint to prevent SSRF', async () => {
      await expect(discoverRssFeedUrl(egress, 'http://169.254.169.254/')).rejects.toThrow(/internal/iu);
    });

    it('rejects IPv4-mapped IPv6 addresses to prevent SSRF', async () => {
      await expect(discoverRssFeedUrl(egress, 'http://[::ffff:169.254.169.254]/')).rejects.toThrow(/internal/iu);
      await expect(discoverRssFeedUrl(egress, 'http://[::ffff:127.0.0.1]/')).rejects.toThrow(/internal/iu);
    });

    it('rejects numeric IPv4 representations to prevent SSRF', async () => {
      // 2130706433 = 127.0.0.1, 0x7f000001 = 127.0.0.1
      await expect(discoverRssFeedUrl(egress, 'http://2130706433/')).rejects.toThrow(/internal/iu);
      await expect(discoverRssFeedUrl(egress, 'http://0x7f000001/')).rejects.toThrow(/internal/iu);
    });

    it('rejects expanded IPv6 loopback and ULA to prevent SSRF', async () => {
      await expect(discoverRssFeedUrl(egress, 'http://[0:0:0:0:0:0:0:1]/')).rejects.toThrow(/internal/iu);
      await expect(discoverRssFeedUrl(egress, 'http://[fd00::1]/')).rejects.toThrow(/internal/iu);
      await expect(discoverRssFeedUrl(egress, 'http://[fe80::1]/')).rejects.toThrow(/internal/iu);
    });

    it('rejects IPv4-compatible and translated IPv6 forms to prevent SSRF', async () => {
      // WHATWG URL は [::127.0.0.1] を [::7f00:1] に正規化する（IPv4 互換）。
      // ::ffff:0:a.b.c.d（IPv4 トランスレーテッド）も同様にブロックする。
      await expect(discoverRssFeedUrl(egress, 'http://[::127.0.0.1]/')).rejects.toThrow(/internal/iu);
      await expect(discoverRssFeedUrl(egress, 'http://[::ffff:0:127.0.0.1]/')).rejects.toThrow(/internal/iu);
      await expect(discoverRssFeedUrl(egress, 'http://[::ffff:0:169.254.169.254]/')).rejects.toThrow(/internal/iu);
    });

    it('rejects octal and hex IPv4 literals to prevent SSRF', async () => {
      // WHATWG URL パーサは 8進/16進オクテットや単一数値を解釈する。
      // 末尾ドット付きは正規化されず残るため、パーサ側でも解釈してブロックする。
      await expect(discoverRssFeedUrl(egress, 'http://0177.0.0.1./')).rejects.toThrow(/internal/iu);
      await expect(discoverRssFeedUrl(egress, 'http://0x7f.0.0.1./')).rejects.toThrow(/internal/iu);
      await expect(discoverRssFeedUrl(egress, 'http://017700000001./')).rejects.toThrow(/internal/iu);
    });

    it('rejects abbreviated IPv4 forms to prevent SSRF', async () => {
      // WHATWG URL パーサは 127.1 を 127.0.0.1 に展開する
      await expect(discoverRssFeedUrl(egress, 'http://127.1./')).rejects.toThrow(/internal/iu);
      await expect(discoverRssFeedUrl(egress, 'http://127.0.1./')).rejects.toThrow(/internal/iu);
    });

    it('rejects NAT64 and 6to4 addresses embedding private IPv4', async () => {
      // NAT64 well-known プレフィックス (64:ff9b::/96) に 127.0.0.1 を埋め込んだ形
      await expect(discoverRssFeedUrl(egress, 'http://[64:ff9b::7f00:1]/')).rejects.toThrow(/internal/iu);
      // 6to4 (2002::/16) に 127.0.0.1 を埋め込んだ形
      await expect(discoverRssFeedUrl(egress, 'http://[2002:7f00:1::]/')).rejects.toThrow(/internal/iu);
    });

    it('allows NAT64 addresses embedding a public IPv4', async () => {
      // 公開 IPv4 (8.8.8.8) を埋め込んだ NAT64 はブロックせず、通常の検出フローに進む。
      // （msw は IPv6 ホストのルートパターンを扱えないため fetch をスタブする）
      const fetchMock = vi.fn().mockResolvedValue(
        new Response('<html><body>no feed</body></html>', {
          headers: { 'Content-Type': 'text/html' },
          status: 200,
        }),
      );
      vi.stubGlobal('fetch', fetchMock);

      try {
        // フィードが見つからないだけで、内部アドレスとしては拒否されない
        await expect(discoverRssFeedUrl(egress, 'http://[64:ff9b::808:808]/')).resolves.toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
      // 検証を通過して実際に fetch が呼ばれたことを確認する
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects trailing-dot FQDN hostnames to prevent SSRF', async () => {
      // WHATWG URL は末尾ドットを保持するため、127.0.0.1. / localhost. は
      // そのままではブロックリストに一致しないが、DNS は同一ホストに解決される。
      await expect(discoverRssFeedUrl(egress, 'http://127.0.0.1./')).rejects.toThrow(/internal/iu);
      await expect(discoverRssFeedUrl(egress, 'http://169.254.169.254./')).rejects.toThrow(/internal/iu);
      await expect(discoverRssFeedUrl(egress, 'http://localhost./')).rejects.toThrow(/internal/iu);
    });

    it('rejects invalid URLs', async () => {
      await expect(discoverRssFeedUrl(egress, 'not-a-url')).rejects.toThrow(/invalid/i);
    });

    it('rejects redirects to internal addresses to prevent SSRF', async () => {
      server.use(
        http.get('https://public.example.com/', () =>
          HttpResponse.text('', { headers: { Location: 'http://127.0.0.1/feed.xml' }, status: 302 }),
        ),
      );

      await expect(discoverRssFeedUrl(egress, 'https://public.example.com/')).rejects.toThrow(/internal/iu);
    });

    it('rejects redirect loops', async () => {
      server.use(
        http.get('https://loop.example.com/a', () =>
          HttpResponse.text('', { headers: { Location: 'https://loop.example.com/b' }, status: 302 }),
        ),
        http.get('https://loop.example.com/b', () =>
          HttpResponse.text('', { headers: { Location: 'https://loop.example.com/a' }, status: 302 }),
        ),
      );

      await expect(discoverRssFeedUrl(egress, 'https://loop.example.com/a')).rejects.toThrow(/redirects/i);
    });

    it('ignores linked feed URLs pointing to internal addresses', async () => {
      const blogHtml = `<!doctype html>
<html>
  <head>
    <link rel="alternate" type="application/rss+xml" href="http://127.0.0.1/feed.xml" />
    <link rel="alternate" type="application/atom+xml" href="https://example.com/atom.xml" />
  </head>
  <body></body>
</html>`;

      server.use(
        http.get('https://example.com/', () =>
          HttpResponse.text(blogHtml, { headers: { 'Content-Type': 'text/html' } }),
        ),
      );

      await expect(discoverRssFeedUrl(egress, 'https://example.com/')).resolves.toEqual({
        alreadyAFeed: false,
        feedUrl: 'https://example.com/atom.xml',
        type: 'atom',
      });
    });

    it('rejects response bodies exceeding the size limit', async () => {
      const oversized = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('x'.repeat(2048)));
          controller.close();
        },
      });
      const fakeResponse = { body: oversized } as unknown as Response;

      await expect(readBoundedText(fakeResponse, 1024)).rejects.toThrow(/size limit/i);
    });

    it('returns the decoded body when under the size limit', async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('hello'));
          controller.close();
        },
      });
      const fakeResponse = { body: stream } as unknown as Response;

      await expect(readBoundedText(fakeResponse, 1024)).resolves.toBe('hello');
    });
  });
});

describe('律速層への障害記録（ADR-0009）', () => {
  it('タイムアウトしたフィード取得は枠にクールダウンを設定する', async () => {
    const egress = createTestEgressContext();
    vi.useFakeTimers();
    const hangingFetch = ((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('The operation was aborted.', 'AbortError'));
        });
      })) as typeof fetch;
    vi.stubGlobal('fetch', hangingFetch);

    try {
      const promise = fetchRssOrFallback(egress, feedUrl);
      const assertion = expect(promise).rejects.toThrow(/timed out/i);
      await vi.advanceTimersByTimeAsync(15_000 + 10);
      await assertion;
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }

    // 枠（example.com）にクールダウンが記録されていること。
    // 時刻系 DI に依存しないよう、ストアの生値で検証する。
    const state = await egress.store.read(bucketKeyOf(feedUrl));
    expect(state?.cooldownUntilMs).toBeGreaterThan(Date.now());
    expect(state?.consecutiveThrottles).toBe(1);
  });
});
