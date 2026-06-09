import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader } from '@/components/ui/card';
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
  return (
    <Card
      className={`scroll-mt-6 ${article.isRead ? 'opacity-65' : 'border-l-4 border-l-primary'}`}
      id={`article-${article.id}`}
      data-article-id={article.id}
    >
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <a
            className="mb-1 inline-block font-bold text-primary text-lg hover:underline"
            href={article.url}
            target="_blank"
            rel="noreferrer noopener"
          >
            {article.title}
          </a>
          <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-sm">
            <Badge variant="secondary">{sourceLabel(article.siteUrl)}</Badge>
            <span>{formatDate(article.publishedAt || article.createdAt)}</span>
            <span className="text-xs break-all text-muted-foreground/70">{article.url}</span>
          </div>
        </div>
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void onMarkAsRead(article.id)}
        >
          既読にする
        </Button>
      </CardHeader>

      <CardContent className="flex flex-col gap-4">
        <section className="rounded-lg bg-muted/50 p-4 overflow-wrap-anywhere">
          <h3 className="mb-2 font-semibold text-sm">記事の要約</h3>
          {article.summary.trim().length > 0 ? (
            <div className="leading-relaxed" dangerouslySetInnerHTML={{ __html: article.summary }} />
          ) : (
            <div className="text-muted-foreground">記事の要約はまだありません。</div>
          )}
        </section>

        <section className="rounded-lg bg-amber-50 p-4 overflow-wrap-anywhere dark:bg-amber-950/20">
          <h3 className="mb-2 font-semibold text-sm">はてブの反応</h3>
          {article.hatenaSummary.trim().length > 0 ? (
            <div className="leading-relaxed" dangerouslySetInnerHTML={{ __html: article.hatenaSummary }} />
          ) : (
            <div className="text-muted-foreground">はてブの反応要約はまだありません。</div>
          )}
        </section>

        <a
          className="inline-flex items-center font-bold text-primary hover:underline"
          href={article.url}
          target="_blank"
          rel="noreferrer noopener"
        >
          記事を読む
        </a>

        <div>
          <h4 className="mb-2 font-semibold text-sm">個別コメント</h4>
          <ul className="list-disc pl-5 text-sm">
            {article.bookmarks.length === 0 ? (
              <li className="text-muted-foreground">はてブコメントはまだありません。</li>
            ) : (
              article.bookmarks.map((bookmark) => (
                <li key={bookmark.id}>
                  <span className="font-medium">{bookmark.user}</span>: {bookmark.comment}
                </li>
              ))
            )}
          </ul>
        </div>
      </CardContent>
    </Card>
  );
}
