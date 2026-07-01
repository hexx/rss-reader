import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { Bookmark, Calendar, Check, ExternalLink, Globe, Link, MessageSquare } from 'lucide-react';
import { useMemo } from 'react';

import type { Article } from '../types.js';
import { getHatenaEntryUrl } from '../utils/hatena.js';
import { sanitizeClientHtml } from '../utils/sanitizeClientHtml.js';

interface ArticleCardProps {
  article: Article;
  onMarkAsRead: (articleId: string) => void | Promise<void>;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '日時不明';
  }

  return new Intl.DateTimeFormat('ja-JP', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function sourceLabel(siteUrl: string): string {
  try {
    return new URL(siteUrl).hostname;
  } catch {
    return siteUrl;
  }
}

export function ArticleCard({ article, onMarkAsRead }: ArticleCardProps) {
  const hasBookmarks = article.bookmarks.length > 0;
  const visibleBookmarks = article.bookmarks.filter((b) => b.comment.trim().length > 0);
  const hasVisibleBookmarks = visibleBookmarks.length > 0;
  const hasSummary = article.summary.trim().length > 0;
  const hasHatenaSummary = article.hatenaSummary.trim().length > 0;

  // サーバー側でサニタイズ済みだが、クライアント側の二重防御として
  // DOMParser で再度許可タグだけに絞り込む。
  const safeSummary = useMemo(() => sanitizeClientHtml(article.summary), [article.summary]);
  const safeHatenaSummary = useMemo(
    () => sanitizeClientHtml(article.hatenaSummary),
    [article.hatenaSummary],
  );

  return (
    <Card
      className={cn(
        'group transition-all hover:shadow-md',
        article.isRead ? 'opacity-60' : 'border-l-4 border-l-primary',
      )}
      id={`article-${article.id}`}
      data-article-id={article.id}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4 min-w-0">
          <div className="flex flex-1 flex-col gap-2 min-w-0">
            {/* Title */}
            <a
              href={article.url}
              target="_blank"
              rel="noreferrer noopener"
              className="block text-lg font-semibold leading-tight hover:text-primary transition-colors line-clamp-2"
            >
              {article.title}
            </a>

            {/* Meta */}
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <Tooltip>
                <TooltipTrigger>
                  <Badge variant="secondary" className="gap-1 cursor-help">
                    <Globe />
                    {sourceLabel(article.siteUrl)}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>{article.siteUrl}</TooltipContent>
              </Tooltip>

              <time
                dateTime={article.publishedAt || article.createdAt}
                className="flex items-center gap-1"
              >
                <Calendar />
                {formatDate(article.publishedAt || article.createdAt)}
              </time>

              {hasBookmarks && (
                <Badge variant="outline" className="gap-1">
                  <Bookmark />
                  {article.bookmarks.length}
                </Badge>
              )}
            </div>

            {/* URL */}
            <a
              href={article.url}
              target="_blank"
              rel="noreferrer noopener"
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-primary transition-colors min-w-0"
            >
              <Link className="shrink-0" />
              <span className="truncate">{article.url}</span>
            </a>
          </div>

          {/* Mark as read button */}
          {!article.isRead && (
            <Tooltip>
              <TooltipTrigger>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 opacity-100 md:opacity-0 group-hover:opacity-100 transition-opacity size-10 md:size-8 bg-muted/50 md:bg-transparent"
                  onClick={() => void onMarkAsRead(article.id)}
                >
                  <Check />
                  <span className="sr-only">既読にする</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>既読にする</TooltipContent>
            </Tooltip>
          )}
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        {/* Summary sections */}
        <div className="grid gap-3 sm:grid-cols-2 min-w-0">
          {hasSummary && (
            <div className="rounded-lg bg-muted/50 p-3 flex flex-col gap-2">
              <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                記事の要約
              </h3>
              <div
                className="text-sm leading-relaxed overflow-wrap-anywhere overflow-x-auto min-w-0 w-full"
                dangerouslySetInnerHTML={{ __html: safeSummary }}
              />
            </div>
          )}

          {hasHatenaSummary && (
            <div className="rounded-lg bg-muted/50 p-3 flex flex-col gap-2">
              <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                はてブの反応
              </h3>
              <div
                className="text-sm leading-relaxed overflow-wrap-anywhere overflow-x-auto min-w-0 w-full"
                dangerouslySetInnerHTML={{ __html: safeHatenaSummary }}
              />
            </div>
          )}
        </div>

        {/* Bookmarks (空コメントは非表示。件数バッジ・見出しのカウントは全件を表示) */}
        {hasVisibleBookmarks && (
          <>
            <Separator />
            <div className="flex flex-col gap-2">
              <h3 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <MessageSquare />
                コメント ({article.bookmarks.length})
              </h3>
              <ul className="flex flex-col gap-1.5 text-sm">
                {visibleBookmarks.map((bookmark) => (
                  <li key={bookmark.id} className="flex gap-2">
                    <span className="font-medium text-primary shrink-0">{bookmark.user}</span>
                    <span className="text-muted-foreground">{bookmark.comment}</span>
                  </li>
                ))}
              </ul>
            </div>
          </>
        )}

        {/* Read article link */}
        <div className="flex justify-end gap-4">
          <a
            href={getHatenaEntryUrl(article.url)}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-primary hover:underline"
          >
            <MessageSquare />
            コメントを読む
          </a>
          <a
            href={article.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            <ExternalLink />
            記事を読む
          </a>
        </div>
      </CardContent>
    </Card>
  );
}
