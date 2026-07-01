import { useEffect } from 'react';

import type { Article } from '../types.js';
import { getHatenaEntryUrl } from '../utils/hatena.js';

interface ShortcutHandler {
  /** 'm' で未読記事を既読にする。 */
  onMarkAsRead: (articleId: string) => void;
}

const TARGET_KEYS = new Set(['INPUT', 'TEXTAREA']);

/** 'm' / 'v' / 'b' のキーボードショートカット。 */
export function useKeyboardShortcuts(articles: Article[], handler: ShortcutHandler) {
  const { onMarkAsRead } = handler;

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target) {
        if (TARGET_KEYS.has(target.tagName) || target.isContentEditable) {
          return;
        }
      }

      const firstUnread = articles.find((article) => !article.isRead);
      if (!firstUnread) {
        return;
      }

      switch (event.key) {
        case 'm': {
          onMarkAsRead(firstUnread.id);
          break;
        }
        case 'v': {
          window.open(firstUnread.url, '_blank', 'noreferrer noopener');
          break;
        }
        case 'b': {
          // 'b' で、はてなブックマークのエントリーページを開く。
          window.open(getHatenaEntryUrl(firstUnread.url), '_blank', 'noreferrer noopener');
          break;
        }
        default: {
          return;
        }
      }
    }

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [articles, onMarkAsRead]);
}
