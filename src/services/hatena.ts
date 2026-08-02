import { browserRequestHeaders, extractMediaType, readBoundedText } from './scraper.js';

export interface HatenaBookmarkComment {
  /**
   * 正規化済みコメント本文。タグのみブックマークのように元データが空でも
   * 空文字として保持する（カウント・並び替えで user を落とさないため）。
   */
  comment: string;
  /**
   * ユーザーがブックマークした日時（分精度）。jsonlite の `timestamp`
   * （`"YYYY/MM/DD HH:MM"` 形式の JST 文字列）を `Date` に確定パースする。
   */
  timestamp: Date;
  user: string;
}

interface HatenaBookmarkApiResponse {
  bookmarks?: {
    comment?: string;
    /**
     * jsonlite は `"YYYY/MM/DD HH:MM"` 形式の JST・分精度文字列を返す。
     * 欠落時は現在時刻をフォールバックとする。
     */
    timestamp?: string;
    user?: string;
  }[];
}

const hatenaEntryJsonLiteBaseUrl = 'https://b.hatena.ne.jp/entry/jsonlite/?url=';

/**
 * 礼儀としての最低待ち時間。はてなのレート制限に余裕で収まる 1 秒とし、
 * ジッターでバースト検出を避ける。
 */
const minimumHatenaRequestDelayMs = 1000;
/** ジッター上界。バースト検出を避けるため最大 3 秒までズラす。 */
const maximumHatenaRequestDelayMs = 3000;
/** Exponential backoff の最大値。5 分を超えて待つのは無意味なので打ち切る。 */
const maximumBackoffMs = 5 * 60 * 1000;
/** Retry-After の値が秒数文字列として有効か判定する厳密正規表現。 */
const retryAfterSecondsPattern = /^\d+$/;

/**
 * モジュールローカルなレートリミッター状態。
 *
 * Cloudflare Workers 上の同一 isolate 内ではリクエストをまたいで共有される。
 * 別 isolate には状態は引き継がれないが、単一の同期 run 内では十分機能する。
 * 429 を受けて exponential backoff に入ったら、retry-after ヘッダの
 * 値と短いバックオフを組み合わせて次のリクエスト可能時刻を計算する。
 */
let nextAllowedAtMs = 0;
let consecutiveBackoffs = 0;

type SleepFn = (ms: number) => Promise<void>;
type RandomFn = () => number;

let sleepFn: SleepFn = (ms) => new Promise((resolve) => {
  setTimeout(resolve, ms);
});
let randomFn: RandomFn = Math.random;

/**
 * テスト用 DI ポイント。本番コードから呼ばない前提。
 *
 * \`src/test-utils/hatena-rate-limiter.ts\` 経由でのみ利用される想定で、
 * モジュールローカルの \`let\` を書き換える。
 */
export function _setSleepForTest(fn: SleepFn | null): void {
  sleepFn = fn ?? ((ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  }));
}

/** テスト用 DI ポイント。本番コードから呼ばない前提。 */
export function _setRandomForTest(fn: RandomFn | null): void {
  randomFn = fn ?? Math.random;
}

/** テスト用: レートリミッター状態をリセットする。 */
export function _resetRateLimiterForTest(): void {
  nextAllowedAtMs = 0;
  consecutiveBackoffs = 0;
}

/** テスト用: 現在のレートリミッター状態を読み出す。 */
export function _getRateLimiterStateForTest(): { nextAllowedAtMs: number; consecutiveBackoffs: number } {
  return { consecutiveBackoffs, nextAllowedAtMs };
}

function jitteredDelayMs(): number {
  const range = maximumHatenaRequestDelayMs - minimumHatenaRequestDelayMs + 1;
  return minimumHatenaRequestDelayMs + Math.floor(randomFn() * range);
}

/** はてな API リクエストのタイムアウト（ミリ秒）。接続が詰まっても同期全体を止めない。 */
const hatenaFetchTimeoutMs = 15_000;
/** はてな API レスポンスボディのサイズ上限（バイト）。bot ブロック等の巨大ページ対策。 */
const maxHatenaResponseBytes = 1024 * 1024;
/** タイムアウトを表すエラーメッセージ（二重ラップ防止のため定数化）。 */
const hatenaTimeoutMessage = 'Hatena API request timed out.';

/** HTML 系のメディアタイプかどうか（bot ブロック等のエラーページ判定用）。 */
function isHtmlMediaType(contentType: string): boolean {
  const mediaType = extractMediaType(contentType);
  return mediaType === 'text/html' || mediaType === 'application/xhtml+xml';
}

