import { load } from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { isTag } from 'domhandler';
import type { Element } from 'domhandler';
import Parser from 'rss-parser';

import { logger } from '../utils/logger.js';
import type { EgressContext } from './egress.js';
import {
  acquireEgressSlot,
  bucketKeyOf,
  continueEgressRequest,
  EGRESS_POLICY,
  EgressUnavailableError,
  markThrottled,
  requestWithinEgressSlot,
} from './egress.js';

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

const browserRequestHeaders = {
  'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
  'accept-language': 'ja,en-US;q=0.9,en;q=0.8',
  'cache-control': 'no-cache',
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
} as const;

/**
 * 既定のエグレス User-Agent。ブラウザ偽装をやめ、リーダとして名乗る（ADR-0011）。
 * `browserRequestHeaders` は 403/451 を返す相手のための退避専用。
 */
export const readerRequestHeaders = {
  ...browserRequestHeaders,
  'user-agent': EGRESS_POLICY.userAgent,
} as const;

/** 拒否（退避発火の対象）と扱う HTTP ステータス。 */
const FORBIDDEN_STATUSES = new Set([403, 451]);

/** Jina Fallback（ADR-0012）の退避先。記事 URL をこの prefix の後に連結する。 */
const JINA_READER_PREFIX = 'https://r.jina.ai/';

/** HTTP エラーをステータス付きで表現する内部エラー（403/451 の退避判定に使う）。 */
class HttpStatusError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'HttpStatusError';
    this.status = status;
  }
}

/** 直接取得が「応答の完結」に失敗したことを表す内部エラー（ADR-0013）。
 * タイムアウト・リダイレクトループ・ボディ超過。Jina Fallback の退避対象になる
 * （429/503 や 5xx など、応答が完結した相手側の律速要求・不調は対象外）。 */
class DirectFetchError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'DirectFetchError';
  }
}


const nonHtmlFileExtensionPattern =
  /\.(?:pdf|zip|exe|mp4|png|jpe?g|gif|webp|avif|svg|bmp|ico|webm|mov|avi|mkv|mp3|wav|ogg|docx?|xlsx?|pptx?|tar|tgz|gz|bz2|7z|rar)$/i;

