import { load } from 'cheerio';
import type { CheerioAPI } from 'cheerio';
import { isTag } from 'domhandler';
import type { Element } from 'domhandler';
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

async function fetchHtml(url: string): Promise<string> {
  // SSRF 対策: 初期 URL のスキーム・ホストを検証する。
  // 記事 URL はフィード由来（信頼できない入力）のため、内部アドレス宛の
  // リクエストやリダイレクトによる迂回を許さない。
  ensureSafePageUrl(url);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    // リダイレクトは safeFetch が手動で追随し、各ホップで安全性を再検証する。
    const response = await safeFetch(url, controller.signal);
    if (!response.ok) {
      throw new Error(`Failed to fetch ${redactUrl(url)}: ${response.status} ${response.statusText}`);
    }
    return await readBoundedText(response, DEFAULT_MAX_HTML_BYTES);
  } catch (error) {
    // タイムアウトによる中断は AbortError のまま呼び出し側に渡さず、
    // 分かりやすいメッセージに置き換える。
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error(`Fetch timed out: ${redactUrl(url)}`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
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
/** 汎用 XML の Content-Type。ルート要素を確認してからフィード判定する。
 * RSS 1.0 の登録 MIME (application/rdf+xml) もルート要素確認の対象に含める。 */
const GENERIC_XML_CONTENT_TYPE_PATTERN = /^(?:(?:application|text)\/xml|application\/rdf\+xml)$/i;

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
  if (/^0[xX][0-9a-fA-F]{1,8}$/.test(part)) {
    return Number.parseInt(part.slice(2), 16);
  }
  if (/^0[0-7]{1,11}$/.test(part)) {
    return Number.parseInt(part, 8);
  }
  // 先頭ゼロだが 8進として不正 → WHATWG では IPv4 としてパースされない
  if (/^0\d/.test(part)) {
    return null;
  }
  if (/^\d{1,10}$/.test(part)) {
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

  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-f]{1,4}$/.test(group))) {
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
  return (first & 0xfe00) === 0xfc00 || (first & 0xfe00) === 0xfe00;
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
  // ヘッダー取得だけでなくボディ読み込みまで含めて全体をタイムアウト対象にする。
  // clearTimeout は finally で一括実行し、早期リターン経路で漏れないようにする。
  try {
    const response = await safeFetch(safeUrl.toString(), controller.signal);

    if (!response.ok) {
      throw new Error(`Failed to fetch the page. status=${response.status}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    const mediaType = extractMediaType(contentType);
    const isGenericXml = GENERIC_XML_CONTENT_TYPE_PATTERN.test(mediaType);

    // 入力 URL が既に RSS/Atom フィードそのものを指している場合はそのまま返す。
    if (FEED_CONTENT_TYPE_PATTERN.test(mediaType)) {
      const type = pickFeedType(mediaType) ?? 'rss';
      return { alreadyAFeed: true, feedUrl: safeUrl.toString(), type };
    }

    // HTML / テキスト（およびルート要素を確認する必要がある汎用 XML）のみ自動検出を試みる。
    if (mediaType.length > 0 && !isGenericXml && !/text\/html|application\/xhtml\+xml/.test(mediaType)) {
      return null;
    }

    const html = await readBoundedText(response, maxBytes);
    const $ = load(html);

    // 汎用 XML (application/xml, text/xml) はルート要素でフィードか判定する。
    // フィード以外の XML（sitemap.xml や XHTML 等）は <link rel=alternate> の
    // 探索へフォールバックし、誤ってフィードとして登録しないようにする。
    // ルート要素は生テキストの先頭タグで判定する（cheerio の load は XML を
    // HTML としてパースし <html> に包むため、ルート要素が取れない）。
    // 文書途中の同名要素による誤検知も防げる。RSS 1.0 は <rdf:RDF> ルートを持つ。
    if (isGenericXml) {
      const rootTagMatch =
        /^\uFEFF?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!DOCTYPE[^>]*>\s*)?<([a-zA-Z][a-zA-Z0-9:_-]*)/.exec(html);
      const rootTagName = rootTagMatch?.[1]?.toLowerCase() ?? '';
      if (rootTagName === 'rss' || rootTagName === 'rdf:rdf') {
        return { alreadyAFeed: true, feedUrl: safeUrl.toString(), type: 'rss' };
      }
      if (rootTagName === 'feed') {
        return { alreadyAFeed: true, feedUrl: safeUrl.toString(), type: 'atom' };
      }
    }

    const candidates: { feedUrl: string; type: DiscoveredFeedType }[] = [];

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
  } finally {
    clearTimeout(timeout);
  }
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