/**
 * 次回リクエストが許可されるまで sleep する。
 * 並行呼び出しがあっても間隔を守れるよう、sleep の前に予約時刻を先へ
 * 進めておく（check-then-sleep-then-reserve の非原子な順序を避ける）。
 */
async function acquireRequestSlot(): Promise<void> {
  const now = Date.now();
  const waitUntil = Math.max(now, nextAllowedAtMs);
  // 礼儀のジッターを反映して次回予約時刻を更新
  nextAllowedAtMs = waitUntil + jitteredDelayMs();
  if (waitUntil > now) {
    await sleepFn(waitUntil - now);
  }
}

/**
 * 429/503 を受けたときに `Retry-After` を尊重しつつ exponential backoff を計算する。
 *
 * 1. \`Retry-After: <秒数>\` 形式: \`/^\d+$/\` で厳密検証 → 秒 * 1000 ms
 * 2. \`Retry-After: <HTTP date>\` 形式: \`new Date()\` でパース → 差分 ms
 * 3. 上記以外 / 未指定: exponential (1s, 2s, 4s, 8s, ...) ジッター 50%–100%
 *
 * 礼儀 delay と同じくサンダリングハード herd を避けるためジッターを入れる。
 *
 * Note: \`Date.now()\` をこの関数内で複数回呼ぶとテストや呼び出し側で
 * ms 単位のドリフトが見えるので、冒頭で 1 回だけ取得して使い回す。
 */
function applyRetryAfter(value: string | null | undefined): void {
  consecutiveBackoffs += 1;
  const now = Date.now();

  let baseBackoffMs: number;

  if (typeof value === 'string' && retryAfterSecondsPattern.test(value)) {
    // Retry-After: <秒数> の厳密マッチ
    const seconds = Number.parseInt(value, 10);
    if (seconds > 0) {
      baseBackoffMs = Math.min(maximumBackoffMs, seconds * 1000);
    } else {
      baseBackoffMs = exponentialBackoffMs(consecutiveBackoffs);
    }
  } else if (typeof value === 'string') {
    // Retry-After: <HTTP date> を試みる
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) {
      baseBackoffMs = exponentialBackoffMs(consecutiveBackoffs);
    } else {
      baseBackoffMs = Math.max(0, date.getTime() - now);
    }
  } else {
    baseBackoffMs = exponentialBackoffMs(consecutiveBackoffs);
  }

  // ジッター (50%–100% の幅) を乗算しサンダリングハード herd を避ける
  const jitter = 0.5 + randomFn() * 0.5;
  const backoffMs = Math.max(1, Math.floor(baseBackoffMs * jitter));

  nextAllowedAtMs = Math.max(nextAllowedAtMs, now + backoffMs);
}

/**
 * Exponential backoff の基準値を計算する。
 * 1 回目: 1s, 2 回目: 2s, 3 回目: 4s, 4 回目: 8s, ... 上限 5 分。
 */
function exponentialBackoffMs(count: number): number {
  const exponent = Math.max(0, count - 1);
  return Math.min(maximumBackoffMs, 1000 * 2 ** exponent);
}

/** 成功時にバックオフ累積をリセット（次回 429 で再カウント）。 */
function resetBackoff(): void {
  consecutiveBackoffs = 0;
}

function normalizeComment(comment: string): string {
  return comment.replaceAll(/\s+/g, ' ').trim();
}

/**
 * Jsonlite の `timestamp`（`"YYYY/MM/DD HH:MM"` 形式、JST・分精度）の厳密パターン。
 * 歴代の jsonlite が返すこの形式だけを受理し、それ以外はフォールバックに落とす
 * （`new Date` の曖昧パースに渡すと環境依存の解釈になるため）。
 */
const hatenaTimestampPattern = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/;

/**
 * Jsonlite の `timestamp`（`"YYYY/MM/DD HH:MM"` 形式、JST）を `Date` に変換する。
 *
 * はてなが返す時刻は日本時間なので、UTC 環境（Cloudflare Workers）でも
 * 順序・表示がずれないよう `+09:00` を付与して確定パースする。
 * 不正・欠落値は `fallback`（現在時刻）を返す。
 */
function parseHatenaTimestamp(value: string | undefined, fallback: Date): Date {
  if (typeof value !== 'string') {
    return fallback;
  }
  const match = hatenaTimestampPattern.exec(value);
  if (match === null) {
    return fallback;
  }
  const iso = `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:00+09:00`;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return fallback;
  }
  return date;
}