function normalizeText(value: string): string {
  return value.replaceAll(/\s+/g, ' ').trim();
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

/** ログ・エラーメッセージ用に URL から認証情報（userinfo）を除去する。 */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

interface HtmlFetchOptions {
  /** 'defer'（フィード取得: 枠が空くのを待たずに失敗する）または 'wait'（記事本文）。 */
  egressMode?: 'defer' | 'wait';
  /** 403/451 のときブラウザ UA で 1 回取り直すか（ADR-0011 の退避）。 */
  allowBrowserUserAgentFallback?: boolean;
}

async function fetchHtml(
  egress: EgressContext,
  url: string,
  options: HtmlFetchOptions = {},
): Promise<string> {
  // SSRF 対策: 初期 URL のスキーム・ホストを検証する。
  // 記事 URL はフィード由来（信頼できない入力）のため、内部アドレス宛の
  // リクエストやリダイレクトによる迂回を許さない。
  ensureSafePageUrl(url);

  try {
    return await fetchHtmlWithHeaders(egress, url, readerRequestHeaders, options);
  } catch (error) {
    // 正直なリーダ UA を嫌う相手だけ、ブラウザ UA で 1 回取り直す。
    // 退避の事実は Source にも取得枠にも保存しない（ADR-0011）。
    if (!options.allowBrowserUserAgentFallback || !isForbiddenResponseError(error)) {
      throw error;
    }
    return fetchHtmlWithHeaders(egress, url, browserRequestHeaders, {
      ...options,
      allowBrowserUserAgentFallback: false,
    });
  }
}

function isForbiddenResponseError(error: unknown): boolean {
  return error instanceof HttpStatusError && FORBIDDEN_STATUSES.has(error.status);
}

/** Jina Fallback の退避対象かを判定する（ADR-0012・ADR-0013）。
 * 退避対象: 403/451（明示的な拒否）と、タイムアウト・リダイレクトループ・ボディ超過
 * （応答が完結しなかった直接取得の失敗）。退避対象外: 429/503（ThrottleError、相手の律速要求に従う）、
 * その他の HTTP エラー（5xx 等の相手の不調）、枠待ち失敗（EgressUnavailableError、持ち越しの領域）。 */
function shouldFallbackToJina(error: unknown): boolean {
  return isForbiddenResponseError(error) || error instanceof DirectFetchError;
}

async function fetchHtmlWithHeaders(
  egress: EgressContext,
  url: string,
  headers: Record<string, string>,
  options: HtmlFetchOptions,
): Promise<string> {
  const bucket = bucketKeyOf(url);
  try {
    // 枠は 1 論理操作で 1 つだけ確保する。リダイレクトは同じ枠の続きとして追随し、
    // 各ホップで安全性を再検証する。
    const slot = await acquireEgressSlot(egress, url, { mode: options.egressMode ?? 'wait' });
    if (!slot.acquired) {
      throw new EgressUnavailableError(bucket, slot.reason ?? 'occupied', slot.cooldownUntilMs ?? 0);
    }
    // HTTP タイムアウトは枠を確保した**あとに**張る。枠待ちの時間を
    // 相手の不調と誤診してクールダウンを作るのを防ぐ（ADR-0009）。
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
    try {
      const first = await requestWithinEgressSlot(
        egress,
        bucket,
        url,
        { headers, redirect: 'manual', signal: controller.signal },
      );
      const response = await followRedirects(egress, bucket, first, url, headers, controller.signal);
      if (!response.ok) {
        throw new HttpStatusError(
          `Failed to fetch ${redactUrl(url)}: ${response.status} ${response.statusText}`,
          response.status,
        );
      }
      // タイムアウトはヘッダー到着だけでなくボディ読み取りまで含めて適用する。
      return await readBoundedText(response, DEFAULT_MAX_HTML_BYTES);
    } finally {
      clearTimeout(timeout);
    }
  } catch (error) {
    // タイムアウト・ボディサイズ超過は 429 と同じ「相手の不調の兆候」として枠に記録し、
    // 間隔だけ空けて同じ相手を叩き返し続けるのを防ぐ（ADR-0009）。
    if (isAbortError(error) || isUnhealthyResponseError(error)) {
      await markThrottled(egress, bucket);
    }
    // タイムアウトによる中断は AbortError のまま呼び出し側に渡さず、
    // 分かりやすいメッセージに置き換える。
    if (isAbortError(error)) {
      throw new DirectFetchError(`Fetch timed out: ${redactUrl(url)}`, { cause: error });
    }
    throw error;
  }
}

/** AbortError（タイムアウト）かどうか。判定は signal ではなくエラー型で行う。 */
function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

/** ボディサイズ超過など、bot ブロック・不調の兆候と扱う応答異常か。 */
function isUnhealthyResponseError(error: unknown): boolean {
  return error instanceof Error && error.message.includes('exceeded the size limit');
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

export interface ArticleContentOptions {
  /** Jina Fallback で使う Jina Reader の API キー。未設定ならキーなし（無料枠）で呼ぶ。 */
  jinaApiKey?: string | undefined;
}

export async function fetchArticleContent(
  egress: EgressContext,
  url: string,
  options: ArticleContentOptions = {},
): Promise<string> {
  // 記事本文は同じ相手を続けて叩くことがあるため、枠の空きを待つ（パス2 の取得）。
  try {
    const html = await fetchHtml(egress, url, {
      allowBrowserUserAgentFallback: true,
      egressMode: 'wait',
    });
    const content = extractArticleContent(html);
    // 200 で本文抽出が空になる経路（Content Gap の「無痕の欠損」— warn も Jina 発火も無い）を
    // 観測可能にする（issues/issue-202609010458-content-backfill.md の経路 (b)）。
    if (content === '') {
      logger.info('直接取得は成功したが本文抽出が空でした。', {
        articleUrl: redactUrl(url),
        htmlLength: html.length,
      });
    }
    return content;
  } catch (error) {
    // 直接取得の失敗を Jina Reader へ退避する（ADR-0012・ADR-0013）: 403/451（明示的な拒否）と、
    // タイムアウト・リダイレクトループ・ボディ超過（応答が完結しなかった失敗）。
    // 429/503（ThrottleError）と 5xx は相手の律速要求・不調であり、退避せず律速・クールダウンに従う。
    // 枠待ち失敗（EgressUnavailableError）も退避せず、持ち越しの領域に残す。
    if (!shouldFallbackToJina(error)) {
      throw error;
    }
    return fetchArticleContentViaJina(egress, url, options.jinaApiKey);
  }
}

/** 拒否された本文を Jina Reader 経由で取得する最終段の退避（ADR-0012 / jina-fallback.md）。 */
async function fetchArticleContentViaJina(
  egress: EgressContext,
  url: string,
  jinaApiKey: string | undefined,
): Promise<string> {
  // 退避先でも対象 URL は直接取得と同じ安全検証に従う（内部アドレス・非HTML は退避しない）。
  const targetUrl = ensureSafePageUrl(url);
  if (shouldSkipNonHtmlUrl(url)) {
    throw new Error(`Refusing to fetch a non-HTML page via Jina Reader: ${redactUrl(url)}`);
  }
  // 認証情報（userinfo）付きの URL は第三者（Jina）へ渡すと漏出になるため退避しない。
  if (targetUrl.username.length > 0 || targetUrl.password.length > 0) {
    throw new Error(`Refusing to fetch a URL with credentials via Jina Reader: ${redactUrl(url)}`);
  }

  const jinaUrl = `${JINA_READER_PREFIX}${url}`;
  ensureSafePageUrl(jinaUrl);

  // UA は ADR-0011 の素直なリーダ UA のまま。キーがあれば Bearer で添付する。
  const headers: Record<string, string> = { ...readerRequestHeaders };
  if (jinaApiKey !== undefined && jinaApiKey.length > 0) {
    headers.authorization = `Bearer ${jinaApiKey}`;
  }

  logger.info('Jina Fallback で本文を取得します。', {
    articleUrl: redactUrl(url),
    bucket: bucketKeyOf(jinaUrl),
  });

  // 応答は Jina 側で本文抽出済みの markdown。cheerio を経ず、空白を正規化してそのまま本文にする。
  const markdown = await fetchHtmlWithHeaders(egress, jinaUrl, headers, { egressMode: 'wait' });
  const content = normalizeText(markdown);
  // Jina が 200 でも空/極端に短い markdown を返す経路（経路 (d)：warn が出ない欠損）を観測可能にする。
  logger.info('Jina Fallback の応答を受け取りました。', {
    articleUrl: redactUrl(url),
    length: content.length,
  });
  return content;
}

/** RSS / Atom フィードの Content-Type として扱う値。 */
const FEED_CONTENT_TYPE_PATTERN = /application\/(?:rss|atom)\+xml/i;
/** 汎用 XML の Content-Type。ルート要素を確認してからフィード判定する。
 * RSS 1.0 の登録 MIME (application/rdf+xml) もルート要素確認の対象に含める。 */
const GENERIC_XML_CONTENT_TYPE_PATTERN = /^(?:(?:application|text)\/xml|application\/rdf\+xml)$/iu;

/** フィードの type として許可する MIME タイプ。 */
const FEED_TYPE_RSS = 'application/rss+xml';
const FEED_TYPE_ATOM = 'application/atom+xml';

/** 自動検出の全体タイムアウト（ミリ秒）。 */
const DISCOVERY_TIMEOUT_MS = 10_000;
/** 記事本文・HTML 読み込みのタイムアウト（ミリ秒）。 */
const FETCH_TIMEOUT_MS = 15_000;
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

/**
 * ワイルドカード DNS サービス（nip.io / sspi.io / sslip.io 等）のホスト名サフィックス。
 * これらは任意の IP アドレスに解決されるため、`169.254.169.254.nip.io` のように
 * メタデータアドレスを包んだホスト名が内部宛先への SSRF になり得る。
 * 文字列レベルの追加防御としてブロックする（DNS rebinding 全般には対応できない）。
 */
const WILDCARD_DNS_SUFFIXES = ['.nip.io', '.sslip.io', '.sspi.io'];

/**
 * IPv4 リテラルの 1 つの構成要素（オクテット or マルチバイト部）を 10進 / 16進 / 8進で解釈する。
 * WHATWG URL パーサと同じ規則に従う: 16進は 0x 前置、先頭ゼロは 8進として解釈し、
 * 8進として不正（例: '08'）な場合はドメイン名として扱うため null を返す。
 */
function parseIpv4Part(part: string): number | null {
  if (/^0[xX][0-9a-fA-F]{1,8}$/u.test(part)) {
    return Number.parseInt(part.slice(2), 16);
  }
  if (/^0[0-7]{1,11}$/u.test(part)) {
    return Number.parseInt(part, 8);
  }
  // 先頭ゼロだが 8進として不正 → WHATWG では IPv4 としてパースされない
  if (/^0\d/u.test(part)) {
    return null;
  }
  if (/^\d{1,10}$/u.test(part)) {
    return Number.parseInt(part, 10);
  }
  return null;
}

/**
 * IPv4 リテラル（ドット区切り 1〜4 部 / 10進・16進・8進の各表記）を 4 オクテットに変換する。
 * WHATWG URL パーサは末尾の部を 8/16/24/32bit 値として扱うため、それに合わせる:
 *   '127.0.0.1'   → [127, 0, 0, 1]
 *   '127.1'       → [127, 0, 0, 1]   (2 部: 末尾は 24bit)
 *   '2130706433'  → [127, 0, 0, 1]   (1 部: 32bit の 10進)
 *   '0x7f000001'  → [127, 0, 0, 1]   (1 部: 32bit の 16進)
 *   '017700000001'→ [127, 0, 0, 1]   (1 部: 32bit の 8進)
 * 変換できない場合は null を返す。
 */
function parseIpv4Literal(value: string): number[] | null {
  const parts = value.split('.');
  if (parts.length < 1 || parts.length > 4) {
    return null;
  }

  // 末尾の部は (5 - parts.length) * 8 bit の値として解釈する
  const last = parts[parts.length - 1]!;
  const lastBits = 8 * (5 - parts.length);
  const lastValue = parseIpv4Part(last);
  if (lastValue === null || lastValue > 2 ** lastBits - 1) {
    return null;
  }

  const octets: number[] = [];
  for (const part of parts.slice(0, -1)) {
    const octet = parseIpv4Part(part);
    if (octet === null || octet > 255) {
      return null;
    }
    octets.push(octet);
  }
  for (let shift = lastBits - 8; shift >= 0; shift -= 8) {
    octets.push((lastValue >> shift) & 255);
  }
  return octets;
}

/** プライベート / ループバック / リンクローカル等の内部宛先 IPv4 かどうか。 */
function isPrivateIpv4(octets: number[]): boolean {
  const a = octets[0] ?? -1;
  const b = octets[1] ?? -1;
  const c = octets[2] ?? -1;
  return (
    a === 0 || // 0.0.0.0/8 (このネットワーク)
    a === 10 || // RFC1918
    a === 127 || // ループバック
    (a === 100 && b >= 64 && b <= 127) || // CGNAT 100.64.0.0/10
    (a === 169 && b === 254) || // リンクローカル (メタデータ 169.254.169.254 を含む)
    (a === 172 && b >= 16 && b <= 31) || // RFC1918
    (a === 192 && b === 168) || // RFC1918
    (a === 192 && b === 0) || // IETF プロトコル割当 (NAT64 well-known 192.0.0.170/171 を含む)
    (a === 192 && b === 88 && c === 99) || // 6to4 リレー (192.88.99.0/24)
    (a === 198 && (b === 18 || b === 19)) || // ベンチマーク (198.18.0.0/15)
    a >= 224 // マルチキャスト・予約
  );
}

/**
 * IPv6 リテラルを 8 グループ（16bit 16進文字列）に展開する。
 * 末尾が IPv4 ドット区切り（::ffff:169.254.169.254 等）の場合も対応する。
 * 展開できない場合は null を返す。
 */
function expandIpv6(value: string): string[] | null {
  let rest = value;

  // 末尾の IPv4 ドット区切り（IPv4 マップド IPv6 等）を 16bit グループに変換する。
  const lastColon = rest.lastIndexOf(':');
  const lastPart = rest.slice(lastColon + 1);
  if (lastPart.includes('.')) {
    const embedded = parseIpv4Literal(lastPart);
    if (embedded === null) {
      return null;
    }
    const head = embedded[0]! << 8 | embedded[1]!;
    const tail = embedded[2]! << 8 | embedded[3]!;
    rest = `${rest.slice(0, lastColon + 1)}${head.toString(16)}:${tail.toString(16)}`;
  }

  const doubleColon = rest.indexOf('::');
  let groups: string[];
  if (doubleColon !== -1) {
    const left = doubleColon === 0 ? '' : rest.slice(0, doubleColon);
    const right = doubleColon + 2 >= rest.length ? '' : rest.slice(doubleColon + 2);
    const leftGroups = left === '' ? [] : left.split(':');
    const rightGroups = right === '' ? [] : right.split(':');
    const missing = 8 - leftGroups.length - rightGroups.length;
    if (missing <= 0) {
      return null;
    }
    groups = [...leftGroups, ...Array.from({ length: missing }, () => '0'), ...rightGroups];
  } else {
    groups = rest.split(':');
  }

  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/u.test(group))) {
    return null;
  }
  return groups;
}

