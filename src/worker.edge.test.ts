import { describe, expect, it, vi } from 'vitest';

describe('worker internal functions', () => {
  describe('formatDate', () => {
    it('returns ISO string for a valid Date object', async () => {
      const { formatDate } = await import('./worker.js');
      const date = new Date('2024-06-15T10:30:00.000Z');
      expect(formatDate(date)).toBe('2024-06-15T10:30:00.000Z');
    });

    it('returns ISO string for a valid ISO string', async () => {
      const { formatDate } = await import('./worker.js');
      expect(formatDate('2024-06-15T10:30:00.000Z')).toBe('2024-06-15T10:30:00.000Z');
    });

    it('returns empty string for an invalid date string', async () => {
      const { formatDate } = await import('./worker.js');
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(formatDate('not-a-date')).toBe('');
      expect(warnSpy).toHaveBeenCalledWith('formatDate: invalid date string encountered', 'not-a-date');

      warnSpy.mockRestore();
    });

    it('returns empty string for null', async () => {
      const { formatDate } = await import('./worker.js');
      expect(formatDate(null)).toBe('');
    });

    it('returns empty string for undefined', async () => {
      const { formatDate } = await import('./worker.js');
      expect(formatDate()).toBe('');
    });
  });

  describe('parsePaginationParam', () => {
    it('returns fallback when value is undefined', async () => {
      const { parsePaginationParam } = await import('./worker.js');
      expect(parsePaginationParam(undefined, 50, 1)).toBe(50);
    });

    it('returns fallback when value is a negative number', async () => {
      const { parsePaginationParam } = await import('./worker.js');
      expect(parsePaginationParam('-1', 50, 1)).toBe(50);
    });

    it('returns fallback when value is 0 and minimum is 1', async () => {
      const { parsePaginationParam } = await import('./worker.js');
      expect(parsePaginationParam('0', 50, 1)).toBe(50);
    });

    it('returns fallback when value is non-numeric', async () => {
      const { parsePaginationParam } = await import('./worker.js');
      expect(parsePaginationParam('abc', 50, 1)).toBe(50);
    });

    it('returns parsed value for a valid numeric string', async () => {
      const { parsePaginationParam } = await import('./worker.js');
      expect(parsePaginationParam('25', 50, 1)).toBe(25);
      expect(parsePaginationParam('1', 50, 1)).toBe(1);
    });

    it('returns fallback for Infinity and NaN strings', async () => {
      const { parsePaginationParam } = await import('./worker.js');
      expect(parsePaginationParam('Infinity', 50, 1)).toBe(50);
      expect(parsePaginationParam('NaN', 50, 1)).toBe(50);
    });
  });

  describe('sourceSuffix', () => {
    it('returns empty string when path is just "/"', async () => {
      const { sourceSuffix } = await import('./worker.js');
      expect(sourceSuffix('https://example.com/')).toBe('');
    });

    it('extracts filename without extension from path', async () => {
      const { sourceSuffix } = await import('./worker.js');
      expect(sourceSuffix('https://example.com/feed.xml')).toBe('FEED');
    });

    it('extracts last path segment from multi-segment path', async () => {
      const { sourceSuffix } = await import('./worker.js');
      expect(sourceSuffix('https://example.com/blog/atom.xml')).toBe('ATOM');
    });

    it('handles query parameters in URL', async () => {
      const { sourceSuffix } = await import('./worker.js');
      expect(sourceSuffix('https://example.com/feed?format=rss')).toBe('FEED');
    });

    it('returns empty string for invalid URL', async () => {
      const { sourceSuffix } = await import('./worker.js');
      expect(sourceSuffix('not-a-url')).toBe('');
    });
  });

  describe('isHatenaSource', () => {
    it('returns true for b.hatena.ne.jp hostname', async () => {
      const { isHatenaSource } = await import('./worker.js');
      expect(isHatenaSource('https://b.hatena.ne.jp/entry/s/example.com')).toBe(true);
    });

    it('returns true for b.hatena.ne.jp without path', async () => {
      const { isHatenaSource } = await import('./worker.js');
      expect(isHatenaSource('https://b.hatena.ne.jp')).toBe(true);
    });

    it('returns false for other domains', async () => {
      const { isHatenaSource } = await import('./worker.js');
      expect(isHatenaSource('https://example.com/')).toBe(false);
    });

    it('returns false for invalid URL', async () => {
      const { isHatenaSource } = await import('./worker.js');
      expect(isHatenaSource('')).toBe(false);
    });
  });

  describe('sourceDisplayTitle', () => {
    it('disambiguates duplicate titles with suffix', async () => {
      const { sourceDisplayTitle } = await import('./worker.js');
      const titleCounts = new Map<string, number>([['Example Feed', 2]]);
      const result = sourceDisplayTitle(
        { siteUrl: 'https://example.com/feed.xml', title: 'Example Feed' },
        titleCounts,
      );
      expect(result).toBe('Example Feed (FEED)');
    });

    it('uses hostname when title is null', async () => {
      const { sourceDisplayTitle } = await import('./worker.js');
      const titleCounts = new Map<string, number>();
      const result = sourceDisplayTitle(
        { siteUrl: 'https://example.com/rss', title: null },
        titleCounts,
      );
      expect(result).toBe('example.com');
    });

    it('adds suffix for hatena source even with unique title', async () => {
      const { sourceDisplayTitle } = await import('./worker.js');
      const titleCounts = new Map<string, number>([['Hatena', 1]]);
      const result = sourceDisplayTitle(
        { siteUrl: 'https://b.hatena.ne.jp/site/feed', title: 'Hatena' },
        titleCounts,
      );
      expect(result).toBe('Hatena (FEED)');
    });

    it('omits suffix when there is no path segment', async () => {
      const { sourceDisplayTitle } = await import('./worker.js');
      const titleCounts = new Map<string, number>([['Example', 1]]);
      const result = sourceDisplayTitle(
        { siteUrl: 'https://example.com/', title: 'Example' },
        titleCounts,
      );
      expect(result).toBe('Example');
    });
  });
});