export async function fetchHatenaBookmarks(articleUrl: string): Promise<HatenaBookmarkComment[]> {
  await acquireRequestSlot();

  // タイムアウトはレスポンスヘッダー到着だけでなく、ボディ読み取り
  // （response.json()）まで含めて適用する（ヘッダーだけ返して本文を
  // 送らない bot ブロック等で同期が止まらないようにする）。
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), hatenaFetchTimeoutMs);

  let payload: HatenaBookmarkApiResponse | null | undefined;
  try {
    const response = await fetch(`${hatenaEntryJsonLiteBaseUrl}${encodeURIComponent(articleUrl)}`, {
      headers: {
        ...browserRequestHeaders,
        accept: 'application/json',
      },
      signal: controller.signal,
    });

    // 429 / 503: Retry-After を尊重して backoff を更新してから例外を投げる。
    // 呼び出し側は warn ログで握り潰し、次の同期 run でリトライする想定。
    if (response.status === 429 || response.status === 503) {
      applyRetryAfter(response.headers.get('Retry-After'));
      throw new Error(`Hatena rate limited: ${response.status} ${response.statusText}`);
    }

    if (!response.ok) {
      throw new Error(`Failed to fetch Hatena bookmarks for ${articleUrl}: ${response.status} ${response.statusText}`);
    }

    // 200 でも HTML エラーページ（bot ブロック等）を返すことがあるため、
    // HTML 系の Content-Type は明確なエラーにしてバックオフを昇格させる。
    // それ以外（ヘッダー欠落や text/plain 等）は JSON としてパースを試み、
    // 失敗時は下の catch で不正 JSON エラーにする（プロキシ等がヘッダーを
    // 落とすケースで正常レスポンスを壊さないため）。
    if (isHtmlMediaType(response.headers.get('content-type') ?? '')) {
      applyRetryAfter(null);
      throw new Error(`Unexpected response from Hatena API for ${articleUrl}: received HTML instead of JSON.`);
    }

    // ボディはサイズ上限付きで読み込む（Content-Length ヘッダーに依存しないハードな上限）。
    // 巨大な bot ブロックページを丸ごとメモリに載せるのを防ぐ。
    let bodyText: string;
    try {
      bodyText = await readBoundedText(response, maxHatenaResponseBytes);
    } catch (error) {
      // サイズ超過も bot ブロックの兆候としてバックオフを昇格させる
      applyRetryAfter(null);
      throw new Error(`Hatena API response for ${articleUrl} exceeded the size limit.`, { cause: error });
    }
    try {
      payload = JSON.parse(bodyText) as HatenaBookmarkApiResponse | null | undefined;
    } catch (error) {
      applyRetryAfter(null);
      throw new Error(`Invalid JSON response from Hatena API for ${articleUrl}.`, { cause: error });
    }
  } catch (error) {
    // タイムアウトによる中断は AbortError のまま呼び出し側に渡さず、
    // 分かりやすいメッセージに置き換える（ここで一括して 1 回だけラップする）。
    // タイムアウトも bot ブロック等の異常の兆候なので、バックオフを昇格させる。
    if (controller.signal.aborted) {
      applyRetryAfter(null);
      throw new Error(`${hatenaTimeoutMessage} (${articleUrl})`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  // 正常に JSON としてパースできた応答のみ成功扱いとし、バックオフをリセットする。
  // （HTML エラーページ・本文停滞・不正 JSON は bot ブロックの兆候のため、
  //   バックオフを維持する方が防御的に安全）
  resetBackoff();

  const bookmarks = payload && Array.isArray(payload.bookmarks) ? payload.bookmarks : [];

  const now = new Date();
  return bookmarks
    .map((bookmark): HatenaBookmarkComment | null => {
      // ユーザー識別子が無いエントリは識別不能なので除外する。
      // ただし「タグだけ」「コメント空」のブックマークは user を含むので保持する。
      if (typeof bookmark.user !== 'string' || bookmark.user.length === 0) {
        return null;
      }

      const rawComment = typeof bookmark.comment === 'string' ? bookmark.comment : '';
      return {
        comment: normalizeComment(rawComment),
        timestamp: parseHatenaTimestamp(bookmark.timestamp, now),
        user: bookmark.user,
      };
    })
    .filter((bookmark): bookmark is HatenaBookmarkComment => bookmark !== null);
}
