import { http, HttpResponse } from 'msw';
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

    constructor(_options?: unknown) {}
  },
}));

import { fetchArticleContent, fetchRssOrFallback, discoverRssFeedUrl } from './scraper.js';

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

  it('returns empty content when no article body can be extracted', async () => {
    server.use(
      http.get(
        articleTwoUrl,
        () => HttpResponse.text('<!doctype html><html><body><script>ignored</script></body></html>', { headers: { 'Content-Type': 'text/html' } }),
      ),
    );

    await expect(fetchArticleContent(articleTwoUrl)).resolves.toBe('');
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

    it('rejects invalid URLs', async () => {
      await expect(discoverRssFeedUrl('not-a-url')).rejects.toThrow(/invalid/i);
    });
  });
});
