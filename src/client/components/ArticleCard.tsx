import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import { Bookmark, Calendar, Check, ExternalLink, Globe, MessageSquare } from 'lucide-react';
import type { Article } from '../types.js';

type ArticleCardProps = {
  article: Article;
  onMarkAsRead: (articleId: string) => void | Promise<void>;
};

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
  const hasSummary = article.summary.trim().length > 0;
  const hasHatenaSummary = article.hatenaSummary.trim().length > 0;

  return (
    <Card
      className={`group transition-all hover:shadow-md ${
        article.isRead ? 'opacity-60' : 'border-l-4 border-l-primary'
      }`}
      id={`article-${article.id}`}
      data-article-id={article.id}
    >
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0 space-y-2">
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
                    <Globe className="size-3" />
                    {sourceLabel(article.siteUrl)}
                  </Badge>
                </TooltipTrigger>
                <TooltipContent>{article.siteUrl}</TooltipContent>
              </Tooltip>

              <span className="flex items-center gap-1">
                <Calendar className="size-3" />
                {formatDate(article.publishedAt || article.createdAt)}
              </span>

              {hasBookmarks && (
                <Badge variant="outline" className="gap-1">
                  <Bookmark className="size-3" />
                  {article.bookmarks.length}
                </Badge>
              )}
            </div>
          </div>

          {/* Mark as read button */}
          {!article.isRead && (
            <Tooltip>
              <TooltipTrigger>
                <Button
                  variant="ghost"
                  size="icon"
                  className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity"
                  onClick={() => void onMarkAsRead(article.id)}
                >
                  <Check className="size-4" />
                  <span className="sr-only">既読にする</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent>既読にする</TooltipContent>
            </Tooltip>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Summary sections */}
        <div className="grid gap-3 sm:grid-cols-2">
          {hasSummary && (
            <div className="rounded-lg bg-muted/50 p-3 space-y-2">
              <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                記事の要約
              </h3>
              <div
                className="text-sm leading-relaxed overflow-wrap-anywhere"
                dangerouslySetInnerHTML={{ __html: article.summary }}
              />
            </div>
          )}

          {hasHatenaSummary && (
            <div className="rounded-lg bg-amber-50/50 p-3 space-y-2 dark:bg-amber-950/20">
              <h3 className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                はてブの反応
              </h3>
              <div
                className="text-sm leading-relaxed overflow-wrap-anywhere"
                dangerouslySetInnerHTML={{ __html: article.hatenaSummary }}
              />
            </div>
          )}
        </div>

        {/* Bookmarks */}
        {hasBookmarks && (
          <>
            <Separator />
            <div className="space-y-2">
              <h3 className="flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
                <MessageSquare className="size-3" />
                コメント ({article.bookmarks.length})
              </h3>
              <ul className="space-y-1.5 text-sm">
                {article.bookmarks.slice(0, 3).map((bookmark) => (
                  <li key={bookmark.id} className="flex gap-2">
                    <span className="font-medium text-primary shrink-0">{bookmark.user}</span>
                    <span className="text-muted-foreground">{bookmark.comment}</span>
                  </li>
                ))}
                {article.bookmarks.length > 3 && (
                  <li className="text-xs text-muted-foreground">
                    他 {article.bookmarks.length - 3} 件のコメント...
                  </li>
                )}
              </ul>
            </div>
          </>
        )}

        {/* Read article link */}
        <div className="flex justify-end">
          <a
            href={article.url}
            target="_blank"
            rel="noreferrer noopener"
            className="inline-flex items-center gap-1 text-sm text-primary hover:underline"
          >
            <ExternalLink className="size-4" />
            記事を読む
          </a>
        </div>
      </CardContent>
    </Card>
  );
}
