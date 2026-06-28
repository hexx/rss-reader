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
});
