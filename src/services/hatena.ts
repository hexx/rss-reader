import { sleep } from '../utils/sleep.js';

export interface HatenaBookmarkComment {
  comment: string;
  user: string;
}

interface HatenaBookmarkApiResponse {
  bookmarks?: Array<{
    comment?: string;
    user?: string;
  }>;
}

const hatenaEntryJsonLiteBaseUrl = 'https://b.hatena.ne.jp/entry/jsonlite/?url=';
const hatenaRequestDelayMs = 1_000;

function normalizeComment(comment: string): string {
  return comment.replace(/\s+/g, ' ').trim();
}

export async function fetchHatenaBookmarks(articleUrl: string): Promise<HatenaBookmarkComment[]> {
  await sleep(hatenaRequestDelayMs);

  const response = await fetch(`${hatenaEntryJsonLiteBaseUrl}${encodeURIComponent(articleUrl)}`, {
    headers: {
      accept: 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch Hatena bookmarks for ${articleUrl}: ${response.status} ${response.statusText}`);
  }

  const payload = (await response.json()) as HatenaBookmarkApiResponse | null | undefined;
  const bookmarks = payload && Array.isArray(payload.bookmarks) ? payload.bookmarks : [];

  return bookmarks
    .map((bookmark): HatenaBookmarkComment | null => {
      if (typeof bookmark.user !== 'string' || typeof bookmark.comment !== 'string') {
        return null;
      }

      const comment = normalizeComment(bookmark.comment);
      if (comment.length === 0) {
        return null;
      }

      return {
        user: bookmark.user,
        comment,
      };
    })
    .filter((bookmark): bookmark is HatenaBookmarkComment => bookmark !== null);
}
