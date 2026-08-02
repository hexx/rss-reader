import { useEffect } from 'react';

import type { Article } from '../types.js';
import { getHatenaEntryUrl } from '../utils/hatena.js';
import { useLatestRef } from './useLatestRef.js';

interface ShortcutHandler {
  /** 'm' で未読記事を既読にする。 */
  onMarkAsRead: (articleId: string) => void;
}

const TARGET_KEYS = new Set(['INPUT', 'TEXTAREA']);

/** 記事 URL として開いてよいスキーム（フィード由来の URL は信頼できないため二重防御）。 */
const SAFE_ARTICLE_URL_PATTERN = /^https?:\/\//i;

/** 'm' / 'v' / 'b' のキーボードショートカット。 */
export function useKeyboardShortcuts(articles: Article[], handler: ShortcutHandler) {
  // Articles / handler は呼び出し側で毎レンダー新しい参照になることがあるため、
  // 最新値を ref 経由で参照し、イベントリスナーの再登録を避ける。
  const articlesRef = useLatestRef(articles);
  const handlerRef = useLatestRef(handler);

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // 修飾キーとの同時押し（Cmd/Ctrl+V の貼り付け、Ctrl+M、Shift+M 等）は
      // ブラウザ/OS の操作を優先し、ショートカットを発火させない。
      // キーリピート（長押し）による連続発火も防ぐ。
      // なお Caps Lock では shiftKey が立たないため、大文字入力のユーザーは動作する。
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey || event.repeat) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (target) {
        if (TARGET_KEYS.has(target.tagName) || target.isContentEditable) {
          return;
        }
      }

      const firstUnread = articlesRef.current.find((article) => !article.isRead);
      if (!firstUnread) {
        return;
      }

      switch (event.key.toLowerCase()) {
        case 'm': {
          // 既読化は URL を開かないため、URL スキームの制約は適用しない
          handlerRef.current.onMarkAsRead(firstUnread.id);
          break;
        }
        case 'v':
        case 'b': {
          // 記事 URL はフィード由来のため http(s) 以外は開かない
          // （スクレイパー側でも除外しているが、保存済みデータへの二重防御）。
          if (!SAFE_ARTICLE_URL_PATTERN.test(firstUnread.url)) {
            return;
          }
          // 'v' は記事本体、'b' ははてなブックマークのエントリーページを開く。
          const targetUrl = event.key.toLowerCase() === 'v'
            ? firstUnread.url
            : getHatenaEntryUrl(firstUnread.url);
          window.open(targetUrl, '_blank', 'noreferrer noopener');
          break;
        }
        default: {
          return;
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [articlesRef, handlerRef]);
}
