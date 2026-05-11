import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { server } from '../test/setup.js';
import { fetchHatenaBookmarks } from './hatena.js';

const articleUrl = 'https://example.com/articles/1';
const hatenaApiBaseUrl = 'https://b.hatena.ne.jp/entry/jsonlite/';

const hatenaResponse = {
  bookmarks: [
    {
      user: 'alice',
      comment: '  良記事  ',
    },
    {
      user: 'bob',
      comment: '',
    },
    {
      user: 'carol',
      comment: '参考になる',
    },
  ],
};

describe('fetchHatenaBookmarks', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('filters out empty comments from Hatena bookmarks', async () => {
    server.use(
      http.get(hatenaApiBaseUrl, ({ request }) => {
        const requestUrl = new URL(request.url);
        expect(request.headers.get('user-agent')).toBe('rss-reader/1.0');
        if (requestUrl.searchParams.get('url') !== articleUrl) {
          return HttpResponse.json(
            { bookmarks: [] },
            {
              headers: { 'Content-Type': 'application/json' },
            },
          );
        }

        return HttpResponse.json(hatenaResponse, {
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.useFakeTimers();

    const promise = fetchHatenaBookmarks(articleUrl);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(promise).resolves.toEqual([
      {
        user: 'alice',
        comment: '良記事',
      },
      {
        user: 'carol',
        comment: '参考になる',
      },
    ]);
  });

  it('returns an empty list when Hatena responds with null', async () => {
    server.use(
      http.get(hatenaApiBaseUrl, ({ request }) => {
        expect(request.headers.get('user-agent')).toBe('rss-reader/1.0');
        return HttpResponse.json(null, {
          headers: { 'Content-Type': 'application/json' },
        });
      }),
    );

    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.useFakeTimers();

    const promise = fetchHatenaBookmarks(articleUrl);

    await vi.advanceTimersByTimeAsync(1_000);

    await expect(promise).resolves.toEqual([]);
  });
});
