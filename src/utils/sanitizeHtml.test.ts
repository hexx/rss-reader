import { describe, expect, it } from 'vitest';

import { sanitizeSummaryHtml } from './sanitizeHtml.js';

describe('sanitizeSummaryHtml', () => {
  it('preserves allowed block elements', () => {
    const html = '<p>hello <strong>world</strong></p><ul><li>item</li></ul>';
    expect(sanitizeSummaryHtml(html)).toBe(
      '<p>hello <strong>world</strong></p><ul><li>item</li></ul>',
    );
  });

  it('preserves heading tags (h1-h6)', () => {
    const html = '<h2>見出し</h2><p>本文</p>';
    expect(sanitizeSummaryHtml(html)).toBe('<h2>見出し</h2><p>本文</p>');
  });

  it('preserves mailto: href values', () => {
    const html = '<p><a href="mailto:test@example.com">contact</a></p>';
    expect(sanitizeSummaryHtml(html)).toBe(
      '<p><a href="mailto:test@example.com">contact</a></p>',
    );
  });

  it('blocks protocol-relative URLs (//evil.com)', () => {
    const html = '<p><a href="//evil.com">x</a></p>';
    expect(sanitizeSummaryHtml(html)).toBe('<p><a>x</a></p>');
  });

  it('handles input containing </div> without breaking the wrapper', () => {
    const html = '</div><p>legit</p><div>';
    // 入力に </div> が含まれても、内容のテキストは保持される
    expect(sanitizeSummaryHtml(html)).toContain('<p>legit</p>');
  });

  it('strips <script> tags entirely', () => {
    const html = '<p>safe</p><script>alert(1)</script>';
    expect(sanitizeSummaryHtml(html)).toBe('<p>safe</p>');
  });

  it('strips event handler attributes', () => {
    const html = '<p onclick="alert(1)">click me</p>';
    expect(sanitizeSummaryHtml(html)).toBe('<p>click me</p>');
  });

  it('removes javascript: URLs from href', () => {
    const html = '<p><a href="javascript:alert(1)">x</a></p>';
    expect(sanitizeSummaryHtml(html)).toBe('<p><a>x</a></p>');
  });

  it('preserves https href values', () => {
    const html = '<p><a href="https://example.com">link</a></p>';
    expect(sanitizeSummaryHtml(html)).toBe('<p><a href="https://example.com">link</a></p>');
  });

  it('preserves relative href values', () => {
    const html = '<p><a href="/foo">link</a></p>';
    expect(sanitizeSummaryHtml(html)).toBe('<p><a href="/foo">link</a></p>');
  });

  it('unwraps disallowed tags but keeps their text', () => {
    const html = '<div><span>kept</span></div>';
    expect(sanitizeSummaryHtml(html)).toBe('kept');
  });

  it('removes style and iframe', () => {
    const html = '<style>body{}</style><p>hi</p><iframe src="https://evil.example"></iframe>';
    expect(sanitizeSummaryHtml(html)).toBe('<p>hi</p>');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeSummaryHtml('')).toBe('');
  });

  it('does not execute embedded SVG with onload', () => {
    const html = '<svg onload="alert(1)"><circle r="5"/></svg><p>ok</p>';
    const result = sanitizeSummaryHtml(html);
    expect(result).not.toContain('onload');
    expect(result).not.toContain('svg');
    expect(result).toContain('<p>ok</p>');
  });

  it('keeps entity-encoded markup as text (no re-parsing XSS)', () => {
    // replaceWith に文字列を渡すと HTML として再パースされ、エンティティ化された
    // <img onerror> が実タグとして復活する XSS があった。テキストのまま残すこと。
    const html = '<div>&lt;img src=x onerror=alert(1)&gt;</div><p>ok</p>';
    const result = sanitizeSummaryHtml(html);
    // エスケープされたテキストとしては残るが、実タグとしては復活しない
    expect(result).not.toMatch(/<img\b/u);
    expect(result).not.toMatch(/<\w[^>]*\sonerror\s*=/iu);
    expect(result).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(result).toContain('<p>ok</p>');
  });

  it('keeps entity-encoded SVG as text', () => {
    const html = '<div>hello &lt;svg onload=alert(1)&gt;&lt;/svg&gt;</div>';
    const result = sanitizeSummaryHtml(html);
    expect(result).not.toMatch(/<svg\b/u);
    expect(result).not.toMatch(/<\w[^>]*\sonload\s*=/iu);
    expect(result).toContain('hello &lt;svg onload=alert(1)&gt;&lt;/svg&gt;');
  });

  it('blocks backslash protocol-relative URLs (/\\evil.com)', () => {
    // WHATWG URL パーサは特別スキームでバックスラッシュをスラッシュと同等に扱うため、
    // /\\evil.com は //evil.com として別オリジンへ遷移し得る。ブロックすること。
    const html = '<p><a href="/\\evil.com">x</a></p>';
    expect(sanitizeSummaryHtml(html)).toBe('<p><a>x</a></p>');
  });

  it('blocks tab/newline-injected protocol-relative URLs', () => {
    // WHATWG URL パーサはパース前に ASCII タブ・改行を除去するため、
    // `/\n/evil.com` や `/\t/evil.com` は `//evil.com` に正規化され得る。ブロックすること。
    expect(sanitizeSummaryHtml('<p><a href="/\n/evil.com">x</a></p>')).toBe('<p><a>x</a></p>');
    expect(sanitizeSummaryHtml('<p><a href="/\t/evil.com">x</a></p>')).toBe('<p><a>x</a></p>');
    // 通常の相対パスは引き続き許可される
    expect(sanitizeSummaryHtml('<p><a href="/foo">x</a></p>')).toBe('<p><a href="/foo">x</a></p>');
  });
});
