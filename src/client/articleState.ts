import type { Article } from './types.js';

export function applyReadStateChange(
  articles: Article[],
  articleId: string,
  isRead: boolean,
  hideReadArticles: boolean,
): Article[] {
  if (hideReadArticles && isRead) {
    return articles.filter((article) => article.id !== articleId);
  }

  return articles.map((article) => (article.id === articleId ? { ...article, isRead } : article));
}
