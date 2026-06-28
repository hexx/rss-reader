/**
 * クライアント側の軽量サニタイザ。
 *
 * ブラウザ標準の DOMParser を使い、許可タグ・許可属性のみに絞る。
 * `cheerio` をクライアント bundle に含めないために、こちらを別途用意している。
 *
 * サーバー側 (src/utils/sanitizeHtml.ts) でのサニタイズが第一防御、
 * この関数は第二防御として、サーバー側を迂回した経路でも安全側に倒す目的で使う。
 */

const ALLOWED_TAGS = new Set([
  'A',
  'B',
  'BLOCKQUOTE',
  'BR',
  'CODE',
  'EM',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'I',
  'LI',
  'OL',
  'P',
  'PRE',
  'STRONG',
  'UL',
]);

const REMOVE_CONTENT_TAGS = new Set([
  'EMBED',
  'IFRAME',
  'NOSCRIPT',
  'OBJECT',
  'SCRIPT',
  'STYLE',
]);

/**
 * 許可する URL スキーム。
 * 重要: 先頭の "/" の後に "/" を続けるプロトコル相対 URL (//evil.com 等) はブロックする。
 */
const SAFE_URL_PATTERN = /^(?:https?:|mailto:|\/(?!\/)|#)/i;

function isSafeHref(value: string): boolean {
  return SAFE_URL_PATTERN.test(value.trim());
}

function sanitizeElement(element: Element): Node | null {
  // 許可されていないタグや、内容ごと除去するタグはここで処理
  if (element instanceof HTMLElement) {
    const tag = element.tagName.toUpperCase();
    if (REMOVE_CONTENT_TAGS.has(tag)) {
      return null;
    }
    if (!ALLOWED_TAGS.has(tag)) {
      // 許可外のタグはテキストノードに置き換える
      return document.createTextNode(element.textContent ?? '');
    }

    // 許可タグでも属性は全削除
    const attrs = Array.from(element.attributes);
    for (const attr of attrs) {
      const keep = tag === 'A' && attr.name === 'href' && isSafeHref(attr.value);
      if (!keep) {
        element.removeAttribute(attr.name);
      }
    }
  }

  // 子ノードを再帰的にサニタイズ
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const sanitized = sanitizeElement(child as Element);
      if (sanitized === null) {
        child.parentNode?.removeChild(child);
      } else if (sanitized !== child) {
        child.parentNode?.replaceChild(sanitized, child);
      }
    }
  }
  return element;
}

/**
 * HTML 文字列をサニタイズして、安全なHTML断片を返す。
 *
 * @param html サニタイズ対象の HTML 文字列
 * @returns 許可タグ・許可属性のみに絞られた HTML 文字列
 */
export function sanitizeClientHtml(html: string): string {
  if (html.length === 0) {
    return '';
  }
  if (typeof DOMParser === 'undefined') {
    // DOMParser が無い環境（例: 一部のテストランナー）はフォールバックとして
    // 全タグをテキストとして除去する。サーバー側サニタイズが第一防御だが、
    // dangerouslySetInnerHTML に生 HTML を絶対に渡さないための保険。
    return html.replace(/<[^>]*>/g, '');
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(`<div id="__root__">${html}</div>`, 'text/html');
  const root = doc.getElementById('__root__');
  if (!root) {
    return '';
  }

  for (const child of Array.from(root.childNodes)) {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const sanitized = sanitizeElement(child as Element);
      if (sanitized === null) {
        child.parentNode?.removeChild(child);
      } else if (sanitized !== child) {
        root.replaceChild(sanitized, child);
      }
    }
  }
  return root.innerHTML;
}
