import { load, type CheerioAPI } from 'cheerio';
import { isTag, type Element } from 'domhandler';
import Parser from 'rss-parser';

import { sleep } from '../utils/sleep.js';

export interface ScrapedLink {
  pubDate: Date | null;
  title: string;
  url: string;
}

export interface ScrapedArticle extends ScrapedLink {
  content: string;
}

const rssParser = new Parser({
  timeout: 10_000,
});

const blockedSelectors = 'script, style, nav, footer, header, aside, noscript, form, iframe';
const contentSelectors = ['article', 'main', '[role="main"]', 'body'];
const linkSelectors = [
  'article a[href]',
  'main a[href]',
  '[role="main"] a[href]',
  'section a[href]',
  'li a[href]',
  'h1 a[href]',
  'h2 a[href]',
  'h3 a[href]',
];

const minimumSleepMs = 1_000;
const maximumSleepMs = 3_000;
export const browserRequestHeaders = {
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
  'cache-control': 'no-cache',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
} as const;

const nonHtmlFileExtensionPattern =
  /\.(?:pdf|zip|exe|mp4|png|jpe?g|gif|webp|avif|svg|bmp|ico|webm|mov|avi|mkv|mp3|wav|ogg|docx?|xlsx?|pptx?|tar|tgz|gz|bz2|7z|rar)$/i;

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function randomSleepMs(): number {
  return Math.floor(Math.random() * (maximumSleepMs - minimumSleepMs + 1)) + minimumSleepMs;
}

function parsePubDate(value: string | undefined): Date | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function resolveUrl(rawUrl: string, baseUrl: string): string | null {
  try {
    const resolvedUrl = new URL(rawUrl, baseUrl);
    if (!['http:', 'https:'].includes(resolvedUrl.protocol)) {
      return null;
    }
    return resolvedUrl.toString();
  } catch {
    return null;
  }
}

function shouldSkipNonHtmlUrl(url: string): boolean {
  try {
    return nonHtmlFileExtensionPattern.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

function extractLinkTitle($: CheerioAPI, element: Element): string {
  const text = normalizeText($(element).text());
  if (text.length > 0) {
    return text;
  }

  const title = normalizeText($(element).attr('title') ?? '');
  return title;
}

async function fetchHtml(url: string): Promise<string> {
  const response = await fetch(url, {
    headers: browserRequestHeaders,
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
  }

  return await response.text();
}

function extractArticleContent(html: string): string {
  const $ = load(html);
  $(blockedSelectors).remove();

  for (const selector of contentSelectors) {
    const candidate = $(selector).first().clone();
    if (candidate.length === 0) {
      continue;
    }

    candidate.find(blockedSelectors).remove();
    const content = normalizeText(candidate.text());
    if (content.length > 0) {
      return content;
    }
  }

  const fallback = normalizeText($('body').text());
  if (fallback.length > 0) {
    return fallback;
  }

  return '';
}

function extractFallbackLinks(html: string, baseUrl: string): ScrapedLink[] {
  const $ = load(html);
  $(blockedSelectors).remove();

  const base = new URL(baseUrl);
  const seenUrls = new Set<string>();
  const links: ScrapedLink[] = [];

  const candidates = $(linkSelectors.join(','));
  const elements = candidates.length > 0 ? candidates : $('a[href]');

  elements.each((_, node) => {
    if (!isTag(node)) {
      return;
    }

    const href = $(node).attr('href');
    if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) {
      return;
    }

    const resolvedUrl = resolveUrl(href, baseUrl);
    if (!resolvedUrl) {
      return;
    }

    const parsed = new URL(resolvedUrl);
    if (parsed.origin !== base.origin) {
      return;
    }

    if (shouldSkipNonHtmlUrl(resolvedUrl)) {
      return;
    }

    const title = extractLinkTitle($, node);
    if (title.length === 0 || seenUrls.has(resolvedUrl)) {
      return;
    }

    seenUrls.add(resolvedUrl);
    links.push({
      pubDate: null,
      title,
      url: resolvedUrl,
    });
  });

  return links;
}

export async function fetchArticleContent(url: string): Promise<string> {
  const html = await fetchHtml(url);
  return extractArticleContent(html);
}

export async function fetchRssOrFallback(siteUrl: string): Promise<ScrapedLink[]> {
  const htmlOrXml = await fetchHtml(siteUrl);

  try {
    const feed = await rssParser.parseString(htmlOrXml);
    const items = feed.items
      .map((item): ScrapedLink | null => {
        const url = item.link ?? item.guid ?? null;
        if (!url) {
          return null;
        }

        if (shouldSkipNonHtmlUrl(url)) {
          return null;
        }

        const title = normalizeText(item.title ?? '');
        return {
          pubDate: parsePubDate(item.isoDate ?? item.pubDate),
          title: title.length > 0 ? title : url,
          url,
        };
      })
      .filter((item): item is ScrapedLink => item !== null);

    if (items.length > 0) {
      return items;
    }
  } catch {
    // Fall back to scraping the site HTML when RSS parsing is unavailable.
  }

  return extractFallbackLinks(htmlOrXml, siteUrl);
}

export async function getSiteArticles(siteUrl: string): Promise<ScrapedArticle[]> {
  const links = await fetchRssOrFallback(siteUrl);
  const articles: ScrapedArticle[] = [];

  for (const link of links) {
    await sleep(randomSleepMs());
    const content = await fetchArticleContent(link.url);
    articles.push({
      ...link,
      content,
    });
  }

  return articles;
}
