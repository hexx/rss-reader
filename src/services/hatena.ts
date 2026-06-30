import { browserRequestHeaders } from './scraper.js';

export interface HatenaBookmarkComment {
  /**
   * 正規化済みコメント本文。タグのみブックマークのように元データが空でも
   * 空文字として保持する（カウント・並び替えで user を落とさないため）。
   */
  comment: string;
  /** ユーザーがブックマークした日時（jsonlite の `timestamp` をミリ秒に展開）。 */
  timestamp: Date;
  user: string;
}

interface HatenaBookmarkApiResponse {
  bookmarks?: Array<{
    comment?: string;
    /** jsonlite は epoch 秒を文字列で返す。欠落時は現在時刻をフォールバックとする。 */
    timestamp?: string;
    user?: string;
  }>;
}

const hatenaEntryJsonLiteBaseUrl = 'https://b.hatena.ne.jp/entry/jsonlite/?url=';

/**
 * 礼儀としての最低待ち時間。はてなのレート制限に余裕で収まる 1 秒とし、
 * ジッターでバースト検出を避ける。
 */
const minimumHatenaRequestDelayMs = 1_000;
/** ジッター上界。バースト検出を避けるため最大 3 秒までズラす。 */
const maximumHatenaRequestDelayMs = 3_000;
/** exponential backoff の最大値。5 分を超えて待つのは無意味なので打ち切る。 */
const maximumBackoffMs = 5 * 60 * 1000;

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

/** 本番では使うな。テスト時の sleep 差し替え用。 */
export function _setSleepForTest(fn: SleepFn | null): void {
  sleepFn = fn ?? ((ms) => new Promise((resolve) => {
    setTimeout(resolve, ms);
  }));
}

/** 本番では使うな。テスト時の乱数差し替え用（ジッター決定論化）。 */
export function _setRandomForTest(fn: RandomFn | null): void {
  randomFn = fn ?? Math.random;
}

/** 本番では使うな。テスト間のレートリミッター状態リセット用。 */
export function _resetRateLimiterForTest(): void {
  nextAllowedAtMs = 0;
  consecutiveBackoffs = 0;
}

/** テスト用: 現在のレートリミッター状態を読み出す。 */
export function _getRateLimiterStateForTest(): { nextAllowedAtMs: number; consecutiveBackoffs: number } {
  return { nextAllowedAtMs, consecutiveBackoffs };
}

function jitteredDelayMs(): number {
  const range = maximumHatenaRequestDelayMs - minimumHatenaRequestDelayMs + 1;
  return minimumHatenaRequestDelayMs + Math.floor(randomFn() * range);
}

/**
 * 次回リクエストが許可されるまで sleep する。
 * 許可されたあと、礼儀として次のリクエストまでの最短間隔を `nextAllowedAtMs`
 * に書き込む（次回の `acquireRequestSlot` で再度この値を見る）。
 */
async function acquireRequestSlot(): Promise<void> {
  const now = Date.now();
  if (nextAllowedAtMs > now) {
    await sleepFn(nextAllowedAtMs - now);
  }
  // 礼儀のジッターを反映して次回予約時刻を更新
  nextAllowedAtMs = Date.now() + jitteredDelayMs();
}

/**
 * 429/503 を受けたときに `Retry-After` を尊重しつつ exponential backoff を計算する。
 * Retry-After は秒数（int）または HTTP date 形式。解釈できない場合は exponential。
 */
function applyRetryAfter(value: string | null | undefined): void {
  consecutiveBackoffs += 1;
  // デフォルト: exponential (1s, 2s, 4s, 8s, ...) 上限 5 分
  let backoffMs = Math.min(maximumBackoffMs, 1000 * Math.pow(2, consecutiveBackoffs));

  if (value) {
    const seconds = Number.parseInt(value, 10);
    if (Number.isFinite(seconds) && seconds > 0) {
      backoffMs = Math.min(maximumBackoffMs, seconds * 1000);
    } else {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) {
        backoffMs = Math.max(0, date.getTime() - Date.now());
      }
    }
  }

  nextAllowedAtMs = Math.max(nextAllowedAtMs, Date.now() + backoffMs);
}

/** 成功時にバックオフ累積をリセット（次回 429 で再カウント）。 */
function resetBackoff(): void {
  consecutiveBackoffs = 0;
}

function normalizeComment(comment: string): string {
  return comment.replace(/\s+/g, ' ').trim();
}

/** jsonlite の `timestamp`（epoch 秒文字列）を `Date` に変換する。 */
function parseHatenaTimestamp(value: string | undefined, fallback: Date): Date {
  if (typeof value !== 'string' || value.length === 0) {
    return fallback;
  }
  const seconds = Number.parseInt(value, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return fallback;
  }
  return new Date(seconds * 1000);
}

export async function fetchHatenaBookmarks(articleUrl: string): Promise<HatenaBookmarkComment[]> {
  await acquireRequestSlot();

  const response = await fetch(`${hatenaEntryJsonLiteBaseUrl}${encodeURIComponent(articleUrl)}`, {
    headers: {
      ...browserRequestHeaders,
      accept: 'application/json',
    },
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

  resetBackoff();

  const payload = (await response.json()) as HatenaBookmarkApiResponse | null | undefined;
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
        user: bookmark.user,
        comment: normalizeComment(rawComment),
        timestamp: parseHatenaTimestamp(bookmark.timestamp, now),
      };
    })
    .filter((bookmark): bookmark is HatenaBookmarkComment => bookmark !== null);
}
