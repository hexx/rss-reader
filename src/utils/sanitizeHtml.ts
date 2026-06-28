import { load, type CheerioAPI } from 'cheerio';
import { isTag, type Element } from 'domhandler';

import { ALLOWED_TAGS, REMOVE_CONTENT_TAGS, SAFE_URL_PATTERN } from '../shared/sanitize-constants.js';

/**
 * AI 要約/はてなブックマーク要約のHTMLをサニタイズするユーティリティ。
 *
 * AI からの出力は信頼できない入力なので、ブラウザへ流し込む前に
 * 許可タグ・許可属性だけに絞り込む。
 *
 * 設計方針:
 * - 許可するタグ: p, ul, ol, li, strong, em, b, i, br, blockquote, code, pre, a
 * - 許可する属性: a タグの href のみ（http/https/relative/fragment のみ許可）
 * - スクリプト・スタイル・on* 属性・javascript: URL は全て除去
 *
 * 依存パッケージを最小限に抑えるため、cheerio だけで実装している
 * （dompurify は Cloudflare Workers 上で動かないため不採用）。
 */

function isSafeHref(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return false;
  }
  return SAFE_URL_PATTERN.test(trimmed);
}

function sanitizeNode($: CheerioAPI, element: Element): void {
  const tagName = element.tagName.toLowerCase();

  if (REMOVE_CONTENT_TAGS.has(tagName)) {
    $(element).remove();
    return;
  }

  if (!ALLOWED_TAGS.has(tagName)) {
    // 許可されていないタグは中身のテキストだけ残す
    const text = $(element).text();
    $(element).replaceWith(text);
    return;
  }

  // 属性を全削除（a タグの href だけ例外的に再付与する）
  // スナップショットを取ってからイテレートする。
  for (const attr of Array.from(element.attributes)) {
    const allowed = tagName === 'a' && attr.name === 'href' && isSafeHref(attr.value);
    if (!allowed) {
      $(element).removeAttr(attr.name);
    }
  }

  // 子ノードを再帰的にサニタイズ
  const children = element.children.slice();
  for (const child of children) {
    if (isTag(child)) {
      sanitizeNode($, child);
    }
  }
}

/**
 * HTML 文字列をサニタイズして、安全なHTMLを返す。
 *
 * @param html サニタイズ対象の HTML 文字列
 * @returns 許可タグ・許可属性のみに絞られた HTML 文字列
 */
export function sanitizeSummaryHtml(html: string): string {
  if (html.length === 0) {
    return '';
  }

  // cheerio の load は <html><head></head><body>...</body></html> を生成する。
  // body を直接使うことで、入力に含まれる </div> などでラッパーが壊れる問題を回避する。
  const $ = load(html);
  const body = $('body');
  const bodyElement = body[0] as Element | undefined;
  if (!bodyElement) {
    return '';
  }

  for (const child of bodyElement.children.slice()) {
    if (isTag(child)) {
      sanitizeNode($, child);
    }
  }

  return body.html() ?? '';
}
