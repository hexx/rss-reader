import type { EgressContext } from './egress.js';
import {
  bucketKeyOf,
  markThrottled,
  startEgressRequest,
  ThrottleError,
} from './egress.js';
import { readerRequestHeaders, readBoundedText } from './scraper.js';

export interface HatenaBookmarkComment {
  /**
   * 正規化済みコメント本文。タグだけブックマークのように元データが空でも
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

/** はてな API リクエストのタイムアウト（ミリ秒）。接続が詰まっても同期全体を止めない。 */
const hatenaFetchTimeoutMs = 15_000;
/** はてな API レスポンスボディのサイズ上限（バイト）。bot ブロック等の巨大ページ対策。 */
const maxHatenaResponseBytes = 1024 * 1024;
/** タイムアウトを表すエラーメッセージ（二重ラップ防止のため定数化）。 */
const hatenaTimeoutMessage = 'Hatena API request timed out.';

/** HTML 系のメディアタイプかどうか（bot ブロック等のエラーページ判定用）。 */
function isHtmlMediaType(response: Response): boolean {
  const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
  return mediaType === 'text/html' || mediaType === 'application/xhtml+xml';
}

/** Jsonlite の `timestamp`（`"YYYY/MM/DD HH:MM"` 形式、JST）の厳密パターン。 */
const hatenaTimestampPattern = /^(\d{4})\/(\d{2})\/(\d{2}) (\d{2}):(\d{2})$/;

function normalizeComment(comment: string): string {
  return comment.replaceAll(/\s+/g, ' ').trim();
}

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

/**
 * 記事にはてブコメント（Bookmark）を 1 件分取得する。
 *
 * 律速（間隔・クールダウン）は共通の律速層（`egress.ts` / ADR-0009）が担当する。
 * 旧モジュール内リミッターは廃止済みで、はてな群 = 1 取得枠として
 * フィード取得・記事本文取得と同じ枠を待つ。
 *
 * @throws {ThrottleError} 429/503・bot ブロック兆候・タイムアウト（クールダウン設定済み）
 */
export async function fetchHatenaBookmarks(
  egress: EgressContext,
  articleUrl: string,
): Promise<HatenaBookmarkComment[]> {
  const requestUrl = `${hatenaEntryJsonLiteBaseUrl}${encodeURIComponent(articleUrl)}`;
  // jsonlite のホスト（b.hatena.ne.jp）ははてな群の 1 取得枠に属する。
  const bucket = bucketKeyOf(requestUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), hatenaFetchTimeoutMs);

  let payload: HatenaBookmarkApiResponse | null | undefined;
  try {
    // タイムアウトはレスポンスヘッダー到着だけでなく、ボディ読み取りまで
    // 含めて適用する（ヘッダーだけ返して本文を送らない bot ブロック等で
    // 同期が止まらないようにするため）。
    const { response } = await startEgressRequest(
      egress,
      requestUrl,
      {
        headers: { ...readerRequestHeaders, accept: 'application/json' },
        signal: controller.signal,
      },
      { mode: 'wait' },
    );

    if (!response.ok) {
      // 429/503 は startEgressRequest 側で ThrottleError になるため、ここはそれ以外の HTTP エラー。
      throw new Error(`Failed to fetch Hatena bookmarks for ${articleUrl}: ${response.status} ${response.statusText}`);
    }

    // 200 でも HTML エラーページ（bot ブロック等）を返すことがあるため、
    // HTML 系の Content-Type は明確なエラーにしてバックオフを昇格させる。
    if (isHtmlMediaType(response)) {
      const nextRetryAtMs = await markThrottled(egress, bucket);
      throw new ThrottleError(
        `Unexpected response from Hatena API for ${articleUrl}: received HTML instead of JSON.`,
        { bucket, nextRetryAtMs, status: response.status },
      );
    }

    // ボディはサイズ上限付きで読み込む（Content-Length ヘッダーに依存しないハードな上限）。
    let bodyText: string;
    try {
      bodyText = await readBoundedText(response, maxHatenaResponseBytes);
    } catch (error) {
      // サイズ超過のみ bot ブロックの兆候としてバックオフを昇格させる。
      if (error instanceof Error && error.message.includes('exceeded the size limit')) {
        const nextRetryAtMs = await markThrottled(egress, bucket);
        throw new ThrottleError(
          `Hatena API response for ${articleUrl} exceeded the size limit.`,
          { bucket, nextRetryAtMs, status: response.status },
        );
      }
      throw error;
    }

    try {
      payload = JSON.parse(bodyText) as HatenaBookmarkApiResponse | null | undefined;
    } catch (error) {
      const nextRetryAtMs = await markThrottled(egress, bucket);
      throw new ThrottleError(`Invalid JSON response from Hatena API for ${articleUrl}.`, {
        bucket,
        cause: error,
        nextRetryAtMs,
        status: response.status,
      });
    }
  } catch (error) {
    // タイムアウトによる中断（AbortError）は分かりやすいメッセージに置き換える。
    // タイムアウトも相手の不調の兆候なのでバックオフを昇格させる（ADR-0009）。
    if (error instanceof DOMException && error.name === 'AbortError') {
      await markThrottled(egress, bucket);
      throw new Error(`${hatenaTimeoutMessage} (${articleUrl})`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

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