/**
 * IPv6 から埋め込み IPv4 アドレスを復元する。対象は以下の形式（展開後のグループ列で判定）:
 *  - IPv4 マップド:           ::ffff:a.b.c.d      → 0:0:0:0:0:ffff:hi:lo
 *  - IPv4 トランスレーテッド: ::ffff:0:a.b.c.d    → 0:0:0:0:ffff:0:hi:lo
 *  - IPv4 互換:               ::a.b.c.d           → 0:0:0:0:0:0:hi:lo
 *  - NAT64 (well-known):      64:ff9b::a.b.c.d    → 64:ff9b:0:0:0:0:hi:lo
 *  - 6to4:                    2002:xxxx:xxxx::    → 2002:hi:lo:0:0:0:0:0
 * 該当しない場合は null を返す。Teredo (2001::/32) は IPv4 が XOR で難読化されており
 * 復元できないため対象外。
 */
function extractEmbeddedIpv4(groups: string[]): number[] | null {
  const [g0, g1, g2, g3, g4, g5] = groups;
  const isMapped = g0 === '0' && g1 === '0' && g2 === '0' && g3 === '0' && g4 === '0' && g5 === 'ffff';
  const isTranslated = g0 === '0' && g1 === '0' && g2 === '0' && g3 === '0' && g4 === 'ffff' && g5 === '0';
  const isCompatible = g0 === '0' && g1 === '0' && g2 === '0' && g3 === '0' && g4 === '0' && g5 === '0';
  const isNat64 = g0 === '64' && g1 === 'ff9b' && g2 === '0' && g3 === '0' && g4 === '0' && g5 === '0';
  // RFC 8215 のローカルユース NAT64 プレフィックス (64:ff9b:1::/48)
  const isNat64Local = g0 === '64' && g1 === 'ff9b' && g2 === '1' && g3 === '0' && g4 === '0' && g5 === '0';

  let hi: string;
  let lo: string;
  if (isNat64 || isNat64Local) {
    hi = groups[6] ?? '';
    lo = groups[7] ?? '';
  } else if (isMapped || isTranslated || isCompatible) {
    hi = groups[6] ?? '';
    lo = groups[7] ?? '';
  } else if (g0 === '2002') {
    // 6to4: 2〜3 グループ目に IPv4 が埋め込まれている
    hi = groups[1] ?? '';
    lo = groups[2] ?? '';
  } else {
    return null;
  }

  const hiValue = Number.parseInt(hi, 16);
  const loValue = Number.parseInt(lo, 16);
  if (!Number.isFinite(hiValue) || !Number.isFinite(loValue)) {
    return null;
  }
  return [(hiValue >> 8) & 255, hiValue & 255, (loValue >> 8) & 255, loValue & 255];
}

