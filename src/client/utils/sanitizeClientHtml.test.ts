import { describe, expect, it } from 'vitest';

import { sanitizeClientHtml } from './sanitizeClientHtml.js';

describe('sanitizeClientHtml', () => {
  it('preserves allowed block elements', () => {
    const html = '<p>hello <strong>world</strong></p><ul><li>item</li></ul>';
    expect(sanitizeClientHtml(html)).toBe(
      '<p>hello <strong>world</strong></p><ul><li>item</li></ul>',
    );
  });

  it('preserves heading tags (h1-h6)', () => {
    const html = '<h2>見出し</h2><p>本文</p>';
    expect(sanitizeClientHtml(html)).toBe('<h2>見出し</h2><p>本文</p>');
  });

  it('preserves mailto: href values', () => {
    const html = '<p><a href="mailto:test@example.com">contact</a></p>';
    // Jsdom の DOMParser は属性値を小文字化する場合があるため、柔軟に検証
    const result = sanitizeClientHtml(html);
    expect(result).toContain('href="mailto:test@example.com"');
    expect(result).toContain('contact');
  });

  it('blocks tab/newline-injected protocol-relative URLs', () => {
    // WHATWG URL パーサはパース前に ASCII タブ・改行を除去するため、
    // `/\n/evil.com` や `/\t/evil.com` は `//evil.com` に正規化され得る。
    const result1 = sanitizeClientHtml('<p><a href="/\n/evil.com">x</a></p>');
    expect(result1).not.toContain('href');
    const result2 = sanitizeClientHtml('<p><a href="/\t/evil.com">x</a></p>');
    expect(result2).not.toContain('href');
    // 通常の相対パスは引き続き許可される
    expect(sanitizeClientHtml('<p><a href="/foo">x</a></p>')).toBe('<p><a href="/foo">x</a></p>');
  });

  it('blocks protocol-relative URLs (//evil.com)', () => {
    const html = '<p><a href="//evil.com">x</a></p>';
    const result = sanitizeClientHtml(html);
    expect(result).not.toContain('href');
    expect(result).toContain('x');
  });

  it('strips <script> tags entirely', () => {
    const html = '<p>safe</p><script>alert(1)</script>';
    expect(sanitizeClientHtml(html)).toBe('<p>safe</p>');
  });

  it('strips event handler attributes', () => {
    const html = '<p onclick="alert(1)">click me</p>';
    expect(sanitizeClientHtml(html)).toBe('<p>click me</p>');
  });

  it('removes javascript: URLs from href', () => {
    const html = '<p><a href="javascript:alert(1)">x</a></p>';
    const result = sanitizeClientHtml(html);
    expect(result).not.toContain('href');
    expect(result).toContain('x');
  });

  it('preserves https href values', () => {
    const html = '<p><a href="https://example.com">link</a></p>';
    expect(sanitizeClientHtml(html)).toBe(
      '<p><a href="https://example.com">link</a></p>',
    );
  });

  it('preserves relative href values', () => {
    const html = '<p><a href="/foo">link</a></p>';
    expect(sanitizeClientHtml(html)).toBe('<p><a href="/foo">link</a></p>');
  });

  it('unwraps disallowed tags but keeps their text', () => {
    const html = '<div><span>kept</span></div>';
    expect(sanitizeClientHtml(html)).toBe('kept');
  });

  it('removes style and iframe', () => {
    const html = '<style>body{}</style><p>hi</p><iframe src="https://evil.example"></iframe>';
    expect(sanitizeClientHtml(html)).toBe('<p>hi</p>');
  });

  it('returns empty string for empty input', () => {
    expect(sanitizeClientHtml('')).toBe('');
  });

  // SVG / MathML などの foreign content は HTMLElement ではないため、
  // `instanceof HTMLElement` で判定すると allowlist をすり抜けていた。
  // タグ名ベースの判定に変更し、onload 等の属性も除去されることを保証する。
  it('sanitizes onload attributes on SVG elements', () => {
    const html = '<svg onload="alert(1)"><circle r="5"/></svg><p>ok</p>';
    const result = sanitizeClientHtml(html);
    expect(result).not.toContain('onload');
    expect(result).not.toContain('svg');
    expect(result).toContain('<p>ok</p>');
  });

  it('keeps entity-encoded markup as text (no re-parsing XSS)', () => {
    const html = '<div>&lt;img src=x onerror=alert(1)&gt;</div><p>ok</p>';
    const result = sanitizeClientHtml(html);
    // エスケープされたテキストとしては残るが、実タグとしては復活しない
    expect(result).not.toMatch(/<img\b/);
    expect(result).not.toMatch(/<\w[^>]*\sonerror\s*=/i);
    expect(result).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(result).toContain('<p>ok</p>');
  });

  it('keeps content after a stray closing div', () => {
    // ラッパー div 方式だと余分な </div> でラッパーが閉じ、後続が切り捨てられた。
    // body 直接パースでは HTML5 パーサが余分な終了タグを無視するため保持される。
    const html = '</div><p>legit</p><div>';
    const result = sanitizeClientHtml(html);
    expect(result).toContain('<p>legit</p>');
  });

  it('preserves br tags', () => {
    const html = '<p>line1<br>line2</p>';
    expect(sanitizeClientHtml(html)).toBe('<p>line1<br>line2</p>');
  });

  it('preserves nested list structures', () => {
    const html = '<ul><li>item1<ul><li>nested</li></ul></li></ul>';
    const result = sanitizeClientHtml(html);
    expect(result).toContain('<ul>');
    expect(result).toContain('<li>nested</li>');
  });
});
