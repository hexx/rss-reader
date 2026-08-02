/**
 * クライアント側の軽量サニタイザ。
 *
 * ブラウザ標準の DOMParser を使い、許可タグ・許可属性のみに絞る。
 * `cheerio` をクライアント bundle に含めないために、こちらを別途用意している。
 *
 * サーバー側 (src/utils/sanitizeHtml.ts) でのサニタイズが第一防御、
 * この関数は第二防御として、サーバー側を迂回した経路でも安全側に倒す目的で使う。
 */

import {
  ALLOWED_TAGS,
  REMOVE_CONTENT_TAGS,
  SAFE_URL_PATTERN,
} from '../../shared/sanitize-constants.js';

function isSafeHref(value: string): boolean {
  return SAFE_URL_PATTERN.test(value.trim());
}

function sanitizeElement(element: Element): Node | null {
  const tag = element.tagName.toLowerCase();

  // 許可されていないタグや、内容ごと除去するタグはここで処理する。
  // 注意: SVG / MathML などの foreign content は HTMLElement ではないため、
  // `instanceof HTMLElement` で判定すると allowlist をすり抜けてしまう
  // (例: `<svg onload=...>`)。タグ名ベースの判定で全ての要素を扱う。
  if (REMOVE_CONTENT_TAGS.has(tag)) {
    return null;
  }
  if (!ALLOWED_TAGS.has(tag)) {
    // 許可外のタグはテキストノードに置き換える
    return document.createTextNode(element.textContent ?? '');
  }

  // 許可タグでも属性は全削除（a タグの href だけ例外的に再付与する）
  const attrs = [...element.attributes];
  for (const attr of attrs) {
    const keep = tag === 'a' && attr.name === 'href' && isSafeHref(attr.value);
    if (!keep) {
      element.removeAttribute(attr.name);
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
    // DangerouslySetInnerHTML に生 HTML を絶対に渡さないための保険。
    // 閉じタグの無い断片（例: `<img onerror=...`）が残らないよう、
    // 除去後に残った '<' はエスケープしてタグとして解釈されないようにする。
    return html.replaceAll(/<[^>]*>/g, '').replaceAll('<', '&lt;');
  }

  const parser = new DOMParser();
  // サーバー側実装と同じく body を直接使う。入力に含まれる余分な `</div>` 等の
  // 終了タグは HTML5 パーサが無視するため、ラッパー要素を割って内容が
  // 切り捨てられる問題を避けられる。
  const doc = parser.parseFromString(html, 'text/html');
  const root = doc.body;
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