/** 内部宛先の IPv6 アドレスかどうか（ループバック / ULA / リンクローカル / 埋め込みプライベート IPv4）。 */
function isUnsafeIpv6(value: string): boolean {
  const groups = expandIpv6(value);
  if (groups === null) {
    // パースできない文字列はホスト名として扱い、ブロックしない。
    return false;
  }

  const [g0, g1, g2, g3, g4, g5, g6, g7] = groups;
  const loopback =
    (g0 ?? '') === '0' && (g1 ?? '') === '0' && (g2 ?? '') === '0' && (g3 ?? '') === '0' &&
    (g4 ?? '') === '0' && (g5 ?? '') === '0' && (g6 ?? '') === '0' && (g7 ?? '') === '1';

  if (loopback) {
    // ::1 / 0:0:...:1 (ループバック)
    return true;
  }
  if (groups.every((group) => group === '0')) {
    // :: (unspecified)
    return true;
  }

  // IPv4 埋め込み形式（マップド / トランスレーテッド / 互換）は末尾 2 グループから
  // IPv4 を復元して判定する。::ffff:8.8.8.8 のような公開 IPv4 マップドは許可し、
  // 埋め込まれた IPv4 がプライベート・ループバック等の場合のみブロックする。
  const embeddedIpv4 = extractEmbeddedIpv4(groups);
  if (embeddedIpv4 !== null) {
    return isPrivateIpv4(embeddedIpv4);
  }

  const first = Number.parseInt(g0 ?? '', 16);
  // fc00::/7 (ULA) と fe80::/10 (リンクローカル)・fec0::/10 (サイトローカル)
  return (first & 0xFE00) === 0xFC00 || (first & 0xFE00) === 0xFE00;
}

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
 * NOTE: 文字列レベルのチェックのみであり、DNS rebinding 攻撃には対処できない。
 * Cloudflare Workers 上で動作するため、ランタイム側のフィルタにも依存する。
 */
