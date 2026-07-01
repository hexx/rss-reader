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
    // jsdom の DOMParser は属性値を小文字化する場合があるため、柔軟に検証
    const result = sanitizeClientHtml(html);
    expect(result).toContain('href="mailto:test@example.com"');
    expect(result).toContain('contact');
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

  // SVG 要素は HTMLElement ではないためサニタイザの対象外です。
  // onload 属性は除去されずそのまま残ります（サーバー側の cheerio ベース
  // サニタイザはタグ名で判定するため別の挙動となります）。
  // クライアント側サニタイザの将来の改善ポイントです。
  it('does not sanitize onload attributes on SVG elements', () => {
    const html = '<svg onload="alert(1)"><circle r="5"/></svg><p>ok</p>';
    const result = sanitizeClientHtml(html);
    // SVG の onload は現状除去されない
    expect(result).toContain('onload');
    expect(result).toContain('svg');
    expect(result).toContain('<p>ok</p>');
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
