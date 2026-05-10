import 'dotenv/config';

import { load, type CheerioAPI } from 'cheerio';
import { isTag, type Element } from 'domhandler';
import Parser from 'rss-parser';

import { sleep } from '../utils/sleep.js';

export interface ScrapedLink {
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

function normalizeText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function randomSleepMs(): number {
  return Math.floor(Math.random() * (maximumSleepMs - minimumSleepMs + 1)) + minimumSleepMs;
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
    headers: {
      'user-agent': 'rss-reader/1.0',
    },
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

  throw new Error('No article content found');
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

    const title = extractLinkTitle($, node);
    if (title.length === 0 || seenUrls.has(resolvedUrl)) {
      return;
    }

    seenUrls.add(resolvedUrl);
    links.push({
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
  try {
    const feed = await rssParser.parseURL(siteUrl);
    const items = feed.items
      .map((item): ScrapedLink | null => {
        const url = item.link ?? item.guid ?? null;
        if (!url) {
          return null;
        }

        const title = normalizeText(item.title ?? '');
        return {
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

  const html = await fetchHtml(siteUrl);
  return extractFallbackLinks(html, siteUrl);
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