function isUnsafeHostname(hostname: string): boolean {
  let lower = hostname.toLowerCase();
  // FQDN ルートの末尾ドットを除去する。
  // WHATWG URL は末尾ドットを保持するため、`127.0.0.1.` や `localhost.` は
  // そのままではブロックリストに一致しないが、DNS は同一ホストに解決される。
  if (lower.endsWith('.')) {
    lower = lower.slice(0, -1);
  }
  if (BLOCKED_HOSTNAMES.has(lower)) {
    return true;
  }
  if (WILDCARD_DNS_SUFFIXES.some((suffix) => lower.endsWith(suffix))) {
    return true;
  }
  // 角括弧で囲まれた IPv6 表記 (例: [::1]) を除去してから評価。
  const stripped = lower.startsWith('[') && lower.endsWith(']') ? lower.slice(1, -1) : lower;
  // IPv6 のゾーン ID (例: fe80::1%25eth0) はリンクローカル宛てのため、除去してから判定する。
  const withoutZoneId = stripped.includes('%') ? stripped.slice(0, stripped.indexOf('%')) : stripped;

  // IPv4 系: ドット区切り / 10進 / 16進の各表記を正規化して判定。
  const ipv4 = parseIpv4Literal(withoutZoneId);
  if (ipv4 !== null) {
    return isPrivateIpv4(ipv4);
  }

  // IPv6 系: 圧縮表記を展開して判定（埋め込み IPv4 を含む）。
  if (withoutZoneId.includes(':')) {
    return isUnsafeIpv6(withoutZoneId);
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
export function extractMediaType(contentType: string): string {
  return contentType.split(';')[0]?.trim().toLowerCase() ?? '';
}

/**
 * 確保済みの取得枠を続けて使い、リダイレクトを手動追随する。
 * 各ホップの Location は安全性（内部アドレスでないこと）を検証してから追う。
 */
async function followRedirects(
  egress: EgressContext,
  bucket: string,
  response: Response,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<Response> {
  let current = response;
  let currentUrl = url;

  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop += 1) {
    if (current.status < 300 || current.status >= 400) {
      return current;
    }

    const location = current.headers.get('location');
    if (!location) {
      throw new Error('Redirect response missing Location header.');
    }
    const nextUrl = new URL(location, currentUrl).toString();
    ensureSafePageUrl(nextUrl);
    // クロスオリジンのリダイレクト先へ認証情報を流さない
    // （Jina Fallback の Bearer ヘッダーが退避先のリダイレクトで他ホストに漏れるのを防ぐ）。
    const hopHeaders = new URL(nextUrl).origin === new URL(currentUrl).origin
      ? headers
      : omitAuthorization(headers);
    current = await continueEgressRequest(
      egress,
      bucket,
      nextUrl,
      { headers: hopHeaders, redirect: 'manual', signal },
    );
    currentUrl = nextUrl;
  }

  throw new DirectFetchError('Too many redirects during feed discovery.');
}

function omitAuthorization(headers: Record<string, string>): Record<string, string> {
  const stripped = { ...headers };
  delete stripped.authorization;
  return stripped;
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
      throw new DirectFetchError('Response body exceeded the size limit.');
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
  egress: EgressContext,
  rawUrl: string,
  options: DiscoverOptions = {},
): Promise<DiscoveredFeed | null> {
  const safeUrl = ensureSafePageUrl(rawUrl);
  const url = safeUrl.toString();
  const bucket = bucketKeyOf(url);

  const slot = await acquireEgressSlot(egress, url, { mode: 'wait' });
  if (!slot.acquired) {
    throw new EgressUnavailableError(bucket, slot.reason ?? 'occupied', slot.cooldownUntilMs ?? 0);
  }

  // HTTP タイムアウトは枠を確保した**あとに**張る。枠待ちの時間を相手の不調と
  // 誤診してクールダウンを作るのを防ぐ（ADR-0009）。
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DISCOVERY_TIMEOUT_MS);
  try {
    const first = await requestWithinEgressSlot(
      egress,
      bucket,
      url,
      { headers: readerRequestHeaders, redirect: 'manual', signal: controller.signal },
    );
    const response = await followRedirects(egress, bucket, first, url, readerRequestHeaders, controller.signal);

    if (!response.ok) {
      throw new Error(`Failed to fetch the page. status=${response.status}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const mediaType = extractMediaType(contentType);
    const isGenericXml = GENERIC_XML_CONTENT_TYPE_PATTERN.test(mediaType);

    // 入力 URL が既に RSS/Atom フィードそのものを指している場合はそのまま返す。
    if (FEED_CONTENT_TYPE_PATTERN.test(mediaType)) {
      const type = pickFeedType(mediaType) ?? 'rss';
      return { alreadyAFeed: true, feedUrl: url, type };
    }

    // HTML / テキスト（およびルート要素を確認する必要がある汎用 XML）のみ自動検出を試みる。
    if (mediaType.length > 0 && !isGenericXml && !/text\/html|application\/xhtml\+xml/u.test(mediaType)) {
      return null;
    }

    // ヘッダー取得だけでなくボディ読み込みまで含めて全体をタイムアウト対象にする。
    const html = await readBoundedText(response, options.maxBytes ?? DEFAULT_MAX_HTML_BYTES);
    return classifyDiscoveredFeed(url, mediaType, isGenericXml, html);
  } catch (error) {
    // タイムアウト・ボディサイズ超過は 429 と同じ「相手の不調の兆候」として枠に記録する。
    if (isAbortError(error) || isUnhealthyResponseError(error)) {
      await markThrottled(egress, bucket);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * 取得したドキュメントからフィード URL を判定する純粋処理。
 *
 * 汎用 XML (application/xml, text/xml) はルート要素でフィードか判定する。
 * フィード以外の XML（sitemap.xml や XHTML 等）は `<link rel=alternate>` の
 * 探索へフォールバックし、誤ってフィードとして登録しないようにする。
 * ルート要素は生テキストの先頭タグで判定する（cheerio の load は XML を
 * HTML としてパースし `<html>` に包むため、ルート要素が取れない）。
 * 文書途中の同名要素による誤検知も防げる。RSS 1.0 は `<rdf:RDF>` ルートを持つ。
 */
function classifyDiscoveredFeed(
  url: string,
  mediaType: string,
  isGenericXml: boolean,
  html: string,
): DiscoveredFeed | null {
  const safeUrl = new URL(url);

  if (isGenericXml) {
    const rootTagMatch =
      /^\uFEFF?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!DOCTYPE[^>]*>)?\s*<([a-zA-Z][a-zA-Z0-9:_-]*)/u.exec(html);
    const rootTagName = rootTagMatch?.[1]?.toLowerCase() ?? '';
    if (rootTagName === 'rss' || rootTagName === 'rdf:rdf') {
      return { alreadyAFeed: true, feedUrl: url, type: 'rss' };
    }
    if (rootTagName === 'feed') {
      return { alreadyAFeed: true, feedUrl: url, type: 'atom' };
    }
  }

  const $ = load(html);
  const candidates: { feedUrl: string; type: DiscoveredFeedType }[] = [];

  $('link[rel~="alternate"]').each((_, node) => {
    if (!isTag(node)) {
      return;
    }
    const feedType = pickFeedType($(node).attr('type') ?? '');
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

export async function fetchRssOrFallback(
  egress: EgressContext,
  siteUrl: string,
): Promise<ScrapedLink[]> {
  // パス1（全 Source のフィード取得）から呼ばれる。枠が空いていなければ
  // 待機せず EgressUnavailableError を返し、呼び出し側の後回し列に譲る（ADR-0009）。
  const htmlOrXml = await fetchHtml(egress, siteUrl, { egressMode: 'defer' });

  try {
    const feed = await rssParser.parseString(htmlOrXml);
    const items = feed.items
      .map((item): ScrapedLink | null => {
        const url = item.link ?? item.guid ?? null;
        if (!url) {
          return null;
        }

        // 記事 URL は http(s) に限定する。フィードは信頼できない入力のため、
        // javascript: や data: 等のスキームを DB に保存すると、クライアントの
        // href / window.open 経由でスクリプト実行につながり得る。
        const resolvedUrl = resolveUrl(url, siteUrl);
        if (!resolvedUrl) {
          return null;
        }

        if (shouldSkipNonHtmlUrl(resolvedUrl)) {
          return null;
        }

        const title = normalizeText(item.title ?? '');
        return {
          pubDate: parsePubDate(item.isoDate ?? item.pubDate),
          title: title.length > 0 ? title : resolvedUrl,
          url: resolvedUrl,
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
