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

function summaryText(value: string, fallback: string): string {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

export function ArticleCard({ article, onMarkAsRead }: ArticleCardProps) {
  return (
    <article className={`card ${article.isRead ? 'is-read' : 'is-unread'}`} id={`article-${article.id}`} data-article-id={article.id}>
      <header className="card__header">
        <div className="card__title-group">
          <a className="card__title" href={article.url} target="_blank" rel="noreferrer noopener">
            {article.title}
          </a>
          <div className="card__meta">
            <span className="card__source">{sourceLabel(article.siteUrl)}</span>
            <span className="card__date">{formatDate(article.publishedAt || article.createdAt)}</span>
            <span className="card__url">{article.url}</span>
          </div>
        </div>
        <button className="card__read-toggle" type="button" onClick={() => void onMarkAsRead(article.id)}>
          既読にする
        </button>
      </header>

      <section className="card__summary-section">
        <h3>記事の要約</h3>
        <div className="card__article-summary">{summaryText(article.summary, '記事の要約はまだありません。')}</div>
      </section>

      <section className="card__summary-section card__summary-section--hatena">
        <h3>はてブの反応</h3>
        <div className="card__hatena-summary">
          {summaryText(article.hatenaSummary, 'はてブの反応要約はまだありません。')}
        </div>
      </section>

      <a className="card__article-link" href={article.url} target="_blank" rel="noreferrer noopener">
        記事を読む
      </a>

      <div className="card__comments-heading">個別コメント</div>
      <ul className="comments">
        {article.bookmarks.length === 0 ? (
          <li>はてブコメントはまだありません。</li>
        ) : (
          article.bookmarks.map((bookmark) => (
            <li key={bookmark.id}>
              {bookmark.user}: {bookmark.comment}
            </li>
          ))
        )}
      </ul>
    </article>
  );
}
