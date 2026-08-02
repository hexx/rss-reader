import { HttpResponse, http } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { server } from '../test/setup.js';

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

import { fetchArticleContent, fetchRssOrFallback, discoverRssFeedUrl, readBoundedText } from './scraper.js';

const feedUrl = 'https://example.com/feed.xml';
const fallbackUrl = 'https://example.com/';
const articleOneUrl = 'https://example.com/posts/one';
const articleTwoUrl = 'https://example.com/posts/two';
const pdfUrl = 'https://example.com/files/report.pdf';
const imageUrl = 'https://example.com/images/photo.png';
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
  afterEach(() => {
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
        expect(request.headers.get('user-agent')).toBe(browserHeaders['user-agent']);

        return HttpResponse.text(articleHtml, { headers: { 'Content-Type': 'text/html' } });
      }),
    );

    await expect(fetchArticleContent(articleOneUrl)).resolves.toBe('First article Article body text.');
  });

  it('rejects internal article URLs to prevent SSRF', async () => {
    await expect(fetchArticleContent('http://127.0.0.1/')).rejects.toThrow(/internal/i);
    await expect(fetchArticleContent('http://169.254.169.254/latest/meta-data/')).rejects.toThrow(/internal/i);
    await expect(fetchArticleContent('http://[::ffff:127.0.0.1]/')).rejects.toThrow(/internal/i);
  });

  it('rejects redirects to internal addresses when fetching article content', async () => {
    server.use(
      http.get('https://public.example.com/article', () =>
        HttpResponse.text('', { headers: { Location: 'http://127.0.0.1/private' }, status: 302 }),
      ),
    );

    await expect(fetchArticleContent('https://public.example.com/article')).rejects.toThrow(/internal/i);
  });

  it('returns empty content when no article body can be extracted', async () => {
    server.use(
      http.get(
        articleTwoUrl,
        () => HttpResponse.text('<!doctype html><html><body><script>ignored</script></body></html>', { headers: { 'Content-Type': 'text/html' } }),
      ),
    );

    await expect(fetchArticleContent(articleTwoUrl)).resolves.toBe('');
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

    await expect(fetchRssOrFallback(feedUrl)).resolves.toEqual([
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
        expect(request.headers.get('user-agent')).toBe(browserHeaders['user-agent']);

        return HttpResponse.text(feedXml, { headers: { 'Content-Type': 'application/rss+xml' } });
      }),
      http.get(fallbackUrl, ({ request }) => {
        expect(request.headers.get('accept')).toBe(browserHeaders.accept);
        expect(request.headers.get('accept-language')).toBe(browserHeaders['accept-language']);
        expect(request.headers.get('cache-control')).toBe(browserHeaders['cache-control']);
        expect(request.headers.get('user-agent')).toBe(browserHeaders['user-agent']);

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

    await expect(fetchRssOrFallback(feedUrl)).resolves.toEqual([
      {
        pubDate: new Date('2024-01-02T03:04:05.000Z'),
        title: 'First article',
        url: articleOneUrl,
      },
    ]);

    await expect(fetchRssOrFallback(fallbackUrl)).resolves.toEqual([
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

    await expect(fetchRssOrFallback(feedUrl)).resolves.toEqual([
      {
        pubDate: null,
        title: 'First article',
        url: articleOneUrl,
      },
    ]);

    await expect(fetchRssOrFallback(fallbackUrl)).resolves.toEqual([
      {
        pubDate: null,
        title: 'First article',
        url: articleOneUrl,
      },
    ]);
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

      await expect(discoverRssFeedUrl('https://example.com/feed.xml')).resolves.toEqual({
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

      await expect(discoverRssFeedUrl('https://example.com/atom.xml')).resolves.toEqual({
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

      await expect(discoverRssFeedUrl('https://example.com/generic-feed')).resolves.toEqual({
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

      await expect(discoverRssFeedUrl('https://example.com/generic-atom')).resolves.toEqual({
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

      await expect(discoverRssFeedUrl('https://example.com/rss10')).resolves.toEqual({
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

      await expect(discoverRssFeedUrl('https://example.com/sitemap.xml')).resolves.toBeNull();
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

      await expect(discoverRssFeedUrl('https://blog.example.com/')).resolves.toEqual({
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

      await expect(discoverRssFeedUrl('https://example.com/blog/')).resolves.toEqual({
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

      await expect(discoverRssFeedUrl('https://example.com/')).resolves.toEqual({
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

      await expect(discoverRssFeedUrl('https://nofeed.example.com/')).resolves.toBeNull();
    });

    it('returns null for non-HTML responses that are not feeds', async () => {
      server.use(
        http.get('https://json.example.com/data', () =>
          HttpResponse.json({ ok: true }, { headers: { 'Content-Type': 'application/json' } }),
        ),
      );

      await expect(discoverRssFeedUrl('https://json.example.com/data')).resolves.toBeNull();
    });

    it('rejects unsupported protocols', async () => {
      await expect(discoverRssFeedUrl('ftp://example.com/feed')).rejects.toThrow(/protocol/i);
    });

    it('rejects localhost to prevent SSRF', async () => {
      await expect(discoverRssFeedUrl('http://localhost/')).rejects.toThrow(/internal/i);
    });

    it('rejects 127.0.0.1 to prevent SSRF', async () => {
      await expect(discoverRssFeedUrl('http://127.0.0.1/')).rejects.toThrow(/internal/i);
    });

    it('rejects private IPv4 ranges to prevent SSRF', async () => {
      await expect(discoverRssFeedUrl('http://10.0.0.1/')).rejects.toThrow(/internal/i);
      await expect(discoverRssFeedUrl('http://192.168.1.1/')).rejects.toThrow(/internal/i);
      await expect(discoverRssFeedUrl('http://172.16.0.1/')).rejects.toThrow(/internal/i);
    });

    it('rejects the cloud metadata endpoint to prevent SSRF', async () => {
      await expect(discoverRssFeedUrl('http://169.254.169.254/')).rejects.toThrow(/internal/i);
    });

    it('rejects IPv4-mapped IPv6 addresses to prevent SSRF', async () => {
      await expect(discoverRssFeedUrl('http://[::ffff:169.254.169.254]/')).rejects.toThrow(/internal/i);
      await expect(discoverRssFeedUrl('http://[::ffff:127.0.0.1]/')).rejects.toThrow(/internal/i);
    });

    it('rejects numeric IPv4 representations to prevent SSRF', async () => {
      // 2130706433 = 127.0.0.1, 0x7f000001 = 127.0.0.1
      await expect(discoverRssFeedUrl('http://2130706433/')).rejects.toThrow(/internal/i);
      await expect(discoverRssFeedUrl('http://0x7f000001/')).rejects.toThrow(/internal/i);
    });

    it('rejects expanded IPv6 loopback and ULA to prevent SSRF', async () => {
      await expect(discoverRssFeedUrl('http://[0:0:0:0:0:0:0:1]/')).rejects.toThrow(/internal/i);
      await expect(discoverRssFeedUrl('http://[fd00::1]/')).rejects.toThrow(/internal/i);
      await expect(discoverRssFeedUrl('http://[fe80::1]/')).rejects.toThrow(/internal/i);
    });

    it('rejects IPv4-compatible and translated IPv6 forms to prevent SSRF', async () => {
      // WHATWG URL は [::127.0.0.1] を [::7f00:1] に正規化する（IPv4 互換）。
      // ::ffff:0:a.b.c.d（IPv4 トランスレーテッド）も同様にブロックする。
      await expect(discoverRssFeedUrl('http://[::127.0.0.1]/')).rejects.toThrow(/internal/i);
      await expect(discoverRssFeedUrl('http://[::ffff:0:127.0.0.1]/')).rejects.toThrow(/internal/i);
      await expect(discoverRssFeedUrl('http://[::ffff:0:169.254.169.254]/')).rejects.toThrow(/internal/i);
    });

    it('rejects octal and hex IPv4 literals to prevent SSRF', async () => {
      // WHATWG URL パーサは 8進/16進オクテットや単一数値を解釈する。
      // 末尾ドット付きは正規化されず残るため、パーサ側でも解釈してブロックする。
      await expect(discoverRssFeedUrl('http://0177.0.0.1./')).rejects.toThrow(/internal/i);
      await expect(discoverRssFeedUrl('http://0x7f.0.0.1./')).rejects.toThrow(/internal/i);
      await expect(discoverRssFeedUrl('http://017700000001./')).rejects.toThrow(/internal/i);
    });

    it('rejects abbreviated IPv4 forms to prevent SSRF', async () => {
      // WHATWG URL パーサは 127.1 を 127.0.0.1 に展開する
      await expect(discoverRssFeedUrl('http://127.1./')).rejects.toThrow(/internal/i);
      await expect(discoverRssFeedUrl('http://127.0.1./')).rejects.toThrow(/internal/i);
    });

    it('rejects NAT64 and 6to4 addresses embedding private IPv4', async () => {
      // NAT64 well-known プレフィックス (64:ff9b::/96) に 127.0.0.1 を埋め込んだ形
      await expect(discoverRssFeedUrl('http://[64:ff9b::7f00:1]/')).rejects.toThrow(/internal/i);
      // 6to4 (2002::/16) に 127.0.0.1 を埋め込んだ形
      await expect(discoverRssFeedUrl('http://[2002:7f00:1::]/')).rejects.toThrow(/internal/i);
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
        await expect(discoverRssFeedUrl('http://[64:ff9b::808:808]/')).resolves.toBeNull();
      } finally {
        vi.unstubAllGlobals();
      }
      // 検証を通過して実際に fetch が呼ばれたことを確認する
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('rejects trailing-dot FQDN hostnames to prevent SSRF', async () => {
      // WHATWG URL は末尾ドットを保持するため、127.0.0.1. / localhost. は
      // そのままではブロックリストに一致しないが、DNS は同一ホストに解決される。
      await expect(discoverRssFeedUrl('http://127.0.0.1./')).rejects.toThrow(/internal/i);
      await expect(discoverRssFeedUrl('http://169.254.169.254./')).rejects.toThrow(/internal/i);
      await expect(discoverRssFeedUrl('http://localhost./')).rejects.toThrow(/internal/i);
    });

    it('rejects invalid URLs', async () => {
      await expect(discoverRssFeedUrl('not-a-url')).rejects.toThrow(/invalid/i);
    });

    it('rejects redirects to internal addresses to prevent SSRF', async () => {
      server.use(
        http.get('https://public.example.com/', () =>
          HttpResponse.text('', { headers: { Location: 'http://127.0.0.1/feed.xml' }, status: 302 }),
        ),
      );

      await expect(discoverRssFeedUrl('https://public.example.com/')).rejects.toThrow(/internal/i);
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

      await expect(discoverRssFeedUrl('https://loop.example.com/a')).rejects.toThrow(/redirects/i);
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

      await expect(discoverRssFeedUrl('https://example.com/')).resolves.toEqual({
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
