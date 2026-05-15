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

import { fetchArticleContent, fetchRssOrFallback, getSiteArticles } from './scraper.js';

const feedUrl = 'https://example.com/feed.xml';
const fallbackUrl = 'https://example.com/';
const articleOneUrl = 'https://example.com/posts/one';
const articleTwoUrl = 'https://example.com/posts/two';

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

describe('scraper service', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    parseStringMock.mockReset();
    parseURLMock.mockReset();
  });

  it('extracts article content while dropping boilerplate markup', async () => {
    server.use(
      http.get(articleOneUrl, () => HttpResponse.text(articleHtml, { headers: { 'Content-Type': 'text/html' } })),
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
      http.get(feedUrl, () => HttpResponse.text(feedXml, { headers: { 'Content-Type': 'application/rss+xml' } })),
      http.get(fallbackUrl, () => HttpResponse.text(fallbackHtml, { headers: { 'Content-Type': 'text/html' } })),
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

  it('paces article fetches while collecting site articles', async () => {
    server.use(
      http.get(feedUrl, () => HttpResponse.text(feedXml, { headers: { 'Content-Type': 'application/rss+xml' } })),
      http.get(articleOneUrl, () => HttpResponse.text(articleHtml, { headers: { 'Content-Type': 'text/html' } })),
    );

    vi.useFakeTimers();
    vi.spyOn(Math, 'random').mockReturnValue(0);
    parseStringMock.mockResolvedValue({
      items: [
        {
          isoDate: '2024-01-02T03:04:05.000Z',
          link: articleOneUrl,
          title: 'First article',
        },
      ],
    });

    const promise = getSiteArticles(feedUrl);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(promise).resolves.toEqual([
      {
        pubDate: new Date('2024-01-02T03:04:05.000Z'),
        title: 'First article',
        url: articleOneUrl,
        content: 'First article Article body text.',
      },
    ]);
  });
});
