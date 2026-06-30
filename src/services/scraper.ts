import { load, type CheerioAPI } from 'cheerio';
import { isTag, type Element } from 'domhandler';
import Parser from 'rss-parser';

export interface ScrapedLink {
  pubDate: Date | null;
  title: string;
  url: string;
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

/** RSS / Atom フィードの Content-Type として扱う値。 */
const FEED_CONTENT_TYPE_PATTERN = /application\/(?:rss|atom)\+xml/i;

/** フィードの type として許可する MIME タイプ。 */
const FEED_TYPE_RSS = 'application/rss+xml';
const FEED_TYPE_ATOM = 'application/atom+xml';

/** 自動検出の全体タイムアウト（ミリ秒）。 */
const DISCOVERY_TIMEOUT_MS = 10_000;
/** HTML 読み込みサイズ上限（バイト）。過剰な応答による DoS を防ぐ。 */
const DEFAULT_MAX_HTML_BYTES = 2 * 1024 * 1024;
/** リダイレクトの最大追随回数。これを超えると拒否する。 */
const MAX_REDIRECT_HOPS = 5;

export interface DiscoverOptions {
  /** レスポンスサイズの上限（バイト）。テスト用。 */
  maxBytes?: number;
}

/** 自動検出を許可しないホスト名（SSRF 対策）。 */
const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  '0.0.0.0',
  '127.0.0.1',
  '::1',
  '[::1]',
  '169.254.169.254',
  'metadata.google.internal',
  'metadata',
]);

const PRIVATE_IPV4_PATTERN = /^(?:10\.|172\.(?:1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|127\.|0\.0\.0\.0)/;
const PRIVATE_IPV6_PATTERN = /^(?:fc|fd|fe80|::1$|fec0)/i;

export type DiscoveredFeedType = 'rss' | 'atom';

export interface DiscoveredFeed {
  /** 検出されたフィードの絶対 URL。 */
  feedUrl: string;
  /** 検出されたフィードの種類。 */
  type: DiscoveredFeedType;
  /** 入力 URL と検出結果が同一だったかどうか。 */
  alreadyAFeed: boolean;
}

/**
 * URL のホスト名が内部ネットワーク（SSRF 対象）かどうか判定する。
 *
 * NOTE: 文字列レベルのチェックのみであり、DNS rebinding 攻撃には対凅できない。
 * Cloudflare Workers 上で動作するため、ランタイム側のフィルタにも依存する。
 */
function isUnsafeHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(lower)) {
    return true;
  }
  // 角括弧で囲まれた IPv6 表記 (例: [::1]) を除去してから評価。
  const stripped = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
  if (PRIVATE_IPV4_PATTERN.test(stripped) || PRIVATE_IPV6_PATTERN.test(stripped)) {
    return true;
  }
  return false;
}

/**
 * 自動検出対象として URL を検証する。許可されないプロトコルや内部ネットワーク宛の URL は例外を投げる。
 *
 * エラーメッセージにはユーザー入力や内部ホスト名を含めず、サーバー側ログとの情報漏洩を防ぐ。
 */
function ensureSafePageUrl(rawUrl: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid URL provided.');
  }
  if (!['http:', 'https:'].includes(url.protocol)) {
    throw new Error('Unsupported protocol for feed discovery.');
  }
  if (isUnsafeHostname(url.hostname)) {
    throw new Error('Refusing to fetch from an internal address.');
  }
  return url;
}

function pickFeedType(typeAttr: string): DiscoveredFeedType | null {
  const lower = typeAttr.toLowerCase();
  if (lower === FEED_TYPE_RSS) {
    return 'rss';
  }
  if (lower === FEED_TYPE_ATOM) {
    return 'atom';
  }
  return null;
}

/** Content-Type ヘッダーのメディアタイプ部分のみを取り出す（charset などを除去）。 */
function extractMediaType(contentType: string): string {
  return contentType.split(';')[0]?.trim().toLowerCase() ?? '';
}

