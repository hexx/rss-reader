/**
 * サーバー側・クライアント側のサニタイザで共有する定数。
 *
 * 許可タグ・除去タグ・安全なURLパターンを一箇所で管理し、
 * サーバー・クライアント間の同期漏れを防ぐ。
 */

/** サニタイズ後も保持を許可する HTML タグ */
export const ALLOWED_TAGS = new Set([
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'em',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'i',
  'li',
  'ol',
  'p',
  'pre',
  'strong',
  'ul',
]);

/** 内容ごと完全に削除するタグ */
export const REMOVE_CONTENT_TAGS = new Set([
  'embed',
  'iframe',
  'noscript',
  'object',
  'script',
  'style',
]);

/**
 * 許可する URL スキーム。
 *
 * 重要: 先頭の "/" の後に "/" を続けるプロトコル相対 URL (//evil.com 等) は
 * 別オリジンへの遷移を許してしまうため、明示的にブロックする。
 */
export const SAFE_URL_PATTERN = /^(?:https?:|mailto:|\/(?!\/)|#)/i;
