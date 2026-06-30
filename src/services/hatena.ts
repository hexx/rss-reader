import { sleep } from '../utils/sleep.js';
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

const hatenaEntryJsonLiteBaseUrl = 'https://b.hatena.ne.jp/entry/jsonlite/?url=';
const minimumHatenaRequestDelayMs = 1_000;
const maximumHatenaRequestDelayMs = 3_000;
const hatenaUserAgent = 'rss-reader/1.0';

function randomHatenaRequestDelayMs(): number {
  return (
    Math.floor(Math.random() * (maximumHatenaRequestDelayMs - minimumHatenaRequestDelayMs + 1)) +
    minimumHatenaRequestDelayMs
  );
}

function normalizeComment(comment: string): string {
  return comment.replace(/\s+/g, ' ').trim();
}

export async function fetchHatenaBookmarks(articleUrl: string): Promise<HatenaBookmarkComment[]> {
  await sleep(randomHatenaRequestDelayMs());

  const response = await fetch(`${hatenaEntryJsonLiteBaseUrl}${encodeURIComponent(articleUrl)}`, {
    headers: {
      ...browserRequestHeaders,
      accept: 'application/json',
      'user-agent': hatenaUserAgent,
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Hatena bookmarks for ${articleUrl}: ${response.status} ${response.statusText}`);
  }

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
