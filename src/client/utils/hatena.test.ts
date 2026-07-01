import { describe, expect, it } from 'vitest';

import { getHatenaEntryUrl } from './hatena.js';

describe('getHatenaEntryUrl', () => {
  it('converts an https URL to hatena entry format', () => {
    expect(getHatenaEntryUrl('https://example.com/articles/1')).toBe(
      'https://b.hatena.ne.jp/entry/s/example.com/articles/1',
    );
  });

  it('converts an http URL to hatena entry format without the "s" prefix', () => {
    expect(getHatenaEntryUrl('http://example.com/articles/1')).toBe(
      'https://b.hatena.ne.jp/entry/example.com/articles/1',
    );
  });

  it('handles URLs with query parameters', () => {
    expect(getHatenaEntryUrl('https://example.com/page?q=test')).toBe(
      'https://b.hatena.ne.jp/entry/s/example.com/page?q=test',
    );
  });

  it('handles URLs with fragments', () => {
    expect(getHatenaEntryUrl('https://example.com/page#section')).toBe(
      'https://b.hatena.ne.jp/entry/s/example.com/page#section',
    );
  });

  it('handles URLs with paths only', () => {
    expect(getHatenaEntryUrl('https://example.com/')).toBe(
      'https://b.hatena.ne.jp/entry/s/example.com/',
    );
  });
});