async function safeFetch(url: string, signal: AbortSignal, hops = 0): Promise<Response> {
  if (hops > MAX_REDIRECT_HOPS) {
    throw new Error('Too many redirects during feed discovery.');
  }

  const response = await fetch(url, {
    headers: browserRequestHeaders,
    redirect: 'manual',
    signal,
  });

  // リダイレクト時は Location ヘッダーの安全性を検証し、手動で追随する。
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location');
    if (!location) {
      throw new Error('Redirect response missing Location header.');
    }
    const nextUrl = new URL(location, url).toString();
    ensureSafePageUrl(nextUrl);
    return safeFetch(nextUrl, signal, hops + 1);
  }

  return response;
}

export async function readBoundedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) {
    return '';
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) {
      break;
    }
    if (!value) {
      continue;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error('Response body exceeded the size limit.');
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(merged);
}

/**
 * 与えられた URL のページを開き、RSS/Atom フィードの URL を自動検出する。
 *
 * - 入力 URL の Content-Type が既に RSS/Atom だった場合は、その URL をそのまま返す。
 * - HTML の場合は `<link rel="alternate" type="application/rss+xml|application/atom+xml">` を探す。
 * - 複数候補が見つかった場合は RSS を優先して最初の 1 件を返す。
 * - フィードが見つからない場合は null を返す。
 *
 * セキュリティ:
 * - リダイレクトは手動追随し、毎回ホストの安全性を検証する。
 * - 全体のタイムアウトとレスポンスサイズに上限を設ける。
 */
export async function discoverRssFeedUrl(
  rawUrl: string,
  options: DiscoverOptions = {},
): Promise<DiscoveredFeed | null> {
  const safeUrl = ensureSafePageUrl(rawUrl);
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_HTML_BYTES;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  let response: Response;
  try {
    response = await safeFetch(safeUrl.toString(), controller.signal);
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    throw new Error(`Failed to fetch the page. status=${response.status}`);
  }

  const contentType = response.headers.get('content-type') ?? '';
  const mediaType = extractMediaType(contentType);

  // 入力 URL が既にフィードそのものを指している場合はそのまま返す。
  if (FEED_CONTENT_TYPE_PATTERN.test(mediaType)) {
    const type = pickFeedType(mediaType) ?? 'rss';
    return { alreadyAFeed: true, feedUrl: safeUrl.toString(), type };
  }

  // HTML / テキストのみ自動検出を試みる。
  if (mediaType.length > 0 && !/text\/html|application\/xhtml\+xml/.test(mediaType)) {
    return null;
  }

  const html = await readBoundedText(response, maxBytes);
  const $ = load(html);
  const candidates: Array<{ feedUrl: string; type: DiscoveredFeedType }> = [];

  $('link[rel~="alternate"]').each((_, node) => {
    if (!isTag(node)) {
      return;
    }
    const typeAttr = $(node).attr('type') ?? '';
    const feedType = pickFeedType(typeAttr);
    if (!feedType) {
      return;
    }
    const href = $(node).attr('href');
    if (!href || href.length === 0) {
      return;
    }
    try {
      const resolved = new URL(href, safeUrl);
      if (!['http:', 'https:'].includes(resolved.protocol)) {
        return;
      }
      // 検出されたフィード URL も安全性を検証し、ストアド SSRF を防ぐ。
      if (isUnsafeHostname(resolved.hostname)) {
        return;
      }
      candidates.push({ feedUrl: resolved.toString(), type: feedType });
    } catch {
      // 不正な href はスキップ
    }
  });

  if (candidates.length === 0) {
    return null;
  }

  // RSS を優先、同一 type 内ではソース上の出現順を保つ。
  candidates.sort((a, b) => {
    if (a.type === b.type) {
      return 0;
    }
    return a.type === 'rss' ? -1 : 1;
  });

  return { ...candidates[0]!, alreadyAFeed: false };
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
